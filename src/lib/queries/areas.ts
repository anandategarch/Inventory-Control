// ============================================================
//  Area-level analysis — per-area aggregates (outlet count,
//  total sales, total abs nominal, avg DevBom, loss-to-sales ratio).
//  Note: area filter is intentionally passed as null to buildSqlFilters
//  so the breakdown covers ALL areas (the caller filters at the area level).
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

// ============================================================
//  Area Analysis — GROUP BY area (Phase 2)
// ============================================================
export async function queryAreaAnalysis(
  week: string,
  month: string,
  filters: SqlFilterOpts
): Promise<Array<{
  area: string;
  outletCount: number;
  totalSales: number;
  totalAbsNominal: number;
  avgDevBom: number;
  lossToSales: number | null;
}>> {
  const f = buildSqlFilters({ ...filters, area: null });
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
  // (heavy multi-CTE aggregation — vulnerable to slow plans on large tables).
  // DB-06: sales_counts → ranked_sales → sales_mode CTE pipeline replaced
  // with pre-computed OutletPeriodSales table (populated at ingest time,
  // see src/lib/ingestion.ts STEP 3.5). The `f` filter is applied via
  // the InventoryRecord subquery in `area_sales` (mirrors original semantics
  // where sales_counts also filtered by `f`). nominalSales is outlet-level
  // denormalized so the precomputed MODE matches the inline CTE output.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
    area: string;
    outletCount: number;
    totalSales: number;
    totalAbsNominal: number;
    avgDevBom: number;
    lossToSales: number | null;
  }[]>`
    WITH area_sales AS (
      -- DB-06: OutletPeriodSales provides the precomputed MODE; the area
      -- comes from InventoryRecord (NOT Outlet.area) to match the original
      -- CTE semantics — some outlets have InventoryRecord.area values that
      -- differ from Outlet.area (data drift from reassignments), and the
      -- original sales_counts CTE grouped by ir.area. Using o.area
      -- would shift sales between areas and break API parity.
      SELECT fp.area, SUM(ops."salesMode") as "totalSales"
      FROM "OutletPeriodSales" ops
      JOIN (
        SELECT DISTINCT ir."outletId", ir.area
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
          ${f}
      ) fp ON ops."outletId" = fp."outletId"
      WHERE ops."monthLabel" = ${month} AND ops."weekLabel" = ${week}
      GROUP BY fp.area
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
  `);
  return rows;
}


