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

export async function queryTrendByArea(filters: SqlFilterOpts & {
  weekLabel?: string | null;
}): Promise<AreaTrendRow[]> {
  const f = buildSqlFilters({ ...filters, area: null }); // area=null to get ALL areas
  const weekFilter = filters.weekLabel
    ? Prisma.sql`AND ir."weekLabel" = ${filters.weekLabel}`
    : Prisma.empty;
  const areaFilter = filters.area
    ? Prisma.sql`AND ir.area = ${filters.area}`
    : Prisma.empty;
  // DB-06: same weekFilter but for the OutletPeriodSales alias (`ops`).
  const weekFilterOps = filters.weekLabel
    ? Prisma.sql`AND ops."weekLabel" = ${filters.weekLabel}`
    : Prisma.empty;

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<AreaTrendRow[]>`
    WITH filtered_periods AS (
      SELECT DISTINCT ir.area, ir."outletId", ir."monthLabel", ir."weekLabel"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${weekFilter}
        ${areaFilter}
        ${f}
    ),
    area_period_sales AS (
      SELECT fp.area, fp."monthLabel", fp."weekLabel", SUM(ops."salesMode") as "totalSales"
      FROM "OutletPeriodSales" ops
      JOIN filtered_periods fp
        ON fp."outletId" = ops."outletId"
        AND fp."monthLabel" = ops."monthLabel"
        AND fp."weekLabel" = ops."weekLabel"
      WHERE 1=1
        ${weekFilterOps}
      GROUP BY fp.area, fp."monthLabel", fp."weekLabel"
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
    -- FIX BUG 6: LATERAL join to get exactly 1 monthKey per monthLabel
    -- (prevents duplicate rows if multiple SourceFiles have same monthLabel)
    LEFT JOIN LATERAL (
      SELECT "monthKey" FROM "SourceFile"
      WHERE "monthLabel" = apa."monthLabel"
      LIMIT 1
    ) sf ON true
    ORDER BY apa.area, COALESCE(sf."monthKey", '0000-00'), apa."weekLabel"
  `);
  return rows;
}
