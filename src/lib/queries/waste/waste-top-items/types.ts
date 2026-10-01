// ============================================================
//  Waste Top Items — shared types (DEEP-WASTE-1)
//  --------------------------------------------------------
//  SPLIT-0-B: moved verbatim out of waste-top-items.ts. The two
//  raw-row interfaces (SQL round-trip shapes) were module-private
//  in the monolith — the `export` keyword on them below is the
//  ONLY code change in this split (sibling sharing between
//  ./query.ts and ./builders.ts — same precedent as toNum /
//  monthWindowBound in waste/shared.ts, GODSPLIT-W1-B); they are
//  deliberately NOT re-exported by ./index.ts, so the public
//  surface stays byte-compatible with the pre-split module.
// ============================================================

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export interface WasteItemRawRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number | bigint;
  wasteQty: number | bigint;
  outletsActive: number | bigint;
  monthsActive: number | bigint;
  lastMonthWaste: number | bigint;
  prevMonthWaste: number | bigint;
  populationTotal: number | bigint;
}

export interface WasteItemOutletRawRow {
  itemId: number;
  outletCode: string;
  outletName: string;
  area: string;
  waste: number | bigint;
  monthsActive: number | bigint;
}

export interface WasteItemOutletBreakdown {
  outletCode: string;
  outletName: string;
  area: string;
  waste: number;
  monthsActive: number;
  /** waste / item's totalWaste (0 when totalWaste is 0). */
  shareOfItem: number;
}

export interface WasteTopItemRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number;
  wasteQty: number;
  /** #outlet aktif in the window. */
  outletsActive: number;
  /** #bulan aktif in the window. */
  monthsActive: number;
  /** share of the network total waste (0 when population is 0). */
  share: number;
  /** cumulative share from rank 1 (0 when population is 0). */
  cumulativeShare: number;
  /** Waste in the latest window month (0 when the item had none). */
  lastMonthWaste: number;
  /** Waste in the month before the latest (0 when absent). */
  prevMonthWaste: number;
  /** Sistematik = active in ≥ half the window months AND ≥ 2 outlets. */
  sistematik: boolean;
  byOutlet: WasteItemOutletBreakdown[];
}

export interface WasteTopItemsResult {
  items: WasteTopItemRow[];
  /** ΣABS nominalWaste across ALL items in scope (the 100% of the Pareto). */
  populationTotal: number;
  /** Latest + previous monthKeys of the window (for the trend column). */
  lastMonthKey: string | null;
  prevMonthKey: string | null;
  /** ACTUAL number of months in the window (≤ cap; e.g. 8-9 live) — the
   *  sistematik threshold is ceil(windowMonths / 2), NOT the 12-month cap
   *  (BUGHUNT-R1 FIX 2). Additive field. */
  windowMonths: number;
}
