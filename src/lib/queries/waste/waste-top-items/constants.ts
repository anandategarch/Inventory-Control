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
 * classification (SISTEMIK / MUSIMAN). Prevalence = outletsActiveWithBom
 * (BOM>0 AND waste>0 — FIX AUDIT-B M1) / outlets in scope WITH BOM>0 for
 * the item. 0.5 = the item wastes in at least half the outlets that
 * actually use (prep) the item. Both sides of the ratio are BOM-basis
 * counts, so the fraction is always ≤ 1.
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
 * Items with bomQty = 0 have NO usage basis (ratio null) and are not
 * screened.
 *
 * FIX (AUDIT-B M2): this is now the ABSOLUTE tier ("BLATAN") of a
 * TWO-TIER signal-1 — bar absolut BLATAN: ≥ 5% pemakaian teoretis
 * dibukukan trial; jauh di atas sampling R&D (10%+ is blatant). It is
 * deliberately kept at 0.05: an absolute bar that never bends with
 * the population anchors the screen against calibration drift, while
 * the companion OUTLIER tier (WASTE_TRIAL_SCREEN_OUTLIER_Z × MAD below)
 * catches the "unusual vs peers" cases the absolute bar cannot reach
 * on live data (the live maximum ratio was 0.51% — the absolute bar
 * alone left the screen permanently empty).
 */
export const WASTE_TRIAL_SCREEN_BOM_RATIO = 0.05;

/**
 * FIX (AUDIT-B M2): robust-z multiplier of the trial screen's OUTLIER
 * tier — an item screens when trialToBom ≥ median + OUTLIER_Z ×
 * MAD_SCALE × MAD of the BOM-basis item population on the slice.
 * 3 ≈ the 99.87% tail under normality (via the MAD→σ consistency
 * scale below), i.e. "≥ 3 robust sigma above the population median" —
 * deliberately stricter than the 2σ spike detectors because the
 * verdict (trial-abuse indication) names PEOPLE-adjacent behavior.
 */
export const WASTE_TRIAL_SCREEN_OUTLIER_Z = 3;

/**
 * FIX (AUDIT-B M2): minimum BOM-basis items (bomQty > 0) before the
 * OUTLIER tier is computed. Below 5 the median/MAD arithmetic over the
 * slice is noise, not evidence — same min-5 precedent as
 * WASTE_RATE_LEAGUE_MIN_OUTLETS (rate-league) and the W3 HHI guard's
 * "below the guard it is arithmetic, not evidence" rationale. Under
 * the guard the screen degrades to the ABSOLUTE bar only (documented
 * in the UI footnote, never silent).
 */
export const WASTE_TRIAL_SCREEN_MIN_POPULATION = 5;

/**
 * FIX (AUDIT-B M2): MAD → σ consistency constant Φ⁻¹(0.75) ≈ 1.4826 —
 * scaling MAD by this makes the outlier threshold comparable to a
 * classical ±z cut under normality (the textbook robust convention).
 * Deliberately the SAME VALUE as WASTE_RATE_LEAGUE_MAD_SCALE but a
 * SEPARATE declaration: rate-league.ts is a query module (it imports
 * Prisma), so importing its constant into this pure constants home
 * would drag the DB stack along — a documented duplicate instead
 * (same pattern as the module-local toNum twins).
 */
export const WASTE_TRIAL_SCREEN_MAD_SCALE = 1.4826;

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
