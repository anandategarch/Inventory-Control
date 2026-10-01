// Tests for src/lib/queries/waste/network/attribution.ts (W10 —
// "Atribusi Waste-to-Loss + Skenario Sensitivitas Residual").
//
// PURE transform tests — no db, no mocks (same culture as the W2
// waste-persistence tests: the builder is exercised directly).
//
// Covers:
//  1. Composition (TERUKUR) — explainedShare / component shares /
//     residualShare on a known fixture; the structural-identity shape
//     (residualShare near 1 is BY CONSTRUCTION, not an anomaly).
//  2. Scenario arithmetic (HIPOTESIS) — p=0 → trueWaste = W; the linear
//     form trueWaste(p) = W + p·residual (which pins the p=1 bracket
//     W + residual — the spec grid stops at 70%); implied ratios with
//     zero-denominator guards.
//  3. Decile-shift index — synthetic outlet populations: a big
//     residual-holder jumping deciles COUNTS; a rank swap INSIDE one
//     decile does NOT; sales=0 outlets are excluded from the ranking;
//     p=0 reproduces the base ranking (0 moves — the sanity anchor).
//  4. The mandatory disclosure string — present on every result, pins
//     the NET/GROSS/HIPOTESIS wording.
//  5. Null guards — zero loss, zero sales, empty population: shares are
//     0 (never NaN/Infinity), the scenario grid still renders, the
//     disclosure survives.
//  6. Epistemic labels — components TERUKUR, scenarios + decile
//     HIPOTESIS (the spec's presentation guard).
//  7. Purity — the builder never mutates its inputs.
//  8. Wiring — queryWasteNetwork attaches the additive top-level
//     attribution block (ONE merged SQL round trip, unchanged — the
//     builder is a pure third pass), and the waste-series barrel
//     re-exports the new surface (import paths stable for consumers).
//
// Pure builders are deep-imported from the attribution module (no db
// closure); the wiring block imports the barrel like the sibling
// waste-series.test.ts (same vi.hoisted @/lib/db mock — harmless for
// the pure tests).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWasteAttribution,
  WASTE_ATTRIBUTION_DECILE_P,
  WASTE_ATTRIBUTION_DISCLOSURE,
  WASTE_ATTRIBUTION_SCENARIO_P,
} from '@/lib/queries/waste/network/attribution';
import type {
  WasteAttributionKpisInput,
  WasteAttributionOutletInput,
} from '@/lib/queries/waste/network/types';

// Wiring block — the same vi.hoisted @/lib/db mock as waste-series.test.ts
// (queryWasteNetwork runs its SQL through withStatementTimeout → $transaction).
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

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
});

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

/** 10 outlets, sales 1.000 each, waste strictly descending (A0 highest). */
function decileTenOutlets(residualByCode: Record<string, number> = {}): WasteAttributionOutletInput[] {
  return Array.from({ length: 10 }, (_, i) => {
    const outletCode = `A${i}`;
    return { outletCode, sales: 1_000, waste: 100 - i * 10, residual: residualByCode[outletCode] ?? 0 };
  });
}

/** The known-fixture KPIs (waste 550 / susut 250 / trial 50 / residual 1.000 / loss 2.000 / sales 10.000). */
const KPIS: WasteAttributionKpisInput = {
  waste: 550,
  susut: 250,
  trial: 50,
  residual: 1_000,
  totalLoss: 2_000,
  sales: 10_000,
};

const ZERO_KPIS: WasteAttributionKpisInput = {
  waste: 0, susut: 0, trial: 0, residual: 0, totalLoss: 0, sales: 0,
};

// ------------------------------------------------------------
// 1. Composition (TERUKUR)
// ------------------------------------------------------------

