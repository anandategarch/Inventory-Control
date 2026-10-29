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
//  4. queryOutletMonthlySeries — PERF-FILTER1 (B): now derives from the
//     SHARED cached band scan ('q-peer-band-scan'). The scan SQL pins the
//     SAME weekLabel, applies monthKey <= currentMonthKey (inclusive),
//     caps to the 24-month union window (PEER_BAND_SCAN_WINDOW_MONTHS —
//     2× the 12-month consumers), and is OUTLET-INDEPENDENT (no target
//     code in the SQL); the series rows are computed from the scan
//     fixture through the unchanged pure builders.
//  5. queryPeerTrackRecord — same shared scan; the ±10% band, RANK()
//     ties, bandSize + median are now COMPUTED (peer-band-scan helpers)
//     — kelompok scopes the band at compute time (the SQL predicate is
//     gone), months without positive target sales are absent, and the
//     summary wiring is unchanged.
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
import { PEER_BAND_SCAN_WINDOW_MONTHS } from '@/lib/queries/outlets/peer-band-scan';

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

  it('BUGHUNT-R1 FIX 8: nulls MoM across a data gap (non-adjacent monthKeys)', () => {
    // April has no data — May must NOT report a "MoM" against March (the
    // old consecutive-row comparison bridged the gap, presenting a
    // 2-month jump as a 1-month growth rate).
    const rows = buildMonthlySeriesRows([
      rawRow({ monthKey: '2026-03', monthLabel: 'Maret 2026', sales: 1000 }),
      rawRow({ monthKey: '2026-05', monthLabel: 'Mei 2026', sales: 1250 }),
      rawRow({ monthKey: '2026-06', monthLabel: 'Juni 2026', sales: 1500 }),
    ], TOL, HI_LOSS);
    expect(rows[0].salesMoM).toBeNull();     // first row
    expect(rows[1].salesMoM).toBeNull();     // gap 2026-03 → 2026-05 (> 1 month)
    expect(rows[2].salesMoM).toBeCloseTo(0.2, 10); // adjacent 2026-05 → 2026-06
  });

  it('BUGHUNT-R1 FIX 8: gap across a year boundary (2026-12 → 2027-01) is adjacent', () => {
    const rows = buildMonthlySeriesRows([
      rawRow({ monthKey: '2026-12', sales: 1000 }),
      rawRow({ monthKey: '2027-01', sales: 1100 }),
    ], TOL, HI_LOSS);
    expect(rows[1].salesMoM).toBeCloseTo(0.1, 10);
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
// 4. queryOutletMonthlySeries (PERF-FILTER1 B — shared-scan based)
// ------------------------------------------------------------

describe('queryOutletMonthlySeries', () => {
  /** Shared-scan row fixture (the peer-band-scan shape). */
  function scanRow(overrides: Partial<Record<string, number | bigint | string>> = {}) {
    return {
      monthKey: '2026-08',
      monthLabel: 'Agustus 2026',
      outletCode: '1357.TJPPLU',
      nominalDeviasi: -200,
      totalLoss: 300,
      totalSurplus: 100,
      waste: 50,
      absQtyDeviasi: 115,
      absQtyBom: 500,
      sales: 1000,
      ...overrides,
    };
  }

  it('runs the SHARED scan (outlet-independent) and derives the series rows from it', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      scanRow({ nominalDeviasi: BigInt(-200), absQtyDeviasi: BigInt(115), absQtyBom: BigInt(500), sales: BigInt(1000) }),
    ]);
    const { rows, total } = await queryOutletMonthlySeries('1357.TJPPLU', 'WEEK 4', '2026-08', TOL, HI_LOSS);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    expect(sql).toContain('ir."weekLabel" =');
    expect(sql).toContain('WEEK 4');
    expect(sql).toContain('2026-08'); // monthKey upper bound (inclusive window)
    expect(sql).toContain('<=');      // monthWindowBound
    expect(sql).toContain('"OutletPeriodSales"');
    // Excel loss/surplus convention from nominalLossSurplus (same as peer-comparison).
    expect(sql).toContain('nominalLossSurplus" < 0');
    // PERF-FILTER1 B + PERF-FILTER3: the scan caps the UNION window at
    // PEER_BAND_SCAN_WINDOW_MONTHS (now the 3-month dashboard lookback) and
    // NEVER references the target outlet — one row serves every outlet.
    expect(sql).toContain(String(PEER_BAND_SCAN_WINDOW_MONTHS));
    expect(sql).not.toContain('1357.TJPPLU');

    expect(rows).toHaveLength(1);
    expect(rows[0].monthLabel).toBe('Agustus 2026');
    expect(rows[0].sales).toBe(1000);
    expect(rows[0].qtyBom).toBe(500);
    expect(rows[0].devBom).toBeCloseTo(115 / 500, 10); // ΣABS(qtyDeviasi)/ΣABS(qtyBom)
    expect(rows[0].abnormal).toBe(true); // devBom 0.23 > 0.05
    expect(total.months).toBe(1);
    expect(total.abnormalCount).toBe(1);
  });

  it('caps the TARGET window to the last DASHBOARD_LOOKBACK_MONTHS months from the shared scan', async () => {
    // 14 chronological months (2024-08 … 2025-09) of scan rows for the
    // outlet — only the chronologically LAST window may surface.
    // HIST-WINDOW-5 (29 Okt 2026): the consumer window is 5
    // (PERF-FILTER3 era: 3; pre-PERF-FILTER3: 12) — the scan itself also
    // fetches ≤5 months in production, but the slice must still cap
    // whatever the (cache-hit) scan row contains.
    const monthKeys = [
      '2024-08', '2024-09', '2024-10', '2024-11', '2024-12',
      '2025-01', '2025-02', '2025-03', '2025-04', '2025-05',
      '2025-06', '2025-07', '2025-08', '2025-09',
    ];
    const many = monthKeys.map((monthKey) => scanRow({ monthKey }));
    mockQueryRaw.mockResolvedValueOnce(many);
    const { rows } = await queryOutletMonthlySeries('1357.TJPPLU', 'WEEK 4', '2025-09', TOL, HI_LOSS);
    expect(rows.length).toBe(OUTLET_MONTHLY_SERIES_WINDOW_MONTHS);
    // ...and they are the CHRONOLOGICALLY LAST 5 (slice(-5) of ASC order).
    expect(rows[0].monthKey).toBe(monthKeys[9]);
    expect(rows[rows.length - 1].monthKey).toBe(monthKeys[13]);
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
// 5. queryPeerTrackRecord (PERF-FILTER1 B — computed from the scan)
// ------------------------------------------------------------

describe('queryPeerTrackRecord', () => {
  /** Band month fixture: target TJPPLU (sales 1000) + 3 in-band peers + 1 out-of-band. */
  function bandMonth() {
    const mk = (outletCode: string, sales: number, nd: number, loss: number) => ({
      monthKey: '2026-08', monthLabel: 'Agustus 2026', outletCode,
      nominalDeviasi: nd, totalLoss: loss, totalSurplus: 0, waste: 0,
      absQtyDeviasi: 0, absQtyBom: 0, sales,
    });
    return [
      mk('1357.TJPPLU', 1000, -100, 90),  // target
      mk('1030.BDGSET', 950, -50, 40),    // |950-1000| = 50 <= 100 ✓
      mk('1041.BDGUKU', 1050, -150, 95),  // |1050-1000| = 50 <= 100 ✓
      mk('1001.TLGTEU', 900, -20, 30),    // |900-1000| = 100 <= 100 ✓ (inclusive bound)
      mk('1375.TJSSEN', 500, -500, 500),  // |500-1000| = 500 > 100 ✗ (out of band)
    ];
  }

  it('builds the ±10% dynamic band, ranks (ties share a rank), and computes the band median', async () => {
    mockQueryRaw.mockResolvedValueOnce(bandMonth());
    const { rows, summary } = await queryPeerTrackRecord('1357.TJPPLU', 'WEEK 4', '2026-08', null);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    // PERF-FILTER1 B: the band math moved OUT of SQL — the scan is pure
    // aggregation (no RANK/window/±10% predicates left).
    expect(sql).toContain('ir."weekLabel" =');
    expect(sql).not.toContain('RANK() OVER');
    expect(sql).not.toContain('SUBSTRING(o.code FROM');

    expect(rows).toHaveLength(1);
    // rankNetDev ASC by nominalDeviasi: B(-150) 1st, target(-100) 2nd.
    expect(rows[0].rankNetDev).toBe(2);
    // rankLoss DESC by totalLoss: B(95) 1st, target(90) 2nd.
    expect(rows[0].rankLoss).toBe(2);
    // Band = target + BDGSET + BDGUKU + TLGTEU (TJSSEN excluded).
    expect(rows[0].bandSize).toBe(4);
    // Median of [30, 40, 90, 95] — AVG of middle two = 65.
    expect(rows[0].medianLoss).toBe(65);
    expect(rows[0].targetSales).toBe(1000);
    expect(rows[0].nominalDeviasi).toBe(-100);
    expect(summary.monthsTracked).toBe(1);
    expect(summary.lastRankNetDev).toBe(2);
  });

  it('RANK ties SHARE the rank (SQL RANK semantics, not ROW_NUMBER)', async () => {
    const mk = (outletCode: string, nd: number) => ({
      monthKey: '2026-08', monthLabel: 'Agustus 2026', outletCode,
      nominalDeviasi: nd, totalLoss: 10, totalSurplus: 0, waste: 0,
      absQtyDeviasi: 0, absQtyBom: 0, sales: 1000,
    });
    // target + one peer BOTH at -100 → both rankNetDev 1; the third (-50) ranks 3.
    mockQueryRaw.mockResolvedValueOnce([mk('1357.TJPPLU', -100), mk('1030.BDGSET', -100), mk('1041.BDGUKU', -50)]);
    const { rows } = await queryPeerTrackRecord('1357.TJPPLU', 'WEEK 4', '2026-08', null);
    expect(rows[0].rankNetDev).toBe(1);
  });

  it('kelompok scopes the PEER set at compute time — target always stays in scope', async () => {
    mockQueryRaw.mockResolvedValueOnce(bandMonth());
    const { rows } = await queryPeerTrackRecord('1357.TJPPLU', 'WEEK 4', '2026-08', 'BDG');
    // Peers: BDGSET + BDGUKU (kelompok BDG) + the target itself — TLGTEU
    // (kelompok TLG) is excluded even though it is inside the sales band.
    expect(rows[0].bandSize).toBe(3);
    // rankLoss over [40, 95, 90]: BDGUKU 1st, target 2nd.
    expect(rows[0].rankLoss).toBe(2);

    // Out-of-kelompok TARGET still gets ranked (always-in-scope rule):
    // TLGTEU (sales 900) + its BDG-scope peers within ±10% of 900 —
    // BDGSET (950 ✓), BDGUKU (1050 ✗ |1050−900| = 150 > 90) → band of 2.
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValueOnce(bandMonth());
    const { rows: rows2 } = await queryPeerTrackRecord('1001.TLGTEU', 'WEEK 4', '2026-08', 'BDG');
    expect(rows2).toHaveLength(1); // month present, target ranked
    expect(rows2[0].bandSize).toBe(2);
    // rankNetDev ASC: BDGSET (−50) 1st, TLGTEU (−20) 2nd.
    expect(rows2[0].rankNetDev).toBe(2);
  });

  it('months without positive target sales are absent (old target_sales inner-join semantics)', async () => {
    const mk = (monthKey: string, sales: number) => ({
      monthKey, monthLabel: monthKey, outletCode: '1357.TJPPLU',
      nominalDeviasi: -10, totalLoss: 5, totalSurplus: 0, waste: 0,
      absQtyDeviasi: 0, absQtyBom: 0, sales,
    });
    mockQueryRaw.mockResolvedValueOnce([
      mk('2026-07', 0),     // no sales → month DROPPED
      mk('2026-08', 1000),  // ranked
    ]);
    const { rows } = await queryPeerTrackRecord('1357.TJPPLU', 'WEEK 4', '2026-08', null);
    expect(rows).toHaveLength(1);
    expect(rows[0].monthKey).toBe('2026-08');
  });

  it('empty band → empty records + null summary fields', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const { rows, summary } = await queryPeerTrackRecord('X', 'WEEK 4', '2026-08', null);
    expect(rows).toEqual([]);
    expect(summary.monthsTracked).toBe(0);
    expect(summary.lastMonthLabel).toBeNull();
  });
});
