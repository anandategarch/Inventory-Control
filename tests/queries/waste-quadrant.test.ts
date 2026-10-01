// Tests for src/lib/queries/waste/waste-top-items/quadrant.ts (W3 —
// "Kuadran Sistemik vs Insiden", prevalence × persistence + HHI +
// paretoK + class distribution). PURE builders only — no DB mock
// needed (the compute/classify split house rule: the query edge is
// covered by waste-top-items.test.ts's 4-round test).
//
// Covers:
//  1. classifyQuadrantClass — the four classes + boundary cases:
//     prevalence EXACTLY 50% (≥ is inclusive) and monthsActive EXACTLY
//     ceil(windowMonths/2); null prevalence (no BOM basis) reads LOW.
//  2. persistenceThresholdMonths — adaptive to the REAL window
//     (BUGHUNT-R1 FIX 2 pattern): window 9 → 5, window 5 → 3, cap 12 → 6;
//     the same monthsActive flips class when the window shrinks.
//  3. computeHhi — known distributions: 2 outlets 50/50 → 0.5, 10 equal
//     → 0.1, single outlet → 1.0, empty/zero waste → null.
//  4. buildQuadrant — HHI null guard (< 10 active outlets), HHI from the
//     FULL distribution (waste>0 outlets only), prevalence denominator
//     BOM>0 discipline (record presence without BOM excluded), paretoK
//     on known cumulative shares (+ null when the slice never reaches
//     80%), classCounts, purity (input rows not mutated).
import { describe, it, expect } from 'vitest';
import {
  WASTE_QUADRANT_HHI_MIN_OUTLETS,
  WASTE_QUADRANT_PARETO_SHARE,
  WASTE_QUADRANT_PREVALENCE_MIN,
  buildQuadrant,
  classifyQuadrantClass,
  computeHhi,
  persistenceThresholdMonths,
} from '@/lib/queries/waste/waste-top-items';
import type { WasteTopItemRow } from '@/lib/queries/waste/waste-top-items';

// ------------------------------------------------------------
// Fixtures — structurally typed literals (same style as the raw-row
// fixtures in waste-top-items.test.ts; no DB, no imports of raw types).
// ------------------------------------------------------------

function item(overrides: Partial<Record<string, number | string | null>> = {}): WasteTopItemRow {
  return {
    itemId: 1,
    itemName: 'KULIT PANGSIT',
    satuan: 'KG',
    totalWaste: 100,
    wasteQty: 10,
    outletsActive: 10,
    monthsActive: 9,
    share: 0.5,
    cumulativeShare: 0.5,
    lastMonthWaste: 0,
    prevMonthWaste: 0,
    sistematik: true,
    byOutlet: [],
    quadrant: null,
    ...overrides,
  } as WasteTopItemRow;
}

/** Distribution rows for one item: [outletId, waste, hasBom] tuples. */
function dist(itemId: number, specs: Array<[number, number, number]>): Array<{ itemId: number; outletId: number; waste: number; hasBom: number }> {
  return specs.map(([outletId, waste, hasBom]) => ({ itemId, outletId, waste, hasBom }));
}

// ------------------------------------------------------------
// 1. classifyQuadrantClass
// ------------------------------------------------------------

describe('classifyQuadrantClass', () => {
  it('SISTEMIK = prevalence ≥ 50% AND monthsActive ≥ ceil(windowMonths/2)', () => {
    expect(classifyQuadrantClass(0.6, 5, 9)).toBe('SISTEMIK');
    // Boundary: prevalence EXACTLY at the threshold (inclusive ≥).
    expect(classifyQuadrantClass(0.5, 5, 9)).toBe('SISTEMIK');
    // Boundary: monthsActive EXACTLY at the adaptive threshold (5 = ceil(9/2)).
    expect(classifyQuadrantClass(0.9, 5, 9)).toBe('SISTEMIK');
  });

  it('MUSIMAN = widespread but NOT persistent', () => {
    expect(classifyQuadrantClass(0.8, 4, 9)).toBe('MUSIMAN');
    expect(classifyQuadrantClass(0.5, 4, 9)).toBe('MUSIMAN'); // prev exactly 50%
  });

  it('LOKAL-KRONIS = persistent but NOT widespread', () => {
    expect(classifyQuadrantClass(0.49, 5, 9)).toBe('LOKAL-KRONIS');
    expect(classifyQuadrantClass(0, 5, 9)).toBe('LOKAL-KRONIS');
  });

  it('INSIDEN = neither widespread nor persistent', () => {
    expect(classifyQuadrantClass(0.49, 4, 9)).toBe('INSIDEN');
    expect(classifyQuadrantClass(0, 1, 9)).toBe('INSIDEN');
  });

  it('null prevalence (no BOM basis) reads LOW — conservative, never "widespread"', () => {
    // Orphaned waste (no usage denominator): no basis to claim network-wide
    // spread, so the class falls to the persistence side.
    expect(classifyQuadrantClass(null, 6, 9)).toBe('LOKAL-KRONIS');
    expect(classifyQuadrantClass(null, 2, 9)).toBe('INSIDEN');
  });
});

