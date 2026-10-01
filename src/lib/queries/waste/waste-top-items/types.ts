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

/**
 * W3 quadrant round-trip shape: the FULL per-(item, outlet) distribution
 * (GROUP BY outlet, NO cap — unlike the top-8 breakdown slice) plus the
 * BOM>0 flag that anchors the prevalence denominator. `hasBom` is a 0/1
 * MAX flag over the outlet's window rows: 1 = the outlet prepped/used the
 * item (ABS(qtyBom) > 0) somewhere in the window.
 */
export interface WasteItemOutletDistributionRawRow {
  itemId: number;
  outletId: number;
  waste: number | bigint;
  hasBom: number | bigint;
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
  /**
   * W3 (additive): prevalence × persistence quadrant fields — null when the
   * quadrant round-trip wasn't run (e.g. the pure buildWasteTopItems path
   * without a distribution, or an empty window); filled by queryWasteTopItems
   * via buildQuadrant. Never removes/renames pre-W3 fields.
   */
  quadrant: WasteItemQuadrant | null;
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
  /**
   * W3 (additive): network-level quadrant summary — adaptive persistence
   * threshold, paretoK, class distribution. Null on the same conditions as
   * the per-item field (no window / no items / distribution not run).
   */
  quadrant: WasteQuadrantSummary | null;
}

// ------------------------------------------------------------
// W3 — Kuadran Sistemik vs Insiden (prevalence × persistence)
// ------------------------------------------------------------

/**
 * The four quadrants of the prevalence × persistence plane:
 *   - SISTEMIK     — widespread (prevalence ≥ PREVALENCE_MIN) AND persistent
 *                    (monthsActive ≥ ceil(windowMonths/2)): recipe/process
 *                    problem across outlets and months (action framing:
 *                    candidate for resep/proses-level fix, not outlet chase).
 *   - MUSIMAN      — widespread but not persistent: many outlets waste the
 *                    item only in some months (seasonal/supply-wave flavor).
 *   - LOKAL-KRONIS — few outlets but persistent: a handful of outlets with a
 *                    chronic problem on one item (outlet-level SOP chase).
 *   - INSIDEN      — neither: localized one-off incidents.
 */
export type WasteQuadrantClass = 'SISTEMIK' | 'MUSIMAN' | 'LOKAL-KRONIS' | 'INSIDEN';

/** Per-item W3 quadrant fields (see buildQuadrant in ./quadrant.ts). */
export interface WasteItemQuadrant {
  quadrantClass: WasteQuadrantClass;
  /**
   * outletsActive(waste>0) / outletsWithBom — the BOM>0 discipline
   * (BUGHUNT-R1 FIX 1 family): the denominator counts only outlets that
   * actually USED the item (ABS(qtyBom) > 0), never mere record presence.
   * Null when the item has NO BOM>0 outlet in scope (orphaned waste — no
   * usage basis); classification then treats prevalence as LOW (conservative:
   * no basis to claim "widespread").
   */
  prevalence: number | null;
  /** #outlets in scope with BOM>0 for the item (the denominator above). */
  outletsWithBom: number;
  /** monthsActive / windowMonths (0 when windowMonths is 0 — pure guard). */
  persistence: number;
  /**
   * HHI = Σ(share²) over the item's per-outlet waste shares (full
   * distribution, waste>0 outlets only — zero-waste outlets contribute
   * share 0). Null when the item has < WASTE_QUADRANT_HHI_MIN_OUTLETS
   * active outlets (guard) or no positive waste to distribute.
   */
  hhi: number | null;
}

/** Network-level W3 summary (top-level `quadrant` block of the response). */
export interface WasteQuadrantSummary {
  /** Persistence threshold in MONTHS — ceil(windowMonths/2), adaptive to the
   *  REAL window (BUGHUNT-R1 FIX 2 pattern; e.g. 9-month window → 5, not the
   *  12-cap's 6). monthsActive ≥ this = "persistent". */
  persistenceThresholdMonths: number;
  /**
   * #items needed to reach WASTE_QUADRANT_PARETO_SHARE (80%) cumulative
   * network waste share — the "how concentrated is the network's waste"
   * number. Null when the returned top-N slice never reaches the target
   * (possible with a tight limit on a long tail).
   */
  paretoK: number | null;
  /** Class distribution over the returned items (all four keys always set). */
  classCounts: Record<WasteQuadrantClass, number>;
  /** Window months the classification ran on (echoes windowMonths). */
  windowMonths: number;
}
