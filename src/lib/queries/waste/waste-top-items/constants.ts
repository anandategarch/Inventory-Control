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

// ------------------------------------------------------------
// W3 — Kuadran Sistemik vs Insiden (prevalence × persistence)
// Tunable thresholds, one home each (house style: constants are
// documented module knobs, NOT runtime Settings — see findings
// DEEPWASTE2-A §1a E4 note on hardcoded detector constants).
// ------------------------------------------------------------

/**
 * W3 quadrant: minimum prevalence for the "widespread" side of the
 * classification (SISTEMIK / MUSIMAN). Prevalence = outletsActive(waste>0)
 * / outlets in scope WITH BOM>0 for the item. 0.5 = item wastes in at
 * least half the outlets that actually use (prep) the item.
 */
export const WASTE_QUADRANT_PREVALENCE_MIN = 0.5;

/**
 * W3 quadrant: minimum ACTIVE outlets (waste > 0) before an item's HHI
 * (Σ share² of its per-outlet waste distribution) is reported. Below this
 * the concentration number is arithmetic, not evidence — with 2 outlets
 * HHI is ≥ 0.5 by construction (1/n floor), which reads like "extreme
 * concentration" when it is really just "no outlets to spread over".
 */
export const WASTE_QUADRANT_HHI_MIN_OUTLETS = 10;

/**
 * W3 quadrant: cumulative network-waste share target for paretoK
 * (the 80 of the 80/20 reading — how many items reach 80% of the
 * scoped total waste). Mirrors the shared 80/20 convention used by
 * the Pareto card's cumulative-share highlight.
 */
export const WASTE_QUADRANT_PARETO_SHARE = 0.8;

// ------------------------------------------------------------
// W11 — Paritas Susut & Trial: trial-abuse screen tunables
// (findings-DEEPWASTE2-B §2 W11 "Screen trial-abuse": rasio
// trial/BOM + persistensi ≥ 3 bulan + high-value). House style:
// documented module knobs, NOT runtime Settings — same as the W3
// quadrant knobs above (findings-DEEPWASTE2-A §1a E4 note).
// ------------------------------------------------------------

/**
 * Trial/BOM QTY ratio a screened item must reach: Σ|qtyTrial| /
 * Σ|qtyBom| ≥ 0.05 — i.e. ≥ 5% of the item's theoretical usage is
 * booked as "trial". Unitless (same item, same satuan on both sides),
 * so it is comparable across items where a nominal ratio would not.
 * 5% is far beyond R&D sampling; 10%+ is blatant. Items with
 * bomQty = 0 have NO usage basis (ratio null) and are not screened.
 */
export const WASTE_TRIAL_SCREEN_BOM_RATIO = 0.05;

/**
 * Minimum months with trial > 0 (trialMonthsActive) before an item
 * can screen — a one-month trial burst is an R&D spike, not a
 * persistent drain (the spec's "≥ 3 bulan persistent").
 */
export const WASTE_TRIAL_SCREEN_MIN_MONTHS = 3;

/**
 * Minimum Σ|nominalTrial| (Rp) for the "high-value" signal — below
 * this the trial is cheap enough to not warrant controller attention.
 * Rp 100 rb per window at the item level (network scope); area-scoped
 * views see proportionally smaller totals and may want a lower knob.
 */
export const WASTE_TRIAL_SCREEN_MIN_NOMINAL = 100_000;
