// ============================================================
//  Outlet Aggregate Scan — ONE shared per-outlet scan (H-10 / G1)
//  --------------------------------------------------------
//  The per-outlet GROUP BY over the filtered period was implemented
//  twice with separate full-period DB scans:
//    1. queryOutletHealthRanking (analysis payload)     — FILTERed
//       (WHERE NOT zeroDev) sums + zero/non-zero counts.
//    2. queryRestoRecommendations' `curr` CTE (/api/recommendations)
//       — unfiltered sums + tolerance/zScore-proxy counts + topItem.
//  With the Resto tab open alongside the Dashboard (keep-alive tabs),
//  the same ~280K-row period scan ran TWICE per session.
//
//  This module computes the SUPERSET of both projections in ONE scan:
//    - health variants keep their exact FILTER (WHERE NOT zeroDev)
//      semantics (f-prefixed columns) — byte-identical payload.
//    - recommendation variants keep their unfiltered semantics
//      (same column names as the old `curr` CTE, so the scoring code
//      consumes them unchanged).
//    - top_items CTE (per-outlet top item by absNominalDeviasi) rides
//      along in the same round trip.
//
//  The result is wrapped in cachedSharedQuery under queryId
//  `q-outlet-agg` (TTL 30 min, mutation-invalidated). Whichever
//  pipeline touches the period first (analysis via the early-fired
//  healthRanking promise, or /api/recommendations) pays the scan; the
//  other reads the stored row (~5-15ms). `highLossThreshold` affects
//  the highLossItem count, so it is part of the cache key (`hlt`) —
//  callers that have runtime thresholds should pass them explicitly;
//  otherwise the runtime Settings value is resolved here (both then
//  produce the same key for the same settings state).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, DIRECTION_FROM_SUM_SQL, withStatementTimeout, type SqlFilterOpts } from '../shared';
import { cachedSharedQuery } from '../query-cache';
import { getRuntimeThresholds } from '@/lib/settings';

export interface OutletAggScanRow {
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  sales: number;
  // ---- health-ranking variants (FILTER: NOT zeroDev) ----
  fNominalDeviasi: number;
  fTotalQtyDeviasi: number;
  fTotalQtyBom: number;
  fTotalQtyWaste: number;
  fTotalQtySusut: number;
  fTotalQtyTrial: number;
  fTotalResidualQty: number;
  fLossNominal: number;
  zeroDevCount: number;
  nonZeroDevCount: number;
  // ---- recommendation variants (unfiltered) ----
  nominalDeviasi: number;
  devBom: number;
  totalLoss: number;
  totalSurplus: number;
  residualQty: number;
  qtyLossSurplus: number;
  itemCount: number;
  deviatingItems: number;
  totalQtyDeviasi: number;
  totalQtyBom: number;
  grossAbsNominal: number;
  qtyDeviasiLoss: number;
  residualNominal: number;
  toleranceBreachCount: number;
  toleranceBreachHighCount: number;
  zScoreAbnormalCount: number;
  zScoreWarningCount: number;
  benchmarkHighCount: number;
  benchmarkWarningCount: number;
  overExplainedCount: number;
  hasNoTolerance: number;
  highLossItem: number;
  direction: string;
  topItem: string | null;
  topItemNominal: number;
}