// ------------------------------------------------------------
// 2. Adaptive persistence threshold (FIX 2 pattern)
// ------------------------------------------------------------

describe('persistenceThresholdMonths', () => {
  it('follows the REAL window months, not the 12-month cap', () => {
    expect(persistenceThresholdMonths(9)).toBe(5);  // live window
    expect(persistenceThresholdMonths(8)).toBe(4);
    expect(persistenceThresholdMonths(5)).toBe(3);
    expect(persistenceThresholdMonths(12)).toBe(6); // full cap
    expect(persistenceThresholdMonths(1)).toBe(1);
  });

  it('the SAME monthsActive flips class when the window shrinks (9 vs 5)', () => {
    // monthsActive 4 with window 9 → 4 < ceil(9/2)=5 → not persistent;
    // the identical count with window 5 → 4 ≥ ceil(5/2)=3 → persistent.
    expect(classifyQuadrantClass(0.8, 4, 9)).toBe('MUSIMAN');
    expect(classifyQuadrantClass(0.8, 4, 5)).toBe('SISTEMIK');
    // Boundary at window 5: monthsActive EXACTLY 3 = threshold → persistent.
    expect(classifyQuadrantClass(0.8, 3, 5)).toBe('SISTEMIK');
    expect(classifyQuadrantClass(0.8, 2, 5)).toBe('MUSIMAN');
  });
});

// ------------------------------------------------------------
// 3. computeHhi (pure, unguarded)
// ------------------------------------------------------------

describe('computeHhi', () => {
  it('2 outlets 50/50 → 0.5; 10 equal outlets → 0.1 (1/n floor)', () => {
    expect(computeHhi([50, 50])).toBeCloseTo(0.5, 10);
    expect(computeHhi(Array(10).fill(10))).toBeCloseTo(0.1, 10);
  });

  it('single outlet → 1.0 (fully concentrated); skewed mix → Σ share²', () => {
    expect(computeHhi([100])).toBeCloseTo(1.0, 10);
    // 3 outlets 60/30/10 → 0.36 + 0.09 + 0.01 = 0.46.
    expect(computeHhi([60, 30, 10])).toBeCloseTo(0.46, 10);
  });

  it('null when there is no positive waste to distribute', () => {
    expect(computeHhi([])).toBeNull();
    expect(computeHhi([0, 0, 0])).toBeNull();
    expect(computeHhi([0, 100])).toBeCloseTo(1.0, 10); // zeros carry no share
  });
});

// ------------------------------------------------------------
// 4. buildQuadrant
// ------------------------------------------------------------

