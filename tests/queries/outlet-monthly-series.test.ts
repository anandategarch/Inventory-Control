// Tests for src/lib/queries/outlets/outlet-monthly-series.ts (DEEP-RESTO-1 —
// "Deret Bulanan" + "Track-Record Rank Peer").
//
// Covers:
//  1. buildMonthlySeriesRows (pure) — MoM sales growth (null on first row,
//     null on zero previous sales), Net Cost Ratio (0 when no sales),
//     abnormal flag (devBom > tolerance OR loss > threshold — the
//     outlet-recurrence definition), bigint coercion.
//  2. buildMonthlySeriesTotal (pure) — window sums + recomputed net ratio +
//     abnormalCount.
//  3. summarizeTrackRecord (pure) — averages, worst-month counts, latest
//     month; empty input shape.
//  4. queryOutletMonthlySeries — ONE merged set_config round-trip (the
//     withStatementTimeout wrapper), SQL pins the SAME weekLabel, applies
//     monthKey <= currentMonthKey (inclusive window), caps to 12 months,
//     and maps the raw row shape (bigint → Number).
//  5. queryPeerTrackRecord — kelompok predicate appears in SQL only when
//     passed; rank/bandSize/medianLoss mapping; summary wiring.
//
// Mock @/lib/db (same vi.hoisted pattern as change-analysis.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OUTLET_MONTHLY_SERIES_WINDOW_MONTHS,
  buildMonthlySeriesRows,
  buildMonthlySeriesTotal,
  summarizeTrackRecord,
  queryOutletMonthlySeries,
  queryPeerTrackRecord,
} from '@/lib/queries/outlets/outlet-monthly-series';

const { mockQueryRaw, mockExecuteRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: mockQueryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/**
 * Full-text extractor for a tagged-template $queryRaw mock call.
 * mock.calls[0] = [stringsArray, ...values] — the strings array holds the
 * template's literal chunks, while interpolated values include NESTED
 * Prisma.Sql fragments ({ strings, values }) that plain String() would
 * render as "[object Object]". Flattens everything recursively so
 * assertions can see text spliced via ${Prisma.sql`...`} (monthKey bound,
 * kelompok filter, Prisma.empty → '').
 */
function deepText(x: unknown): string {
  if (x == null) return '';
  if (Array.isArray(x)) return x.map(deepText).join('');
  if (typeof x === 'object' && 'strings' in (x as Record<string, unknown>)) {
    const { strings, values } = x as { strings: unknown[]; values?: unknown[] };
    let out = '';
    strings.forEach((s, i) => {
      out += String(s ?? '');
      if (values && i < values.length) out += deepText(values[i]);
    });
    return out;
  }
  return String(x);
}

const TOL = 0.05;
const HI_LOSS = 50_000_000;

function rawRow(overrides: Partial<Record<string, number | bigint | string>> = {}) {
  return {
    monthKey: '2026-08',
    monthLabel: 'Agustus 2026',
    sales: 1000,
    qtyBom: 500,
    nominalDeviasi: -200,
    devBom: 0.2,
    totalLoss: 300,
    totalSurplus: 100,
    ...overrides,
  };
}

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
});

// ------------------------------------------------------------
// 1. buildMonthlySeriesRows
// ------------------------------------------------------------

describe('buildMonthlySeriesRows', () => {
  it('computes MoM vs the previous row and nulls the first row', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({ monthKey: '2026-07', sales: 1000 }),
      rawRow({ monthKey: '2026-08', sales: 1250 }),
    ], TOL, HI_LOSS);
    expect(rows).toHaveLength(2);
    expect(rows[0].salesMoM).toBeNull();
    expect(rows[1].salesMoM).toBeCloseTo(0.25, 10);
  });

  it('nulls MoM when previous sales is 0 (no divide-by-zero)', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({ monthKey: '2026-07', sales: 0 }),
      rawRow({ monthKey: '2026-08', sales: 100 }),
    ], TOL, HI_LOSS);
    expect(rows[1].salesMoM).toBeNull();
  });

  it('computes Net Cost Ratio = (loss − surplus) / sales, 0 when sales is 0', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({ sales: 1000, totalLoss: 300, totalSurplus: 100 }),
      rawRow({ sales: 0, totalLoss: 300, totalSurplus: 100 }),
    ], TOL, HI_LOSS);
    expect(rows[0].netCostRatio).toBeCloseTo(0.2, 10);
    expect(rows[1].netCostRatio).toBe(0);
  });

  it('flags abnormal via devBom > tolerance OR loss > threshold (recurrence definition)', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({ devBom: 0.04, totalLoss: 1000 }),                    // stable
      rawRow({ devBom: 0.06, totalLoss: 1000 }),                    // devBom breach
      rawRow({ devBom: 0.04, totalLoss: HI_LOSS + 1 }),             // loss breach
      rawRow({ devBom: 0.05, totalLoss: HI_LOSS }),                 // exactly at bounds → stable
    ], TOL, HI_LOSS);
    expect(rows.map((r) => r.abnormal)).toEqual([false, true, true, false]);
  });

  it('coerces bigint aggregates to Number', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({
        sales: BigInt(1000),
        qtyBom: BigInt(500),
        nominalDeviasi: BigInt(-200),
        totalLoss: BigInt(300),
        totalSurplus: BigInt(100),
      }),
    ], TOL, HI_LOSS);
    expect(rows[0].sales).toBe(1000);
    expect(rows[0].nominalDeviasi).toBe(-200);
    expect(rows[0].totalLoss).toBe(300);
  });
});