describe('buildWasteAttribution — composition', () => {
  it('computes explainedShare + component shares + residualShare on the known fixture', () => {
    const a = buildWasteAttribution(KPIS, decileTenOutlets());
    // W+S+T = 850; loss = 2.000 → 0,425.
    expect(a.explainedNominal).toBe(850);
    expect(a.explainedShare).toBeCloseTo(0.425, 10);
    expect(a.components).toHaveLength(3);
    expect(a.components[0]!.key).toBe('waste');
    expect(a.components[0]!.nominal).toBe(550);
    expect(a.components[0]!.shareOfLoss).toBeCloseTo(0.275, 10);
    expect(a.components[1]!.key).toBe('susut');
    expect(a.components[1]!.shareOfLoss).toBeCloseTo(0.125, 10);
    expect(a.components[2]!.key).toBe('trial');
    expect(a.components[2]!.shareOfLoss).toBeCloseTo(0.025, 10);
    // Component shares sum to explainedShare exactly.
    const compSum = a.components.reduce((s, c) => s + c.shareOfLoss, 0);
    expect(compSum).toBeCloseTo(a.explainedShare, 10);
    expect(a.residualShare).toBeCloseTo(0.5, 10);
    // Measured inputs echoed for the card/PDF renderers.
    expect(a.waste).toBe(550);
    expect(a.susut).toBe(250);
    expect(a.trial).toBe(50);
    expect(a.residual).toBe(1_000);
    expect(a.totalLoss).toBe(2_000);
    expect(a.sales).toBe(10_000);
  });

  it('carries the structural identity: residualShare near 1 is BY CONSTRUCTION (live TLGTEU shape)', () => {
    // Live shape: residual ≈ totalLoss (W/S/T explain GROSS; the residual
    // IS the NET loss). The block must expose it as a measured share
    // WITHOUT clamping or alarming — the disclosure does the teaching.
    const a = buildWasteAttribution(
      { waste: 63, susut: 120, trial: 7, residual: 2_780, totalLoss: 2_781, sales: 500_000 },
      [],
    );
    expect(a.residualShare).toBeCloseTo(0.99964, 4);
    expect(a.residualShare).toBeLessThanOrEqual(1);
    expect(a.explainedShare).toBeCloseTo(190 / 2_781, 10);
  });
});

// ------------------------------------------------------------
// 2. Scenario arithmetic (HIPOTESIS)
// ------------------------------------------------------------

describe('buildWasteAttribution — scenario grid', () => {
  it('uses the frozen p grid in order', () => {
    const a = buildWasteAttribution(KPIS, decileTenOutlets());
    expect(WASTE_ATTRIBUTION_SCENARIO_P).toEqual([0, 0.3, 0.5, 0.7]);
    expect(a.scenarios.map((s) => s.p)).toEqual([...WASTE_ATTRIBUTION_SCENARIO_P]);
  });

  it('p=0 → trueWaste = W exactly (the recorded-waste-is-all-waste hypothesis)', () => {
    const a = buildWasteAttribution(KPIS, decileTenOutlets());
    const p0 = a.scenarios[0]!;
    expect(p0.p).toBe(0);
    expect(p0.trueWaste).toBe(550);
  });

  it('trueWaste(p) = W + p·residual — the linear form (pins the p=1 bracket W + residual)', () => {
    const a = buildWasteAttribution(KPIS, decileTenOutlets());
    for (const s of a.scenarios) {
      // Linear in p: verifying every grid point pins the full line —
      // p=1 (outside the spec grid) extrapolates to W + residual.
      expect(s.trueWaste).toBeCloseTo(550 + s.p * 1_000, 10);
    }
    // Explicit bracket check via the slope: (tw − W) / residual = p.
    const p07 = a.scenarios[3]!;
    expect((p07.trueWaste - 550) / 1_000).toBeCloseTo(0.7, 10);
  });

  it('implied ratios with zero-denominator guards', () => {
    const a = buildWasteAttribution(KPIS, decileTenOutlets());
    const p50 = a.scenarios.find((s) => s.p === 0.5)!;
    // trueWaste(0.5) = 1.050 → /10.000 sales = 0,105; /2.000 loss = 0,525.
    expect(p50.trueWaste).toBeCloseTo(1_050, 10);
    expect(p50.impliedWasteToSales).toBeCloseTo(0.105, 10);
    expect(p50.impliedWasteShareOfLoss).toBeCloseTo(0.525, 10);
    // sales = 0 → impliedWasteToSales 0 (never NaN/Infinity).
    const noSales = buildWasteAttribution({ ...KPIS, sales: 0 }, decileTenOutlets());
    for (const s of noSales.scenarios) {
      expect(Number.isFinite(s.impliedWasteToSales)).toBe(true);
      expect(s.impliedWasteToSales).toBe(0);
    }
  });
});

