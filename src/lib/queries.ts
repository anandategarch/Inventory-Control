// ============================================================
//  SQL Aggregate Queries — Phase 1b/2/4 egress optimization
//  All aggregation done in PostgreSQL, only minimal rows returned
//  Business logic preserved: Sales=MODE per outlet, DevBom=AVG(ABS), etc.
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// ============================================================
//  Build filter conditions for raw SQL (Prisma.sql fragments)
//  Returns an empty Prisma.sql fragment when no filters apply
//  (Prisma.join requires ≥1 element, so handle empty case explicitly)
// ============================================================
export function buildSqlFilters(opts: {
  area?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  picOutletCodes?: string[] | null;
}): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (opts.area) {
    parts.push(Prisma.sql`AND ir.area = ${opts.area}`);
  }
  if (opts.outletCode) {
    parts.push(Prisma.sql`AND ir."outletId" IN (SELECT id FROM "Outlet" WHERE code = ${opts.outletCode})`);
  }
  if (opts.picOutletCodes && opts.picOutletCodes.length > 0) {
    parts.push(Prisma.sql`AND ir."outletId" IN (SELECT id FROM "Outlet" WHERE code = ANY(${opts.picOutletCodes}::text[]))`);
  }
  if (opts.itemName) {
    parts.push(Prisma.sql`AND ir."itemId" IN (SELECT id FROM "Item" WHERE name ILIKE ${'%' + opts.itemName + '%'})`);
  }
  // Prisma.join requires ≥1 element; return empty fragment when no filters
  if (parts.length === 0) return Prisma.sql``;
  if (parts.length === 1) return parts[0];
  return Prisma.join(parts, ' ');
}

// ============================================================
//  Trend Query — per-period aggregates (Phase 1b)
//  Returns ~18 rows (one per period) instead of 540K raw records
//
//  Business logic preserved:
//  - sales = SUM(MODE(nominalSales) per outlet) — dedup via ROW_NUMBER
//  - nominal = SUM(absNominalDeviasi)
//  - devBom = AVG(ABS(pctQtyDeviasiToBom)) WHERE qtyBom != 0
//  - lossNominal = SUM(nominalDeviasi) WHERE > 0
//  - surplusNominal = SUM(ABS(nominalDeviasi)) WHERE < 0
// ============================================================
export interface TrendAggRow {
  monthLabel: string;
  weekLabel: string;
  sales: number;
  nominal: number;
  devBom: number;
  lossNominal: number;
  surplusNominal: number;
}

export async function queryTrendAgg(filters: {
  area?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  picOutletCodes?: string[] | null;
}): Promise<TrendAggRow[]> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<TrendAggRow[]>`
    WITH sales_counts AS (
      SELECT ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales",
        COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${f}
      GROUP BY ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT "monthLabel", "weekLabel", "outletId", "nominalSales",
        ROW_NUMBER() OVER (
          PARTITION BY "monthLabel", "weekLabel", "outletId"
          ORDER BY cnt DESC, "nominalSales" ASC
        ) as rn
      FROM sales_counts
    ),
    sales_per_period AS (
      SELECT "monthLabel", "weekLabel", SUM("nominalSales") as sales
      FROM ranked_sales
      WHERE rn = 1
      GROUP BY "monthLabel", "weekLabel"
    ),
    period_aggs AS (
      SELECT ir."monthLabel", ir."weekLabel",
        COALESCE(SUM(ir."absNominalDeviasi"), 0) as nominal,
        COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "devBom",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "lossNominal",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "surplusNominal"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${f}
      GROUP BY ir."monthLabel", ir."weekLabel"
    )
    SELECT pa."monthLabel", pa."weekLabel",
      COALESCE(sp.sales, 0) as sales,
      pa.nominal,
      pa."devBom",
      pa."lossNominal",
      pa."surplusNominal"
    FROM period_aggs pa
    LEFT JOIN sales_per_period sp ON pa."monthLabel" = sp."monthLabel" AND pa."weekLabel" = sp."weekLabel"
    ORDER BY pa."monthLabel", pa."weekLabel"
  `;
  return rows;
}