describe('buildQuadrant', () => {
  it('computes prevalence with the BOM>0 denominator (FIX 1 discipline: record presence excluded)', () => {
    // 10 outlets in scope: 8 with BOM, 2 record-presence-only (hasBom 0).
    // outletsActive (waste>0) = 4 → prevalence 4/8 = 0.5, NOT 4/10.
    const rows = [item({ itemId: 1, outletsActive: 4, monthsActive: 9 })];
    const distribution = dist(1, [
      [1, 100, 1], [2, 100, 1], [3, 100, 1], [4, 100, 1],          // waste + BOM
      [5, 0, 1], [6, 0, 1], [7, 0, 1], [8, 0, 1],                  // BOM, zero waste
      [9, 0, 0], [10, 0, 0],                                       // presence WITHOUT BOM
    ]);
    const { perItem } = buildQuadrant(rows, distribution, 9);
    expect(perItem.get(1)?.outletsWithBom).toBe(8);
    expect(perItem.get(1)?.prevalence).toBeCloseTo(0.5, 10);
    expect(perItem.get(1)?.persistence).toBeCloseTo(1, 10);
    expect(perItem.get(1)?.quadrantClass).toBe('SISTEMIK');
  });

  it('HHI null guard: < 10 active (waste>0) outlets → null, ≥ 10 → Σ share²', () => {
    // 9 active outlets (would-be HHI 1/9 ≈ 0.111) → guarded to null.
    const nine = dist(1, Array.from({ length: 9 }, (_, i) => [i + 1, 100, 1] as [number, number, number]));
    const { perItem: guarded } = buildQuadrant([item({ itemId: 1, outletsActive: 9 })], nine, 9);
    expect(guarded.get(1)?.hhi).toBeNull();

    // 10 equal active outlets → HHI exactly 0.1.
    const ten = dist(1, Array.from({ length: 10 }, (_, i) => [i + 1, 100, 1] as [number, number, number]));
    const { perItem: computed } = buildQuadrant([item({ itemId: 1, outletsActive: 10 })], ten, 9);
    expect(computed.get(1)?.hhi).toBeCloseTo(0.1, 10);
    // Guard boundary rides the constant, not a magic number.
    expect(WASTE_QUADRANT_HHI_MIN_OUTLETS).toBe(10);
  });

  it('HHI uses the FULL per-outlet distribution (zero-waste outlets carry no share)', () => {
    // 10 active outlets at 100 + 5 zero-waste BOM outlets: the zeros must
    // not dilute HHI (shares are over the item's total waste).
    const distribution = dist(1, [
      ...Array.from({ length: 10 }, (_, i) => [i + 1, 100, 1] as [number, number, number]),
      ...Array.from({ length: 5 }, (_, i) => [100 + i + 1, 0, 1] as [number, number, number]),
    ]);
    const { perItem } = buildQuadrant([item({ itemId: 1, outletsActive: 10 })], distribution, 9);
    expect(perItem.get(1)?.hhi).toBeCloseTo(0.1, 10);
  });

  it('prevalence null when NO outlet has BOM>0 (orphaned waste — conservative LOW)', () => {
    const distribution = dist(1, [
      [1, 100, 0], [2, 100, 0],
    ]);
    const { perItem } = buildQuadrant(
      [item({ itemId: 1, outletsActive: 2, monthsActive: 9 })],
      distribution,
      9,
    );
    expect(perItem.get(1)?.outletsWithBom).toBe(0);
    expect(perItem.get(1)?.prevalence).toBeNull();
    // Persistence-only reading: 9/9 months → LOKAL-KRONIS.
    expect(perItem.get(1)?.quadrantClass).toBe('LOKAL-KRONIS');
  });

  it('persistence guards windowMonths 0 (pure-builder edge) and rides adaptive months', () => {
    // Degenerate window: the query edge early-returns on empty windows, so
    // this only pins the pure guard's shape — persistence reads 0, and with
    // NO BOM basis (prevalence null) the class falls to the persistence side
    // (threshold ceil(0/2)=0 → any monthsActive counts as persistent).
    const { perItem } = buildQuadrant(
      [item({ itemId: 1, outletsActive: 2, monthsActive: 3 })],
      dist(1, [[1, 100, 0], [2, 0, 0]]),
      0,
    );
    expect(perItem.get(1)?.persistence).toBe(0);
    expect(perItem.get(1)?.prevalence).toBeNull();
    expect(perItem.get(1)?.quadrantClass).toBe('LOKAL-KRONIS');
  });

  it('paretoK = 1-based rank of the first item crossing 80% cumulative share', () => {
    const items = [
      item({ itemId: 1, share: 0.3, cumulativeShare: 0.3 }),
      item({ itemId: 2, share: 0.4, cumulativeShare: 0.7 }),
      item({ itemId: 3, share: 0.15, cumulativeShare: 0.85 }),
      item({ itemId: 4, share: 0.15, cumulativeShare: 1.0 }),
    ];
    const { summary } = buildQuadrant(items, [], 9);
    expect(summary.paretoK).toBe(3); // 0.85 is the first ≥ 0.8
    expect(WASTE_QUADRANT_PARETO_SHARE).toBe(0.8);
  });

  it('paretoK null when the returned slice never reaches 80% (tight limit, long tail)', () => {
    const items = [
      item({ itemId: 1, share: 0.2, cumulativeShare: 0.2 }),
      item({ itemId: 2, share: 0.2, cumulativeShare: 0.4 }),
    ];
    const { summary } = buildQuadrant(items, [], 9);
    expect(summary.paretoK).toBeNull();
  });

  it('summary carries the adaptive threshold + class distribution over the items', () => {
    // Small-denominator note (displayed honestly as "X/Y outlet" in the UI):
    // prevalence is RELATIVE to BOM>0 outlets — an item used in 10 outlets
    // but wasting in 1 reads 1/10 (narrow); an item used AND wasting in all
    // 10 reads 10/10 (widespread).
    const items = [
      item({ itemId: 1, outletsActive: 10, monthsActive: 9 }),   // 10/10, persist 9/9
      item({ itemId: 2, outletsActive: 10, monthsActive: 2 }),   // 10/10, persist 2/9
      item({ itemId: 3, outletsActive: 1, monthsActive: 7 }),    // 1/10, persist 7/9
      item({ itemId: 4, outletsActive: 1, monthsActive: 1 }),    // 1/10, persist 1/9
    ];
    const allWasting = Array.from({ length: 10 }, (_, i) => [i + 1, 100, 1] as [number, number, number]);
    const oneWasting = [
      [1, 100, 1] as [number, number, number],
      ...Array.from({ length: 9 }, (_, i) => [i + 2, 0, 1] as [number, number, number]),
    ];
    const distribution = [
      ...dist(1, allWasting), ...dist(2, allWasting),
      ...dist(3, oneWasting), ...dist(4, oneWasting),
    ];
    const { summary, perItem } = buildQuadrant(items, distribution, 9);
    expect(summary.persistenceThresholdMonths).toBe(5); // ceil(9/2)
    expect(summary.windowMonths).toBe(9);
    expect(summary.classCounts).toEqual({ SISTEMIK: 1, MUSIMAN: 1, 'LOKAL-KRONIS': 1, INSIDEN: 1 });
    expect(perItem.get(1)?.quadrantClass).toBe('SISTEMIK');
    expect(perItem.get(2)?.quadrantClass).toBe('MUSIMAN');
    expect(perItem.get(3)?.quadrantClass).toBe('LOKAL-KRONIS');
    expect(perItem.get(4)?.quadrantClass).toBe('INSIDEN');
  });

  it('is PURE — the input rows are not mutated (caller owns the merge)', () => {
    const rows = [item({ itemId: 1, quadrant: null })];
    buildQuadrant(rows, dist(1, [[1, 100, 1]]), 9);
    expect(rows[0].quadrant).toBeNull();
  });

  it('empty items → empty perItem map + zeroed classCounts (paretoK null)', () => {
    const { perItem, summary } = buildQuadrant([], [], 9);
    expect(perItem.size).toBe(0);
    expect(summary.paretoK).toBeNull();
    expect(summary.classCounts).toEqual({ SISTEMIK: 0, MUSIMAN: 0, 'LOKAL-KRONIS': 0, INSIDEN: 0 });
    expect(summary.persistenceThresholdMonths).toBe(5);
  });

  it('items without distribution rows still classify (prevalence null, HHI null)', () => {
    // Defensive: a distribution round that somehow missed an item must not
    // crash the classification — it degrades to the persistence-only read.
    const { perItem } = buildQuadrant([item({ itemId: 42, outletsActive: 5, monthsActive: 6 })], [], 9);
    expect(perItem.get(42)).toEqual({
      quadrantClass: 'LOKAL-KRONIS',
      prevalence: null,
      outletsWithBom: 0,
      persistence: 6 / 9,
      hhi: null,
    });
  });
});

// ------------------------------------------------------------
// Threshold constants — pin the documented tunables (drift alarm)
// ------------------------------------------------------------

describe('W3 quadrant constants', () => {
  it('prevalence threshold is the documented 50%', () => {
    expect(WASTE_QUADRANT_PREVALENCE_MIN).toBe(0.5);
  });
});
