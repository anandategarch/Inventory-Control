// Tests for the W11 "Paritas Susut & Trial" feature:
//   - src/lib/queries/waste/waste-top-items/fingerprint.ts (PURE —
//     fingerprint shares/classification + the trial-abuse screen);
//   - src/lib/queries/waste/waste-top-items/builders.ts metric param
//     (breakdown sort/cap + the parity share fields);
//   - src/lib/queries/waste/network/susut-spike.ts (PURE — the
//     metric-swap twin of the SQL waste spike);
//   - the QUERY edges (db-mock): the metric-driven ORDER BY + the W11
//     columns in the round-1 SQL + the additive wiring of fingerprint /
//     trialScreen / susutSpikeMonths (same vi.hoisted pattern as
//     waste-top-items.test.ts / waste-series.test.ts).
//
// Hand-computed fixtures (documented inline): fingerprint shares of
// explained loss, the W>S>T tie-break, trial-screen signal boundaries,
// and the 2σ susut spike on a 9-month synthetic window.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WASTE_TRIAL_SCREEN_BOM_RATIO,
  WASTE_TRIAL_SCREEN_MIN_MONTHS,
  WASTE_TRIAL_SCREEN_MIN_NOMINAL,
  // FIX (AUDIT-B M2): the two-tier signal-1 knobs (pinned below).
  WASTE_TRIAL_SCREEN_OUTLIER_Z,
  WASTE_TRIAL_SCREEN_MIN_POPULATION,
  WASTE_TRIAL_SCREEN_MAD_SCALE,
  buildFingerprint,
  buildTrialScreen,
  classifyFingerprintClass,
  buildWasteTopItems,
  queryWasteTopItems,
} from '@/lib/queries/waste/waste-top-items';
import type { WasteTopItemRow } from '@/lib/queries/waste/waste-top-items';
// FIX (AUDIT-B M2): module-local median/MAD helpers — deep import (the
// barrel deliberately re-exports only the +3 constants; the helpers stay
// module-level exports for vitest, same precedent as buildSusutSpike).
import { medianOf, madOf } from '@/lib/queries/waste/waste-top-items/fingerprint';
import { buildSusutSpike } from '@/lib/queries/waste/network/susut-spike';
import { queryWasteNetwork } from '@/lib/queries/waste/waste-series';
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

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

/** Full top-item row (W11 fields neutral unless overridden). */
function row(overrides: Partial<Record<string, unknown>> = {}): WasteTopItemRow {
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
    susutNominal: 0,
    susutQty: 0,
    trialNominal: 0,
    trialQty: 0,
    bomQty: 0,
    trialMonthsActive: 0,
    susutShare: 0,
    trialShare: 0,
    susutCumulativeShare: 0,
    trialCumulativeShare: 0,
    fingerprint: null,
    ...overrides,
  } as WasteTopItemRow;
}

/** Round-1 raw row (untyped mock shape — toNum coerces what's absent). */
function rawItemRow(overrides: Record<string, number | bigint | string | null> = {}) {
  return {
    itemId: 1,
    itemName: 'KULIT PANGSIT',
    satuan: 'KG',
    totalWaste: 100,
    wasteQty: 500,
    totalSusut: 0,
    susutQty: 0,
    totalTrial: 0,
    trialQty: 0,
    bomQty: 0,
    trialMonthsActive: 0,
    outletsActive: 3,
    monthsActive: 7,
    lastMonthWaste: 40,
    prevMonthWaste: 60,
    populationTotal: 1000,
    susutPopulationTotal: 0,
    trialPopulationTotal: 0,
    ...overrides,
  };
}

