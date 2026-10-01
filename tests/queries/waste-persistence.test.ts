// Tests for src/lib/queries/waste/network/persistence.ts (W2 —
// "Kronis vs Episodik": outlet-level waste persistence).
//
// Covers:
//  1. fisherExact2x2 (pure) — known published/hand-verified tables:
//     Fisher 1935 tea tasting [[3,1],[1,3]] → 34/70; perfect diagonals
//     [[5,0],[0,5]] → 2/252 and [[4,0],[0,4]] → 2/70; the scipy docs
//     example [[8,2],[1,5]] → 400/11440; degenerate margins/empty
//     table → 1; NaN on negative/non-integer cells; row/column-swap
//     invariance; p ∈ [0,1]. All expected values independently
//     verified with exact BigInt arithmetic (sum-of-no-more-likely-
//     tables, the R fisher.test two-sided convention).
//  2. classifyWastePersistence (pure) — boundaries: 60% exactly
//     (inclusive ≥), 5 vs 6 active months (TERBATAS gate), KRONIS
//     dominates EPISODIK, TERBATAS dominates everything.
//  3. buildWastePersistence (pure) — per-month network median
//     correctness (odd n = middle, even n = midpoint, DQ rows
//     excluded from the median, strict > at the median), dqError
//     months counted SEPARATELY as invalid (never above/below, chain
//     breaker), sales=0 months as zeroSalesMonths, transition pair
//     counting (calendar-consecutive active months only — gaps skip),
//     network summary (probabilities, ratio, Fisher p, class
//     distribution), empty input.
//  4. Wiring — queryWasteNetwork attaches the additive per-outlet
//     fields + top-level persistence block (ONE merged SQL round
//     trip, unchanged), and the waste-series barrel re-exports the
//     new surface (import paths stable for existing consumers).
//
// Pure builders are deep-imported from the persistence module (no db
// closure); the wiring block imports the barrel like the sibling
// waste-series.test.ts (same vi.hoisted @/lib/db mock — harmless for
// the pure tests).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WASTE_KRONIS_MIN_MONTHS,
  WASTE_KRONIS_SHARE,
  buildWastePersistence,
  classifyWastePersistence,
  fisherExact2x2,
} from '@/lib/queries/waste/network/persistence';
import {
  buildWastePersistence as buildWastePersistenceBarrel,
  queryWasteNetwork,
  WASTE_KRONIS_SHARE as WASTE_KRONIS_SHARE_BARREL,
} from '@/lib/queries/waste/waste-series';
import type { WasteMonthlyRow } from '@/lib/queries/waste/network';

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

const HI_LOSS = 50_000_000;

/** Direct WasteMonthlyRow factory (the builder reads wasteToSales directly). */
function mrow(overrides: Partial<WasteMonthlyRow> = {}): WasteMonthlyRow {
  return {
    outletCode: 'A',
    outletName: 'Outlet A',
    area: 'JAKARTA 1',
    monthKey: '2026-01',
    monthLabel: 'Januari 2026',
    sales: 1_000_000,
    waste: 20_000,
    susut: 0,
    trial: 0,
    residual: 0,
    totalLoss: 20_000,
    totalSurplus: 0,
    wasteToSales: 0.02,
    wasteShareOfLoss: 1,
    residualShare: 0,
    spike: false,
    dqError: false,
    dqErrorCount: 0,
    ...overrides,
  };
}

/** Months 2026-01..2026-N with a fixed ratio for one outlet. */
function months(
  outletCode: string,
  ratios: number[],
  overrides: Partial<WasteMonthlyRow> = {},
): WasteMonthlyRow[] {
  const LABELS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return ratios.map((ratio, i) => mrow({
    outletCode,
    monthKey: `2026-${String(i + 1).padStart(2, '0')}`,
    monthLabel: `${LABELS[i]} 2026`,
    wasteToSales: ratio,
    waste: ratio * 1_000_000,
    ...overrides,
  }));
}

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
});

// ------------------------------------------------------------
// 1. fisherExact2x2
// ------------------------------------------------------------

