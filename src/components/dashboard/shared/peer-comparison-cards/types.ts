// ============================================================
//  Peer Comparison Cards — shared types
//  --------------------------------------------------------
//  Generic types used by the PRESENTATIONAL cards in this
//  folder. The cards accept PRE-COMPUTED values (not raw row
//  objects) so they can be reused by both:
//    - PeerComparison.tsx (Peer Tab — uses PeerRow)
//    - ItemPeerComparison.tsx (Trend Item Tab — uses ItemPeerRow)
//
//  Each caller computes its own values from its own row type,
//  then passes them to the shared card.
// ============================================================

/**
 * Common fields shared by PeerRow (outlet-level) + ItemPeerRow (item-level).
 * Documented for clarity — the shared cards do NOT consume this directly
 * (they take pre-computed values). Callers may use this as a structural
 * reference for the field overlap.
 */
export interface BasePeerRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  nominalDeviasi: number;
  devBom: number | null;
  direction: string;
  isTarget: boolean;
}

/**
 * Generic peer averages — callers compute from their own row type.
 * Documented for clarity; the shared cards take pre-computed values
 * directly rather than this aggregate.
 */
export interface BasePeerAverages {
  devBom: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  lossOutlets: number;
  surplusOutlets: number;
}

// ------------------------------------------------------------
//  Pre-computed value shapes consumed by the shared cards
// ------------------------------------------------------------

/** One anomaly flag row (emoji + text + tailwind color class). */
export interface AnomalyFlag {
  emoji: string;
  text: string;
  color: string;
}

/** One gap analysis row — target vs (optional) best vs (optional) avg. */
export interface GapRow {
  label: string;
  targetVal: number;
  bestVal: number;
  /** Optional — shown when provided (with "· avg" prefix). */
  avgVal?: number;
  /** Optional — shown when provided AND non-zero (with "% vs best" suffix). */
  pctAboveBest?: number;
  format: (v: number) => string;
  higherBetter: boolean;
}

/** One scatter plot point. Tooltip lines are pre-computed by caller. */
export interface ScatterPoint {
  x: number;
  y: number;
  /** Outlet name — shown as tooltip title. */
  label: string;
  /** Optional direction tag — shown in tooltip when provided. */
  direction?: string;
  /** Pre-computed tooltip rows (label + formatted value). */
  tooltipLines?: Array<{ label: string; value: string }>;
  isTarget: boolean;
}

/** One ranking summary stat box (label + badge content). */
export interface RankItem {
  /** Small uppercase label above the badge. */
  label: string;
  /** Pre-formatted badge content (e.g. "#3/12", "p25", "5"). */
  badgeContent: string;
  /** Tailwind classes for the badge background/text color. */
  badgeClass?: string;
  /** Badge variant — matches shadcn Badge API. */
  variant?: 'secondary' | 'outline';
  /** Show ★ (best) marker after the badge content. */
  star?: boolean;
  /** Show ⚠ (worst) marker after the badge content. */
  warn?: boolean;
}