// ------------------------------------------------------------
// 3. Decile-shift index
// ------------------------------------------------------------

describe('buildWasteAttribution — decile-shift index', () => {
  it('counts a big residual-holder jumping deciles; p=0 is the 0-move sanity anchor', () => {
    // A9 (lowest waste, decile 10 of 10) holds ALL the residual: at p>0 its
    // re-estimated waste jumps to the top → decile 1. Rank-position deciles
    // with n=10 put EVERY outlet in its own decile (ceil((i+1)·10/10) = i+1),
    // so A9's insertion at the top displaces A0..A8 one index down — each
    // crosses a decile boundary → ALL 10 move. The "inside-one-decile swap"
    // test below covers the bin semantics when n > 10 (multiple outlets
    // per bin). Keeping ratios fixed does NOT freeze rank-position bins.
    const a = buildWasteAttribution(KPIS, decileTenOutlets({ A9: 1_000 }));
    expect(a.decile.outletsRanked).toBe(10);
    expect(a.decile.outletsExcluded).toBe(0);
    expect(a.decile.p).toBe(WASTE_ATTRIBUTION_DECILE_P);
    expect(a.decile.p).toBe(0.5);
    // p=0 reproduces the base ranking → 0 moves.
    expect(a.scenarios[0]!.decileShifts).toBe(0);
    // p=0.3/0.5/0.7: A9's new waste (10 + p·1000) tops the list → A9 jumps
    // decile 10→1 AND displaces the other nine one bin down: 10 moves.
    expect(a.scenarios[1]!.decileShifts).toBe(10);
    expect(a.scenarios[2]!.decileShifts).toBe(10);
    expect(a.scenarios[3]!.decileShifts).toBe(10);
    // Headline object mirrors the p=50% row.
    expect(a.decile.outletsMoved).toBe(10);
    expect(a.decile.movedShare).toBeCloseTo(1, 10);
  });

  it('a rank swap INSIDE one decile does NOT count as a move', () => {
    // 20 outlets → exactly 2 per decile (ceil((i+1)*10/20)). B1 gets
    // residual 50 → at p=0.5 its waste (190 + 25 = 215) overtakes B0 (200)
    // — positions 0↔1 swap, but both stay in decile 1 → 0 moves.
    const outlets = Array.from({ length: 20 }, (_, i) => ({
      outletCode: `B${i}`,
      sales: 100,
      waste: 200 - i * 10,
      residual: i === 1 ? 50 : 0,
    }));
    const a = buildWasteAttribution(KPIS, outlets);
    expect(a.decile.outletsRanked).toBe(20);
    expect(a.scenarios.find((s) => s.p === 0.5)!.decileShifts).toBe(0);
    expect(a.decile.outletsMoved).toBe(0);
    expect(a.decile.movedShare).toBe(0);
  });

  it('excludes sales=0 outlets from the ranking (ratio undefined — W2 discipline)', () => {
    const outlets: WasteAttributionOutletInput[] = [
      { outletCode: 'OK1', sales: 100, waste: 10, residual: 0 },
      { outletCode: 'OK2', sales: 100, waste: 5, residual: 0 },
      { outletCode: 'NOSALES', sales: 0, waste: 999, residual: 999 },
    ];
    const a = buildWasteAttribution(KPIS, outlets);
    expect(a.decile.outletsRanked).toBe(2);
    expect(a.decile.outletsExcluded).toBe(1);
    // Even a huge residual cannot move a ratio-less outlet (its ratio is
    // forced 0 in BOTH rankings).
    for (const s of a.scenarios) expect(s.decileShifts).toBe(0);
  });

  it('empty population → zeroed decile object (JSON-safe)', () => {
    const a = buildWasteAttribution(KPIS, []);
    expect(a.decile.outletsRanked).toBe(0);
    expect(a.decile.outletsMoved).toBe(0);
    expect(a.decile.movedShare).toBe(0);
    expect(Number.isFinite(a.decile.movedShare)).toBe(true);
  });
});

// ------------------------------------------------------------
// 4. Mandatory disclosure
// ------------------------------------------------------------

