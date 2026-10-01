// Tests for src/lib/queries/waste/waste-series.ts (DEEP-WASTE-1/2 —
// "Profil Waste Outlet" network series + "TJPPLU Fokus" peer z-score).
//
// Covers:
//  1. buildWasteMonthlyRows (pure) — ratios (wasteToSales guarded on
//     sales=0, shares guarded on loss=0), spike flag coercion, bigint
//     coercion, DQ passthrough.
//  2. buildWasteOutlets (pure) — window aggregation per outlet, the 4
//     network detectors (zeroWasteBigLoss / underRecording /
//     residualDominant boundaries — BUGHUNT-R1: the first two are
//     PER-MONTH grain, never window sums), competition rank with ties.
//  3. buildWasteKpis (pure) — network totals + anomaly counts + spike
//     cells; guard when population is empty.
//  4. summarizeWastePeerZScore (pure) — avg z over defined z only,
//     worst-month counts, salesGrowth, paradox flag, last-month fields.
//  5. queryWasteNetwork — ONE merged set_config round-trip, SQL pins the
//     SAME weekLabel, applies monthKey <= currentMonthKey (inclusive),
//     caps to 12 months, aggregates ΣABS nominal waste/susut/trial +
//     residualNominal + Excel loss/surplus convention, computes the
//     2σ spike window (STDDEV_SAMP), and returns months/monthly/outlets/kpis.
//  6. queryWastePeerZScore — ±10% dynamic band + RANK() DESC + z-score
//     guarded on bandSize >= 3 AND std > 0; kelompok predicate appears
//     only when passed; bigint mapping.
//
// Mock @/lib/db (same vi.hoisted pattern as outlet-monthly-series.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WASTE_WINDOW_MONTHS,
  WASTE_UNDER_RECORD_PCT,
  WASTE_RESIDUAL_DOMINANT_PCT,
  WASTE_SPIKE_MIN_MONTHS,
  WASTE_ZSCORE_MIN_BAND,
  buildWasteMonthlyRows,
  buildWasteOutlets,
  buildWasteKpis,
  summarizeWastePeerZScore,
  queryWasteNetwork,
  queryWastePeerZScore,
} from '@/lib/queries/waste/waste-series';

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
 * Full-text extractor for a tagged-template $queryRaw mock call (nested
 * Prisma.Sql fragments render as [object Object] otherwise) — same helper
 * as outlet-monthly-series.test.ts.
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

const HI_LOSS = 50_000_000;

function rawRow(overrides: Partial<Record<string, number | bigint | string | boolean>> = {}) {
  return {
    outletCode: '1357.TJPPLU',
    outletName: 'TJPPLU',
    area: 'JAKARTA 1',
    monthKey: '2026-08',
    monthLabel: 'Agustus 2026',
    sales: 1_000_000,
    waste: 20_000,
    susut: 5_000,
    trial: 2_000,
    residual: 80_000,
    totalLoss: 100_000,
    totalSurplus: 10_000,
    spike: 0,
    dqError: false,
    dqErrorCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
});

// ------------------------------------------------------------
// 1. buildWasteMonthlyRows
// ------------------------------------------------------------

describe('buildWasteMonthlyRows', () => {
  it('computes wasteToSales and loss shares with divide-by-zero guards', () => {
    const rows = buildWasteMonthlyRows([
      rawRow({ sales: 1_000_000, waste: 20_000, totalLoss: 100_000, residual: 80_000 }),
      rawRow({ monthKey: '2026-07', sales: 0, waste: 20_000, totalLoss: 0, residual: 0 }),
    ]);
    expect(rows[0].wasteToSales).toBeCloseTo(0.02, 10);
    expect(rows[0].wasteShareOfLoss).toBeCloseTo(0.2, 10);
    expect(rows[0].residualShare).toBeCloseTo(0.8, 10);
    expect(rows[1].wasteToSales).toBe(0);
    expect(rows[1].wasteShareOfLoss).toBe(0);
    expect(rows[1].residualShare).toBe(0);
  });

  it('maps spike 1 → true and coerces bigint aggregates', () => {
    const rows = buildWasteMonthlyRows([
      rawRow({
        spike: 1,
        sales: BigInt(1_000_000),
        waste: BigInt(20_000),
        susut: BigInt(5_000),
        trial: BigInt(2_000),
        residual: BigInt(80_000),
        totalLoss: BigInt(100_000),
        totalSurplus: BigInt(10_000),
        dqErrorCount: BigInt(3),
      }),
    ]);
    expect(rows[0].spike).toBe(true);
    expect(rows[0].sales).toBe(1_000_000);
    expect(rows[0].waste).toBe(20_000);
    expect(rows[0].residual).toBe(80_000);
    expect(rows[0].dqErrorCount).toBe(3);
  });

  it('passes DQ flags through', () => {
    const rows = buildWasteMonthlyRows([rawRow({ dqError: true, dqErrorCount: 2 })]);
    expect(rows[0].dqError).toBe(true);
    expect(rows[0].dqErrorCount).toBe(2);
  });
});

