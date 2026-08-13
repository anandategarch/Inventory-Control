// ============================================================
//  Outlet-level queries — top-N outlets by abs nominal deviation
//  and top-N outlets by sales. Sales uses MODE per outlet (deduped
//  via ROW_NUMBER window function).
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters } from './shared';

// ============================================================
//  Top Outlets — GROUP BY outletId (Phase 2)
// ============================================================
export interface TopOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  absNominal: number;
  devBom: number;
  direction: string;
  sales: number;
  lossAmount: number;
  surplusAmount: number;
}

export async function queryTopOutlets(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10
): Promise<TopOutletRow[]> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<TopOutletRow[]>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${f}
      GROUP BY ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
    ),
    outlet_aggs AS (
      SELECT ir."outletId",
        SUM(ir."absNominalLossSurplus") as "absNominal",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "lossAmount",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "surplusAmount"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT o.code as "outletCode", o.name as "outletName", oa."absNominal",
      COALESCE(oa."devBom", 0) as "devBom",
      CASE WHEN oa."lossAmount" > oa."surplusAmount" THEN 'LOSS'
           WHEN oa."surplusAmount" > oa."lossAmount" THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction,
      COALESCE(sm.sales, 0) as sales,
      COALESCE(oa."lossAmount", 0) as "lossAmount",
      COALESCE(oa."surplusAmount", 0) as "surplusAmount",
      ir2.area
    FROM outlet_aggs oa
    JOIN "Outlet" o ON oa."outletId" = o.id
    LEFT JOIN sales_mode sm ON oa."outletId" = sm."outletId"
    JOIN (SELECT DISTINCT "outletId", area FROM "InventoryRecord" WHERE "monthLabel" = ${month} AND "weekLabel" = ${week}) ir2 ON oa."outletId" = ir2."outletId"
    ORDER BY oa."absNominal" DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ============================================================
//  Top Outlets by Sales (Phase 2)
// ============================================================
export async function queryTopOutletsBySales(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10
): Promise<Array<{ outletCode: string; outletName: string; area: string; sales: number; absNominal: number }>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ outletCode: string; outletName: string; area: string; sales: number; absNominal: number }[]>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${f}
      GROUP BY ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
    ),
    outlet_nominal AS (
      SELECT ir."outletId", SUM(ir."absNominalLossSurplus") as "absNominal"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT o.code as "outletCode", o.name as "outletName",
      COALESCE(sm.sales, 0) as sales,
      COALESCE(on2."absNominal", 0) as "absNominal",
      ir2.area
    FROM sales_mode sm
    JOIN "Outlet" o ON sm."outletId" = o.id
    LEFT JOIN outlet_nominal on2 ON sm."outletId" = on2."outletId"
    JOIN (SELECT DISTINCT "outletId", area FROM "InventoryRecord" WHERE "monthLabel" = ${month} AND "weekLabel" = ${week}) ir2 ON sm."outletId" = ir2."outletId"
    ORDER BY sm.sales DESC
    LIMIT ${limit}
  `;
  return rows;
}
