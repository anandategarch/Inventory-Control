// ============================================================
//  Dashboard queries — top-level KPIs for the main dashboard view.
//  Includes: trend per period, executive summary, deviation breakdown,
//  loss vs surplus, and cost impact decomposition.
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

// ============================================================
//  Trend Query — per-period aggregates (Phase 1b)
//  Returns ~18 rows (one per period) instead of 540K raw records
//
//  Business logic preserved:
//  - sales = SUM(MODE(nominalSales) per outlet) — dedup via ROW_NUMBER
//  - nominal = SUM(nominalDeviasi) (signed)
//  - devBom = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))  (volume-weighted, Metric Engine)
//  - lossNominal = SUM(ABS(nominalLossSurplus)) WHERE nominalLossSurplus < 0 (LOSS = negative)
//  - surplusNominal = SUM(nominalLossSurplus) WHERE > 0 (SURPLUS = positive)
// ============================================================
export interface TrendAggRow {
  monthLabel: string;
  weekLabel: string;
  sales: number;
  nominal: number;
  devBom: number;
  qtyBom?: number; // FIX FLOW3-2: added for multiPeriodComparison.bom
  lossNominal: number;
  surplusNominal: number;
}

export async function queryTrendAgg(filters: SqlFilterOpts & {
  weekLabel?: string | null; // FIX: filter trend to same weekLabel only (cumulative weeks)
}): Promise<TrendAggRow[]> {
  const f = buildSqlFilters(filters);
  const weekFilter = filters.weekLabel
    ? Prisma.sql`AND ir."weekLabel" = ${filters.weekLabel}`
    : Prisma.empty;
  // DB-06: same weekFilter but for the OutletPeriodSales alias (`ops`).
  // Used by the refactored sales_per_period CTE.
  const weekFilterOps = filters.weekLabel
    ? Prisma.sql`AND ops."weekLabel" = ${filters.weekLabel}`
    : Prisma.empty;
  // PERF-DB-02: when no InventoryRecord-specific filter (item, area, outlet, pic)
  // is applied, derive `filtered_periods` from OutletPeriodSales (4400 rows)
  // instead of InventoryRecord (306K rows). The set of (outletId, monthLabel,
  // weekLabel) tuples is identical between the two tables (OutletPeriodSales is
  // populated from InventoryRecord at ingest time), but OutletPeriodSales is
  // 70× smaller → eliminates a parallel seq scan of InventoryRecord.
  //
  // PERF (TAHAP-2 / P2-8): the same ops-based derivation now ALSO applies when
  // the filter set is OUTLET-RESOLVABLE ONLY (kelompok / outletCode / pic) —
  // those filters were already expressed as `outletId IN (SELECT id FROM Outlet
  // WHERE ...)` subqueries by buildSqlFilters, so restricting OutletPeriodSales
  // by the SAME subquery yields the identical tuple set WITHOUT the fallback's
  // DISTINCT scan over InventoryRecord. That fallback was the "outlet filter →
  // 40-60s tail" hot spot: with no month predicate on the trend's all-period
  // scope, the planner had no usable leading index for the outletId-subquery
  // form and seq-scanned the whole 280K-row table.
  //   - itemName → still the ir fallback (the item dimension only exists on
  //     InventoryRecord; OutletPeriodSales has no item column).
  //   - area → still the ir fallback (ir.area is the per-row stamped value; the
  //     (area, monthLabel, weekLabel) index keeps that DISTINCT scan cheap
  //     — ~1/19th of the table, index-driven).
  const hasIrOnlyFilter = !!(filters.area || filters.itemName);
  const hasOutletResolvableFilter = !!(
    filters.kelompok ||
    filters.outletCode ||
    (filters.picOutletCodes && filters.picOutletCodes.length > 0)
  );
  let filteredPeriodsSql: Prisma.Sql;
  if (hasIrOnlyFilter) {
    filteredPeriodsSql = Prisma.sql`
      SELECT DISTINCT ir."outletId", ir."monthLabel", ir."weekLabel"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${f}
        ${weekFilter}
    `;
  } else if (hasOutletResolvableFilter) {
    // Same Outlet predicates buildSqlFilters generates (kelompok / outletCode /
    // pic), applied to the 4.4K-row OutletPeriodSales instead of InventoryRecord.
    const outletPreds: Prisma.Sql[] = [];
    if (filters.kelompok) {
      outletPreds.push(Prisma.sql`LEFT(SUBSTRING(code FROM '[^.]+$'), 3) = UPPER(${filters.kelompok})`);
    }
    if (filters.outletCode) {
      outletPreds.push(Prisma.sql`code = ${filters.outletCode}`);
    }
    if (filters.picOutletCodes && filters.picOutletCodes.length > 0) {
      // Empty-PIC sentinel ('__NO_MATCH__') flows through as a non-matching code
      // set — same empty result the ir fallback produced.
      outletPreds.push(Prisma.sql`code IN (${Prisma.join(filters.picOutletCodes)})`);
    }
    const outletWhere = Prisma.join(outletPreds, ' AND ');
    filteredPeriodsSql = Prisma.sql`
      SELECT DISTINCT ops."outletId", ops."monthLabel", ops."weekLabel"
      FROM "OutletPeriodSales" ops
      WHERE 1=1
        ${weekFilterOps}
        AND ops."outletId" IN (SELECT id FROM "Outlet" WHERE ${outletWhere})
    `;
  } else {
    filteredPeriodsSql = Prisma.sql`
      SELECT DISTINCT "outletId", "monthLabel", "weekLabel"
      FROM "OutletPeriodSales" ops
      WHERE 1=1
        ${weekFilterOps}
    `;
  }
  // FIX H4 (AUDIT-7): wrap in withStatementTimeout — trend query scans all periods.
  // DB-06: sales_counts → ranked_sales → sales_per_period CTE pipeline replaced
  // with pre-computed OutletPeriodSales table. The `f` filter (which can include
  // itemName) is applied via the `filtered_periods` subquery — this returns the
  // (outletId, monthLabel, weekLabel) tuples that match `f`+weekFilter on
  // InventoryRecord, preserving the original semantics where only outlets with
  // matching records in a given period contribute to that period's SUM.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<TrendAggRow[]>`
    WITH filtered_periods AS (
      ${filteredPeriodsSql}
    ),
    sales_per_period AS (
      SELECT ops."monthLabel", ops."weekLabel", SUM(ops."salesMode") as sales
      FROM "OutletPeriodSales" ops
      JOIN filtered_periods fp
        ON fp."outletId" = ops."outletId"
        AND fp."monthLabel" = ops."monthLabel"
        AND fp."weekLabel" = ops."weekLabel"
      WHERE 1=1
        ${weekFilterOps}
      GROUP BY ops."monthLabel", ops."weekLabel"
    ),
    period_aggs AS (
      SELECT ir."monthLabel", ir."weekLabel",
        COALESCE(SUM(ir."nominalDeviasi"), 0) as nominal,
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        -- FIX FLOW3-2: add qtyBom aggregate so multiPeriodComparison.bom is not always null
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
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
      pa."qtyBom",
      pa."lossNominal",
      pa."surplusNominal"
    FROM period_aggs pa
    LEFT JOIN sales_per_period sp ON pa."monthLabel" = sp."monthLabel" AND pa."weekLabel" = sp."weekLabel"
    ORDER BY pa."monthLabel", pa."weekLabel"
  `);
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
  filters: SqlFilterOpts
): Promise<ExecSummaryRow | null> {
  const f = buildSqlFilters(filters);
  // FIX H4 (AUDIT-7): wrap in withStatementTimeout — exec summary is critical path.
  // DB-06: sales_counts → ranked_sales → sales_mode CTE pipeline (Variant D —
  // grand total of MODE per outlet) replaced with pre-computed OutletPeriodSales
  // table. The `f` filter is applied via the InventoryRecord subquery so only
  // outlets matching `f` (area/kelompok/outletCode/picOutletCodes/itemName)
  // contribute to the grand total — preserves original semantics.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<ExecSummaryRow[]>`
    WITH sales_mode AS (
      SELECT SUM(ops."salesMode") as sales
      FROM "OutletPeriodSales" ops
      WHERE ops."monthLabel" = ${month} AND ops."weekLabel" = ${week}
        AND ops."outletId" IN (
          SELECT DISTINCT ir."outletId"
          FROM "InventoryRecord" ir
          WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
            ${f}
        )
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
  `);
  return rows[0] || null;
}

// ============================================================
//  Deviation Breakdown — single row (Phase 2)
// ============================================================
export async function queryDeviationBreakdown(
  week: string,
  month: string,
  filters: SqlFilterOpts
): Promise<{ waste: number; susut: number; trial: number; residual: number; total: number }> {
  const f = buildSqlFilters(filters);
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ waste: number; susut: number; trial: number; residual: number; total: number }[]>`
    SELECT
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as waste,
      COALESCE(SUM(ABS(ir."qtySusut")), 0) as susut,
      COALESCE(SUM(ABS(ir."qtyTrial")), 0) as trial,
      COALESCE(SUM(ABS(ir."residualQty")), 0) as residual,
      COALESCE(SUM(ir."absQtyDeviasi"), 0) as total
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
  `);
  return rows[0] || { waste: 0, susut: 0, trial: 0, residual: 0, total: 0 };
}

// ============================================================
//  Deviation Breakdown Drivers — per-item aggregates across
//  4 categories (waste / susut / trial / residual) in a single
//  query. Used by the Deviation Breakdown card to power the
//  80% Pareto drill-down (mirrors GrowthComparison's growthDrivers).
//
//  Groups by item name (cross-outlet aggregation) so the user sees
//  "Ayam Fillet contributes 30% of total waste" regardless of which
//  outlet generated it. Returns ALL items — JS computes the Pareto
//  cut at 80% cumulative share.
// ============================================================
export interface DeviationDriverItemRow {
  itemName: string;
  wasteQty: number;
  wasteNominal: number;
  susutQty: number;
  susutNominal: number;
  trialQty: number;
  trialNominal: number;
  residualQty: number;
  residualNominal: number;
}

export async function queryDeviationBreakdownDrivers(
  week: string,
  month: string,
  filters: SqlFilterOpts
): Promise<DeviationDriverItemRow[]> {
  const f = buildSqlFilters(filters);
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<DeviationDriverItemRow[]>`
    SELECT
      i.name as "itemName",
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "wasteQty",
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "wasteNominal",
      COALESCE(SUM(ABS(ir."qtySusut")), 0) as "susutQty",
      COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "susutNominal",
      COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "trialQty",
      COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "trialNominal",
      COALESCE(SUM(ABS(ir."residualQty")), 0) as "residualQty",
      COALESCE(SUM(ABS(ir."residualNominal")), 0) as "residualNominal"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
    GROUP BY i.name
    -- FIX M-D (AUDIT-1): cap at 500 items to prevent unbounded payload if
    -- catalog grows. Currently ~109 items, but no safeguard existed.
    LIMIT 500
  `);
  return rows;
}

// ============================================================
//  Loss vs Surplus — single row (Phase 2)
// ============================================================
export async function queryLossVsSurplus(
  week: string,
  month: string,
  filters: SqlFilterOpts
): Promise<{ loss: number; surplus: number; lossNominal: number; surplusNominal: number }> {
  const f = buildSqlFilters(filters);
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ loss: number; surplus: number; lossNominal: number; surplusNominal: number }[]>`
    SELECT
      -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
      CAST(COUNT(CASE WHEN ir."nominalLossSurplus" < 0 THEN 1 END) AS INTEGER) as loss,
      CAST(COUNT(CASE WHEN ir."nominalLossSurplus" > 0 THEN 1 END) AS INTEGER) as surplus,
      COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "lossNominal",
      COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "surplusNominal"
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
  `);
  return rows[0] || { loss: 0, surplus: 0, lossNominal: 0, surplusNominal: 0 };
}

// ============================================================
//  Cost Impact — single row (Phase 2)
// ============================================================
export async function queryCostImpact(
  week: string,
  month: string,
  salesTotal: number,
  filters: SqlFilterOpts
): Promise<{
  wasteCost: number; susutCost: number; trialCost: number; residualCost: number; totalCost: number;
  wastePct: number; susutPct: number; trialPct: number; residualPct: number;
  wasteToSales: number; susutToSales: number; trialToSales: number; residualToSales: number; totalCostToSales: number;
}> {
  const f = buildSqlFilters(filters);
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
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
  `);
  const r = rows[0] || { wasteCost: 0, susutCost: 0, trialCost: 0, residualCost: 0, totalCost: 0 };
  return costImpactRatios(r, salesTotal);
}

// ============================================================
//  PERF (PAKET B / F2 — scan merge): queryDashboardKpis
//  --------------------------------------------------------
//  queryExecSummary + queryDeviationBreakdown + queryLossVsSurplus +
//  queryCostImpact each scanned the SAME filtered period
//  (WHERE monthLabel/weekLabel/f) separately — 4 scans + 4 transactions
//  for what is one logical "current-period KPI" read. This function does
//  it in ONE scan + ONE transaction.
//
//  Field-for-field identical to the four originals:
//    - exec:      sales (sales_mode CTE) + the 13 aggs expressions
//    - breakdown: waste/susut/trial = the same qty aggregates already in
//                 exec (qtyWaste/qtySusut/qtyTrial); total = qtyDeviasi;
//                 residual = NEW SUM(ABS(residualQty))
//    - lvs:       lossNominal/surplusNominal = totalLoss/totalSurplus
//                 (identical expressions); loss/surplus counts = NEW
//    - cost:      the 5 nominal aggregates (identical expressions)
//  The individual functions are kept (tested + used by export-report);
//  the analysis pipeline + export-report now use this merged query.
// ============================================================
export interface DashboardKpisRow extends ExecSummaryRow {
  // queryDeviationBreakdown extras
  residualQtyAbs: number;
  // queryLossVsSurplus extras
  lossCount: number;
  surplusCount: number;
  // queryCostImpact fields
  wasteCost: number;
  susutCost: number;
  trialCost: number;
  residualCost: number;
  totalCost: number;
}

/** Shared ratio math — used by both queryCostImpact and kpisToCostImpact. */
function costImpactRatios(
  r: Pick<DashboardKpisRow, 'wasteCost' | 'susutCost' | 'trialCost' | 'residualCost' | 'totalCost'>,
  salesTotal: number,
): {
  wasteCost: number; susutCost: number; trialCost: number; residualCost: number; totalCost: number;
  wastePct: number; susutPct: number; trialPct: number; residualPct: number;
  wasteToSales: number; susutToSales: number; trialToSales: number; residualToSales: number; totalCostToSales: number;
} {
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

export async function queryDashboardKpis(
  week: string,
  month: string,
  filters: SqlFilterOpts
): Promise<DashboardKpisRow | null> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<DashboardKpisRow[]>`
    WITH sales_mode AS (
      SELECT SUM(ops."salesMode") as sales
      FROM "OutletPeriodSales" ops
      WHERE ops."monthLabel" = ${month} AND ops."weekLabel" = ${week}
        AND ops."outletId" IN (
          SELECT DISTINCT ir."outletId"
          FROM "InventoryRecord" ir
          WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
            ${f}
        )
    ),
    aggs AS (
      SELECT
        -- ==== queryExecSummary fields (identical expressions) ====
        COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
        COALESCE(SUM(ir."absQtyDeviasi"), 0) as "qtyDeviasi",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "qtyWaste",
        COALESCE(SUM(ABS(ir."qtySusut")), 0) as "qtySusut",
        COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "qtyTrial",
        COALESCE(SUM(ir."absQtyLossSurplus"), 0) as "qtyLossSurplus",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalLoss",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "totalSurplus",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END), 0) as "residualLossQty",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END), 0) as "residualLossNominal",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ir."absQtyDeviasi" ELSE 0 END), 0) as "qtyDeviasiLoss",
        -- ==== queryDeviationBreakdown extras ====
        COALESCE(SUM(ABS(ir."residualQty")), 0) as "residualQtyAbs",
        -- ==== queryLossVsSurplus extras (nominal totals = totalLoss/totalSurplus above) ====
        CAST(COUNT(CASE WHEN ir."nominalLossSurplus" < 0 THEN 1 END) AS INTEGER) as "lossCount",
        CAST(COUNT(CASE WHEN ir."nominalLossSurplus" > 0 THEN 1 END) AS INTEGER) as "surplusCount",
        -- ==== queryCostImpact fields (identical expressions) ====
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
    )
    SELECT
      COALESCE(sm.sales, 0) as sales,
      a."nominalDeviasi", a."qtyBom", a."qtyDeviasi", a."qtyWaste",
      a."qtySusut", a."qtyTrial", a."qtyLossSurplus",
      a."totalLoss", a."totalSurplus",
      a."residualLossQty", a."residualLossNominal",
      a."qtyDeviasiLoss",
      a."residualQtyAbs", a."lossCount", a."surplusCount",
      a."wasteCost", a."susutCost", a."trialCost", a."residualCost", a."totalCost"
    FROM aggs a, sales_mode sm
  `);
  return rows[0] || null;
}

