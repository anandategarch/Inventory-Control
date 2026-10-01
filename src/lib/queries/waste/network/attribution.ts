// ============================================================
//  W10 — Atribusi Waste-to-Loss + Skenario Sensitivitas Residual
//  (PURE builder — additive pass over queryWasteNetwork's outputs)
//  --------------------------------------------------------
//  Business question (findings-DEEPWASTE2-B §2 W10): "Kalau W/S/T
//  saya percaya, berapa % loss yang benar-benar terjelaskan?
//  Kesimpulan saya seberapa ROBUST terhadap asumsi bahwa residual
//  bukan waste tak-tercatat?"
//
//  Input  : the WasteKpis block + the outlets array ALREADY computed
//           by queryWasteNetwork (structural input types below — the
//           full server shapes satisfy them, and the decomposition
//           card builds the same aggregates from the monthly rows).
//           No SQL, no db — pure third pass (house compute/classify
//           split, same as ./persistence.ts for W2).
//  Output : the top-level `attribution` block — measured loss-side
//           composition (W/S/T shares + residualShare), the HIPOTESIS
//           scenario table p ∈ {0, 30, 50, 70}% and the decile-shift
//           index, plus the mandatory structural disclosure.
//
//  METHODOLOGICAL DECISIONS (all pinned by tests):
//   1. Loss-side convention (BUGHUNT-R1 FIX 5 family): every share
//      uses totalLoss as the denominator and the loss-side residual
//      as the unexplained part — the SAME grain the waste-series
//      SQL aggregates, so explainedShare + residualShare read as one
//      decomposition (they do NOT have to sum to 1: W/S/T are summed
//      over ALL records while residual/totalLoss are loss-side only).
//   2. STRUCTURAL IDENTITY (mandatory disclosure on EVERY surface —
//      findings-DEEPWASTE2-B §1a): per record,
//        residual = sign(dev) × max(0, |dev| − (|W|+|S|+|T|))
//        net      = dev − sign(dev) × (|W|+|S|+|T|)
//      (engine/transform.ts computeResidual/deriveRecord), so on a
//      LOSS row |residual| ≡ |net loss| BY CONSTRUCTION (live check:
//      TLGTEU residual 43.925.875,94 vs totalLoss 43.925.875,95 —
//      identical to the last rupiah; the cents differ only where
//      Excel's own Loss/Surplus column disagrees with the computed
//      net inside the NET_DEVIATION_MISMATCH tolerance). A
//      residualShare near 1 is therefore a property of the DATA
//      MODEL, not evidence that "~100% of loss vanished" — W/S/T
//      explain the GROSS deviation, the residual IS the NET loss.
//      The scenario table below is the honest way to ask "what if
//      part of that NET were unrecorded waste".
//   3. Scenarios are HIPOTESIS, never measurements: trueWaste(p) =
//      W + p·residual assumes p of the loss-side residual is waste
//      that was never recorded. p=0 (nothing hidden — the recorded
//      waste IS all the waste) and p=1 (all residual is hidden
//      waste) bracket the truth; 0.5 is the headline sensitivity.
//      Deterministic arithmetic — no statistical claim, no outlet
//      accusation without W9 triangulation (spec guard).
//   4. Decile-shift index: outlets are ranked by window wasteToSales
//      DESC (tie-break outletCode ASC — the same deterministic
//      convention as buildWasteOutlets' competition rank) and binned
//      into deciles 1..10 (decile 1 = the top 10%); under a scenario
//      p every outlet's waste is re-estimated as waste + p·residual,
//      re-ranked, and the index counts outlets whose decile CHANGED
//      (≥ 1 decile). Computed per scenario p so the table can show
//      the shift next to each hypothesis; the block's headline
//      `decile` object is the p = 50% row.
//   5. Ranking population = outlets with sales > 0 ONLY: the
//      wasteToSales ratio is undefined on sales=0 months (the SQL
//      emits NULL and buildWasteMonthlyRows forces 0 — a FORCED
//      value, not a real 0). Following the W2 persistence
//      discipline, sales=0 outlets are excluded from the deciles and
//      reported separately as `outletsExcluded` so the index is not
//      diluted by ratio-less outlets.
//   6. Zero guards: every share is 0 (never NaN/±Infinity — JSON
//      safe) when its denominator is 0; an empty population yields a
//      zeroed block that still carries the disclosure.
// ============================================================
import type {
  WasteAttributionComponent,
  WasteAttributionDecile,
  WasteAttributionKpisInput,
  WasteAttributionOutletInput,
  WasteAttributionResult,
  WasteAttributionScenario,
} from './types';

/**
 * Scenario grid for the attribution table — the spec's p ∈ {0%, 30%,
 * 50%, 70%} of the loss-side residual treated as unrecorded waste.
 * Frozen on purpose: the card/PDF pin row ORDER to this constant.
 */
export const WASTE_ATTRIBUTION_SCENARIO_P = [0, 0.3, 0.5, 0.7] as const;

/** Headline decile-shift scenario (the "p=50%" sensitivity index). */
export const WASTE_ATTRIBUTION_DECILE_P = 0.5;

/**
 * MANDATORY structural disclosure — must surface on EVERY W10
 * surface (API block, decomposition-card subsection, executive line
 * tooltip, PDF section). Wording pins the identity to the engine's
 * own formula so the reader can verify it in FormulaInfo/drill-down.
 */
export const WASTE_ATTRIBUTION_DISCLOSURE =
  'Residual \u2248 NET loss secara konstruksi (residual = tanda \u00D7 max(0, |deviasi| \u2212 (|W|+|S|+|T|))): ' +
  'W/S/T menjelaskan porsi GROSS deviasi, bukan NET loss \u2014 residualShare yang mendekati 1 adalah properti ' +
  'struktur data, bukan bukti loss \u201Chilang\u201D. Skenario p adalah HIPOTESIS atas asumsi \u201Cresidual = ' +
  'waste tak tercatat\u201D, bukan pengukuran.';

