// ============================================================
//  Waste Top Items — W11 "Paritas Susut & Trial" (pure builders)
//  --------------------------------------------------------
//  Business question (findings-DEEPWASTE2-B §2 W11): "Susut saya
//  1,8× waste — bahan perishable mana yang SUSUT-driven
//  (penyimpanan/cold-chain) vs WASTE-driven (prep)? Trial dipakai
//  wajar (R&D) atau keran pembuangan?"
//
//  Two pure passes over the BUILT top-item rows (which already carry
//  the W11 additive aggregates Σ|nominal|/Σ|qty| for waste/susut/
//  trial + Σ|qtyBom| + trialMonthsActive — all gained by the SAME
//  round-1 aggregate scan, zero extra round trips):
//
//  1. FINGERPRINT — per-item composition of the EXPLAINED loss
//     (w + s + t, all Σ|nominal|): shareW/shareS/shareT + class
//     W-DOMINANT / S-DOMINANT / T-DOMINANT.
//  2. TRIAL-ABUSE SCREEN — items where "trial" looks like a drain
//     rather than R&D (3 documented signals, all must hold).
//
//  METHODOLOGICAL DECISIONS (all pinned by tests):
//   a. Classification = SIMPLE MAX-SHARE over (shareW, shareS, shareT)
//      with a deterministic tie-break priority W > S > T (waste is the
//      module's named subject; then susut; then trial). Exact ties are
//      measure-zero on real data but must be deterministic for tests.
//      NO minimum-margin is imposed: with three components the max
//      share is always ≥ 1/3, so a "no dominance" zone would need a
//      fourth class the spec does not define; a 34/33 near-tie instead
//      reads as a near-tie because the UI shows the exact shares.
//   b. Guard: explained == 0 (w = s = t = 0) → class null, shares 0 —
//      "TANPA EXPLAINED": there is no decomposition to dominate
//      (the item's loss, if any, is all residual — see W10's
//      residual ≈ NET-loss-by-construction disclosure).
//   c. T-DOMINANT is always presented with the INDIKASI epistemic
//      label (house convention): the trial ACCOUNT SEMANTICS are
//      unverified — "trial" rows may be genuine R&D sampling or a
//      dumping ground; the fingerprint only says trial dominates the
//      explained loss, never which. W/S-DOMINANT carry the same
//      pattern-not-root-cause caveat (the summary's epistemicLabel).
//   d. Trial screen signals (documented tunables in ./constants.ts):
//        ratio       : trialQty / bomQty ≥ WASTE_TRIAL_SCREEN_BOM_RATIO
//                      (unitless — same item/satuan on both sides; null
//                      when bomQty = 0 → NOT screened, no usage basis)
//        persistence : trialMonthsActive ≥ WASTE_TRIAL_SCREEN_MIN_MONTHS
//                      (months with trial > 0 — FIX 1 discipline)
//        high-value  : trialNominal ≥ WASTE_TRIAL_SCREEN_MIN_NOMINAL
//      All three must hold (AND) — the screen is deliberately
//      conservative: each signal alone has benign explanations.
//   e. SUBSTITUTION SIGNAL (trial↑ while deviasi↓) — NOT implemented:
//      the current aggregates carry WINDOW SUMS only; the signal
//      needs per-item month-over-month trial/deviasi pivots which do
//      not exist in any round trip, and the task explicitly forbids
//      adding new SQL just for it. Noted here as the documented
//      4th-signal candidate (would need 4 CASE-WHEN pivots in the
//      round-1 scan — cheap, but out of scope per the instruction).
//   f. Screen SCOPE = the RETURNED top-N slice (the query LIMITs
//      round 1 by the ACTIVE metric before the builder sees the
//      rows). Under metric='trial' the slice is trial-ordered, i.e.
//      the screen sees the fullest trial population; under
//      metric='waste' a trial-heavy item outside the waste top-N is
//      invisible to the screen. The UI documents this and the 2-click
//      path is: switch the selector to Trial → screen.
//
//  PURE (compute/classify split — same as ./quadrant.ts): no DB, no
//  mutation of the input rows (the caller merges `fingerprint` onto
//  the rows). Exported for vitest.
// ============================================================
import {
  WASTE_TRIAL_SCREEN_BOM_RATIO,
  WASTE_TRIAL_SCREEN_MIN_MONTHS,
  WASTE_TRIAL_SCREEN_MIN_NOMINAL,
} from './constants';
import type {
  WasteFingerprintClass,
  WasteFingerprintSummary,
  WasteItemFingerprint,
  WasteTopItemRow,
  WasteTrialScreenItem,
} from './types';

