// ============================================================
//  Top Items by Other Metric — Nominal & Dev/BOM top-N
//  --------------------------------------------------------
//  The two single-metric top-N rankings:
//    1. queryTopItemsByNominal — top by ABS(nominalDeviasi)
//    2. queryTopItemsByDevBom  — top by ABS(qtyDeviasi / qtyBom)
//
//  Split from ./by-other-metric.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Both stay
//  re-exported from ./by-other-metric.ts, so the public import
//  path is unchanged.
// ============================================================
import { buildSqlFilters, DIRECTION_FROM_SUM_SQL, withStatementTimeout, type SqlFilterOpts } from '../../shared';

export async function queryTopItemsByNominal(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; satuan: string | null; absNominal: number; nominalDeviasi: number; direction: string; devBom: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 3: Sort by ABS(nominalDeviasi), but return signed nominalDeviasi for display.
  // Previous version sorted/displayed absNominalLossSurplus (NET) — user wants nominalDeviasi (GROSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // REFINE-1: + devBom per group (NULL when the group has no BOM rows) — feeds
  // the "% Deviasi To BOM" column in export table 3.1.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; satuan: string | null; absNominal: number; nominalDeviasi: number; direction: string; devBom: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      MAX(ir."satuan") as "satuan",
      ABS(SUM(ir."nominalDeviasi")) as "absNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") / NULLIF(SUM(ABS(ir."qtyBom")), 0) as "devBom",
      -- FIX VERIFY3-8: direction derived from SUM(nominalLossSurplus) with qtyDeviasi NULL fallback
      -- FIX (RESTORE-SHARED-1): use shared DIRECTION_FROM_SUM_SQL fragment from ../shared
      ${DIRECTION_FROM_SUM_SQL} as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "absNominal" DESC
    LIMIT ${limit}
  `);
  return rows;
}

export async function queryTopItemsByDevBom(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; satuan: string | null; devBom: number; devBomAbs: number; tolerance: number | null; nominalDeviasi: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 4: Sort by ABS(devBom), but return signed devBom for display.
  // Signed devBom = SUM(qtyDeviasi) / SUM(ABS(qtyBom)) — can be negative (SURPLUS) or positive (LOSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // REFINE-1: + signed nominalDeviasi per group — feeds the "Nominal Deviasi"
  // column in export table 3.2.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; satuan: string | null; devBom: number; devBomAbs: number; tolerance: number | null; nominalDeviasi: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      MAX(ir."satuan") as "satuan",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBom",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBomAbs",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      -- FIX FUNC-3: use MIN for LOSS (strictest tolerance), MAX for SURPLUS (was: MAX always)
      CASE
        WHEN SUM(ir."nominalLossSurplus") < 0 THEN MIN(ir."tolerancePct")
        ELSE MAX(ir."tolerancePct")
      END as "tolerance"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."qtyBom" != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "devBomAbs" DESC
    LIMIT ${limit}
  `);
  return rows;
}
