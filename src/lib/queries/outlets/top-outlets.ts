// ============================================================
//  Outlet-level queries — top-N outlets by abs nominal deviation
//  and top-N outlets by sales. Sales uses MODE per outlet (deduped
//  via ROW_NUMBER window function).
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

// ============================================================
//  Top Outlets — GROUP BY outletId (Phase 2)
// ============================================================
export interface TopOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  absNominal: number;  // ABS for sorting only
  nominalDeviasi: number;  // FIX: signed SUM for display (was: only absNominal)
  devBom: number;
  direction: string;
  sales: number;
  lossAmount: number;
  surplusAmount: number;
}

export async function queryTopOutlets(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<TopOutletRow[]> {
  const f = buildSqlFilters(filters);
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // DB-06: sales_mode CTE pipeline replaced with LEFT JOIN to pre-computed
  // OutletPeriodSales table (populated at ingest time, see
  // src/lib/ingestion.ts STEP 3.5). The `f` filter on outlet_aggs already
  // restricts the outlet set; the LEFT JOIN to OutletPeriodSales naturally
  // matches only outlets present in outlet_aggs. nominalSales is outlet-level
  // denormalized so the precomputed MODE matches the inline CTE output.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<TopOutletRow[]>`
    WITH outlet_aggs AS (
      SELECT ir."outletId",
        -- FIX (MASTER-CONTEXT): ABS(SUM(nominalDeviasi)) — ABS of sum, not sum of per-item ABS
        ABS(SUM(ir."nominalDeviasi")) as "absNominal",
        -- FIX (AUDIT-CALC-SQL BUG-1): was SUM(nominalLossSurplus) (NET) — should be SUM(nominalDeviasi) (GROSS)
        -- to match all other queries. nominalDeviasi is GROSS financial impact.
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "lossAmount",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "surplusAmount"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT o.code as "outletCode", o.name as "outletName", COALESCE(oa."absNominal", 0) as "absNominal",
      COALESCE(oa."nominalDeviasi", 0) as "nominalDeviasi",
      COALESCE(oa."devBom", 0) as "devBom",
      CASE WHEN oa."lossAmount" > oa."surplusAmount" THEN 'LOSS'
           WHEN oa."surplusAmount" > oa."lossAmount" THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction,
      COALESCE(ops."salesMode", 0) as sales,
      COALESCE(oa."lossAmount", 0) as "lossAmount",
      COALESCE(oa."surplusAmount", 0) as "surplusAmount",
      o.area
    FROM outlet_aggs oa
    JOIN "Outlet" o ON oa."outletId" = o.id
    LEFT JOIN "OutletPeriodSales" ops
      ON ops."outletId" = oa."outletId"
      AND ops."monthLabel" = ${month}
      AND ops."weekLabel" = ${week}
    ORDER BY oa."absNominal" DESC
    LIMIT ${limit}
  `);
  return rows;
}

// ============================================================
//  Top Outlets by Sales (Phase 2)
// ============================================================
export async function queryTopOutletsBySales(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<Array<{ outletCode: string; outletName: string; area: string; sales: number; absNominal: number; nominalDeviasi: number }>> {
  const f = buildSqlFilters(filters);
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // DB-06: sales_mode CTE pipeline replaced with OutletPeriodSales as the
  // primary table (was: FROM sales_mode sm). The `f` filter (area/kelompok/
  // outletCode/picOutletCodes/itemName) is applied via the same InventoryRecord
  // subquery pattern — preserves the original semantics where only outlets
  // matching `f` are returned.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ outletCode: string; outletName: string; area: string; sales: number; absNominal: number; nominalDeviasi: number }[]>`
    WITH filtered_outlets AS (
      SELECT DISTINCT ir."outletId"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
    ),
    outlet_nominal AS (
      SELECT ir."outletId",
        -- FIX (MASTER-CONTEXT): ABS(SUM(nominalDeviasi)) — ABS of sum, not sum of per-item ABS
        ABS(SUM(ir."nominalDeviasi")) as "absNominal",
        -- FIX (AUDIT-CALC-SQL BUG-1): was SUM(nominalLossSurplus) (NET) — should be SUM(nominalDeviasi) (GROSS)
        SUM(ir."nominalDeviasi") as "nominalDeviasi"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT o.code as "outletCode", o.name as "outletName",
      COALESCE(ops."salesMode", 0) as sales,
      COALESCE(on2."absNominal", 0) as "absNominal",
      COALESCE(on2."nominalDeviasi", 0) as "nominalDeviasi",
      o.area
    FROM "OutletPeriodSales" ops
    JOIN "Outlet" o ON ops."outletId" = o.id
    JOIN filtered_outlets fo ON ops."outletId" = fo."outletId"
    LEFT JOIN outlet_nominal on2 ON ops."outletId" = on2."outletId"
    WHERE ops."monthLabel" = ${month} AND ops."weekLabel" = ${week}
    ORDER BY ops."salesMode" DESC
    LIMIT ${limit}
  `);
  return rows;
}

