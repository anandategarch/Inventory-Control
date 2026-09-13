// ============================================================
//  growth-drivers/types — shared types
//  --------------------------------------------------------
//  Extracted from the former src/lib/queries/growth-drivers.ts
//  monolith (REFACTOR-1-a pure-move split). Hosts the interfaces
//  used by BOTH query families:
//    - drivers.ts    → queryGrowthDrivers (Pareto 80% analysis)
//    - top-growth.ts → queryTopGrowth (Top-N movers)
// ============================================================
import type { SqlFilterOpts } from '../shared';

export interface DriverEntry {
  item: string;
  delta: number;
  pct: number;
  cumPct: number;
  sharePct: number;
}
export interface DriverResult {
  drivers: DriverEntry[];
  remainderCount: number;
  remainderPct: number;
}
export interface GrowthDriverMetric {
  metric: string;
  label: string;
  groupBy: 'outlet' | 'item';
  up: DriverResult;
  down: DriverResult;
}

// Shared filter type re-exported from ../shared — kept as a local alias for
// backwards-compat with internal call sites. New code should use SqlFilterOpts
// directly from ../shared.
export type FilterOpts = SqlFilterOpts;

export interface TopGrowthContributor {
  /** Contributor name — barang (inside a resto row) or resto (inside a barang row). */
  name: string;
  /** SUM(qtyDeviasi) current period for this cell (signed). */
  qtyCurr: number;
  /** SUM(qtyDeviasi) compare period for this cell (signed). */
  qtyPrev: number;
  /** SIGNED Δ kuantiti deviasi = qtyCurr − qtyPrev — the drill-down's RANKING key. */
  qtyDelta: number;
  /** SUM(nominalDeviasi) current period for this cell (signed, Rp). */
  nominalCurr: number;
  /** SUM(nominalDeviasi) compare period for this cell (signed, Rp). */
  nominalPrev: number;
  /** SIGNED Δ nominal deviasi (Rp) = nominalCurr − nominalPrev — displayed alongside the qty ("ada nominal juga"). */
  nominalDelta: number;
  /** No deviation base of EITHER kind in the compare period (qty & nominal prev both 0) — UI shows "Baru". */
  isNew: boolean;
  /**
   * TASK H-7: satuan label for this contributor's QTY — byOutlet
   * drill-down (contributor = barang) uses the barang's OWN satuan;
   * byItem drill-down (contributor = resto) uses the ROW item's
   * satuan, since the qty being ranked IS that item's qty.
   */
  unit: string | null;
}

export interface TopGrowthRow {
  name: string;
  /** SUM(nominalDeviasi) current period (signed, Rp). */
  curr: number;
  /** SUM(nominalDeviasi) compare period (signed, Rp). */
  prev: number;
  /** SIGNED Δ nominal deviasi (Rp) = curr − prev — negative = toward LOSS, positive = toward SURPLUS. */
  delta: number;
  /** SIGNED growth (curr − prev)/|prev| — null when prev = 0 (new). */
  pct: number | null;
  /** No previous base — pct cannot be computed, UI shows "Baru". */
  isNew: boolean;
  /**
   * Task H-5: drill-down — top sub-grain movers driving this row's Δ
   * (items for byOutlet rows, outlets for byItem rows). Always an
   * array (possibly empty) so the field ALWAYS serializes into the
   * cached payload — it doubles as a required payload-shape marker.
   */
  contributors: TopGrowthContributor[];
}

export interface TopGrowthResult {
  byOutlet: TopGrowthRow[];
  byItem: TopGrowthRow[];
  /**
   * Cap used for each row's `contributors` list (informational — the
   * UI footnote reads it). ALWAYS serialized; required payload marker.
   */
  contributorLimit: number;
  /**
   * TASK H-7: grain → metric descriptors, ALWAYS serialized (wrapper-
   * level scalars → payload-shape markers). BOTH grains rank the
   * signed net NOMINAL deviation (Rp).
   */
  byOutletMetric: 'nominalDeviasi';
  byItemMetric: 'nominalDeviasi';
  /**
   * TASK H-7: the drill-down's ranking metric — Δ kuantiti deviasi
   * (Δ nominal displayed alongside). ALWAYS serialized; required
   * payload marker (a v4 row lacks this key entirely → never served).
   */
  contributorRankMetric: 'qtyDeviasi';
}