const ZERO_KPIS: DashboardKpisRow = {
  sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0,
  qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0,
  residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0,
  residualQtyAbs: 0, lossCount: 0, surplusCount: 0,
  wasteCost: 0, susutCost: 0, trialCost: 0, residualCost: 0, totalCost: 0,
};

/** Derive queryDeviationBreakdown's result shape from a merged KPI row. */
export function kpisToBreakdown(k: DashboardKpisRow | null): { waste: number; susut: number; trial: number; residual: number; total: number } {
  const r = k ?? ZERO_KPIS;
  return { waste: r.qtyWaste, susut: r.qtySusut, trial: r.qtyTrial, residual: r.residualQtyAbs, total: r.qtyDeviasi };
}

/** Derive queryLossVsSurplus's result shape from a merged KPI row. */
export function kpisToLvs(k: DashboardKpisRow | null): { loss: number; surplus: number; lossNominal: number; surplusNominal: number } {
  const r = k ?? ZERO_KPIS;
  return { loss: r.lossCount, surplus: r.surplusCount, lossNominal: r.totalLoss, surplusNominal: r.totalSurplus };
}

/** Derive queryCostImpact's result shape from a merged KPI row. */
export function kpisToCostImpact(k: DashboardKpisRow | null, salesTotal: number): ReturnType<typeof costImpactRatios> {
  const r = k ?? ZERO_KPIS;
  return costImpactRatios(r, salesTotal);
}