// ------------------------------------------------------------
// 2. buildMonthlySeriesTotal
// ------------------------------------------------------------

describe('buildMonthlySeriesTotal', () => {
  it('sums the window and recomputes net ratio on totals', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({ monthKey: '2026-07', sales: 1000, totalLoss: 300, totalSurplus: 100, nominalDeviasi: -50, devBom: 0.04 }),
      rawRow({ monthKey: '2026-08', sales: 1000, totalLoss: 200, totalSurplus: 100, nominalDeviasi: 50, devBom: 0.04 }),
    ], TOL, HI_LOSS);
    const total = buildMonthlySeriesTotal(rows);
    expect(total.months).toBe(2);
    expect(total.sales).toBe(2000);
    expect(total.totalLoss).toBe(500);
    expect(total.totalSurplus).toBe(200);
    expect(total.nominalDeviasi).toBe(0);
    expect(total.netCostRatio).toBeCloseTo(0.15, 10);
    expect(total.abnormalCount).toBe(0);
  });

  it('net ratio is 0 when the whole window has no sales', () => {
    const rows = buildMonthlySeriesRows([rawRow({ sales: 0 })], TOL, HI_LOSS);
    expect(buildMonthlySeriesTotal(rows).netCostRatio).toBe(0);
  });

  it('empty window → zeroed total', () => {
    const total = buildMonthlySeriesTotal([]);
    expect(total.months).toBe(0);
    expect(total.sales).toBe(0);
    expect(total.abnormalCount).toBe(0);
  });
});

// ------------------------------------------------------------
// 3. summarizeTrackRecord
// ------------------------------------------------------------

describe('summarizeTrackRecord', () => {
  it('empty input → null summary fields', () => {
    const s = summarizeTrackRecord([]);
    expect(s.monthsTracked).toBe(0);
    expect(s.avgRankNetDev).toBeNull();
    expect(s.lastMonthLabel).toBeNull();
    expect(s.monthsWorstNetDev).toBe(0);
  });

  it('averages ranks, counts worst months, exposes the latest month', () => {
    const s = summarizeTrackRecord([
      { monthKey: '2026-02', monthLabel: 'Februari 2026', targetSales: 1000, nominalDeviasi: -10, totalLoss: 50, rankNetDev: 2, rankLoss: 1, bandSize: 9, medianLoss: 40 },
      { monthKey: '2026-03', monthLabel: 'Maret 2026', targetSales: 1100, nominalDeviasi: -20, totalLoss: 60, rankNetDev: 1, rankLoss: 2, bandSize: 11, medianLoss: 55 },
      { monthKey: '2026-04', monthLabel: 'April 2026', targetSales: 1050, nominalDeviasi: -30, totalLoss: 70, rankNetDev: 3, rankLoss: 1, bandSize: 10, medianLoss: 50 },
    ]);
    expect(s.monthsTracked).toBe(3);
    expect(s.avgRankNetDev).toBeCloseTo(2, 10);
    expect(s.avgRankLoss).toBeCloseTo(4 / 3, 10);
    expect(s.monthsWorstNetDev).toBe(1);
    expect(s.monthsWorstLoss).toBe(2);
    expect(s.lastMonthLabel).toBe('April 2026');
    expect(s.lastRankNetDev).toBe(3);
    expect(s.lastBandSize).toBe(10);
  });
});