// ------------------------------------------------------------
// 2. buildWasteOutlets
// ------------------------------------------------------------

describe('buildWasteOutlets', () => {
  it('aggregates the window per outlet and ranks waste/sales DESC with ties', () => {
    const monthly = buildWasteMonthlyRows([
      rawRow({ outletCode: 'A', monthKey: '2026-07', sales: 1_000, waste: 50, totalLoss: 100, residual: 10 }),
      rawRow({ outletCode: 'A', monthKey: '2026-08', sales: 1_000, waste: 50, totalLoss: 100, residual: 10 }),
      rawRow({ outletCode: 'B', monthKey: '2026-08', sales: 1_000, waste: 20, totalLoss: 100, residual: 10 }),
      rawRow({ outletCode: 'C', monthKey: '2026-08', sales: 1_000, waste: 50, totalLoss: 100, residual: 10 }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    expect(outlets).toHaveLength(3);
    const a = outlets.find((o) => o.outletCode === 'A')!;
    expect(a.months).toBe(2);
    expect(a.sales).toBe(2_000);
    expect(a.waste).toBe(100);
    expect(a.wasteToSales).toBeCloseTo(0.05, 10);
    // A and C tie on wasteToSales (0.05) → both rank 1; B ranks 3.
    const c = outlets.find((o) => o.outletCode === 'C')!;
    const b = outlets.find((o) => o.outletCode === 'B')!;
    expect(a.rankWasteToSales).toBe(1);
    expect(c.rankWasteToSales).toBe(1);
    expect(b.rankWasteToSales).toBe(3);
  });

  it('flags zeroWasteBigLoss at the boundary (waste ≤ 1 AND loss > threshold)', () => {
    const monthly = buildWasteMonthlyRows([
      rawRow({ outletCode: 'A', waste: 0, totalLoss: HI_LOSS + 1 }),
      rawRow({ outletCode: 'B', waste: 1, totalLoss: HI_LOSS + 1 }),
      rawRow({ outletCode: 'C', waste: 2, totalLoss: HI_LOSS + 1 }),
      rawRow({ outletCode: 'D', waste: 0, totalLoss: HI_LOSS }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    const get = (code: string) => outlets.find((o) => o.outletCode === code)!.zeroWasteBigLoss;
    expect(get('A')).toBe(true);
    expect(get('B')).toBe(true);   // waste = 1 → still ≈ 0
    expect(get('C')).toBe(false);  // waste = 2 → above
    expect(get('D')).toBe(false);  // loss exactly at threshold → not above
  });

  it('BUGHUNT-R1 FIX 3: zeroWasteBigLoss is PER-MONTH, not the window sum', () => {
    // 9 months × loss 5.6jt = 50.4jt window total > Rp 50jt threshold, but
    // NO single month exceeds it — the old window-sum grain flagged this
    // outlet KRITIS while every per-month consumer of the same threshold
    // (outlet-recurrence, HIGH_LOSS_NOMINAL) would not.
    const steadyLossMonths = Array.from({ length: 9 }, (_, i) =>
      rawRow({ outletCode: 'WINDOW', monthKey: `2026-0${i + 1}`, waste: 0, totalLoss: 5_600_000 }),
    );
    // One month over the threshold with zero waste → flags (any-month).
    const oneBadMonth = [
      rawRow({ outletCode: 'ANY', monthKey: '2026-07', waste: 0, totalLoss: HI_LOSS + 1 }),
      rawRow({ outletCode: 'ANY', monthKey: '2026-08', waste: 500, totalLoss: 10_000_000 }),
    ];
    const outlets = buildWasteOutlets(
      buildWasteMonthlyRows([...steadyLossMonths, ...oneBadMonth]),
      HI_LOSS,
    );
    expect(outlets.find((o) => o.outletCode === 'WINDOW')!.zeroWasteBigLoss).toBe(false);
    expect(outlets.find((o) => o.outletCode === 'ANY')!.zeroWasteBigLoss).toBe(true);
  });

  it('flags underRecording (≥ 2 months EACH with sales > 0 and ratio < 0.1%)', () => {
    const monthly = buildWasteMonthlyRows([
      rawRow({ outletCode: 'A', monthKey: '2026-07', sales: 100_000, waste: 10 }),  // 0.01%, 2 months
      rawRow({ outletCode: 'A', monthKey: '2026-08', sales: 100_000, waste: 10 }),
      rawRow({ outletCode: 'B', monthKey: '2026-08', sales: 100_000, waste: 10 }),  // 1 month only
      rawRow({ outletCode: 'C', monthKey: '2026-07', sales: 100_000, waste: 500 }), // 0.5% — above
      rawRow({ outletCode: 'C', monthKey: '2026-08', sales: 100_000, waste: 500 }),
      rawRow({ outletCode: 'D', monthKey: '2026-07', sales: 0, waste: 0 }),          // no sales
      rawRow({ outletCode: 'D', monthKey: '2026-08', sales: 0, waste: 0 }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    const get = (code: string) => outlets.find((o) => o.outletCode === code)!.underRecording;
    expect(get('A')).toBe(true);
    expect(get('B')).toBe(false);
    expect(get('C')).toBe(false);
    expect(get('D')).toBe(false);
    void WASTE_UNDER_RECORD_PCT;
  });

  it('BUGHUNT-R1 FIX 4: aggregate-ratio under-recording no longer flags (needs ≥ 2 qualifying MONTHS)', () => {
    // One clean month + one 0.15% month: the WINDOW AGGREGATE ratio is
    // 160/200.000 = 0.08% < 0.1% (the old detector flagged this), but only
    // ONE month is individually under 0.1% — the "≥ 2 months each" spec
    // (and the record-grain WASTE_SALES_UNDER_RECORD rule) says no flag.
    const monthly = buildWasteMonthlyRows([
      rawRow({ outletCode: 'AGG', monthKey: '2026-07', sales: 100_000, waste: 10 }),   // 0.01% ✓
      rawRow({ outletCode: 'AGG', monthKey: '2026-08', sales: 100_000, waste: 150 }), // 0.15% ✗
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    const agg = outlets.find((o) => o.outletCode === 'AGG')!;
    expect(agg.underRecording).toBe(false);
    // Both months individually under → flags.
    const both = buildWasteOutlets(buildWasteMonthlyRows([
      rawRow({ outletCode: 'AGG2', monthKey: '2026-07', sales: 100_000, waste: 10 }),
      rawRow({ outletCode: 'AGG2', monthKey: '2026-08', sales: 100_000, waste: 50 }),
    ]), HI_LOSS);
    expect(both.find((o) => o.outletCode === 'AGG2')!.underRecording).toBe(true);
  });

  it('flags residualDominant (loss-side residual > 80% loss AND waste < 10% of loss)', () => {
    const monthly = buildWasteMonthlyRows([
      // residual 90 / loss 100 = 90% > 80%; waste 5/100 = 5% < 10% → fires
      rawRow({ outletCode: 'A', waste: 5, residual: 90, totalLoss: 100 }),
      // residual 85% but waste 12% → not dominant
      rawRow({ outletCode: 'B', waste: 12, residual: 85, totalLoss: 100 }),
      // waste 5% but residual 79% → not dominant
      rawRow({ outletCode: 'C', waste: 5, residual: 79, totalLoss: 100 }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    expect(outlets.find((o) => o.outletCode === 'A')!.residualDominant).toBe(true);
    expect(outlets.find((o) => o.outletCode === 'B')!.residualDominant).toBe(false);
    expect(outlets.find((o) => o.outletCode === 'C')!.residualDominant).toBe(false);
    void WASTE_RESIDUAL_DOMINANT_PCT;
  });

  it('BUGHUNT-R1 FIX 5: loss-side residual keeps residualShare ≤ 1 and residualDominant ⊅ wasteShareOfLoss < 10%', () => {
    // Fixture mirrors a mixed month AFTER the SQL fix: loss-side records
    // carry residual 60 of the 100 loss, while the (formerly two-sided)
    // residual also counted 80 of "residual" sitting on SURPLUS records —
    // exactly the shape that produced residualShare > 1 (median 2.34 live)
    // and made the > 0.8 guard vacuous.
    const monthly = buildWasteMonthlyRows([
      // LOSS-side residual only 60/100 = 60% → NOT dominant even though
      // wasteShareOfLoss (5%) < 10% — the old two-sided 140/100 = 140%
      // flagged it. Proves the two predicates are no longer equivalent.
      rawRow({ outletCode: 'MIX', waste: 5, residual: 60, totalLoss: 100, totalSurplus: 80 }),
      // A genuinely residual-dominated outlet still flags with share ≤ 1.
      rawRow({ outletCode: 'RD', waste: 5, residual: 95, totalLoss: 100, totalSurplus: 0 }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    const mix = outlets.find((o) => o.outletCode === 'MIX')!;
    const rd = outlets.find((o) => o.outletCode === 'RD')!;
    expect(mix.residualShare).toBeCloseTo(0.6, 10);
    expect(mix.residualShare).toBeLessThanOrEqual(1);
    expect(mix.wasteShareOfLoss).toBeCloseTo(0.05, 10);
    expect(mix.residualDominant).toBe(false); // waste<10% of loss but residual only 60% of it
    expect(rd.residualShare).toBeCloseTo(0.95, 10);
    expect(rd.residualDominant).toBe(true);
  });

  it('counts spikeMonths from the monthly rows', () => {
    const monthly = buildWasteMonthlyRows([
      rawRow({ outletCode: 'A', monthKey: '2026-07', spike: 1 }),
      rawRow({ outletCode: 'A', monthKey: '2026-08', spike: 0 }),
      rawRow({ outletCode: 'A', monthKey: '2026-06', spike: 1 }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    expect(outlets[0].spikeMonths).toBe(2);
  });
});

// ------------------------------------------------------------
// 3. buildWasteKpis
// ------------------------------------------------------------

describe('buildWasteKpis', () => {
  it('computes network totals + anomaly counts + spike cells', () => {
    const monthly = buildWasteMonthlyRows([
      rawRow({ outletCode: 'A', monthKey: '2026-07', sales: 1_000_000, waste: 10_000, susut: 1_000, trial: 500, residual: 5_000, totalLoss: 20_000, totalSurplus: 1_000, spike: 1 }),
      rawRow({ outletCode: 'A', monthKey: '2026-08', sales: 1_000_000, waste: 10_000, susut: 1_000, trial: 500, residual: 5_000, totalLoss: 20_000, totalSurplus: 1_000, spike: 0 }),
      rawRow({ outletCode: 'B', monthKey: '2026-08', sales: 500_000, waste: 0, susut: 0, trial: 0, residual: 0, totalLoss: HI_LOSS + 1, totalSurplus: 0, spike: 1 }),
    ]);
    const outlets = buildWasteOutlets(monthly, HI_LOSS);
    const kpis = buildWasteKpis(monthly, outlets);
    expect(kpis.outlets).toBe(2);
    expect(kpis.months).toBe(2);
    expect(kpis.sales).toBe(2_500_000);
    expect(kpis.waste).toBe(20_000);
    expect(kpis.susut).toBe(2_000);
    expect(kpis.trial).toBe(1_000);
    expect(kpis.residual).toBe(10_000);
    expect(kpis.wasteToSales).toBeCloseTo(20_000 / 2_500_000, 10);
    expect(kpis.zeroWasteBigLossOutlets).toBe(1);
    expect(kpis.spikeCells).toBe(2);
  });

  it('empty network → zeroed KPIs', () => {
    const kpis = buildWasteKpis([], []);
    expect(kpis.outlets).toBe(0);
    expect(kpis.months).toBe(0);
    expect(kpis.wasteToSales).toBe(0);
    expect(kpis.spikeCells).toBe(0);
  });
});

// ------------------------------------------------------------
// 4. summarizeWastePeerZScore
// ------------------------------------------------------------

describe('summarizeWastePeerZScore', () => {
  it('empty input → null summary fields', () => {
    const s = summarizeWastePeerZScore([]);
    expect(s.monthsTracked).toBe(0);
    expect(s.avgZ).toBeNull();
    expect(s.salesGrowth).toBeNull();
    expect(s.paradox).toBe(false);
    expect(s.lastMonthLabel).toBeNull();
  });

  it('averages z over defined z only, counts extremes, computes salesGrowth', () => {
    const s = summarizeWastePeerZScore([
      { monthKey: '2026-02', monthLabel: 'Februari 2026', targetSales: 100, waste: 2, wasteToSales: 0.02, rankWasteToSales: 1, bandSize: 9, bandMean: 0.01, bandStd: 0.005, zScore: 2.5 },
      { monthKey: '2026-03', monthLabel: 'Maret 2026', targetSales: 150, waste: 1.5, wasteToSales: 0.01, rankWasteToSales: 3, bandSize: 9, bandMean: 0.01, bandStd: 0.005, zScore: 0 },
      { monthKey: '2026-04', monthLabel: 'April 2026', targetSales: 200, waste: 3, wasteToSales: 0.015, rankWasteToSales: 1, bandSize: 8, bandMean: 0.01, bandStd: 0.005, zScore: 1.5 },
      { monthKey: '2026-05', monthLabel: 'Mei 2026', targetSales: 250, waste: 2.5, wasteToSales: 0.01, rankWasteToSales: 2, bandSize: 2, bandMean: 0.01, bandStd: 0, zScore: null },
    ]);
    expect(s.monthsTracked).toBe(4);
    expect(s.avgZ).toBeCloseTo(4 / 3, 10); // (2.5 + 0 + 1.5) / 3 — null z excluded
    expect(s.monthsZAbove1).toBe(2);      // 2.5 and 1.5 (strictly > 1)
    expect(s.monthsZAbove2).toBe(1);      // 2.5 only
    expect(s.monthsHighestWaste).toBe(2);
    expect(s.salesGrowth).toBeCloseTo(1.5, 10); // 250/100 − 1
    expect(s.lastMonthLabel).toBe('Mei 2026');
    expect(s.lastZScore).toBeNull();
    expect(s.lastBandSize).toBe(2);
  });

  it('paradox = sales grew AND avg z > 1', () => {
    const base = { monthKey: '2026-02', monthLabel: 'Februari 2026', waste: 1, wasteToSales: 0.02, rankWasteToSales: 1, bandMean: 0.01, bandStd: 0.005, bandSize: 5 };
    const paradox = summarizeWastePeerZScore([
      { ...base, targetSales: 100, zScore: 2 },
      { ...base, monthKey: '2026-08', monthLabel: 'Agustus 2026', targetSales: 300, zScore: 2 },
    ]);
    expect(paradox.salesGrowth).toBeCloseTo(2, 10);
    expect(paradox.avgZ).toBe(2);
    expect(paradox.paradox).toBe(true);

    const noGrowth = summarizeWastePeerZScore([
      { ...base, targetSales: 100, zScore: 2 },
      { ...base, monthKey: '2026-08', monthLabel: 'Agustus 2026', targetSales: 90, zScore: 2 },
    ]);
    expect(noGrowth.paradox).toBe(false);

    const growthButCalm = summarizeWastePeerZScore([
      { ...base, targetSales: 100, zScore: 0.5 },
      { ...base, monthKey: '2026-08', monthLabel: 'Agustus 2026', targetSales: 300, zScore: 0.5 },
    ]);
    expect(growthButCalm.paradox).toBe(false);
  });
});

// ------------------------------------------------------------
// 5. queryWasteNetwork
// ------------------------------------------------------------

describe('queryWasteNetwork', () => {
  it('pins the same weekLabel, bounds the window inclusively, caps to 12, aggregates waste components + 2σ spike', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      rawRow({ sales: BigInt(1_000_000), waste: BigInt(20_000), residual: BigInt(80_000), spike: 1 }),
    ]);
    const result = await queryWasteNetwork('WEEK 4', '2026-08', {}, HI_LOSS);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    expect(sql).toContain('ir."weekLabel" =');
    expect(sql).toContain('<=');
    expect(sql).toContain(String(WASTE_WINDOW_MONTHS));
    expect(sql).toContain('ABS(ir."nominalWaste")');
    expect(sql).toContain('ABS(ir."nominalSusut")');
    expect(sql).toContain('ABS(ir."nominalTrial")');
    expect(sql).toContain('ABS(ir."residualNominal")');
    expect(sql).toContain('nominalLossSurplus" < 0');
    expect(sql).toContain('"OutletPeriodSales"');
    expect(sql).toContain('STDDEV_SAMP("wasteToSales")');
    expect(sql).toContain(String(WASTE_SPIKE_MIN_MONTHS));
    expect(sql).toContain('BOOL_OR(sf."dqStatus" = \'ERROR\')');
    // BUGHUNT-R1 FIX 5: the residual aggregate is loss-side (CASE-guarded).
    expect(sql).toContain('CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END');
    // BUGHUNT-R1 FIX 7: sales=0 months emit NULL ratios and are excluded
    // from the spike baseline count (COUNT over the non-NULL ratio only).
    expect(sql).toContain('CASE WHEN mr.sales > 0 THEN mr.waste / mr.sales END');
    expect(sql).toContain('COUNT("wasteToSales")');
    expect(sql).not.toContain('COUNT(*) as n');

    expect(result.monthly).toHaveLength(1);
    expect(result.monthly[0].waste).toBe(20_000);
    expect(result.monthly[0].spike).toBe(true);
    expect(result.outlets).toHaveLength(1);
    expect(result.outlets[0].residualShare).toBeCloseTo(0.8, 10);
    expect(result.kpis.outlets).toBe(1);
    expect(result.months).toHaveLength(1);
    expect(result.months[0].monthKey).toBe('2026-08');
  });

  it('applies the area filter fragment when provided', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWasteNetwork('WEEK 4', '2026-08', { area: 'JAKARTA 1' }, HI_LOSS);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    expect(sql).toContain('ir.area =');
  });

  it('fires the merged set_config round-trip via withStatementTimeout', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWasteNetwork('WEEK 4', null, {}, HI_LOSS);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(deepText(mockExecuteRaw.mock.calls[0])).toContain('set_config');
  });

  it('FIX (AUDIT-B M3): merges susutRatioMonths (the spike baseline n) onto the outlet rows — the field reaches the API edge', async () => {
    // Wiring test for the transparency field buildSusutSpike has ALWAYS
    // computed (module header decision 3) but the query-edge merge used
    // to drop: pre-fix, 0/344 live outlet rows carried it. Fixture = the
    // sibling waste-fingerprint test's spike shape: one outlet, 9 months
    // with sales > 0 (≥ 3 so the spike baseline forms), susut spiking on
    // the last month (8 × 0.01 + 0.30 → mean+2σ crossed exactly once).
    mockQueryRaw.mockResolvedValueOnce(
      Array.from({ length: 9 }, (_, i) => ({
        outletCode: '1357.TJPPLU',
        outletName: 'TJPPLU',
        area: 'JAKARTA 1',
        monthKey: `2026-0${i + 1}`,
        monthLabel: `Bulan ${i + 1}`,
        sales: 1_000_000,
        waste: 20_000,
        susut: i === 8 ? 300_000 : 10_000,
        trial: 2_000,
        residual: 80_000,
        totalLoss: 100_000,
        totalSurplus: 10_000,
        spike: 0,
        dqError: false,
        dqErrorCount: 0,
      })),
    );
    const result = await queryWasteNetwork('WEEK 4', '2026-08', {}, HI_LOSS);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(result.outlets).toHaveLength(1);
    // Both W11 spike fields now flow: the count AND the baseline n
    // ("dari 9 bulan ber-sales" — the tooltip's transparency number).
    expect(result.outlets[0].susutSpikeMonths).toBe(1);
    expect(result.outlets[0].susutRatioMonths).toBe(9);
    // Base fields keep their exact values (additive merge only).
    expect(result.outlets[0].outletCode).toBe('1357.TJPPLU');
    expect(result.outlets[0].susut).toBe(380_000);
  });

  it('empty result → zeroed kpis, no throw', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteNetwork('WEEK 4', '2026-08', {}, HI_LOSS);
    expect(result.monthly).toEqual([]);
    expect(result.outlets).toEqual([]);
    expect(result.kpis.outlets).toBe(0);
    expect(result.months).toEqual([]);
  });
});

// ------------------------------------------------------------
// 6. queryWastePeerZScore
// ------------------------------------------------------------

describe('queryWastePeerZScore', () => {
  function zRow(overrides: Partial<Record<string, number | bigint | string | null>> = {}) {
    return {
      monthKey: '2026-08',
      monthLabel: 'Agustus 2026',
      targetSales: BigInt(1_000_000),
      waste: BigInt(20_000),
      wasteToSales: 0.02,
      rankWasteToSales: BigInt(1),
      bandSize: BigInt(11),
      bandMean: 0.01,
      bandStd: 0.005,
      zScore: 2,
      ...overrides,
    };
  }

  it('builds the ±10% dynamic band, ranks waste/sales DESC, guards z on bandSize + std', async () => {
    mockQueryRaw.mockResolvedValueOnce([zRow()]);
    const { rows, summary } = await queryWastePeerZScore('1357.TJPPLU', 'WEEK 4', '2026-08', null);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = deepText(mockQueryRaw.mock.calls[0]);
    expect(sql).toContain('0.1');
    expect(sql).toContain('RANK() OVER');
    expect(sql).toContain('STDDEV_SAMP("wasteToSales")');
    expect(sql).toContain(String(WASTE_ZSCORE_MIN_BAND));
    expect(sql).toContain('ir."weekLabel" =');

    expect(rows).toHaveLength(1);
    expect(rows[0].rankWasteToSales).toBe(1);
    expect(rows[0].bandSize).toBe(11);
    expect(rows[0].zScore).toBe(2);
    expect(summary.monthsTracked).toBe(1);
    expect(summary.monthsHighestWaste).toBe(1);
  });

  it('maps zScore null (degenerate band) to null', async () => {
    mockQueryRaw.mockResolvedValueOnce([zRow({ bandSize: BigInt(2), bandStd: 0, zScore: null })]);
    const { rows, summary } = await queryWastePeerZScore('X', 'WEEK 4', '2026-08', null);
    expect(rows[0].zScore).toBeNull();
    expect(summary.avgZ).toBeNull();
    expect(summary.monthsZAbove1).toBe(0);
  });

  it('includes the kelompok peer-scope predicate only when kelompok is passed', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWastePeerZScore('X', 'WEEK 4', '2026-08', 'TJP');
    const sqlScoped = deepText(mockQueryRaw.mock.calls[0]);
    expect(sqlScoped).toContain('SUBSTRING(o.code FROM');

    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWastePeerZScore('X', 'WEEK 4', '2026-08', null);
    const sqlUnscoped = deepText(mockQueryRaw.mock.calls[0]);
    expect(sqlUnscoped).not.toContain('SUBSTRING(o.code FROM');
  });

  it('empty band → empty records + null summary fields', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const { rows, summary } = await queryWastePeerZScore('X', 'WEEK 4', '2026-08', null);
    expect(rows).toEqual([]);
    expect(summary.monthsTracked).toBe(0);
    expect(summary.lastMonthLabel).toBeNull();
  });
});
