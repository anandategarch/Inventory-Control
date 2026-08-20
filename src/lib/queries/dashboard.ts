// ============================================================
//  Dashboard queries — top-level KPIs for the main dashboard view.
//  Includes: trend per period, executive summary, deviation breakdown,
//  loss vs surplus, and cost impact decomposition.
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters } from './shared';

// ============================================================
//  Trend Query — per-period aggregates (Phase 1b)
//  Returns ~18 rows (one per period) instead of 540K raw records
//
//  Business logic preserved:
//  - sales = SUM(MODE(nominalSales) per outlet) — dedup via ROW_NUMBER
//  - nominal = SUM(absNominalDeviasi)
//  - devBom = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))  (volume-weighted, Metric Engine)
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
  weekLabel?: string | null; // FIX: filter trend to same weekLabel only (cumulative weeks)
}): Promise<TrendAggRow[]> {
  const f = buildSqlFilters(filters);
  const weekFilter = filters.weekLabel
    ? Prisma.sql`AND ir."weekLabel" = ${filters.weekLabel}`
    : Prisma.empty;
  const rows = await db.$queryRaw<TrendAggRow[]>`
    WITH sales_counts AS (
      SELECT ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales",
        COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${f}
        ${weekFilter}
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
        COALESCE(SUM(ir."nominalDeviasi"), 0) as nominal,
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "lossNominal",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "surplusNominal"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${f}
        ${weekFilter}
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
        COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
        COALESCE(SUM(ir."absQtyDeviasi"), 0) as "qtyDeviasi",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "qtyWaste",
        COALESCE(SUM(ABS(ir."qtySusut")), 0) as "qtySusut",
        COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "qtyTrial",
        COALESCE(SUM(ir."absQtyLossSurplus"), 0) as "qtyLossSurplus",
        -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalLoss",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "totalSurplus",
        -- FIX CALC-3: use nominalLossSurplus < 0 (LOSS) instead of stored ir.direction (which may be inverted)
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END), 0) as "residualLossQty",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END), 0) as "residualLossNominal",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ir."absQtyDeviasi" ELSE 0 END), 0) as "qtyDeviasiLoss"
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
      -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
      CAST(COUNT(CASE WHEN ir."nominalLossSurplus" < 0 THEN 1 END) AS INTEGER) as loss,
      CAST(COUNT(CASE WHEN ir."nominalLossSurplus" > 0 THEN 1 END) AS INTEGER) as surplus,
      COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "lossNominal",
      COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "surplusNominal"
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
  `;
  return rows[0] || { loss: 0, surplus: 0, lossNominal: 0, surplusNominal: 0 };
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