// ============================================================
//  Executive Summary Query — single row with all KPIs (Phase 2)
//  Returns 1 row instead of 35K raw records
// ============================================================
export interface ExecSummaryRow {
  sales: number;
  nominalDeviasi: number;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  totalLoss: number;
  totalSurplus: number;
  residualLossQty: number;
  residualLossNominal: number;
  qtyDeviasiLoss: number;
}

export async function queryExecSummary(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<ExecSummaryRow | null> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<ExecSummaryRow[]>`
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
      SELECT SUM("nominalSales") as sales FROM ranked_sales WHERE rn = 1
    ),
    aggs AS (
      SELECT
        COALESCE(SUM(ir."absNominalDeviasi"), 0) as "nominalDeviasi",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
        COALESCE(SUM(ir."absQtyDeviasi"), 0) as "qtyDeviasi",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "qtyWaste",
        COALESCE(SUM(ABS(ir."qtySusut")), 0) as "qtySusut",
        COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "qtyTrial",
        COALESCE(SUM(ir."absQtyLossSurplus"), 0) as "qtyLossSurplus",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "totalLoss",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalSurplus",
        COALESCE(SUM(CASE WHEN ir.direction = 'LOSS' THEN ABS(ir."residualQty") ELSE 0 END), 0) as "residualLossQty",
        COALESCE(SUM(CASE WHEN ir.direction = 'LOSS' THEN ABS(ir."residualNominal") ELSE 0 END), 0) as "residualLossNominal",
        COALESCE(SUM(CASE WHEN ir.direction = 'LOSS' THEN ir."absQtyDeviasi" ELSE 0 END), 0) as "qtyDeviasiLoss"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
    )
    SELECT
      COALESCE(sm.sales, 0) as sales,
      a."nominalDeviasi", a."qtyBom", a."qtyDeviasi", a."qtyWaste",
      a."qtySusut", a."qtyTrial", a."qtyLossSurplus",
      a."totalLoss", a."totalSurplus",
      a."residualLossQty", a."residualLossNominal",
      a."qtyDeviasiLoss"
    FROM aggs a, sales_mode sm
  `;
  return rows[0] || null;
}

// ============================================================
//  Top Items by Metric — GROUP BY itemId (Phase 2)
//  Returns N rows instead of 35K
// ============================================================
export interface TopItemRow {
  itemName: string;
  outletCode: string;
  absNominal: number;
  direction: string;
}