// ------------------------------------------------------------
// 4. queryOutletMonthlySeries
// ------------------------------------------------------------

describe('queryOutletMonthlySeries', () => {
  it('pins the same weekLabel, bounds the window inclusively, caps to 12, and maps rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      rawRow({ monthKey: '2026-08', monthLabel: 'Agustus 2026', sales: BigInt(1000), nominalDeviasi: BigInt(-200), devBom: 0.23 }),
    ]);
    const { rows, total } = await queryOutletMonthlySeries('1357.TJPPLU', 'WEEK 4', '2026-08', TOL, HI_LOSS);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    expect(sql).toContain('ir."weekLabel" =');
    expect(sql).toContain('<=');
    expect(sql).toContain('LIMIT');
    expect(sql).toContain(String(OUTLET_MONTHLY_SERIES_WINDOW_MONTHS));
    expect(sql).toContain('"OutletPeriodSales"');
    // Excel loss/surplus convention from nominalLossSurplus (same as peer-comparison).
    expect(sql).toContain('nominalLossSurplus" < 0');

    expect(rows).toHaveLength(1);
    expect(rows[0].monthLabel).toBe('Agustus 2026');
    expect(rows[0].sales).toBe(1000);
    expect(rows[0].abnormal).toBe(true); // devBom 0.23 > 0.05
    expect(total.months).toBe(1);
    expect(total.abnormalCount).toBe(1);
  });

  it('fires the merged set_config round-trip via withStatementTimeout', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryOutletMonthlySeries('X', 'WEEK 4', null, TOL, HI_LOSS);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(deepText(mockExecuteRaw.mock.calls[0])).toContain('set_config');
  });

  it('empty result → zeroed total, no throw', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const { rows, total } = await queryOutletMonthlySeries('X', 'WEEK 4', '2026-08', TOL, HI_LOSS);
    expect(rows).toEqual([]);
    expect(total.months).toBe(0);
  });
});

// ------------------------------------------------------------
// 5. queryPeerTrackRecord
// ------------------------------------------------------------

describe('queryPeerTrackRecord', () => {
  function trRow(overrides: Partial<Record<string, number | bigint | string>> = {}) {
    return {
      monthKey: '2026-08',
      monthLabel: 'Agustus 2026',
      targetSales: BigInt(1000),
      nominalDeviasi: BigInt(-91_500_000),
      totalLoss: BigInt(91_500_000),
      rankNetDev: BigInt(2),
      rankLoss: BigInt(1),
      bandSize: BigInt(11),
      medianLoss: BigInt(60_000_000),
      ...overrides,
    };
  }

  it('ranks via RANK() windows, builds the ±10% dynamic band, and maps bigint ranks', async () => {
    mockQueryRaw.mockResolvedValueOnce([trRow()]);
    const { rows, summary } = await queryPeerTrackRecord('1357.TJPPLU', 'WEEK 4', '2026-08', null);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    expect(sql).toContain('RANK() OVER');
    expect(sql).toContain('0.1');
    expect(sql).toContain('ROW_NUMBER()');
    expect(sql).toContain('ir."weekLabel" =');

    expect(rows).toHaveLength(1);
    expect(rows[0].rankNetDev).toBe(2);
    expect(rows[0].rankLoss).toBe(1);
    expect(rows[0].bandSize).toBe(11);
    expect(summary.monthsTracked).toBe(1);
    expect(summary.monthsWorstLoss).toBe(1);
    expect(summary.lastRankNetDev).toBe(2);
  });

  it('includes the kelompok peer-scope predicate only when kelompok is passed', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryPeerTrackRecord('X', 'WEEK 4', '2026-08', 'BDG');
    const sqlScoped = deepText(mockQueryRaw.mock.calls[0]);
    expect(sqlScoped).toContain('SUBSTRING(o.code FROM');

    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryPeerTrackRecord('X', 'WEEK 4', '2026-08', null);
    const sqlUnscoped = deepText(mockQueryRaw.mock.calls[0]);
    expect(sqlUnscoped).not.toContain('SUBSTRING(o.code FROM');
  });

  it('empty band → empty records + null summary fields', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const { rows, summary } = await queryPeerTrackRecord('X', 'WEEK 4', '2026-08', null);
    expect(rows).toEqual([]);
    expect(summary.monthsTracked).toBe(0);
    expect(summary.lastMonthLabel).toBeNull();
  });
});