async function computeOutletAggregateScan(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  highLossThreshold: number,
): Promise<OutletAggScanRow[]> {
  const f = buildSqlFilters(filters);

  // Zero-dev classification — identical to queryOutletHealthRanking's
  // original expression (kept byte-for-byte so the health payload does
  // not change):
  //   zeroDev = (qtyDeviasi IS NULL OR = 0) AND (absNominalDeviasi IS NULL OR = 0)
  const zeroDevExpr = Prisma.sql`(
    (ir."qtyDeviasi" IS NULL OR ir."qtyDeviasi" = 0)
    AND (ir."absNominalDeviasi" IS NULL OR ir."absNominalDeviasi" = 0)
  )`;

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<OutletAggScanRow[]>`
    WITH outlet_stats AS (
      SELECT
        ir."outletId",
        -- ==== health-ranking variants (FILTER: NOT zeroDev) ====
        COUNT(*) FILTER (WHERE ${zeroDevExpr}) as "zeroDevCount",
        COUNT(*) FILTER (WHERE NOT ${zeroDevExpr}) as "nonZeroDevCount",
        SUM(ir."nominalDeviasi") FILTER (WHERE NOT ${zeroDevExpr}) as "fNominalDeviasi",
        SUM(ABS(ir."qtyDeviasi")) FILTER (WHERE NOT ${zeroDevExpr}) as "fTotalQtyDeviasi",
        SUM(ABS(ir."qtyBom")) FILTER (WHERE NOT ${zeroDevExpr}) as "fTotalQtyBom",
        SUM(ABS(ir."qtyWaste")) FILTER (WHERE NOT ${zeroDevExpr}) as "fTotalQtyWaste",
        SUM(ABS(ir."qtySusut")) FILTER (WHERE NOT ${zeroDevExpr}) as "fTotalQtySusut",
        SUM(ABS(ir."qtyTrial")) FILTER (WHERE NOT ${zeroDevExpr}) as "fTotalQtyTrial",
        SUM(ABS(ir."residualQty")) FILTER (WHERE NOT ${zeroDevExpr}) as "fTotalResidualQty",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) FILTER (WHERE NOT ${zeroDevExpr}) as "fLossNominal",
        -- ==== recommendation variants (unfiltered) ====
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        SUM(ABS(ir."qtyBom")) as "qtyBom",
        SUM(ABS(ir."qtyDeviasi")) as "qtyDeviasi",
        SUM(ir."absQtyLossSurplus") as "qtyLossSurplus",
        -- grossAbsNominal = SUM(ABS(nominalDeviasi)) for correct itemConcentration denominator (FIX Bug 1A)
        SUM(ir."absNominalDeviasi") as "grossAbsNominal",
        -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalLoss",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalSurplus",
        -- FIX CALC-3: residual restricted to LOSS rows
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END) as "residualNominal",
        -- FIX CALC2-2: qtyDeviasiLoss = SUM(ABS(qtyDeviasi) WHERE LOSS) — for correct residualRatio (LOSS/LOSS)
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ir."absQtyDeviasi" ELSE 0 END) as "qtyDeviasiLoss",
        COUNT(DISTINCT ir."itemId") as "itemCount",
        COUNT(CASE WHEN ir."absNominalDeviasi" > 0 THEN 1 END) as "deviatingItems",
        -- FIX CALC-2: ABS() on both sides — pctQtyDeviasiToBom and tolerancePct are SIGNED in Excel
        COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > ABS(ir."tolerancePct") THEN 1 END) as "toleranceBreachCount",
        COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > ABS(ir."tolerancePct") * 2 THEN 1 END) as "toleranceBreachHighCount",
        -- zScore/benchmark proxies: ABS(pctQtyDeviasiToBom) thresholds (0.50 / 0.25 per user request)
        COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.50 THEN 1 END) as "zScoreAbnormalCount",
        COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.25 THEN 1 END) as "zScoreWarningCount",
        COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.50 THEN 1 END) as "benchmarkHighCount",
        0 as "benchmarkWarningCount",
        COUNT(CASE WHEN ir."qtyDeviasi" IS NOT NULL AND ir."qtyDeviasi" != 0 AND ABS(ir."qtyWaste") + ABS(ir."qtySusut") + ABS(ir."qtyTrial") > ABS(ir."qtyDeviasi") THEN 1 END) as "overExplainedCount",
        -- FIX REC-1: COUNT() of items without tolerance (was MAX() returning 0/1)
        COUNT(CASE WHEN ir."tolerancePct" IS NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL THEN 1 END) as "hasNoTolerance",
        -- FIX (AUDIT7-CALC-11): runtime-configurable HIGH_LOSS_NOMINAL threshold (part of the cache key via hlt)
        COUNT(CASE WHEN ir."nominalLossSurplus" < -${highLossThreshold} THEN 1 END) as "highLossItem",
        -- FIX CALC-5 + VERIFY3-8: outlet direction from net nominalLossSurplus with qtyDeviasi NULL fallback
        ${DIRECTION_FROM_SUM_SQL} as "outletDirection"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    ),
    top_items AS (
      SELECT "outletId", "topItem", "topItemNominal" FROM (
        SELECT
          ir."outletId",
          i.name as "topItem",
          ir."absNominalDeviasi" as "topItemNominal",
          ROW_NUMBER() OVER (PARTITION BY ir."outletId" ORDER BY ir."absNominalDeviasi" DESC) as rn
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
          ${f}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ) ranked WHERE rn = 1
    )
    SELECT
      os."outletId",
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      COALESCE(ops."salesMode", 0) as "sales",
      COALESCE(os."nominalDeviasi", 0) as "nominalDeviasi",
      COALESCE(os."devBom", 0) as "devBom",
      COALESCE(os."totalLoss", 0) as "totalLoss",
      COALESCE(os."totalSurplus", 0) as "totalSurplus",
      COALESCE(os."residualQty", 0) as "residualQty",
      COALESCE(os."qtyLossSurplus", 0) as "qtyLossSurplus",
      COALESCE(os."itemCount", 0) as "itemCount",
      COALESCE(os."deviatingItems", 0) as "deviatingItems",
      COALESCE(os."qtyDeviasi", 0) as "totalQtyDeviasi",
      COALESCE(os."qtyBom", 0) as "totalQtyBom",
      COALESCE(os."grossAbsNominal", 0) as "grossAbsNominal",
      COALESCE(os."qtyDeviasiLoss", 0) as "qtyDeviasiLoss",
      COALESCE(os."residualNominal", 0) as "residualNominal",
      COALESCE(os."toleranceBreachCount", 0) as "toleranceBreachCount",
      COALESCE(os."toleranceBreachHighCount", 0) as "toleranceBreachHighCount",
      COALESCE(os."zScoreAbnormalCount", 0) as "zScoreAbnormalCount",
      COALESCE(os."zScoreWarningCount", 0) as "zScoreWarningCount",
      COALESCE(os."benchmarkHighCount", 0) as "benchmarkHighCount",
      COALESCE(os."benchmarkWarningCount", 0) as "benchmarkWarningCount",
      COALESCE(os."overExplainedCount", 0) as "overExplainedCount",
      COALESCE(os."hasNoTolerance", 0) as "hasNoTolerance",
      COALESCE(os."highLossItem", 0) as "highLossItem",
      COALESCE(os."fNominalDeviasi", 0) as "fNominalDeviasi",
      COALESCE(os."fTotalQtyDeviasi", 0) as "fTotalQtyDeviasi",
      COALESCE(os."fTotalQtyBom", 0) as "fTotalQtyBom",
      COALESCE(os."fTotalQtyWaste", 0) as "fTotalQtyWaste",
      COALESCE(os."fTotalQtySusut", 0) as "fTotalQtySusut",
      COALESCE(os."fTotalQtyTrial", 0) as "fTotalQtyTrial",
      COALESCE(os."fTotalResidualQty", 0) as "fTotalResidualQty",
      COALESCE(os."fLossNominal", 0) as "fLossNominal",
      COALESCE(os."zeroDevCount", 0) as "zeroDevCount",
      COALESCE(os."nonZeroDevCount", 0) as "nonZeroDevCount",
      os."outletDirection" as "direction",
      ti."topItem",
      COALESCE(ti."topItemNominal", 0) as "topItemNominal"
    FROM outlet_stats os
    JOIN "Outlet" o ON os."outletId" = o.id
    LEFT JOIN "OutletPeriodSales" ops
      ON ops."outletId" = os."outletId"
      AND ops."monthLabel" = ${month}
      AND ops."weekLabel" = ${week}
    LEFT JOIN top_items ti ON os."outletId" = ti."outletId"
    ORDER BY ABS(COALESCE(os."nominalDeviasi", 0)) DESC
  `);

  // Coerce BigInt → Number once, for both downstream consumers.
  return rows.map((r) => ({
    outletId: Number(r.outletId),
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area,
    sales: Number(r.sales) || 0,
    fNominalDeviasi: Number(r.fNominalDeviasi) || 0,
    fTotalQtyDeviasi: Number(r.fTotalQtyDeviasi) || 0,
    fTotalQtyBom: Number(r.fTotalQtyBom) || 0,
    fTotalQtyWaste: Number(r.fTotalQtyWaste) || 0,
    fTotalQtySusut: Number(r.fTotalQtySusut) || 0,
    fTotalQtyTrial: Number(r.fTotalQtyTrial) || 0,
    fTotalResidualQty: Number(r.fTotalResidualQty) || 0,
    fLossNominal: Number(r.fLossNominal) || 0,
    zeroDevCount: Number(r.zeroDevCount) || 0,
    nonZeroDevCount: Number(r.nonZeroDevCount) || 0,
    nominalDeviasi: Number(r.nominalDeviasi) || 0,
    devBom: Number(r.devBom) || 0,
    totalLoss: Number(r.totalLoss) || 0,
    totalSurplus: Number(r.totalSurplus) || 0,
    residualQty: Number(r.residualQty) || 0,
    qtyLossSurplus: Number(r.qtyLossSurplus) || 0,
    itemCount: Number(r.itemCount) || 0,
    deviatingItems: Number(r.deviatingItems) || 0,
    totalQtyDeviasi: Number(r.totalQtyDeviasi) || 0,
    totalQtyBom: Number(r.totalQtyBom) || 0,
    grossAbsNominal: Number(r.grossAbsNominal) || 0,
    qtyDeviasiLoss: Number(r.qtyDeviasiLoss) || 0,
    residualNominal: Number(r.residualNominal) || 0,
    toleranceBreachCount: Number(r.toleranceBreachCount) || 0,
    toleranceBreachHighCount: Number(r.toleranceBreachHighCount) || 0,
    zScoreAbnormalCount: Number(r.zScoreAbnormalCount) || 0,
    zScoreWarningCount: Number(r.zScoreWarningCount) || 0,
    benchmarkHighCount: Number(r.benchmarkHighCount) || 0,
    benchmarkWarningCount: Number(r.benchmarkWarningCount) || 0,
    overExplainedCount: Number(r.overExplainedCount) || 0,
    hasNoTolerance: Number(r.hasNoTolerance) || 0,
    highLossItem: Number(r.highLossItem) || 0,
    direction: r.direction,
    topItem: r.topItem,
    topItemNominal: Number(r.topItemNominal) || 0,
  }));
}

/**
 * Shared, cache-wrapped per-outlet aggregate scan (superset of the old
 * health-ranking + recommendations-curr projections).
 *
 * `highLossThreshold` is part of the cache key — pass it explicitly when
 * the caller already loaded runtime thresholds; otherwise the current
 * Settings value is resolved here so all callers converge on one key.
 */
export async function queryOutletAggregateScan(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  highLossThreshold?: number,
): Promise<OutletAggScanRow[]> {
  const hlt = highLossThreshold ?? (await getRuntimeThresholds()).HIGH_LOSS_NOMINAL_THRESHOLD;
  return cachedSharedQuery(
    'q-outlet-agg',
    { month, week, filters, extra: { hlt } },
    () => computeOutletAggregateScan(week, month, filters, hlt),
  );
}