export async function queryTopItemsByNominal(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; absNominal: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; absNominal: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      SUM(ir."absNominalLossSurplus") as "absNominal",
      CASE WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "absNominal" DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function queryTopItemsByDevBom(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; devBom: number; tolerance: number | null }>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; devBom: number; tolerance: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      AVG(ABS(ir."pctQtyDeviasiToBom")) as "devBom",
      MAX(ir."tolerancePct") as "tolerance"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."qtyBom" != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "devBom" DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ============================================================
//  Top Items by Waste/Susut/Trial/LossSurplus (Phase 2)
// ============================================================
export async function queryTopItemsByCategory(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  category: 'waste' | 'susut' | 'trial' | 'lossSurplus',
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; qty: number; nominal: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  const qtyCol = category === 'waste' ? 'qtyWaste'
    : category === 'susut' ? 'qtySusut'
    : category === 'trial' ? 'qtyTrial'
    : 'qtyLossSurplus';
  const nomCol = category === 'waste' ? 'nominalWaste'
    : category === 'susut' ? 'nominalSusut'
    : category === 'trial' ? 'nominalTrial'
    : 'nominalLossSurplus';

  // Build column reference safely
  const qtyRef = Prisma.raw(`ir."${qtyCol}"`);
  const nomRef = Prisma.raw(`ir."${nomCol}"`);

  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; qty: number; nominal: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      SUM(ABS(${qtyRef})) as qty,
      SUM(ABS(${nomRef})) as nominal,
      CASE WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ${qtyRef} IS NOT NULL AND ${qtyRef} != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY qty DESC
    LIMIT ${limit}
  `;
  return rows;
}

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
        AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL) as "devBom",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "lossAmount",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "surplusAmount"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT o.code as "outletCode", o.name as "outletName", oa."absNominal",
      COALESCE(oa."devBom", 0) as "devBom",
      CASE WHEN oa."lossAmount" > oa."surplusAmount" THEN 'LOSS' ELSE 'SURPLUS' END as direction,
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

// ============================================================
//  Deviation Breakdown — single row (Phase 2)
// ============================================================
export async function queryDeviationBreakdown(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<{ waste: number; susut: number; trial: number; residual: number; total: number }> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ waste: number; susut: number; trial: number; residual: number; total: number }[]>`
    SELECT
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as waste,
      COALESCE(SUM(ABS(ir."qtySusut")), 0) as susut,
      COALESCE(SUM(ABS(ir."qtyTrial")), 0) as trial,
      COALESCE(SUM(ABS(ir."residualQty")), 0) as residual,
      COALESCE(SUM(ir."absQtyDeviasi"), 0) as total
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
  `;
  return rows[0] || { waste: 0, susut: 0, trial: 0, residual: 0, total: 0 };
}

// ============================================================
//  Loss vs Surplus — single row (Phase 2)
// ============================================================
export async function queryLossVsSurplus(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<{ loss: number; surplus: number; lossNominal: number; surplusNominal: number }> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ loss: number; surplus: number; lossNominal: number; surplusNominal: number }[]>`
    SELECT
      COUNT(*) FILTER (WHERE ir."nominalLossSurplus" > 0)::int as loss,
      COUNT(*) FILTER (WHERE ir."nominalLossSurplus" < 0)::int as surplus,
      COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "lossNominal",
      COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "surplusNominal"
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
  `;
  return rows[0] || { loss: 0, surplus: 0, lossNominal: 0, surplusNominal: 0 };
}

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
        COUNT(DISTINCT ir."outletId")::int as "outletCount",
        SUM(ir."absNominalLossSurplus") as "totalAbsNominal",
        AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL) as "avgDevBom",
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

// ============================================================
//  Cost Impact — single row (Phase 2)
// ============================================================
export async function queryCostImpact(
  week: string,
  month: string,
  salesTotal: number,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<{
  wasteCost: number; susutCost: number; trialCost: number; residualCost: number; totalCost: number;
  wastePct: number; susutPct: number; trialPct: number; residualPct: number;
  wasteToSales: number; susutToSales: number; trialToSales: number; residualToSales: number; totalCostToSales: number;
}> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{
    wasteCost: number; susutCost: number; trialCost: number; residualCost: number; totalCost: number;
  }[]>`
    SELECT
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "wasteCost",
      COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "susutCost",
      COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "trialCost",
      COALESCE(SUM(ABS(ir."residualNominal")), 0) as "residualCost",
      COALESCE(SUM(ABS(ir."nominalWaste")), 0)
        + COALESCE(SUM(ABS(ir."nominalSusut")), 0)
        + COALESCE(SUM(ABS(ir."nominalTrial")), 0)
        + COALESCE(SUM(ABS(ir."residualNominal")), 0) as "totalCost"
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
  `;
  const r = rows[0] || { wasteCost: 0, susutCost: 0, trialCost: 0, residualCost: 0, totalCost: 0 };
  // BUG 2.3 fix: if totalCost is 0, percentages should be 0 (not wasteCost/1 = 10000%).
  // Previously `total = totalCost || 1` produced 10000% values when columns were NULL.
  const safeDiv = (num: number, den: number): number => den > 0 ? num / den : 0;
  return {
    ...r,
    wastePct: safeDiv(r.wasteCost, r.totalCost),
    susutPct: safeDiv(r.susutCost, r.totalCost),
    trialPct: safeDiv(r.trialCost, r.totalCost),
    residualPct: safeDiv(r.residualCost, r.totalCost),
    wasteToSales: safeDiv(r.wasteCost, salesTotal),
    susutToSales: safeDiv(r.susutCost, salesTotal),
    trialToSales: safeDiv(r.trialCost, salesTotal),
    residualToSales: safeDiv(r.residualCost, salesTotal),
    totalCostToSales: safeDiv(r.totalCost, salesTotal),
  };
}

// ============================================================
//  Pareto Analysis — window function (Phase 4)
//  Returns top N items + total item count + class A stats (across ALL items)
// ============================================================
export async function queryPareto(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 50
): Promise<{
  items: Array<{ rank: number; itemName: string; outletCode: string; absNominal: number; cumulative: number; cumulativePct: number; classification: 'A' | 'B' | 'C' }>;
  classACount: number; classACost: number; classAPct: number;
  classBCount: number; classBCost: number; classBPct: number;
  classCCount: number; classCCost: number; classCPct: number;
  totalItems: number; totalAbsNominal: number;
  // Phase 4: true class A stats across ALL items (not capped by LIMIT)
  classACountFull: number; classAPctFull: number;
}> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{
    rank: number; itemName: string; outletCode: string; absNominal: number;
    cumulative: number; cumulativePct: number; classification: 'A' | 'B' | 'C';
    totalItems: number; grandTotal: number;
    classACountFull: number; classAPctFull: number;
  }[]>`
    WITH item_totals AS (
      SELECT i.name as "itemName", o.code as "outletCode",
        SUM(ir."absNominalLossSurplus") as "absNominal"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
        ${f}
      GROUP BY i.name, o.code
    ),
    ranked AS (
      SELECT "itemName", "outletCode", "absNominal",
        ROW_NUMBER() OVER (ORDER BY "absNominal" DESC)::int as rank,
        SUM("absNominal") OVER (ORDER BY "absNominal" DESC) as cumulative,
        SUM("absNominal") OVER () as grand_total,
        COUNT(*) OVER ()::int as total_items
      FROM item_totals
    ),
    class_a_stats AS (
      SELECT
        COUNT(*)::int as class_a_count,
        COALESCE(MAX(cumulative / NULLIF(grand_total, 0)), 0) as class_a_pct
      FROM ranked
      WHERE cumulative / NULLIF(grand_total, 0) <= 0.70
    )
    SELECT r.rank, r."itemName", r."outletCode", r."absNominal", r.cumulative,
      (r.cumulative / NULLIF(r.grand_total, 0)) * 100 as "cumulativePct",
      CASE
        WHEN (r.cumulative / NULLIF(r.grand_total, 0)) * 100 <= 70 THEN 'A'
        WHEN (r.cumulative / NULLIF(r.grand_total, 0)) * 100 <= 90 THEN 'B'
        ELSE 'C'
      END as classification,
      r.total_items as "totalItems",
      r.grand_total as "grandTotal",
      (SELECT class_a_count FROM class_a_stats) as "classACountFull",
      (SELECT class_a_pct FROM class_a_stats) as "classAPctFull"
    FROM ranked r
    ORDER BY r.rank
    LIMIT ${limit}
  `;

  const items = rows;
  const grandTotal = items.length > 0 ? items[0].grandTotal : 0;
  const totalItemsCount = items.length > 0 ? items[0].totalItems : 0;
  const classACountFull = items.length > 0 ? items[0].classACountFull : 0;
  const classAPctFull = items.length > 0 ? items[0].classAPctFull : 0;

  // Class A/B/C stats WITHIN returned items (for backward compat)
  const classA = items.filter(i => i.classification === 'A');
  const classB = items.filter(i => i.classification === 'B');
  const classC = items.filter(i => i.classification === 'C');

  return {
    items,
    classACount: classA.length,
    classACost: classA.reduce((s, i) => s + i.absNominal, 0),
    classAPct: grandTotal > 0 ? classA.reduce((s, i) => s + i.absNominal, 0) / grandTotal : 0,
    classBCount: classB.length,
    classBCost: classB.reduce((s, i) => s + i.absNominal, 0),
    classBPct: grandTotal > 0 ? classB.reduce((s, i) => s + i.absNominal, 0) / grandTotal : 0,
    classCCount: classC.length,
    classCCost: classC.reduce((s, i) => s + i.absNominal, 0),
    classCPct: grandTotal > 0 ? classC.reduce((s, i) => s + i.absNominal, 0) / grandTotal : 0,
    totalItems: totalItemsCount,
    totalAbsNominal: grandTotal,
    classACountFull,
    classAPctFull,
  };
}

// ============================================================
//  Item Consistency — GROUP BY itemName with outlet count (Phase 4)
//  SYSTEMIC: >=10 outlets, WIDESPREAD: 5-9, ISOLATED: 2-4
// ============================================================
export async function queryItemConsistency(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<Array<{
  itemName: string;
  outletCount: number;
  lossOutlets: number;
  surplusOutlets: number;
  totalAbsNominal: number;
  avgDevBom: number;
  consistency: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
}>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{
    itemName: string;
    outletCount: number;
    lossOutlets: number;
    surplusOutlets: number;
    totalAbsNominal: number;
    avgDevBom: number;
    consistency: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
  }[]>`
    WITH item_outlets AS (
      SELECT i.name as "itemName",
        COUNT(DISTINCT ir."outletId")::int as "outletCount",
        COUNT(DISTINCT CASE WHEN ir.direction = 'LOSS' THEN ir."outletId" END)::int as "lossOutlets",
        COUNT(DISTINCT CASE WHEN ir.direction = 'SURPLUS' THEN ir."outletId" END)::int as "surplusOutlets",
        SUM(ir."absNominalLossSurplus") as "totalAbsNominal",
        AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL) as "avgDevBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
        ${f}
      GROUP BY i.name
    )
    SELECT "itemName", "outletCount", "lossOutlets", "surplusOutlets",
      "totalAbsNominal", COALESCE("avgDevBom", 0) as "avgDevBom",
      CASE
        WHEN "outletCount" >= 10 THEN 'SYSTEMIC'
        WHEN "outletCount" >= 5 THEN 'WIDESPREAD'
        ELSE 'ISOLATED'
      END as consistency
    FROM item_outlets
    ORDER BY "totalAbsNominal" DESC
  `;
  return rows;
}

// ============================================================
//  Historical Stats — per outlet+item AVG/STDDEV (Phase 4)
//  Returns ~N rows (outlet+item pairs) instead of 540K raw records
// ============================================================
export async function queryHistoricalStats(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<Map<string, { mean: number; stdDev: number; n: number }>> {
  if (historicalPeriods.length === 0) return new Map();

  // Build OR conditions for historical periods
  const periodPairs = historicalPeriods.map(p => `${p.monthLabel}|${p.weekLabel}`);
  const f = buildSqlFilters(filters);

  const rows = await db.$queryRaw<{
    outletId: number; itemId: number; mean: number; stdDev: number; n: number;
  }[]>`
    SELECT ir."outletId", ir."itemId",
      AVG(ir."pctQtyDeviasiToBom") as mean,
      COALESCE(STDDEV_POP(ir."pctQtyDeviasiToBom"), 0) as "stdDev",
      COUNT(*)::int as n
    FROM "InventoryRecord" ir
    WHERE (ir."monthLabel" || '|' || ir."weekLabel") IN (${Prisma.join(periodPairs)})
      AND ir."pctQtyDeviasiToBom" IS NOT NULL
      AND ir."qtyBom" != 0
      ${f}
    GROUP BY ir."outletId", ir."itemId"
  `;

  const map = new Map<string, { mean: number; stdDev: number; n: number }>();
  for (const r of rows) {
    map.set(`${r.outletId}|${r.itemId}`, { mean: r.mean, stdDev: r.stdDev, n: r.n });
  }
  return map;
}