// ------------------------------------------------------------
// Decile binning (pure, internal — pinned through the builder tests)
// ------------------------------------------------------------

/**
 * Rank-position decile: decile 1 = the top 10% of the population.
 * ceil((index0 + 1) × 10 / n) puts index 0 in decile 1 and the last
 * index in decile 10; clamped defensively for rounding edge cases.
 */
function decileOfIndex(index0: number, n: number): number {
  return Math.min(10, Math.max(1, Math.ceil(((index0 + 1) * 10) / n)));
}

/**
 * Decile per outletCode over a ratio ranking (ratio DESC, outletCode
 * ASC tie-break — deterministic, the buildWasteOutlets convention).
 * Returns an empty Map for an empty population.
 */
function decilesByOutlet(
  rows: ReadonlyArray<{ outletCode: string; ratio: number }>,
): Map<string, number> {
  const n = rows.length;
  const out = new Map<string, number>();
  if (n === 0) return out;
  const sorted = rows
    .slice()
    .sort((a, b) => b.ratio - a.ratio || a.outletCode.localeCompare(b.outletCode));
  sorted.forEach((r, i) => out.set(r.outletCode, decileOfIndex(i, n)));
  return out;
}

// ------------------------------------------------------------
// buildWasteAttribution — the pure builder
// ------------------------------------------------------------

/**
 * Loss-side attribution composition + residual sensitivity scenarios
 * from the network KPIs + per-outlet window aggregates. Pure —
 * identical input ⇒ identical output (vitest tests this directly,
 * no db). See the module header for the decision log.
 */
export function buildWasteAttribution(
  kpis: WasteAttributionKpisInput,
  outlets: ReadonlyArray<WasteAttributionOutletInput>,
): WasteAttributionResult {
  const { waste, susut, trial, residual, totalLoss, sales } = kpis;

  // ---- Measured composition (TERUKUR) ----
  const explainedNominal = waste + susut + trial;
  // Zero guards: 0 (never NaN/±Infinity) when the denominator is 0 —
  // same convention as buildWasteMonthlyRows' share fields.
  const explainedShare = totalLoss > 0 ? explainedNominal / totalLoss : 0;
  const residualShare = totalLoss > 0 ? residual / totalLoss : 0;
  const components: WasteAttributionComponent[] = [
    { key: 'waste', label: 'Waste', nominal: waste, shareOfLoss: totalLoss > 0 ? waste / totalLoss : 0, epistemicLabel: 'TERUKUR' },
    { key: 'susut', label: 'Susut', nominal: susut, shareOfLoss: totalLoss > 0 ? susut / totalLoss : 0, epistemicLabel: 'TERUKUR' },
    { key: 'trial', label: 'Trial', nominal: trial, shareOfLoss: totalLoss > 0 ? trial / totalLoss : 0, epistemicLabel: 'TERUKUR' },
  ];

  // ---- Decile ranking population (decision 5) ----
  const ranked = outlets.filter((o) => o.sales > 0);
  const baseDeciles = decilesByOutlet(
    ranked.map((o) => ({ outletCode: o.outletCode, ratio: o.waste / o.sales })),
  );

  // ---- Scenario table (HIPOTESIS — decision 3) ----
  const scenarios: WasteAttributionScenario[] = WASTE_ATTRIBUTION_SCENARIO_P.map((p) => {
    const trueWaste = waste + p * residual;
    // Re-estimate every ranked outlet's waste at this p and count the
    // decile moves vs the base ranking (decision 4). p=0 reproduces the
    // base ranking exactly → 0 moves (a sanity anchor the tests pin).
    const shiftedDeciles = decilesByOutlet(
      ranked.map((o) => ({ outletCode: o.outletCode, ratio: (o.waste + p * o.residual) / o.sales })),
    );
    let decileShifts = 0;
    for (const [code, d] of shiftedDeciles) {
      if (baseDeciles.get(code) !== d) decileShifts++;
    }
    return {
      p,
      trueWaste,
      impliedWasteToSales: sales > 0 ? trueWaste / sales : 0,
      impliedWasteShareOfLoss: totalLoss > 0 ? trueWaste / totalLoss : 0,
      decileShifts,
      epistemicLabel: 'HIPOTESIS',
    };
  });

  // Headline decile-shift index = the p = 50% scenario row (the const
  // grid always contains it; the guard keeps hand-built grids honest).
  const headline =
    scenarios.find((s) => s.p === WASTE_ATTRIBUTION_DECILE_P) ??
    scenarios[scenarios.length - 1];
  const decile: WasteAttributionDecile = {
    p: WASTE_ATTRIBUTION_DECILE_P,
    outletsRanked: ranked.length,
    outletsExcluded: outlets.length - ranked.length,
    outletsMoved: headline ? headline.decileShifts : 0,
    movedShare: ranked.length > 0 && headline ? headline.decileShifts / ranked.length : 0,
    epistemicLabel: 'HIPOTESIS',
  };

  return {
    // Measured inputs echoed (TERUKUR) — the card/PDF render these
    // straight from the block instead of re-deriving them.
    sales,
    waste,
    susut,
    trial,
    residual,
    totalLoss,
    explainedNominal,
    explainedShare,
    residualShare,
    components,
    scenarios,
    decile,
    // Mandatory structural identity disclosure (decision 2) — every
    // surface that renders this block must also render this string.
    disclosure: WASTE_ATTRIBUTION_DISCLOSURE,
  };
}