describe('fisherExact2x2', () => {
  it('Fisher 1935 tea-tasting table [[3,1],[1,3]] → two-sided 34/70', () => {
    // Margins (4,4,4,4): p(x) = C(4,x)·C(4,4−x)/70 → 1,16,36,16,1 /70.
    // Tables no more likely than x=3 (16/70): x ∈ {0,1,3,4} → 34/70.
    expect(fisherExact2x2(3, 1, 1, 3)).toBeCloseTo(34 / 70, 12);
  });

  it('perfect diagonals: [[5,0],[0,5]] → 2/252 and [[4,0],[0,4]] → 2/70', () => {
    expect(fisherExact2x2(5, 0, 0, 5)).toBeCloseTo(2 / 252, 12);
    expect(fisherExact2x2(4, 0, 0, 4)).toBeCloseTo(2 / 70, 12);
  });

  it('scipy-docs example [[8,2],[1,5]] → 400/11440', () => {
    // C(16,9)=11440; p(8)=270/11440, p(3)=120, p(9)=10 → 400/11440.
    expect(fisherExact2x2(8, 2, 1, 5)).toBeCloseTo(400 / 11440, 12);
  });

  it('degenerate tables: empty → 1, zero row/col margin → 1', () => {
    expect(fisherExact2x2(0, 0, 0, 0)).toBe(1);
    expect(fisherExact2x2(0, 4, 0, 4)).toBe(1); // zero col-1 margin
    expect(fisherExact2x2(4, 0, 4, 0)).toBe(1); // zero col-2 margin
    expect(fisherExact2x2(0, 0, 3, 5)).toBe(1); // zero row-1 margin
  });

  it('rejects negative / non-integer cells with NaN', () => {
    expect(fisherExact2x2(-1, 2, 2, 2)).toBeNaN();
    expect(fisherExact2x2(1.5, 2, 2, 2)).toBeNaN();
    expect(fisherExact2x2(1, 2, 2, Number.NaN)).toBeNaN();
  });

  it('is invariant to row/column swaps (symmetry of the hypergeometric)', () => {
    const p = fisherExact2x2(8, 2, 1, 5);
    expect(fisherExact2x2(1, 5, 8, 2)).toBeCloseTo(p, 12); // row swap
    expect(fisherExact2x2(2, 8, 5, 1)).toBeCloseTo(p, 12); // col swap
    expect(fisherExact2x2(5, 1, 2, 8)).toBeCloseTo(p, 12); // both
  });

  it('returns a probability in [0,1] across a sweep of tables', () => {
    for (let a = 0; a <= 6; a++) {
      for (let b = 0; b <= 4; b++) {
        for (let c = 0; c <= 4; c++) {
          for (let d = 0; d <= 5; d++) {
            const p = fisherExact2x2(a, b, c, d);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

// ------------------------------------------------------------
// 2. classifyWastePersistence — boundaries
// ------------------------------------------------------------

describe('classifyWastePersistence', () => {
  it('pins the thresholds (KRONIS = ≥60% share, min 6 active months)', () => {
    expect(WASTE_KRONIS_SHARE).toBe(0.6);
    expect(WASTE_KRONIS_MIN_MONTHS).toBe(6);
  });

  it('60% exactly is KRONIS (inclusive ≥); just below is not', () => {
    expect(classifyWastePersistence(10, 0.6, 0)).toBe('KRONIS');   // 6/10 exactly
    expect(classifyWastePersistence(6, 0.6, 0)).toBe('KRONIS');    // 3.6/6 → e.g. 4/6
    expect(classifyWastePersistence(10, 0.5999, 0)).toBe('SEHAT');
    expect(classifyWastePersistence(10, 0.5, 0)).toBe('SEHAT');
  });

  it('5 vs 6 active months: the TERBATAS gate dominates even 100% share', () => {
    expect(classifyWastePersistence(5, 1, 3)).toBe('TERBATAS'); // 100% above, 5 months
    expect(classifyWastePersistence(6, 1, 0)).toBe('KRONIS');   // 100% above, 6 months
    expect(classifyWastePersistence(0, 0, 0)).toBe('TERBATAS'); // no active months
  });

  it('EPISODIK = spikes without kronis persistence; KRONIS dominates spikes', () => {
    expect(classifyWastePersistence(8, 0.25, 1)).toBe('EPISODIK');
    expect(classifyWastePersistence(8, 0.25, 0)).toBe('SEHAT');
    // Chronically above median AND occasionally spiking → still KRONIS
    // (persistence dominates — a kronis outlet can spike too).
    expect(classifyWastePersistence(8, 0.75, 2)).toBe('KRONIS');
  });
});

// ------------------------------------------------------------
// 3. buildWastePersistence
// ------------------------------------------------------------

describe('buildWastePersistence — per-month network median', () => {
  it('odd n → middle value, even n → midpoint; DQ rows excluded from the median', () => {
    const rows = [
      // m1: A 0.01, B 0.02, C 0.03 active (+ DQX 0.99 invalid) → median 0.02
      mrow({ outletCode: 'A', monthKey: '2026-01', wasteToSales: 0.01 }),
      mrow({ outletCode: 'B', monthKey: '2026-01', wasteToSales: 0.02 }),
      mrow({ outletCode: 'C', monthKey: '2026-01', wasteToSales: 0.03 }),
      mrow({ outletCode: 'DQX', monthKey: '2026-01', wasteToSales: 0.99, dqError: true }),
      // m2: A 0.01, B 0.02 → median 0.015
      mrow({ outletCode: 'A', monthKey: '2026-02', wasteToSales: 0.01 }),
      mrow({ outletCode: 'B', monthKey: '2026-02', wasteToSales: 0.02 }),
      // m3: A 0.01, B 0.02, C 0.03, E 0.10 → median (0.02+0.03)/2 = 0.025
      mrow({ outletCode: 'A', monthKey: '2026-03', wasteToSales: 0.01 }),
      mrow({ outletCode: 'B', monthKey: '2026-03', wasteToSales: 0.02 }),
      mrow({ outletCode: 'C', monthKey: '2026-03', wasteToSales: 0.03 }),
      mrow({ outletCode: 'E', monthKey: '2026-03', wasteToSales: 0.1 }),
    ];
    const { medians } = buildWastePersistence(rows);
    expect(medians).toHaveLength(3);
    expect(medians.map((m) => m.monthKey)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(medians[0].medianWasteToSales).toBeCloseTo(0.02, 12);   // odd, DQ excluded
    expect(medians[0].activeOutlets).toBe(3);
    expect(medians[1].medianWasteToSales).toBeCloseTo(0.015, 12);  // even
    expect(medians[1].activeOutlets).toBe(2);
    expect(medians[2].medianWasteToSales).toBeCloseTo(0.025, 12);  // even
    expect(medians[2].activeOutlets).toBe(4);
  });

  it('strictly above: the outlet sitting exactly at an odd-n median is NOT above', () => {
    // B (0.02) IS the m1 median → never counted as above in that month.
    const rows = [
      mrow({ outletCode: 'A', monthKey: '2026-01', wasteToSales: 0.01 }),
      mrow({ outletCode: 'B', monthKey: '2026-01', wasteToSales: 0.02 }),
      mrow({ outletCode: 'C', monthKey: '2026-01', wasteToSales: 0.03 }),
    ];
    const { outlets } = buildWastePersistence(rows);
    const b = outlets.find((o) => o.outletCode === 'B')!;
    expect(b.monthsAboveMedian).toBe(0);
    expect(b.aboveMedianShare).toBe(0);
    expect(outlets.find((o) => o.outletCode === 'C')!.monthsAboveMedian).toBe(1);
    expect(outlets.find((o) => o.outletCode === 'A')!.monthsAboveMedian).toBe(0);
  });

  it('seasonality control: per-month median, not one static window median', () => {
    // A is 0.05 in BOTH months. A static window median over {0.05, 0.01,
    // 0.05, 0.02} = 0.035 would call A "above" in both months; the
    // PER-MONTH medians (m1: 0.03, m2: 0.035) call A above only in m2 —
    // a month where the whole network calmed down must not manufacture
    // "above median" persistence.
    const rows = [
      mrow({ outletCode: 'A', monthKey: '2026-01', wasteToSales: 0.05 }),
      mrow({ outletCode: 'B', monthKey: '2026-01', wasteToSales: 0.01 }),
      mrow({ outletCode: 'C', monthKey: '2026-01', wasteToSales: 0.03 }), // m1 median
      mrow({ outletCode: 'A', monthKey: '2026-02', wasteToSales: 0.05 }),
      mrow({ outletCode: 'B', monthKey: '2026-02', wasteToSales: 0.02 }),
      mrow({ outletCode: 'D', monthKey: '2026-02', wasteToSales: 0.025 }),
      mrow({ outletCode: 'C', monthKey: '2026-02', wasteToSales: 0.02 }), // m2 median 0.02
    ];
    // m2 actives: 0.02, 0.02, 0.025, 0.05 → median (0.02+0.025)/2 = 0.0225
    const { outlets } = buildWastePersistence(rows);
    const a = outlets.find((o) => o.outletCode === 'A')!;
    expect(a.monthsAboveMedian).toBe(2); // 0.05 > 0.03 and 0.05 > 0.0225
    // B: m1 0.01 < 0.03 low; m2 0.02 < 0.0225 low → 0 above.
    expect(outlets.find((o) => o.outletCode === 'B')!.monthsAboveMedian).toBe(0);
    // C: m1 exactly median (not above); m2 0.02 < 0.0225 (not above) → 0.
    expect(outlets.find((o) => o.outletCode === 'C')!.monthsAboveMedian).toBe(0);
    // D: m2 0.025 > 0.0225 → 1 above in its only month.
    expect(outlets.find((o) => o.outletCode === 'D')!.monthsAboveMedian).toBe(1);
  });
});

describe('buildWastePersistence — dqError exclusion (W2 guard)', () => {
  it('dqError months: invalidMonths counted separately, never above/below, excluded from median + share', () => {
    // DQ is 0.99 every month; month 03 is DQ-error. Y2 is 0.01.
    const rows = [
      ...months('DQ', [0.99, 0.99, 0.99, 0.99, 0.99, 0.99]).map((r, i) =>
        i === 2 ? { ...r, dqError: true, spike: true, dqErrorCount: 4 } : r),
      ...months('Y2', [0.01, 0.01, 0.01, 0.01, 0.01, 0.01]),
    ];
    const { outlets, medians, summary } = buildWastePersistence(rows);
    const dq = outlets.find((o) => o.outletCode === 'DQ')!;
    expect(dq.invalidMonths).toBe(1);
    expect(dq.activeMonths).toBe(5);           // months 1,2,4,5,6
    expect(dq.monthsAboveMedian).toBe(5);      // 0.99 > 0.5 in every active month
    expect(dq.aboveMedianShare).toBeCloseTo(1, 12);
    // The DQ month's own spike flag is NOT evidence — excluded.
    expect(dq.activeSpikeMonths).toBe(0);
    // 5 active months < 6 → TERBATAS even at 100% share (the guard:
    // without excluding the DQ month this would wrongly read KRONIS).
    expect(dq.persistenceClass).toBe('TERBATAS');

    // Month 03 median is computed over the ACTIVE outlets only (Y2) —
    // DQ's 0.99 does not drag the median.
    const m3 = medians.find((m) => m.monthKey === '2026-03')!;
    expect(m3.medianWasteToSales).toBeCloseTo(0.01, 12);
    expect(m3.activeOutlets).toBe(1);
    expect(summary.minActiveOutletsPerMonth).toBe(1);

    // Y2: 6 active months, never above, no spikes → SEHAT.
    const y2 = outlets.find((o) => o.outletCode === 'Y2')!;
    expect(y2.activeMonths).toBe(6);
    expect(y2.persistenceClass).toBe('SEHAT');
  });

  it('an invalid month in between BREAKS the transition chain (not month-over-month)', () => {
    // Same fixture as above: DQ's active months are 1,2,4,5,6 — pairs
    // (1,2), (4,5), (5,6) count; (2,4) does NOT (month 03 invalid
    // between them → not calendar-consecutive). DQ is high in all its
    // active months → 3 HH. Y2 contributes 5 LL (its 6 consecutive
    // low months; in month 03 it is the only active outlet and sits
    // exactly on the median → low).
    const rows = [
      ...months('DQ', [0.99, 0.99, 0.99, 0.99, 0.99, 0.99]).map((r, i) =>
        i === 2 ? { ...r, dqError: true } : r),
      ...months('Y2', [0.01, 0.01, 0.01, 0.01, 0.01, 0.01]),
    ];
    const { summary } = buildWastePersistence(rows);
    expect(summary.transitionHH).toBe(3);
    expect(summary.transitionHL).toBe(0);
    expect(summary.transitionLH).toBe(0);
    expect(summary.transitionLL).toBe(5);
    expect(summary.transitionPairs).toBe(8);
    // Degenerate 2×2 (no high→low, no low→high): p = 1/56.
    expect(summary.fisherP).toBeCloseTo(1 / 56, 12);
  });
});

describe('buildWastePersistence — sales=0 months', () => {
  it('zeroSalesMonths counted separately; ratio-less months excluded from the share + chain', () => {
    // ZS: m1 high (0.09), m2 sales=0 (forced wasteToSales 0 — NOT a real
    // 0), m3 high (0.09). LO: low companion (0.01) all 3 months.
    const rows = [
      mrow({ outletCode: 'ZS', monthKey: '2026-01', wasteToSales: 0.09 }),
      mrow({ outletCode: 'ZS', monthKey: '2026-02', wasteToSales: 0, sales: 0, spike: true }),
      mrow({ outletCode: 'ZS', monthKey: '2026-03', wasteToSales: 0.09 }),
      ...months('LO', [0.01, 0.01, 0.01]),
    ];
    const { outlets, medians, summary } = buildWastePersistence(rows);
    const zs = outlets.find((o) => o.outletCode === 'ZS')!;
    expect(zs.zeroSalesMonths).toBe(1);
    expect(zs.activeMonths).toBe(2);
    expect(zs.invalidMonths).toBe(0);
    // The forced-0 month is NOT counted as "below median", and the
    // spike flag inside a ratio-less month is not active evidence.
    expect(zs.monthsAboveMedian).toBe(2); // 0.09 > 0.05 in m1 and m3
    expect(zs.aboveMedianShare).toBeCloseTo(1, 12);
    expect(zs.activeSpikeMonths).toBe(0);
    // m2 median over active outlets only (LO alone → 0.01).
    const m2 = medians.find((m) => m.monthKey === '2026-02')!;
    expect(m2.activeOutlets).toBe(1);
    // Chain: ZS active months are m1,m3 — not calendar-consecutive →
    // no ZS pair. LO contributes 2 LL pairs.
    expect(summary.transitionPairs).toBe(2);
    expect(summary.transitionLL).toBe(2);
  });
});

describe('buildWastePersistence — transition matrix + network summary', () => {
  it('counts HH/HL/LH/LL over calendar-consecutive active pairs; gap months skip pairs', () => {
    // Designed fixture (6 outlets; states verified against the per-month
    // medians asserted below):
    //   P1  0.09 × 6 months            → H,H,H,H,H,H  (5 HH pairs)
    //   P2  0.08 × months 1-3          → H,H,H        (2 HH pairs)
    //   E1  m1 0.075, m2 0.02          → H,L          (1 HL pair)
    //   E2  m1 0.02,  m2 0.07          → L,H          (1 LH pair)
    //   C1  0.01 × 6 months            → L,L,L,L,L,L  (5 LL pairs)
    //   C2  0.011 × months 1-3         → L,L,L        (2 LL pairs)
    // Per-month medians: m1 (6 actives) = 0.0475; m2 = 0.045;
    // m3 (4 actives) = 0.0455; m4-m6 (2 actives) = 0.05.
    // Gap behavior (a missing month breaking the chain) is pinned in the
    // "null probabilities" test below via months 1-2-4 fixtures.
    const rows = [
      ...months('P1', [0.09, 0.09, 0.09, 0.09, 0.09, 0.09]),
      ...months('C1', [0.01, 0.01, 0.01, 0.01, 0.01, 0.01]),
      ...months('P2', [0.08, 0.08, 0.08]),
      mrow({ outletCode: 'E1', monthKey: '2026-01', wasteToSales: 0.075 }),
      mrow({ outletCode: 'E1', monthKey: '2026-02', wasteToSales: 0.02 }),
      mrow({ outletCode: 'E2', monthKey: '2026-01', wasteToSales: 0.02 }),
      mrow({ outletCode: 'E2', monthKey: '2026-02', wasteToSales: 0.07 }),
      ...months('C2', [0.011, 0.011, 0.011]),
    ];
    const { summary, medians, outlets } = buildWastePersistence(rows);
    // Medians sanity (pins the state assignments above).
    expect(medians.find((m) => m.monthKey === '2026-01')!.medianWasteToSales).toBeCloseTo(0.0475, 12);
    expect(medians.find((m) => m.monthKey === '2026-02')!.medianWasteToSales).toBeCloseTo(0.045, 12);
    expect(medians.find((m) => m.monthKey === '2026-03')!.medianWasteToSales).toBeCloseTo(0.0455, 12);
    expect(medians.find((m) => m.monthKey === '2026-04')!.medianWasteToSales).toBeCloseTo(0.05, 12);

    expect(summary.transitionHH).toBe(7);  // 5 (P1) + 2 (P2)
    expect(summary.transitionHL).toBe(1);  // E1
    expect(summary.transitionLH).toBe(1);  // E2
    expect(summary.transitionLL).toBe(7);  // 5 (C1) + 2 (C2)
    expect(summary.transitionPairs).toBe(16);
    // P(high t+1 | high t) = 7/8; P(high t+1 | low t) = 1/8 → ratio 7.
    expect(summary.pHighNextGivenHigh).toBeCloseTo(7 / 8, 12);
    expect(summary.pHighNextGivenLow).toBeCloseTo(1 / 8, 12);
    expect(summary.persistenceRatio).toBeCloseTo(7, 12);
    // Fisher on [[7,1],[1,7]]: margins (8,8,8,16), C(16,8)=12870;
    // p(x)=C(8,x)²/12870 → tables ≤ p(7)=64/12870 are {0,1,7,8} →
    // (1+64+64+1)/12870 = 130/12870 — verified independently with
    // exact BigInt arithmetic.
    expect(summary.fisherP).toBeCloseTo(130 / 12870, 12);
    expect(summary.epistemicLabel).toBe('INDIKASI');
    expect(summary.monthsWithMedian).toBe(6);
    expect(summary.minActiveOutletsPerMonth).toBe(2);
    expect(summary.classDistribution).toEqual({ kronis: 1, episodik: 0, sehat: 1, terbatas: 4 });
    // Spot-check the per-outlet metrics behind the distribution.
    expect(outlets.find((o) => o.outletCode === 'P1')!.persistenceClass).toBe('KRONIS');
    expect(outlets.find((o) => o.outletCode === 'P2')!.persistenceClass).toBe('TERBATAS');
    expect(outlets.find((o) => o.outletCode === 'C1')!.persistenceClass).toBe('SEHAT');
  });

  it('null probabilities/ratio when a transition row is empty (JSON-safe, never ±Infinity)', () => {
    // Two outlets, months 1-2-4 (no month 03): GA high, GB low.
    // Pairs: (1,2) HH and (1,2) LL only; the (2,4) pairs are skipped.
    const rows = [
      ...months('GA', [0.09, 0.09]).concat(
        mrow({ outletCode: 'GA', monthKey: '2026-04', wasteToSales: 0.09 })),
      ...months('GB', [0.01, 0.01]).concat(
        mrow({ outletCode: 'GB', monthKey: '2026-04', wasteToSales: 0.01 })),
    ];
    const { summary } = buildWastePersistence(rows);
    expect(summary.transitionHH).toBe(1);
    expect(summary.transitionLL).toBe(1);
    expect(summary.pHighNextGivenHigh).toBe(1); // 1/1
    expect(summary.pHighNextGivenLow).toBe(0);  // 0/1
    // P(high t+1 | low t) = 0 → ratio would be +∞ → reported null.
    expect(summary.persistenceRatio).toBeNull();
    expect(summary.fisherP).toBeCloseTo(1, 12); // [[1,0],[0,1]] → 1
  });
});

describe('buildWastePersistence — classification (integration)', () => {
  it('60% exactly (6 of 10 active months) → KRONIS; 5 months at 100% → TERBATAS', () => {
    // X: high months 1-6 (0.09 vs Y 0.01 + Z/W pairs), low months 7-10.
    // Months 1-5 have 4 actives (X,Y,Z,W) → median 0.05; month 6 has
    // X,Y → 0.05; months 7-10 have X,Y with roles swapped → 0.05.
    const rows = [
      ...months('X', [0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.01, 0.01, 0.01, 0.01]),
      ...months('Y', [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.09, 0.09, 0.09, 0.09]),
      ...months('Z', [0.09, 0.09, 0.09, 0.09, 0.09]),   // 5 months only
      ...months('W', [0.01, 0.01, 0.01, 0.01, 0.01]),   // 5 months only
    ];
    const { outlets, summary } = buildWastePersistence(rows);
    const x = outlets.find((o) => o.outletCode === 'X')!;
    expect(x.activeMonths).toBe(10);
    expect(x.monthsAboveMedian).toBe(6);
    expect(x.aboveMedianShare).toBeCloseTo(0.6, 12);
    expect(x.persistenceClass).toBe('KRONIS');          // boundary inclusive
    const y = outlets.find((o) => o.outletCode === 'Y')!;
    expect(y.monthsAboveMedian).toBe(4);
    expect(y.persistenceClass).toBe('SEHAT');
    const z = outlets.find((o) => o.outletCode === 'Z')!;
    expect(z.aboveMedianShare).toBeCloseTo(1, 12);
    expect(z.persistenceClass).toBe('TERBATAS');        // 5 active months
    expect(outlets.find((o) => o.outletCode === 'W')!.persistenceClass).toBe('TERBATAS');
    expect(summary.classDistribution).toEqual({ kronis: 1, episodik: 0, sehat: 1, terbatas: 2 });
  });

  it('EPISODIK: ≥6 active months with a 2σ spike but below-kronis persistence', () => {
    // Single outlet (n=1 per month → it sits exactly on its own median,
    // never "above"): the spike months carry the episodic signal.
    const rows = months('EP', [0.02, 0.02, 0.02, 0.02, 0.02, 0.02]).map((r, i) =>
      i === 1 || i === 4 ? { ...r, spike: true } : r);
    const { outlets, summary } = buildWastePersistence(rows);
    const ep = outlets.find((o) => o.outletCode === 'EP')!;
    expect(ep.activeMonths).toBe(6);
    expect(ep.activeSpikeMonths).toBe(2);
    expect(ep.persistenceClass).toBe('EPISODIK');
    expect(summary.classDistribution.episodik).toBe(1);
  });
});

describe('buildWastePersistence — guards', () => {
  it('empty input → zeroed outlets/medians + null statistics, epistemic label kept', () => {
    const { outlets, medians, summary } = buildWastePersistence([]);
    expect(outlets).toEqual([]);
    expect(medians).toEqual([]);
    expect(summary.transitionPairs).toBe(0);
    expect(summary.transitionHH).toBe(0);
    expect(summary.pHighNextGivenHigh).toBeNull();
    expect(summary.pHighNextGivenLow).toBeNull();
    expect(summary.persistenceRatio).toBeNull();
    expect(summary.fisherP).toBeNull();
    expect(summary.monthsWithMedian).toBe(0);
    expect(summary.minActiveOutletsPerMonth).toBe(0);
    expect(summary.classDistribution).toEqual({ kronis: 0, episodik: 0, sehat: 0, terbatas: 0 });
    expect(summary.epistemicLabel).toBe('INDIKASI');
  });

  it('unsorted input rows are handled (grouped + sorted by monthKey internally)', () => {
    const rows = [
      mrow({ outletCode: 'A', monthKey: '2026-03', wasteToSales: 0.03 }),
      mrow({ outletCode: 'A', monthKey: '2026-01', wasteToSales: 0.01 }),
      mrow({ outletCode: 'A', monthKey: '2026-02', wasteToSales: 0.02 }),
      mrow({ outletCode: 'B', monthKey: '2026-02', wasteToSales: 0.05 }),
      mrow({ outletCode: 'B', monthKey: '2026-03', wasteToSales: 0.06 }),
      mrow({ outletCode: 'B', monthKey: '2026-01', wasteToSales: 0.04 }),
    ];
    const { summary, medians } = buildWastePersistence(rows);
    // Medians: m1 [0.01, 0.04] → 0.025; m2 [0.02, 0.05] → 0.035; m3 [0.03, 0.06] → 0.045.
    // A: low,low,low → 2 LL; B: high,high,high → 2 HH. Order-independent.
    expect(medians.map((m) => m.monthKey)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(summary.transitionHH).toBe(2);
    expect(summary.transitionLL).toBe(2);
    expect(summary.persistenceRatio).toBeNull(); // P(high|low) = 0/2 = 0 → null
  });
});

// ------------------------------------------------------------
// 4. Wiring — queryWasteNetwork + barrel surface
// ------------------------------------------------------------

describe('queryWasteNetwork wiring (W2 additive fields)', () => {
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

  it('attaches per-outlet persistence fields + the top-level persistence block (no extra SQL round-trip)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      rawRow({ monthKey: '2026-07', monthLabel: 'Juli 2026', sales: BigInt(1_000_000), waste: BigInt(20_000), spike: 1 }),
      rawRow({ monthKey: '2026-08', sales: BigInt(1_000_000), waste: BigInt(20_000) }),
    ]);
    const result = await queryWasteNetwork('WEEK 4', '2026-08', {}, HI_LOSS);

    // Still ONE merged SQL round-trip — the persistence pass is pure.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);

    // Top-level additive block.
    expect(result.persistence.summary.epistemicLabel).toBe('INDIKASI');
    expect(result.persistence.summary.transitionPairs).toBe(1); // 2 consecutive months, L→L
    expect(result.persistence.summary.transitionLL).toBe(1);
    expect(result.persistence.medians).toHaveLength(2);

    // Per-outlet additive fields; existing fields untouched.
    expect(result.outlets).toHaveLength(1);
    const o = result.outlets[0];
    expect(o.months).toBe(2);
    expect(o.activeMonths).toBe(2);
    expect(o.invalidMonths).toBe(0);
    expect(o.zeroSalesMonths).toBe(0);
    expect(o.monthsAboveMedian).toBe(0); // sole outlet → sits on its own median
    expect(o.aboveMedianShare).toBe(0);
    expect(o.activeSpikeMonths).toBe(1);
    expect(o.persistenceClass).toBe('TERBATAS'); // 2 active months < 6
    expect(o.rankWasteToSales).toBe(1);          // base fields intact
    expect(o.spikeMonths).toBe(1);
  });

  it('empty SQL result → zeroed persistence block, no throw', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteNetwork('WEEK 4', '2026-08', {}, HI_LOSS);
    expect(result.outlets).toEqual([]);
    expect(result.persistence.medians).toEqual([]);
    expect(result.persistence.summary.transitionPairs).toBe(0);
    expect(result.persistence.summary.fisherP).toBeNull();
  });

  it('barrel re-exports the W2 surface (import paths stable for existing consumers)', () => {
    expect(typeof buildWastePersistenceBarrel).toBe('function');
    expect(WASTE_KRONIS_SHARE_BARREL).toBe(WASTE_KRONIS_SHARE);
    // The barrel-bound builder IS the deep-imported one (same behavior).
    expect(buildWastePersistenceBarrel([]).summary.epistemicLabel).toBe('INDIKASI');
  });
});