/** WasteMonthlyRow fixture (susut spike builder input). */
function monthRow(overrides: Partial<Record<string, number | string | boolean>> = {}): WasteMonthlyRow {
  return {
    outletCode: '1357.TJPPLU',
    outletName: 'TJPPLU',
    area: 'JAKARTA 1',
    monthKey: '2026-08',
    monthLabel: 'Agustus 2026',
    sales: 1_000_000,
    waste: 20_000,
    susut: 10_000,
    trial: 2_000,
    residual: 80_000,
    totalLoss: 100_000,
    totalSurplus: 10_000,
    wasteToSales: 0.02,
    wasteShareOfLoss: 0.2,
    residualShare: 0.8,
    spike: false,
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
// 0. Trial-screen tunables (pin the knobs — W1-EXEC house style)
// ------------------------------------------------------------

describe('W11 trial-screen constants', () => {
  it('pins the three documented thresholds', () => {
    expect(WASTE_TRIAL_SCREEN_BOM_RATIO).toBe(0.05);
    expect(WASTE_TRIAL_SCREEN_MIN_MONTHS).toBe(3);
    expect(WASTE_TRIAL_SCREEN_MIN_NOMINAL).toBe(100_000);
  });

  it('FIX (AUDIT-B M2): pins the two-tier OUTLIER knobs (drift alarm)', () => {
    expect(WASTE_TRIAL_SCREEN_OUTLIER_Z).toBe(3);
    expect(WASTE_TRIAL_SCREEN_MIN_POPULATION).toBe(5);
    // Φ⁻¹(0.75) — the same consistency constant as rate-league's robust-z.
    expect(WASTE_TRIAL_SCREEN_MAD_SCALE).toBe(1.4826);
  });
});

// ------------------------------------------------------------
// 1. classifyFingerprintClass
// ------------------------------------------------------------

describe('classifyFingerprintClass', () => {
  it('max share wins for each class', () => {
    expect(classifyFingerprintClass(0.62, 0.31, 0.07)).toBe('W-DOMINANT');
    expect(classifyFingerprintClass(0.31, 0.62, 0.07)).toBe('S-DOMINANT');
    expect(classifyFingerprintClass(0.07, 0.31, 0.62)).toBe('T-DOMINANT');
  });

  it('tie rule: W > S > T (documented priority chain)', () => {
    // Three-way tie (1/3 each) → W-DOMINANT (first in the chain).
    expect(classifyFingerprintClass(1 / 3, 1 / 3, 1 / 3)).toBe('W-DOMINANT');
    // W==S tie above T → W-DOMINANT.
    expect(classifyFingerprintClass(0.45, 0.45, 0.10)).toBe('W-DOMINANT');
    // S==T tie above W → S-DOMINANT.
    expect(classifyFingerprintClass(0.10, 0.45, 0.45)).toBe('S-DOMINANT');
  });

  it('guard: explained == 0 (all shares ≤ 0) → null (TANPA EXPLAINED)', () => {
    expect(classifyFingerprintClass(0, 0, 0)).toBeNull();
  });

  it('near-tie still resolves by max (no minimum margin)', () => {
    // 0.34 vs 0.33 — the documented no-margin rule: max wins; the UI
    // shows the exact shares so a near-tie reads as a near-tie.
    expect(classifyFingerprintClass(0.34, 0.33, 0.33)).toBe('W-DOMINANT');
    expect(classifyFingerprintClass(0.33, 0.34, 0.33)).toBe('S-DOMINANT');
  });
});

// ------------------------------------------------------------
// 2. buildFingerprint
// ------------------------------------------------------------

describe('buildFingerprint', () => {
  it('computes the W/S/T shares of explained loss (hand-checked) + classCounts + purity', () => {
    const items = [
      // explained = 6.2+3.1+0.7 = 10 → W 0.62 / S 0.31 / T 0.07.
      { itemId: 1, totalWaste: 6.2, susutNominal: 3.1, trialNominal: 0.7 },
      // explained = 0 → TANPA EXPLAINED.
      { itemId: 2, totalWaste: 0, susutNominal: 0, trialNominal: 0 },
      // explained = 1 → T 1.0.
      { itemId: 3, totalWaste: 0, susutNominal: 0, trialNominal: 150_000 },
    ];
    const input = items.map((i) => ({ ...i }));
    const { perItem, summary } = buildFingerprint(items);

    expect(perItem.get(1)?.shareW).toBeCloseTo(0.62, 10);
    expect(perItem.get(1)?.shareS).toBeCloseTo(0.31, 10);
    expect(perItem.get(1)?.shareT).toBeCloseTo(0.07, 10);
    expect(perItem.get(1)?.explainedNominal).toBeCloseTo(10, 10);
    expect(perItem.get(1)?.fingerprintClass).toBe('W-DOMINANT');
    expect(perItem.get(2)?.fingerprintClass).toBeNull();
    expect(perItem.get(2)?.explainedNominal).toBe(0);
    expect(perItem.get(3)?.fingerprintClass).toBe('T-DOMINANT');
    expect(perItem.get(3)?.shareT).toBe(1);

    expect(summary.classCounts).toEqual({ wDominant: 1, sDominant: 0, tDominant: 1, tanpaExplained: 1 });
    expect(summary.epistemicLabel).toBe('INDIKASI');
    // Purity: the input rows are not mutated (no fingerprint assigned).
    expect(input[0]).toEqual(items[0]);
  });

  it('bigint/null leakage is coerced (defensive toNum)', () => {
    const { perItem } = buildFingerprint([
      // BigInt/null inputs exercise the builder's defensive coercion
      // (raw-row leakage) — cast because the BUILT row type is number.
      {
        itemId: 1,
        totalWaste: BigInt(300),
        susutNominal: BigInt(100),
        trialNominal: null,
      } as unknown as Parameters<typeof buildFingerprint>[0][number],
    ]);
    expect(perItem.get(1)?.explainedNominal).toBe(400);
    expect(perItem.get(1)?.shareW).toBeCloseTo(0.75, 10);
    expect(perItem.get(1)?.fingerprintClass).toBe('W-DOMINANT');
  });
});

// ------------------------------------------------------------
// 3. buildTrialScreen
// ------------------------------------------------------------

describe('buildTrialScreen', () => {
  it('screens an item passing ALL THREE signals (ratio + persistence + value) — BLATAN tier recorded', () => {
    const items = [
      row({
        itemId: 7,
        itemName: 'AYAM CINCANG',
        trialQty: 600, bomQty: 10_000,   // ratio 0.06 ≥ 0.05
        trialMonthsActive: 5,             // ≥ 3
        trialNominal: 150_000,            // ≥ 100_000
        fingerprint: { shareW: 0, shareS: 0, shareT: 1, explainedNominal: 150_000, fingerprintClass: 'T-DOMINANT' },
      }),
    ];
    const screen = buildTrialScreen(items);
    expect(screen).toHaveLength(1);
    expect(screen[0].itemId).toBe(7);
    expect(screen[0].trialToBom).toBeCloseTo(0.06, 10);
    expect(screen[0].trialMonthsActive).toBe(5);
    expect(screen[0].trialNominal).toBe(150_000);
    // FIX (AUDIT-B M2): the tier disclosure pair — absolute bar fired.
    expect(screen[0].ratioSignal).toBe('BLATAN');
    expect(screen[0].ratioThreshold).toBe(0.05);
    expect(screen[0].fingerprintClass).toBe('T-DOMINANT');
    expect(screen[0].epistemicLabel).toBe('INDIKASI');
  });

  it('each signal alone is NOT enough (conservative AND screen)', () => {
    // Ratio OK, persistence OK, value too low → not screened.
    expect(buildTrialScreen([row({ trialQty: 600, bomQty: 10_000, trialMonthsActive: 5, trialNominal: 99_999 })])).toEqual([]);
    // Ratio OK, value OK, only 2 persistent months → not screened.
    expect(buildTrialScreen([row({ trialQty: 600, bomQty: 10_000, trialMonthsActive: 2, trialNominal: 150_000 })])).toEqual([]);
    // Persistence OK, value OK, ratio below → not screened.
    expect(buildTrialScreen([row({ trialQty: 499, bomQty: 10_000, trialMonthsActive: 5, trialNominal: 150_000 })])).toEqual([]);
  });

  it('boundary values are INCLUSIVE (≥ thresholds — both signal-1 tiers)', () => {
    // Absolute bar EXACTLY at 0.05 (single item — n < 5, outlier tier off).
    const screen = buildTrialScreen([
      row({ trialQty: 500, bomQty: 10_000, trialMonthsActive: 3, trialNominal: 100_000 }),
    ]);
    expect(screen).toHaveLength(1);
    expect(screen[0].ratioSignal).toBe('BLATAN');
    expect(screen[0].ratioThreshold).toBe(0.05);
  });

  it('bomQty = 0 → ratio null → NOT screened (no usage basis)', () => {
    const screen = buildTrialScreen([
      row({ trialQty: 600, bomQty: 0, trialMonthsActive: 9, trialNominal: 500_000 }),
    ]);
    expect(screen).toEqual([]);
  });

  it('empty input → empty screen', () => {
    expect(buildTrialScreen([])).toEqual([]);
  });

  // ----------------------------------------------------------
  // FIX (AUDIT-B M2) — the two-tier signal-1 (BLATAN | OUTLIER).
  // Population fixtures: 5 items, bomQty 10_000 each → ratios are
  // trialQty/10_000. Hand-computed (see each case).
  // ----------------------------------------------------------

  it('FIX (AUDIT-B M2): OUTLIER tier fires — a 3σ+ item screens below the 5% absolute bar', () => {
    // Ratios [0.001, 0.001, 0.002, 0.002, 0.02]: median 0.002,
    // MAD 0.001 → threshold 0.002 + 3×1.4826×0.001 = 0.0064478.
    // The 0.02 item (2% — BELOW the 5% absolute bar, the live-like case)
    // clears the robust threshold → screens as OUTLIER with the exact
    // threshold recorded. Peers fail signals 2/3 anyway.
    const items = [
      row({ itemId: 1, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 2, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 3, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 4, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 5, itemName: 'SURAI NAGA', trialQty: 200, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
    ];
    const screen = buildTrialScreen(items);
    expect(screen).toHaveLength(1);
    expect(screen[0].itemId).toBe(5);
    expect(screen[0].trialToBom).toBeCloseTo(0.02, 10);
    expect(screen[0].ratioSignal).toBe('OUTLIER');
    expect(screen[0].ratioThreshold).toBeCloseTo(0.0064478, 10);
    expect(screen[0].epistemicLabel).toBe('INDIKASI');
  });

  it('FIX (AUDIT-B M2): guard population < 5 items → ONLY the absolute bar (no outlier tier)', () => {
    // 4 items, ratios [0.001, 0.001, 0.002, 0.03]: the 0.03 item PASSES
    // signals 2/3 and would clear a robust threshold on this population
    // (n≥5-computed: 0.0064478 < 0.03, see the second half) — but n = 4
    // < 5 → tier OFF, and 0.03 < the 5% absolute bar → empty screen. The
    // guard is what blocks it (not the signals).
    const items = [
      row({ itemId: 1, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 2, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 3, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 4, trialQty: 300, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
    ];
    expect(buildTrialScreen(items)).toEqual([]);
    // Same population + one more peer (n = 5, ratios
    // [0.001, 0.001, 0.002, 0.03, 0.002]: median 0.002, MAD 0.001 →
    // threshold 0.0064478) → the tier comes alive and the 0.03 item
    // screens as OUTLIER — proving the n=4 block above was the GUARD.
    const withFifth = [...items, row({ itemId: 5, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 })];
    const screen = buildTrialScreen(withFifth);
    expect(screen).toHaveLength(1);
    expect(screen[0].itemId).toBe(4);
    expect(screen[0].ratioSignal).toBe('OUTLIER');
    expect(screen[0].ratioThreshold).toBeCloseTo(0.0064478, 10);
  });

  it('FIX (AUDIT-B M2): guard MAD = 0 (majority on the median) → ONLY the absolute bar', () => {
    // 5 items, ratios [0.01, 0.01, 0.01, 0.01, 0.04]: median 0.01, devs
    // [0,0,0,0,0.03] → MAD 0 → no scale, tier OFF. The 0.04 item passes
    // signals 2/3 but sits below the 5% absolute bar → empty screen.
    const items = [
      row({ itemId: 1, trialQty: 100, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 2, trialQty: 100, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 3, trialQty: 100, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 4, trialQty: 100, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 5, trialQty: 400, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
    ];
    expect(buildTrialScreen(items)).toEqual([]);
    // An item ≥ 5% still screens via the absolute bar under MAD = 0 —
    // the tier guard degrades, it never disables the screen.
    const blatant = buildTrialScreen([
      ...items.slice(0, 4),
      row({ itemId: 5, trialQty: 600, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
    ]);
    expect(blatant).toHaveLength(1);
    expect(blatant[0].ratioSignal).toBe('BLATAN');
  });

  it('FIX (AUDIT-B M2): BLATAN precedence — an item ≥ 5% that is ALSO an outlier records the absolute bar', () => {
    // Ratios [0.001, 0.001, 0.002, 0.002, 0.06]: threshold 0.0064478 — the
    // 0.06 item clears BOTH tiers; the absolute bar is the stronger,
    // population-independent reading, so it wins and ratioThreshold is
    // the 0.05 bar (NOT the robust threshold).
    const items = [
      row({ itemId: 1, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 2, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 3, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 4, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 5, trialQty: 600, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
    ];
    const screen = buildTrialScreen(items);
    expect(screen).toHaveLength(1);
    expect(screen[0].ratioSignal).toBe('BLATAN');
    expect(screen[0].ratioThreshold).toBe(0.05);
    expect(screen[0].ratioThreshold).not.toBeCloseTo(0.0064478, 10);
  });

  it('FIX (AUDIT-B M2): zero-trial items JOIN the baseline at ratio 0 (the median reflects them)', () => {
    // Ratios [0, 0, 0.001, 0.002, 0.02]: WITH the two zero-trial items the
    // median is 0.001 → threshold 0.0054478; WITHOUT them it would be
    // 0.002 → 0.0064478. The recorded ratioThreshold pins the INCLUSIVE
    // median (zero-inflation honesty — rate-league precedent).
    const items = [
      row({ itemId: 1, trialQty: 0, bomQty: 10_000, trialNominal: 0, trialMonthsActive: 0 }),
      row({ itemId: 2, trialQty: 0, bomQty: 10_000, trialNominal: 0, trialMonthsActive: 0 }),
      row({ itemId: 3, trialQty: 10, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 4, trialQty: 20, bomQty: 10_000, trialNominal: 5_000, trialMonthsActive: 1 }),
      row({ itemId: 5, trialQty: 200, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
    ];
    const screen = buildTrialScreen(items);
    expect(screen).toHaveLength(1);
    expect(screen[0].itemId).toBe(5);
    expect(screen[0].ratioSignal).toBe('OUTLIER');
    expect(screen[0].ratioThreshold).toBeCloseTo(0.0054478, 10);
    // Direct helper pins (the same population, hand-computed):
    expect(medianOf([0, 0, 0.001, 0.002, 0.02])).toBeCloseTo(0.001, 12);
    expect(madOf([0, 0, 0.001, 0.002, 0.02], 0.001)).toBeCloseTo(0.001, 12);
  });

  it('FIX (AUDIT-B M2): is PURE — the input rows are not mutated', () => {
    const items = [
      row({ itemId: 1, trialQty: 10, bomQty: 10_000 }),
      row({ itemId: 2, trialQty: 200, bomQty: 10_000, trialNominal: 150_000, trialMonthsActive: 9 }),
      row({ itemId: 3, trialQty: 20, bomQty: 10_000 }),
      row({ itemId: 4, trialQty: 20, bomQty: 10_000 }),
      row({ itemId: 5, trialQty: 10, bomQty: 10_000 }),
    ];
    const snapshot = items.map((i) => ({ ...i }));
    buildTrialScreen(items);
    expect(items).toEqual(snapshot);
  });
});

// ------------------------------------------------------------
// 3b. FIX (AUDIT-B M2): medianOf / madOf — the module-local robust
//     helpers (deep import; rate-league twins, NOT imported from it)
// ------------------------------------------------------------

describe('medianOf / madOf (trial-screen helpers)', () => {
  it('medianOf: odd → middle, even → mean of the middle pair, empty → null', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBeNull();
    expect(medianOf([5])).toBe(5);
  });

  it('madOf: median of |x − median| (hand-computed), empty → null', () => {
    // [1,2,3,4,5] median 3 → devs [2,1,0,1,2] → MAD 1.
    expect(madOf([1, 2, 3, 4, 5], 3)).toBe(1);
    // NOT scaled by 1.4826 — the scale is applied once, in the threshold.
    expect(madOf([1, 2, 3, 4, 5], 3)).not.toBeCloseTo(1.4826, 10);
    expect(madOf([], 0)).toBeNull();
  });
});

// ------------------------------------------------------------
// 4. buildSusutSpike (network — metric-swap twin of the SQL waste spike)
// ------------------------------------------------------------

describe('buildSusutSpike', () => {
  it('detects a susut/sales spike (hand-computed 2σ over the outlet\'s own 9 valid months)', () => {
    // Ratios: 8 × 0.01 + one 0.30 → mean 0.042222, sample σ 0.096674,
    // mean + 2σ = 0.235570 < 0.30 → exactly one spike month.
    const months = Array.from({ length: 9 }, (_, i) =>
      monthRow({ monthKey: `2026-0${i + 1}`, susut: i === 8 ? 300_000 : 10_000 }));
    const [outlet] = buildSusutSpike(months);
    expect(outlet.susutSpikeMonths).toBe(1);
    expect(outlet.susutRatioMonths).toBe(9);
  });

  it('mild variation → no spike (max ratio below mean + 2σ)', () => {
    const ratios = [0.010, 0.012, 0.008, 0.011, 0.009, 0.010, 0.012, 0.008, 0.011];
    const months = ratios.map((r, i) => monthRow({ monthKey: `2026-0${i + 1}`, susut: r * 1_000_000 }));
    const [outlet] = buildSusutSpike(months);
    expect(outlet.susutSpikeMonths).toBe(0);
    expect(outlet.susutRatioMonths).toBe(9);
  });

  it('constant ratios → σ = 0 guard → no spike (a constant series cannot spike)', () => {
    const months = Array.from({ length: 9 }, (_, i) =>
      monthRow({ monthKey: `2026-0${i + 1}`, susut: 10_000 }));
    const [outlet] = buildSusutSpike(months);
    expect(outlet.susutSpikeMonths).toBe(0);
  });

  it('min-months guard: < 3 valid months → no spike claim (n reported honestly)', () => {
    const months = [
      monthRow({ monthKey: '2026-08', susut: 500_000 }),
      monthRow({ monthKey: '2026-07', susut: 10_000 }),
    ];
    const [outlet] = buildSusutSpike(months);
    expect(outlet.susutSpikeMonths).toBe(0);
    expect(outlet.susutRatioMonths).toBe(2);
  });

  it('sales = 0 months are SKIPPED (FIX 7 discipline — ratio undefined), not forced to 0', () => {
    // 10 months: 8 × 0.01 + one 0.30 (the spike, sales > 0) + one
    // sales=0 month with huge susut. The valid-month count must be 9
    // (the sales=0 month never enters the baseline) and the spike is
    // still exactly the 0.30 month.
    const months = Array.from({ length: 9 }, (_, i) =>
      monthRow({ monthKey: `2026-0${i + 1}`, susut: i === 8 ? 300_000 : 10_000 }));
    months.push(monthRow({ monthKey: '2026-10', sales: 0, susut: 5_000_000 }));
    const [outlet] = buildSusutSpike(months);
    expect(outlet.susutRatioMonths).toBe(9);
    expect(outlet.susutSpikeMonths).toBe(1);
  });

  it('per-outlet grouping: independent baselines per outlet', () => {
    const months = [
      ...Array.from({ length: 9 }, (_, i) =>
        monthRow({ outletCode: 'A', monthKey: `2026-0${i + 1}`, susut: i === 8 ? 300_000 : 10_000 })),
      ...Array.from({ length: 9 }, (_, i) =>
        monthRow({ outletCode: 'B', monthKey: `2026-0${i + 1}`, susut: 10_000 })),
    ];
    const outlets = buildSusutSpike(months);
    expect(outlets).toHaveLength(2);
    const a = outlets.find((o) => o.outletCode === 'A');
    const b = outlets.find((o) => o.outletCode === 'B');
    expect(a?.susutSpikeMonths).toBe(1);
    expect(b?.susutSpikeMonths).toBe(0);
  });

  it('empty input → empty result', () => {
    expect(buildSusutSpike([])).toEqual([]);
  });
});

// ------------------------------------------------------------
// 5. buildWasteTopItems — metric param (breakdown slice + parity shares)
// ------------------------------------------------------------

describe('buildWasteTopItems (W11 metric param)', () => {
  const breakdown = [
    // waste DESC but susut ASC — the two sorts pick OPPOSITE ends.
    { itemId: 1, outletCode: 'OUT0', outletName: 'O0', area: 'A', waste: 90, susut: 10, trial: 0, monthsActive: 3 },
    { itemId: 1, outletCode: 'OUT1', outletName: 'O1', area: 'A', waste: 80, susut: 20, trial: 0, monthsActive: 3 },
    { itemId: 1, outletCode: 'OUT2', outletName: 'O2', area: 'A', waste: 70, susut: 30, trial: 0, monthsActive: 3 },
  ];

  it('default metric stays waste: breakdown sorted by waste (pre-W11 behavior)', () => {
    const result = buildWasteTopItems([rawItemRow({ totalWaste: 240 })], breakdown, 9);
    expect(result.metric).toBe('waste');
    expect(result.items[0].byOutlet[0].outletCode).toBe('OUT0');
  });

  it("metric='susut': breakdown sorted (and capped) by the susut field", () => {
    const result = buildWasteTopItems([rawItemRow({ totalWaste: 240 })], breakdown, 9, 'susut');
    expect(result.items[0].byOutlet[0].outletCode).toBe('OUT2');
    expect(result.items[0].byOutlet[0].susut).toBe(30);
  });

  it('parity shares + cumulatives are mapped for all three metric families', () => {
    const result = buildWasteTopItems(
      [
        rawItemRow({ itemId: 1, totalWaste: 600, totalSusut: 300, totalTrial: 100, populationTotal: 1000, susutPopulationTotal: 500, trialPopulationTotal: 200 }),
        rawItemRow({ itemId: 2, totalWaste: 400, totalSusut: 200, totalTrial: 100, populationTotal: 1000, susutPopulationTotal: 500, trialPopulationTotal: 200 }),
      ],
      [],
      9,
    );
    const [a, b] = result.items;
    expect(a.share).toBeCloseTo(0.6, 10);
    expect(a.susutShare).toBeCloseTo(0.6, 10);
    expect(a.trialShare).toBeCloseTo(0.5, 10);
    expect(a.susutCumulativeShare).toBeCloseTo(0.6, 10);
    expect(b.susutCumulativeShare).toBeCloseTo(1.0, 10);
    expect(b.trialCumulativeShare).toBeCloseTo(1.0, 10);
    expect(result.susutPopulationTotal).toBe(500);
    expect(result.trialPopulationTotal).toBe(200);
    // Additive defaults on the pure path (query edge fills them).
    expect(a.fingerprint).toBeNull();
    expect(result.fingerprint).toBeNull();
    expect(result.trialScreen).toEqual([]);
  });

  it('zero populations guard the parity shares to 0', () => {
    const result = buildWasteTopItems([rawItemRow({ totalSusut: 100, susutPopulationTotal: 0 })], [], 9);
    expect(result.items[0].susutShare).toBe(0);
    expect(result.items[0].susutCumulativeShare).toBe(0);
  });

  it('empty input carries the metric echo + W11 defaults', () => {
    const result = buildWasteTopItems([], [], 9, 'trial');
    expect(result.metric).toBe('trial');
    expect(result.susutPopulationTotal).toBe(0);
    expect(result.trialPopulationTotal).toBe(0);
    expect(result.fingerprint).toBeNull();
    expect(result.trialScreen).toEqual([]);
  });
});

/**
 * deepText over the WHOLE $queryRaw call renders the static template
 * text (value gaps blank) + each argument appended after — the ORDER BY
 * column arrives as an interpolated Prisma.Sql ARGUMENT, so pin it via
 * this helper: renders every argument of the call separately.
 */
function callArgs(call: unknown[]): string[] {
  return call.map(deepText);
}

// ------------------------------------------------------------
// 6. queryWasteTopItems — the W11 SQL + wiring (db-mock)
// ------------------------------------------------------------

describe('queryWasteTopItems (W11)', () => {
  function mockFourRounds(itemRows: Array<Record<string, unknown>>) {
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }, { monthKey: '2026-07' }]);
    mockQueryRaw.mockResolvedValueOnce(itemRows);
    mockQueryRaw.mockResolvedValueOnce([]);
    mockQueryRaw.mockResolvedValueOnce([]);
  }

  it('default metric orders by totalWaste (pre-W11 SQL unchanged) + the W11 columns ride round 1', async () => {
    mockFourRounds([rawItemRow({})]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20);
    expect(result.metric).toBe('waste');
    const args = callArgs(mockQueryRaw.mock.calls[1]);
    // The ORDER BY column fragment is an interpolated argument (a
    // literal column reference, never user text) — 'waste' picks
    // ia."totalWaste".
    expect(args).toContain('ia."totalWaste"');
    expect(args).not.toContain('ia."totalSusut"');
    const itemSql = deepText(mockQueryRaw.mock.calls[1]);
    expect(itemSql).toContain('ORDER BY ');
    expect(itemSql).toContain(' DESC, i.name ASC');
    // The W11 aggregates are on the SAME scan (round 1).
    expect(itemSql).toContain('COALESCE(SUM(ABS(ir."nominalSusut"))');
    expect(itemSql).toContain('COALESCE(SUM(ABS(ir."qtySusut"))');
    expect(itemSql).toContain('COALESCE(SUM(ABS(ir."nominalTrial"))');
    expect(itemSql).toContain('COALESCE(SUM(ABS(ir."qtyTrial"))');
    expect(itemSql).toContain('COALESCE(SUM(ABS(ir."qtyBom"))');
    expect(itemSql).toContain('FILTER (WHERE ABS(ir."nominalTrial") > 0) as "trialMonthsActive"');
    expect(itemSql).toContain('SUM(ia."totalSusut") OVER () as "susutPopulationTotal"');
    expect(itemSql).toContain('SUM(ia."totalTrial") OVER () as "trialPopulationTotal"');
    // Round 2 carries the per-outlet susut/trial companions.
    const breakdownSql = deepText(mockQueryRaw.mock.calls[2]);
    expect(breakdownSql).toContain('COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "susut"');
    expect(breakdownSql).toContain('COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "trial"');
    // Round 3 (W3 quadrant distribution) stays waste-only.
    const distributionSql = deepText(mockQueryRaw.mock.calls[3]);
    expect(distributionSql).not.toContain('nominalSusut');
  });

  it("metric='susut' orders the top-N by Σ|nominalSusut| (LIMIT applies AFTER the ordering)", async () => {
    mockFourRounds([rawItemRow({ totalSusut: 300 })]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20, 'susut');
    expect(result.metric).toBe('susut');
    const args = callArgs(mockQueryRaw.mock.calls[1]);
    expect(args).toContain('ia."totalSusut"');
    expect(args).not.toContain('ia."totalWaste"');
    expect(deepText(mockQueryRaw.mock.calls[1])).toContain('ORDER BY ');
  });

  it("metric='trial' orders by Σ|nominalTrial|", async () => {
    mockFourRounds([rawItemRow({ totalTrial: 50 })]);
    await queryWasteTopItems('WEEK 4', '2026-08', {}, 20, 'trial');
    const args = callArgs(mockQueryRaw.mock.calls[1]);
    expect(args).toContain('ia."totalTrial"');
    expect(args).not.toContain('ia."totalWaste"');
    expect(deepText(mockQueryRaw.mock.calls[1])).toContain('ORDER BY ');
  });

  it('wires the fingerprint per item + summary + trial screen (S-DOMINANT fixture)', async () => {
    // explained = 100 + 300 + 0 = 400 → S 0.75 → S-DOMINANT; no trial
    // (trialQty 0) → empty screen.
    mockFourRounds([rawItemRow({ totalWaste: 100, totalSusut: 300 })]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20);
    expect(result.items[0].fingerprint).toEqual({
      shareW: 0.25,
      shareS: 0.75,
      shareT: 0,
      explainedNominal: 400,
      fingerprintClass: 'S-DOMINANT',
    });
    expect(result.fingerprint).toEqual({
      classCounts: { wDominant: 0, sDominant: 1, tDominant: 0, tanpaExplained: 0 },
      epistemicLabel: 'INDIKASI',
    });
    expect(result.trialScreen).toEqual([]);
  });

  it('screens a trial-abusive item end-to-end (T-DOMINANT + all 3 signals)', async () => {
    mockFourRounds([
      rawItemRow({
        itemId: 7,
        itemName: 'AYAM CINCANG',
        totalWaste: 0,
        totalSusut: 0,
        totalTrial: 150_000,
        trialQty: 600,
        bomQty: 10_000,
        trialMonthsActive: 5,
      }),
    ]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20, 'trial');
    expect(result.items[0].fingerprint?.fingerprintClass).toBe('T-DOMINANT');
    expect(result.trialScreen).toHaveLength(1);
    expect(result.trialScreen[0].itemName).toBe('AYAM CINCANG');
    expect(result.trialScreen[0].trialToBom).toBeCloseTo(0.06, 10);
    // FIX (AUDIT-B M2): the two-tier fields ride the query edge too.
    expect(result.trialScreen[0].ratioSignal).toBe('BLATAN');
    expect(result.trialScreen[0].ratioThreshold).toBe(0.05);
    expect(result.trialScreen[0].fingerprintClass).toBe('T-DOMINANT');
    expect(result.fingerprint?.classCounts.tDominant).toBe(1);
  });

  it('explained == 0 → fingerprint null class + tanpaExplained count', async () => {
    mockFourRounds([rawItemRow({ totalWaste: 0, totalSusut: 0, totalTrial: 0 })]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20);
    expect(result.items[0].fingerprint?.fingerprintClass).toBeNull();
    expect(result.fingerprint?.classCounts.tanpaExplained).toBe(1);
  });

  it('susut vs waste ORDERING differ on the SAME fixture (the metric actually reaches the SQL)', async () => {
    // Same mocked rows; only the metric differs → different SQL text.
    mockFourRounds([rawItemRow({ totalWaste: 100, totalSusut: 300 })]);
    await queryWasteTopItems('WEEK 4', '2026-08', {}, 20, 'waste');
    const wasteSql = deepText(mockQueryRaw.mock.calls[1]);
    mockQueryRaw.mockReset();
    mockFourRounds([rawItemRow({ totalWaste: 100, totalSusut: 300 })]);
    await queryWasteTopItems('WEEK 4', '2026-08', {}, 20, 'susut');
    const susutSql = deepText(mockQueryRaw.mock.calls[1]);
    expect(wasteSql).not.toBe(susutSql);
  });
});

// ------------------------------------------------------------
// 7. queryWasteNetwork — susutSpikeMonths wiring (db-mock)
// ------------------------------------------------------------

describe('queryWasteNetwork (W11 susut spike wiring)', () => {
  it('merges susutSpikeMonths onto the outlet rows with ZERO extra SQL round-trips', async () => {
    // One outlet, 9 months, spike on the last (same fixture as the pure
    // builder test: 8 × 0.01 + 0.30 → exactly 1 spike month).
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
    const result = await queryWasteNetwork('WEEK 4', '2026-08', {}, 50_000_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(result.outlets).toHaveLength(1);
    expect(result.outlets[0].susutSpikeMonths).toBe(1);
    // Base fields untouched by the merge (additive-only).
    expect(result.outlets[0].outletCode).toBe('1357.TJPPLU');
    expect(result.outlets[0].waste).toBe(180_000);
    expect(result.outlets[0].susut).toBe(380_000);
  });
});
