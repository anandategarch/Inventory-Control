// ============================================================
//  Global Item Search — cross-outlet view + autocomplete + trend.
//  Used by Cmd+K modal in the dashboard.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, DIRECTION_FROM_SUM_SQL, withStatementTimeout, type SqlFilterOpts } from '../shared';

export interface GlobalItemSearchRow {
  itemName: string;
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  satuan: string | null;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
  absNominalDeviasi: number;
  devBom: number | null;
  direction: string;
}

export async function queryGlobalItemSearch(
  week: string,
  month: string,
  itemNameFilter: string,
  filters: SqlFilterOpts,
  limit: number = 100
): Promise<GlobalItemSearchRow[]> {
  // Filter by exact item name (case-insensitive). Outlet filter is intentionally
  // NOT applied — this is a CROSS-OUTLET view (user wants to see the item in
  // ALL outlets). Area + PIC + kelompok filters are still respected (narrow the outlet scope).
  // FIX (BUG-KELOMPOK-GLOBAL): pass kelompok to buildSqlFilters so the cross-outlet
  // view respects the global kelompok filter.
  const f = buildSqlFilters({
    area: filters.area,
    kelompok: filters.kelompok,
    outletCode: null, // cross-outlet: no outlet filter
    itemName: null,   // itemName handled by exact match below
    picOutletCodes: filters.picOutletCodes,
  });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<GlobalItemSearchRow>>`
    SELECT
      i.name as "itemName",
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      pic.pic,
      MAX(ir."satuan") as "satuan",
      COALESCE(SUM(ir."qtyBom"), 0) as "qtyBom",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasi",
      COALESCE(SUM(ir."qtyWaste"), 0) as "qtyWaste",
      COALESCE(SUM(ir."qtySusut"), 0) as "qtySusut",
      COALESCE(SUM(ir."qtyTrial"), 0) as "qtyTrial",
      COALESCE(SUM(ir."qtyLossSurplus"), 0) as "qtyLossSurplus",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      COALESCE(SUM(ir."nominalLossSurplus"), 0) as "nominalLossSurplus",
      COALESCE(ABS(SUM(ir."nominalDeviasi")), 0) as "absNominalDeviasi",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE NULL END as "devBom",
      -- FIX VERIFY3-8: direction derived from SUM(nominalLossSurplus) with qtyDeviasi NULL fallback
      -- FIX (RESTORE-SHARED-1): use shared DIRECTION_FROM_SUM_SQL fragment from ../shared
      ${DIRECTION_FROM_SUM_SQL} as "direction"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND LOWER(i.name) = LOWER(${itemNameFilter})
      ${f}
    GROUP BY i.name, o.code, o.name, o.area, pic.pic
    ORDER BY "absNominalDeviasi" DESC
    LIMIT ${limit}
  `);
  // Coerce BigInt/Decimal to Number (PostgreSQL SUM returns bigint for integer columns)
  return rows.map((r) => ({
    ...r,
    qtyBom: Number(r.qtyBom),
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyWaste: Number(r.qtyWaste),
    qtySusut: Number(r.qtySusut),
    qtyTrial: Number(r.qtyTrial),
    qtyLossSurplus: Number(r.qtyLossSurplus),
    nominalDeviasi: Number(r.nominalDeviasi),
    nominalLossSurplus: Number(r.nominalLossSurplus),
    absNominalDeviasi: Number(r.absNominalDeviasi),
    devBom: r.devBom != null ? Number(r.devBom) : null,
  }));
}

// ============================================================
//  Item Autocomplete — for the global search bar (Cmd+K)
//  Returns up to `limit` item names matching `q` (case-insensitive).
//  Ranked by total absNominalDeviasi DESC so high-impact items
//  surface first.
// ============================================================
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

// ============================================================
//  Item Trend Analysis — per-(period, outlet) for 1 item across ALL periods
//  --------------------------------------------------------
//  Returns the item's deviation across ALL months × weeks in the DB,
//  grouped by outlet. Used for trend line chart in GlobalItemSearchModal.
//
//  Each row = 1 period × 1 outlet:
//    - monthLabel, weekLabel (for X-axis sorting)
//    - outletCode, outletName, area (for line identification)
//    - nominalDeviasi (signed, for Y-axis)
//    - devBom (signed, for alternative Y-axis)
//    - direction (LOSS/SURPLUS/NEUTRAL)
//
//  Sorted by period (chronological) then outlet.
//  Uses index @@index([monthLabel, weekLabel, outletId]) for fast scan.
// ============================================================
export interface ItemTrendRow {
  monthLabel: string;
  monthKey: string; // FIX (AUDIT-NEWFEATURES C1): ISO format "2026-08" for chronological sort (monthLabel alphabetical sort is wrong for Indonesian month names)
  weekLabel: string;
  outletCode: string;
  outletName: string;
  area: string;
  nominalDeviasi: number;
  devBom: number | null;
  direction: string;
}

export async function queryItemTrend(
  itemNameFilter: string,
  filters: SqlFilterOpts,
  limit: number = 500
): Promise<ItemTrendRow[]> {
  // No month/week filter — we want ALL periods. Only area + PIC + kelompok filters apply.
  // FIX (BUG-KELOMPOK-GLOBAL): pass kelompok to buildSqlFilters so trend view
  // respects the global kelompok filter.
  const f = buildSqlFilters({
    area: filters.area,
    kelompok: filters.kelompok,
    outletCode: null,
    itemName: null, // handled by exact match below
    picOutletCodes: filters.picOutletCodes,
  });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<ItemTrendRow>>`
    SELECT
      ir."monthLabel",
      sf."monthKey",
      ir."weekLabel",
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE NULL END as "devBom",
      -- FIX VERIFY3-8: direction derived from SUM(nominalLossSurplus) with qtyDeviasi NULL fallback
      -- FIX (RESTORE-SHARED-1): use shared DIRECTION_FROM_SUM_SQL fragment from ../shared
      ${DIRECTION_FROM_SUM_SQL} as "direction"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE LOWER(i.name) = LOWER(${itemNameFilter})
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY ir."monthLabel", sf."monthKey", ir."weekLabel", o.code, o.name, o.area
    ORDER BY sf."monthKey", ir."weekLabel", o.code
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    ...r,
    nominalDeviasi: Number(r.nominalDeviasi),
    devBom: r.devBom != null ? Number(r.devBom) : null,
  }));
}