// toNum mirrors waste/shared.ts (kept local — the split precedent keeps
// builders.ts's toNum module-private; same defensive bigint/null coercion).
const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

/**
 * Fingerprint classification from the three shares of explained loss.
 * Max-share wins; ties break W > S > T (documented rule); ALL shares
 * ≤ 0 (explained == 0) → null (TANPA EXPLAINED).
 */
export function classifyFingerprintClass(
  shareW: number,
  shareS: number,
  shareT: number,
): WasteFingerprintClass | null {
  if (shareW <= 0 && shareS <= 0 && shareT <= 0) return null;
  // >= (not >) so the FIRST check in the priority chain wins exact ties:
  // W > S > T — a three-way 1/3 tie classifies W-DOMINANT, an S==T tie
  // (both above W) classifies S-DOMINANT. Deterministic, documented.
  if (shareW >= shareS && shareW >= shareT) return 'W-DOMINANT';
  if (shareS >= shareT) return 'S-DOMINANT';
  return 'T-DOMINANT';
}

/**
 * Build the per-item fingerprint fields + the network summary.
 * PURE — does not mutate `items` (the caller assigns row.fingerprint).
 *
 * @param items rows carrying the W11 additive aggregates
 *              (totalWaste/susutNominal/trialNominal); WasteTopItemRow
 *              satisfies this structurally, tests may pass slimmer
 *              fixtures. toNum guards bigint/null leakage only.
 */
export function buildFingerprint(
  items: Array<Pick<WasteTopItemRow, 'itemId' | 'totalWaste' | 'susutNominal' | 'trialNominal'>>,
): { perItem: Map<number, WasteItemFingerprint | null>; summary: WasteFingerprintSummary } {
  const perItem = new Map<number, WasteItemFingerprint | null>();
  const classCounts = { wDominant: 0, sDominant: 0, tDominant: 0, tanpaExplained: 0 };
  for (const item of items) {
    const w = toNum(item.totalWaste);
    const s = toNum(item.susutNominal);
    const t = toNum(item.trialNominal);
    const explained = w + s + t;
    const shareW = explained > 0 ? w / explained : 0;
    const shareS = explained > 0 ? s / explained : 0;
    const shareT = explained > 0 ? t / explained : 0;
    const fingerprintClass = classifyFingerprintClass(shareW, shareS, shareT);
    perItem.set(item.itemId, {
      shareW,
      shareS,
      shareT,
      explainedNominal: explained,
      fingerprintClass,
    });
    if (fingerprintClass === 'W-DOMINANT') classCounts.wDominant += 1;
    else if (fingerprintClass === 'S-DOMINANT') classCounts.sDominant += 1;
    else if (fingerprintClass === 'T-DOMINANT') classCounts.tDominant += 1;
    else classCounts.tanpaExplained += 1;
  }
  return {
    perItem,
    summary: {
      classCounts,
      epistemicLabel: 'INDIKASI',
    },
  };
}

/**
 * Trial-abuse screen over the RETURNED top-item rows: items where the
 * "trial" account looks like a drain (ratio + persistence + value —
 * all three signals must hold). Rows keep the exact numbers behind
 * each signal so the UI can show them; always INDIKASI. PURE.
 */
export function buildTrialScreen(items: WasteTopItemRow[]): WasteTrialScreenItem[] {
  const screened: WasteTrialScreenItem[] = [];
  for (const item of items) {
    const trialQty = toNum(item.trialQty);
    const bomQty = toNum(item.bomQty);
    const trialNominal = toNum(item.trialNominal);
    const trialMonthsActive = toNum(item.trialMonthsActive);
    // Signal 1 — ratio: undefined basis (bomQty = 0) → NOT screened
    // (a trial with no theoretical usage cannot be ratio-judged; it is
    // surfaced by the fingerprint, not the screen).
    const trialToBom = bomQty > 0 ? trialQty / bomQty : null;
    if (trialToBom == null || trialToBom < WASTE_TRIAL_SCREEN_BOM_RATIO) continue;
    // Signal 2 — persistence: a one-month trial burst is an R&D spike.
    if (trialMonthsActive < WASTE_TRIAL_SCREEN_MIN_MONTHS) continue;
    // Signal 3 — high-value: cheap trials are not controller-worthy.
    if (trialNominal < WASTE_TRIAL_SCREEN_MIN_NOMINAL) continue;
    screened.push({
      itemId: item.itemId,
      itemName: item.itemName,
      satuan: item.satuan,
      trialNominal,
      trialQty,
      bomQty,
      trialToBom,
      trialMonthsActive,
      fingerprintClass: item.fingerprint?.fingerprintClass ?? null,
      epistemicLabel: 'INDIKASI',
    });
  }
  return screened;
}
