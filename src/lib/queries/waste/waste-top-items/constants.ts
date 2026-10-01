// ============================================================
//  Waste Top Items — constants (DEEP-WASTE-1)
//  --------------------------------------------------------
//  SPLIT-0-B: moved verbatim out of waste-top-items.ts (was a
//  323-LOC monolith — pre-split for the upcoming W3 quadrant /
//  W11 fingerprint / W1 league waves so the module's new knobs
//  get one home). ./index.ts is the barrel that keeps every
//  pre-split import path resolving unchanged.
// ============================================================

/** Max months in the waste window (incl. running month) — shared with waste-series. */
export const WASTE_TOP_ITEMS_WINDOW_MONTHS = 12;

/** Default + max top-N items returned. */
export const WASTE_TOP_ITEMS_DEFAULT_LIMIT = 20;
export const WASTE_TOP_ITEMS_MAX_LIMIT = 50;

/** Per-item outlet breakdown cap (the Item×Outlet matrix width). */
export const WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT = 8;
