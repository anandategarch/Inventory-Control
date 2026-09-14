// ============================================================
//  Item Trend Matrix — per-(month × item) ABS nominal aggregates
//  --------------------------------------------------------
//  Returns per-item aggregates for EVERY month that has the given
//  weekLabel (e.g. "WEEK 4" of Januari, Februari, ... — the same
//  same-week-across-months convention as flip-ranking.ts and
//  item-trend-rank.ts). Powers the export report's "Trend Item"
//  section: a items × periods matrix with heat-colored cells +
//  per-item trend direction.
//
//  Why a dedicated query (not queryTrendAgg / queryItemTrendRank):
//    - queryTrendAgg aggregates ALL items into ONE number per period
//      (no per-item breakdown).
//    - queryItemTrendRank ranks ONE item per period (needs a target).
//    - This query returns EVERY item × period pair so the export can
//      pick the top-N items by the CURRENT period and still show their
//      full history.
//
//  Implementation notes (mirrors flip-ranking.ts):
//  - `withStatementTimeout` + `buildSqlFilters` (area/kelompok/
//    outletCode/picOutletCodes). itemName is NOT passed through
//    filters (LIKE would over-match — this query scans ALL items).
//  - monthLabel is NOT filtered: the whole point is the cross-month
//    timeline. The weekLabel filter keeps the same-week convention.
//  - Prisma.sql tagged templates (zero $queryRawUnsafe).
//  - BigInt/Decimal coercion via Number().
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

export interface ItemTrendMatrixRow {
  monthLabel: string;
  /** Sortable month key ("2026-07") from SourceFile — null when absent. */
  monthKey: string | null;
  itemName: string;
  /** SUM(ABS(nominalDeviasi)) for this (month, item) — magnitude. */
  absNominal: number;
  /** SUM(nominalDeviasi) — SIGNED (negative = net LOSS side). */
  nominalDeviasi: number;
}

export interface ItemTrendMatrixResult {
  rows: ItemTrendMatrixRow[];
}

/**
 * Per-(month × item) aggregates for the same weekLabel across ALL months.
 *
 * @param weekLabel  Week filter (e.g. "WEEK 4") — respected across months.
 * @param filters    Dashboard filters (area, kelompok, outletCode,
 *                   picOutletCodes). itemName is IGNORED — scans all items.
 */
export async function queryItemTrendMatrix(
  weekLabel: string,
  filters: SqlFilterOpts,
): Promise<ItemTrendMatrixResult> {
  // itemName NOT passed to buildSqlFilters — same rationale as flip-ranking:
  // the LIKE filter would over-match item names, and the section needs ALL
  // distinct items to rank by the current period.
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    monthLabel: string;
    monthKey: string | null;
    itemName: string;
    absNominal: number | bigint;
    nominalDeviasi: number | bigint;
  }>>`
    SELECT
      ir."monthLabel",
      MAX(sf."monthKey") as "monthKey",
      i.name as "itemName",
      COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) as "absNominal",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    LEFT JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${weekLabel}
      ${f}
    GROUP BY ir."monthLabel", i.name
    ORDER BY MAX(sf."monthKey") ASC NULLS LAST, i.name ASC
  `);

  return {
    rows: rows.map((r) => ({
      monthLabel: r.monthLabel,
      monthKey: r.monthKey ?? null,
      itemName: r.itemName,
      absNominal: Number(r.absNominal) || 0,
      nominalDeviasi: Number(r.nominalDeviasi) || 0,
    })),
  };
}
