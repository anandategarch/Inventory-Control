// ============================================================
//  Waste Top Items — Pareto (DEEP-WASTE-1) — folder barrel
//  --------------------------------------------------------
//  SPLIT-0-B: split the 323-LOC waste-top-items.ts monolith into
//  this folder (constants / types / sistematik / builders /
//  query) — pre-split for the upcoming feature waves (W3
//  quadrant, W11 fingerprint, W1 league integration) so the
//  module extends without regrowing a god file.
//
//  Importers that stay untouched (zero-importer-edit split):
//    - src/lib/queries/index.ts — `export * from './waste/waste-top-items'`
//      (now resolves to THIS index.ts);
//    - tests/queries/waste-top-items.test.ts — deep import of 2 constants
//      + isSistematikWasteItem + buildWasteTopItems + queryWasteTopItems
//      from '@/lib/queries/waste/waste-top-items';
//    - src/app/api/waste-top-items/route.ts — imports via '@/lib/queries'.
//
//  The named re-exports below match the pre-split export surface
//  EXACTLY (grep '^export ' on the old file): 4 constants +
//  3 types + 3 functions — PLUS the W3-EXEC additive names (3
//  constants, 3 types, 4 quadrant builders) and the W11-EXEC
//  additive names (3 constants, 5 types, 3 fingerprint builders) so
//  the surface only grows, never shifts (house additive-only rule).
//  WasteItemRawRow /
//  WasteItemOutletRawRow / WasteItemOutletDistributionRawRow
//  moved to ./types.ts with an `export` keyword added (sibling
//  sharing) and are deliberately NOT re-exported here; toNum
//  stays module-private inside ./builders.ts (and ./quadrant.ts).
//
//  --- Original module doc (moved verbatim; the SQL round-trip
//      paragraph moved to ./query.ts) ---
//  The in-app version of the offline report's "Top Item Waste"
//  (Pareto + kumulatif + #outlet/#bulan sistematik) + "Item×Outlet"
//  sheets: the TOP-N items by ΣABS nominalWaste over the same-week
//  multi-month window (most recent 12 months, incl. running month),
//  scoped by the global filters, with:
//    - waste qty (ΣABS qtyWaste) + satuan;
//    - SISTEMIK columns: #outlet aktif + #bulan aktif (an item that
//      wastes across many outlets AND months is a recipe/process
//      problem, not a one-off incident) — counted only over rows with
//      waste > 0 (BUGHUNT-R1 FIX 1: record presence overstated both
//      counts, e.g. an item stocked in 343 outlets but wasting in 1);
//    - share of the network's total waste + cumulative share (the
//      80/20 reading);
//    - last-month vs prev-month waste (trend direction);
//    - per-outlet breakdown (top 8 per item, the Item×Outlet matrix).

//  GRAIN: same-weekLabel multi-month window — identical to
//  waste-series.ts (the ONLY valid cross-month comparison).
//  PURELY ADDITIVE: feeds the new /api/waste-top-items route used
//  by the Waste tab's Pareto card.
// ============================================================

export {
  WASTE_TOP_ITEMS_DEFAULT_LIMIT,
  WASTE_TOP_ITEMS_MAX_LIMIT,
  WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT,
  WASTE_TOP_ITEMS_WINDOW_MONTHS,
  // W3 (additive): quadrant tunables — see ./constants.ts.
  WASTE_QUADRANT_PREVALENCE_MIN,
  WASTE_QUADRANT_HHI_MIN_OUTLETS,
  WASTE_QUADRANT_PARETO_SHARE,
  // W11 (additive): trial-abuse screen tunables — see ./constants.ts.
  WASTE_TRIAL_SCREEN_BOM_RATIO,
  WASTE_TRIAL_SCREEN_MIN_MONTHS,
  WASTE_TRIAL_SCREEN_MIN_NOMINAL,
} from './constants';
export type {
  WasteItemOutletBreakdown,
  WasteTopItemRow,
  WasteTopItemsResult,
  // W3 (additive): quadrant types — see ./types.ts.
  WasteQuadrantClass,
  WasteItemQuadrant,
  WasteQuadrantSummary,
  // W11 (additive): paritas susut & trial types — see ./types.ts.
  WasteMetric,
  WasteFingerprintClass,
  WasteItemFingerprint,
  WasteFingerprintSummary,
  WasteTrialScreenItem,
} from './types';
export { isSistematikWasteItem } from './sistematik';
export { buildWasteTopItems } from './builders';
// W3 (additive): pure quadrant builders (exported for vitest).
export { buildQuadrant, classifyQuadrantClass, computeHhi, persistenceThresholdMonths, WASTE_QUADRANT_CLASSES } from './quadrant';
// W11 (additive): pure fingerprint + trial-screen builders (vitest).
export { buildFingerprint, buildTrialScreen, classifyFingerprintClass } from './fingerprint';
export { queryWasteTopItems } from './query';
