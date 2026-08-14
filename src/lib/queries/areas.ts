// ============================================================
//  Area-level analysis — per-area aggregates (outlet count,
//  total sales, total abs nominal, avg DevBom, loss-to-sales ratio).
//  Note: area filter is intentionally passed as null to buildSqlFilters
//  so the breakdown covers ALL areas (the caller filters at the area level).
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters } from './shared';

// ============================================================
//  Area Analysis — GROUP BY area (Phase 2)
// ============================================================
export async function queryAreaAnalysis(
  week: string,
  month: string,
  filters: {
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<Array<{
  area: string;
  outletCount: number;
  totalSales: number;
  totalAbsNominal: number;
  avgDevBom: number;
  lossToSales: number | null;
}>> {
  const f = buildSqlFilters({ ...filters, area: null });
  const rows = await db.$queryRaw<{
    area: string;
    outletCount: number;
    totalSales: number;
    totalAbsNominal: number;
    avgDevBom: number;
    lossToSales: number | null;
  }[]>`
    WITH sales_counts AS (
      SELECT ir.area, ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${f}
      GROUP BY ir.area, ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT area, "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY area, "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT area, "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
    ),
    area_sales AS (
      SELECT area, SUM(sales) as "totalSales" FROM sales_mode GROUP BY area
    ),
    area_aggs AS (
      SELECT ir.area,
        CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
        SUM(ir."absNominalLossSurplus") as "totalAbsNominal",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "avgDevBom",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "lossNominal"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir.area
    )
    SELECT aa.area, aa."outletCount",
      COALESCE(ast."totalSales", 0) as "totalSales",
      COALESCE(aa."totalAbsNominal", 0) as "totalAbsNominal",
      COALESCE(aa."avgDevBom", 0) as "avgDevBom",
      CASE WHEN COALESCE(ast."totalSales", 0) > 0
        THEN aa."lossNominal" / ast."totalSales"
        ELSE NULL END as "lossToSales"
    FROM area_aggs aa
    LEFT JOIN area_sales ast ON aa.area = ast.area
    ORDER BY aa."totalAbsNominal" DESC
  `;
  return rows;
}
