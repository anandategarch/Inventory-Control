// ============================================================
//  Item Autocomplete — for search bars (e.g., ItemTrendTab).
//  Returns up to `limit` item names matching `q` (case-insensitive).
//  Ranked by total absNominalDeviasi DESC so high-impact items
//  surface first.
//
//  NOTE: queryGlobalItemSearch + queryItemTrend were removed along
//  with the GlobalItemSearchModal (Cmd+K cross-outlet analysis).
//  The autocomplete function is retained for ItemTrendTab's search.
// ============================================================
import { withStatementTimeout } from '../shared';

export async function queryItemAutocomplete(
  week: string,
  month: string,
  q: string,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCount: number; totalAbsNominal: number }>> {
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ itemName: string; outletCount: number; totalAbsNominal: number | bigint }>>`
    SELECT
      i.name as "itemName",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      COALESCE(ABS(SUM(ir."nominalDeviasi")), 0) as "totalAbsNominal"
    FROM "Item" i
    JOIN "InventoryRecord" ir ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      AND LOWER(i.name) LIKE LOWER(${'%' + q + '%'})
    GROUP BY i.name
    ORDER BY "totalAbsNominal" DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    itemName: r.itemName,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
  }));
}
