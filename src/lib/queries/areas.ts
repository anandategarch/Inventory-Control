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
        -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "lossNominal"
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

// ============================================================
//  Trend by Area — per area × per period aggregates
//  Returns one row per (area, monthLabel, weekLabel) with:
//  - sales (MODE per outlet, summed)
//  - avgDevBom = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))
//  - totalAbsNominal = SUM(ABS(nominalLossSurplus))
//  - outletCount
//
//  Used by AreaTrendChart to show Dev/BOM% trend per area over time.
//  Filter by same weekLabel only (cumulative weeks — W4 vs W4, not W4 vs W1).
// ============================================================
export interface AreaTrendRow {
  area: string;
  monthLabel: string;
  weekLabel: string;
  monthKey: string | null;
  sales: number;
  avgDevBom: number;
  totalAbsNominal: number;
  outletCount: number;
}

export async function queryTrendByArea(filters: {
  weekLabel?: string | null;
  area?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  picOutletCodes?: string[] | null;
}): Promise<AreaTrendRow[]> {
  const f = buildSqlFilters({ ...filters, area: null }); // area=null to get ALL areas
  const weekFilter = filters.weekLabel
    ? Prisma.sql`AND ir."weekLabel" = ${filters.weekLabel}`
    : Prisma.empty;
  const areaFilter = filters.area
    ? Prisma.sql`AND ir.area = ${filters.area}`
    : Prisma.empty;

  const rows = await db.$queryRaw<AreaTrendRow[]>`
    WITH sales_counts AS (
      SELECT ir.area, ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales",
        COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${weekFilter}
        ${areaFilter}
        ${f}
      GROUP BY ir.area, ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT area, "monthLabel", "weekLabel", "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY area, "monthLabel", "weekLabel", "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT area, "monthLabel", "weekLabel", "outletId", "nominalSales" as sales
      FROM ranked_sales WHERE rn = 1
    ),
    area_period_sales AS (
      SELECT area, "monthLabel", "weekLabel", SUM(sales) as "totalSales"
      FROM sales_mode GROUP BY area, "monthLabel", "weekLabel"
    ),
    area_period_aggs AS (
      SELECT ir.area, ir."monthLabel", ir."weekLabel",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "avgDevBom",
        COALESCE(SUM(ir."absNominalLossSurplus"), 0) as "totalAbsNominal",
        CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${weekFilter}
        ${areaFilter}
        ${f}
      GROUP BY ir.area, ir."monthLabel", ir."weekLabel"
    )
    SELECT apa.area, apa."monthLabel", apa."weekLabel",
      sf."monthKey",
      COALESCE(aps."totalSales", 0) as sales,
      COALESCE(apa."avgDevBom", 0) as "avgDevBom",
      COALESCE(apa."totalAbsNominal", 0) as "totalAbsNominal",
      COALESCE(apa."outletCount", 0) as "outletCount"
    FROM area_period_aggs apa
    LEFT JOIN area_period_sales aps
      ON apa.area = aps.area AND apa."monthLabel" = aps."monthLabel" AND apa."weekLabel" = aps."weekLabel"
    LEFT JOIN "SourceFile" sf ON sf."monthLabel" = apa."monthLabel"
    ORDER BY apa.area, COALESCE(sf."monthKey", '0000-00'), apa."weekLabel"
  `;
  return rows;
}
