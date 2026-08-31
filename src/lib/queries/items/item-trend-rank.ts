// ============================================================
//  Item Trend Rank — per-item, per-period NATIONAL rank
//  --------------------------------------------------------
//  Returns the national rank of a specific item for EACH
//  period (monthLabel × weekLabel). The rank is computed by
//  ABS(nominalDeviasi) DESC across ALL items in the same
//  period (1 = highest deviasi magnitude).
//
//  This powers the "Rank Trend" compact chart in the Trend
//  Item Tab — visualizes how an item's national standing
//  fluctuates across periods (e.g. rank 5 → rank 1 → rank 12).
//
//  Approach:
//  1. `item_per_period` CTE: per-(period, item) ABS(nominalDeviasi)
//     aggregates for ALL items (not just the target). This is
//     required for ranking — we need the full distribution per
//     period to compute the target item's rank within it.
//     Typically ~153 items × ~8 periods = ~1224 rows (lightweight).
//  2. `ranked` CTE: RANK() OVER (PARTITION BY monthLabel, weekLabel
//     ORDER BY absNominal DESC) computes the per-period rank, and
//     COUNT(*) OVER (PARTITION BY monthLabel, weekLabel) computes
//     totalItems (so the UI can show "rank 5 of 153"). Window
//     functions are O(N log N) per partition — efficient.
//  3. Final SELECT: filter to `itemName = ${itemName}` (exact match,
//     same convention as item-trend.ts — the dashboard's item picker
//     selects from a precise list, and buildSqlFilters' LIKE would
//     over-match "CABAI" against both "CABAI FROZEN" and "CABAI MERAH").
//
//  Implementation notes (mirrors item-trend.ts):
//  - `withStatementTimeout` (heavy aggregation across ALL items).
//  - `buildSqlFilters` for area/kelompok/outletCode/picOutletCodes.
//    itemName is NOT passed through filters (applied directly in
//    WHERE) to avoid LIKE over-matching.
//  - Prisma.sql tagged templates (zero $queryRawUnsafe).
//  - Sorting: monthKey ASC + weekLabel ASC (chronological, same as
//    item-trend.ts). Uses MAX(sf."monthKey") since GROUP BY is on
//    (monthLabel, weekLabel) and all rows for the same monthLabel
//    share one SourceFile.monthKey.
//  - BigInt/Decimal coercion via Number() (Prisma raw query returns
//    BigInt for COUNT and Decimal for SUM; JSON serialization would
//    throw on BigInt without coercion).
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

// ------------------------------------------------------------
//  Public types
// ------------------------------------------------------------

export interface ItemTrendRankPeriod {
  monthLabel: string;
  weekLabel: string;
  /** Sortable month key (e.g. "2026-07") from SourceFile — null if no SourceFile. */
  monthKey: string | null;
  /** National rank of this item for this period (by ABS(nominalDeviasi) DESC). 1 = highest deviasi. */
  rankNominal: number;
  /** Total items with deviasi in this period (so user can see "rank 5 of 153"). */
  totalItems: number;
  /** This item's ABS(nominalDeviasi) for this period (for tooltip display). */
  absNominal: number;
}

export interface ItemTrendRankResult {
  periods: ItemTrendRankPeriod[];
}

// ------------------------------------------------------------
//  Query function
// ------------------------------------------------------------

/**
 * Query the per-item, per-period national rank timeline.
 *
 * Returns ALL periods (monthLabel × weekLabel) where this item appears
 * with deviasi > 0, along with the item's national rank within each
 * period (ranked by ABS(nominalDeviasi) DESC) and the total number of
 * items in that period's ranking.
 *
 * @param itemName   Exact item name (e.g. "CABAI FROZEN") — matched via
 *                   `i.name = ${itemName}` (exact, not LIKE).
 * @param filters    Dashboard filters (area, kelompok, outletCode,
 *                   picOutletCodes). itemName in filters is IGNORED (the
 *                   explicit `itemName` arg takes precedence).
 */
export async function queryItemTrendRank(
  itemName: string,
  filters: SqlFilterOpts,
): Promise<ItemTrendRankResult> {
  // NOTE: buildSqlFilters applies `itemName` as a LIKE filter (substring match),
  // which would over-match the rank query (e.g. "CABAI" matches both
  // "CABAI FROZEN" and "CABAI MERAH"). Strip itemName from filters and apply
  // an EXACT match (`i.name = ${itemName}`) in the WHERE clause below.
  // Same convention as item-trend.ts.
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    monthLabel: string;
    weekLabel: string;
    monthKey: string | null;
    rankNominal: bigint | number;
    totalItems: bigint | number;
    absNominal: number;
  }>>`
    WITH item_per_period AS (
      SELECT
        ir."monthLabel",
        ir."weekLabel",
        MAX(sf."monthKey") as "monthKey",
        i.name as "itemName",
        COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) as "absNominal"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY ir."monthLabel", ir."weekLabel", i.name
    ),
    ranked AS (
      SELECT
        "monthLabel",
        "weekLabel",
        "monthKey",
        "itemName",
        "absNominal",
        RANK() OVER (PARTITION BY "monthLabel", "weekLabel" ORDER BY "absNominal" DESC) as "rankNominal",
        COUNT(*) OVER (PARTITION BY "monthLabel", "weekLabel") as "totalItems"
      FROM item_per_period
    )
    SELECT
      "monthLabel",
      "weekLabel",
      "monthKey",
      "rankNominal",
      "totalItems",
      "absNominal"
    FROM ranked
    WHERE "itemName" = ${itemName}
    ORDER BY "monthKey" ASC NULLS LAST, "weekLabel" ASC
  `);

  // Coerce BigInt/Decimal → Number (Prisma raw returns BigInt for COUNT/RANK
  // and Decimal for SUM; JSON.stringify throws on BigInt without coercion).
  const periods: ItemTrendRankPeriod[] = rows.map((r) => ({
    monthLabel: r.monthLabel,
    weekLabel: r.weekLabel,
    monthKey: r.monthKey ?? null,
    rankNominal: Number(r.rankNominal) || 0,
    totalItems: Number(r.totalItems) || 0,
    absNominal: Number(r.absNominal) || 0,
  }));

  return { periods };
}