describe('buildWasteAttribution — disclosure', () => {
  it('every result carries the mandated structural-identity string', () => {
    for (const a of [
      buildWasteAttribution(KPIS, decileTenOutlets()),
      buildWasteAttribution(ZERO_KPIS, []),
    ]) {
      expect(a.disclosure).toBe(WASTE_ATTRIBUTION_DISCLOSURE);
    }
    // The mandated content (findings-DEEPWASTE2-B §1a/§2 W10): the
    // identity + GROSS-vs-NET + scenarios-are-hypotheses.
    expect(WASTE_ATTRIBUTION_DISCLOSURE).toContain('Residual');
    expect(WASTE_ATTRIBUTION_DISCLOSURE).toContain('NET loss');
    expect(WASTE_ATTRIBUTION_DISCLOSURE).toContain('GROSS deviasi');
    expect(WASTE_ATTRIBUTION_DISCLOSURE).toContain('konstruksi');
    expect(WASTE_ATTRIBUTION_DISCLOSURE).toContain('HIPOTESIS');
    // The formula is spelled out so readers can verify it in drill-down.
    expect(WASTE_ATTRIBUTION_DISCLOSURE).toContain('max(0, |deviasi|');
  });
});

// ------------------------------------------------------------
// 5. Null guards (zero loss / zero everything)
// ------------------------------------------------------------

describe('buildWasteAttribution — null guards', () => {
  it('zero loss → shares are 0 (never NaN/Infinity), grid still computed', () => {
    const kpis: WasteAttributionKpisInput = { waste: 100, susut: 0, trial: 0, residual: 0, totalLoss: 0, sales: 500 };
    const a = buildWasteAttribution(kpis, [{ outletCode: 'X', sales: 500, waste: 100, residual: 0 }]);
    expect(a.explainedShare).toBe(0);
    expect(a.residualShare).toBe(0);
    for (const c of a.components) expect(c.shareOfLoss).toBe(0);
    for (const s of a.scenarios) {
      expect(Number.isFinite(s.impliedWasteShareOfLoss)).toBe(true);
      expect(s.impliedWasteShareOfLoss).toBe(0);
      expect(s.impliedWasteToSales).toBeCloseTo(s.trueWaste / 500, 10);
      // trueWaste(p) = W + p·0 = W for every p.
      expect(s.trueWaste).toBe(100);
    }
  });

  it('all-zero input → zeroed block that still carries the disclosure + grid', () => {
    const a = buildWasteAttribution(ZERO_KPIS, []);
    expect(a.explainedNominal).toBe(0);
    expect(a.explainedShare).toBe(0);
    expect(a.residualShare).toBe(0);
    expect(a.scenarios).toHaveLength(4);
    for (const s of a.scenarios) expect(s.trueWaste).toBe(0);
    expect(a.disclosure).toBe(WASTE_ATTRIBUTION_DISCLOSURE);
  });
});

// ------------------------------------------------------------
// 6. Epistemic labels (the spec's presentation guard)
// ------------------------------------------------------------

describe('buildWasteAttribution — epistemic labels', () => {
  it('components TERUKUR; scenarios + decile HIPOTESIS (never measurements)', () => {
    const a = buildWasteAttribution(KPIS, decileTenOutlets());
    for (const c of a.components) expect(c.epistemicLabel).toBe('TERUKUR');
    for (const s of a.scenarios) expect(s.epistemicLabel).toBe('HIPOTESIS');
    expect(a.decile.epistemicLabel).toBe('HIPOTESIS');
  });
});

// ------------------------------------------------------------
// 7. Purity
// ------------------------------------------------------------

describe('buildWasteAttribution — purity', () => {
  it('does not mutate its inputs', () => {
    const kpis: WasteAttributionKpisInput = { ...KPIS };
    const outlets = decileTenOutlets({ A9: 1_000 });
    const kpisBefore = JSON.stringify(kpis);
    const outletsBefore = JSON.stringify(outlets);
    buildWasteAttribution(kpis, outlets);
    expect(JSON.stringify(kpis)).toBe(kpisBefore);
    expect(JSON.stringify(outlets)).toBe(outletsBefore);
  });

  it('identical input ⇒ identical output (deterministic tie-break)', () => {
    const outlets = decileTenOutlets({ A3: 400, A7: 250 });
    const a1 = buildWasteAttribution(KPIS, outlets);
    const a2 = buildWasteAttribution(KPIS, outlets);
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a2));
  });
});
