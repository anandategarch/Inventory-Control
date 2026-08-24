// ============================================================
//  Outlet-level queries — top-N outlets by abs nominal deviation
//  and top-N outlets by sales. Sales uses MODE per outlet (deduped
//  via ROW_NUMBER window function).
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout } from './shared';

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
        -- FIX: add signed SUM(nominalLossSurplus) for display (ABS only for sorting)
        SUM(ir."nominalLossSurplus") as "nominalDeviasi",
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
      COALESCE(sm.sales, 0) as sales,
      COALESCE(oa."lossAmount", 0) as "lossAmount",
      COALESCE(oa."surplusAmount", 0) as "surplusAmount",
      o.area
    FROM outlet_aggs oa
    JOIN "Outlet" o ON oa."outletId" = o.id
    LEFT JOIN sales_mode sm ON oa."outletId" = sm."outletId"
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
): Promise<Array<{ outletCode: string; outletName: string; area: string; sales: number; absNominal: number; nominalDeviasi: number }>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ outletCode: string; outletName: string; area: string; sales: number; absNominal: number; nominalDeviasi: number }[]>`
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
      SELECT ir."outletId",
        SUM(ir."absNominalLossSurplus") as "absNominal",
        -- FIX: add signed SUM for display
        SUM(ir."nominalLossSurplus") as "nominalDeviasi"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT o.code as "outletCode", o.name as "outletName",
      COALESCE(sm.sales, 0) as sales,
      COALESCE(on2."absNominal", 0) as "absNominal",
      COALESCE(on2."nominalDeviasi", 0) as "nominalDeviasi",
      o.area
    FROM sales_mode sm
    JOIN "Outlet" o ON sm."outletId" = o.id
    LEFT JOIN outlet_nominal on2 ON sm."outletId" = on2."outletId"
    ORDER BY sm.sales DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ============================================================
//  Peer Comparison — all outlets with similar sales (±10%)
//  Returns full metrics per outlet for side-by-side comparison.
//  mode: 'week' = filter by weekLabel, 'month' = aggregate all weeks
// ============================================================
export interface PeerComparisonRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  sales: number;
  nominalDeviasi: number;
  devBom: number;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  totalLoss: number;
  totalSurplus: number;
  residualQty: number;
  itemCount: number;
  topItem: string | null;
  topItemNominal: number;
  direction: string;
  isTarget: boolean;
}

export async function queryPeerComparison(
  outletCode: string,
  month: string,
  week: string | null,
  mode: 'week' | 'month',
  limit: number = 10
): Promise<{ targetSales: number; peers: PeerComparisonRow[] }> {
  // CRITICAL FIX (PEER-BACKEND-5): In month mode, weeks are CUMULATIVE
  // (W1=1-7, W2=1-14, W3=1-21, W4=1-25). Summing all weeks multi-counts.
  // Fix: in month mode, use only the LATEST week (MAX weekLabel) for the month.
  const weekFilter = mode === 'week' && week
    ? Prisma.sql`AND ir."weekLabel" = ${week}`
    : Prisma.sql`AND ir."weekLabel" = (
        SELECT MAX(ir2."weekLabel") FROM "InventoryRecord" ir2
        WHERE ir2."monthLabel" = ${month}
      )`;

  const rows = await db.$queryRaw<any[]>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${weekFilter}
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
    target AS (
      SELECT sm.sales, o.id as "outletId"
      FROM sales_mode sm
      JOIN "Outlet" o ON sm."outletId" = o.id
      WHERE o.code = ${outletCode}
    ),
    -- FIX: If target has no sales (nominalSales null/0), target CTE is empty.
    -- CROSS JOIN with empty target = 0 rows = 'Tidak ada peer'.
    -- Fallback: if target has InventoryRecords but no sales, use 0 as targetSales
    -- and find peers by outlet_aggs instead of sales_mode.
    target_fallback AS (
      SELECT 0 as sales, o.id as "outletId"
      FROM "Outlet" o
      WHERE o.code = ${outletCode}
        AND NOT EXISTS (SELECT 1 FROM target)
    ),
    target_combined AS (
      SELECT * FROM target
      UNION ALL
      SELECT * FROM target_fallback
    ),
    outlet_aggs AS (
      SELECT
        ir."outletId",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        SUM(ABS(ir."qtyBom")) as "qtyBom",
        SUM(ir."qtyDeviasi") as "qtyDeviasi",
        SUM(ABS(ir."qtyWaste")) as "qtyWaste",
        SUM(ABS(ir."qtySusut")) as "qtySusut",
        SUM(ABS(ir."qtyTrial")) as "qtyTrial",
        SUM(ir."absQtyLossSurplus") as "qtyLossSurplus",
        -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalLoss",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalSurplus",
        -- FIX CALC-3: use nominalLossSurplus < 0 (LOSS) instead of stored ir.direction (which may be inverted)
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
        COUNT(DISTINCT ir."itemId") as "itemCount",
        MAX(ABS(ir."absNominalDeviasi")) as "topItemNominalRaw"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month}
        ${weekFilter}
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
        WHERE ir."monthLabel" = ${month}
          ${weekFilter}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ) ranked WHERE rn = 1
    )
    SELECT
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      pic.pic,
      COALESCE(sm.sales, 0) as "sales",
      COALESCE(oa."nominalDeviasi", 0) as "nominalDeviasi",
      COALESCE(oa."devBom", 0) as "devBom",
      COALESCE(oa."qtyBom", 0) as "qtyBom",
      COALESCE(oa."qtyDeviasi", 0) as "qtyDeviasi",
      COALESCE(oa."qtyWaste", 0) as "qtyWaste",
      COALESCE(oa."qtySusut", 0) as "qtySusut",
      COALESCE(oa."qtyTrial", 0) as "qtyTrial",
      COALESCE(oa."qtyLossSurplus", 0) as "qtyLossSurplus",
      COALESCE(oa."totalLoss", 0) as "totalLoss",
      COALESCE(oa."totalSurplus", 0) as "totalSurplus",
      COALESCE(oa."residualQty", 0) as "residualQty",
      COALESCE(oa."itemCount", 0) as "itemCount",
      ti."topItem",
      COALESCE(ti."topItemNominal", 0) as "topItemNominal",
      CASE WHEN oa."totalLoss" > oa."totalSurplus" THEN 'LOSS'
           WHEN oa."totalSurplus" > oa."totalLoss" THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as "direction",
      CASE WHEN o.code = ${outletCode} THEN true ELSE false END as "isTarget"
    FROM outlet_aggs oa
    JOIN "Outlet" o ON oa."outletId" = o.id
    LEFT JOIN sales_mode sm ON oa."outletId" = sm."outletId"
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    LEFT JOIN top_items ti ON oa."outletId" = ti."outletId"
    CROSS JOIN target_combined t
    WHERE COALESCE(sm.sales, 0) > 0
      AND ABS(COALESCE(sm.sales, 0) - t.sales) <= CASE WHEN t.sales > 0 THEN t.sales * 0.1 ELSE 999999999 END
    ORDER BY ABS(COALESCE(sm.sales, 0) - t.sales)
    LIMIT ${limit + 1}
  `;

  const targetRow = rows.find((r: any) => r.isTarget);
  const targetSales = targetRow ? Number(targetRow.sales) : 0;

  const peers: PeerComparisonRow[] = rows.map((r: any) => ({
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area,
    pic: r.pic,
    sales: Number(r.sales),
    nominalDeviasi: Number(r.nominalDeviasi),
    devBom: Number(r.devBom),
    qtyBom: Number(r.qtyBom),
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyWaste: Number(r.qtyWaste),
    qtySusut: Number(r.qtySusut),
    qtyTrial: Number(r.qtyTrial),
    qtyLossSurplus: Number(r.qtyLossSurplus),
    totalLoss: Number(r.totalLoss),
    totalSurplus: Number(r.totalSurplus),
    residualQty: Number(r.residualQty),
    itemCount: Number(r.itemCount),
    topItem: r.topItem,
    topItemNominal: Number(r.topItemNominal),
    direction: r.direction,
    isTarget: Boolean(r.isTarget),
  }));

  return { targetSales, peers };
}

// ============================================================
//  Peer Item Comparison — for the top N items in the target
//  outlet, return the same items' metrics across all peer
//  outlets (±10% sales). Enables item-level comparison:
//  "Item Ayam di Resto A vs Item Ayam di Resto B, C, D".
//  mode: 'week' = filter by weekLabel, 'month' = MAX(weekLabel)
//  (same cumulative-week fix as queryPeerComparison, see
//  schema comment lines 35-39: weeks are CUMULATIVE so
//  summing across weeks multi-counts).
// ============================================================
export interface PeerItemRow {
  itemName: string;
  outletCode: string;
  outletName: string;
  qtyDeviasi: number;
  qtyBom: number;
  nominalDeviasi: number;
  devBom: number;
  direction: string;
  isTarget: boolean;
}

export async function queryPeerItemComparison(
  outletCode: string,
  month: string,
  week: string | null,
  mode: 'week' | 'month',
  topItems: number = 5,
  peerLimit: number = 10
): Promise<PeerItemRow[]> {
  // CRITICAL FIX (PEER-BACKEND-5): Same cumulative-week fix as
  // queryPeerComparison. In month mode, MAX(weekLabel) gives the
  // latest cumulative week (= whole-month aggregate) — summing all
  // 4 weeks would quadruple-count metrics because each week already
  // INCLUDES all previous weeks (schema lines 35-39).
  const weekFilter = mode === 'week' && week
    ? Prisma.sql`AND ir."weekLabel" = ${week}`
    : Prisma.sql`AND ir."weekLabel" = (
        SELECT MAX(ir2."weekLabel") FROM "InventoryRecord" ir2
        WHERE ir2."monthLabel" = ${month}
      )`;

  const rows = await db.$queryRaw<any[]>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
        ${weekFilter}
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
    target AS (
      SELECT sm.sales, o.id as "outletId"
      FROM sales_mode sm
      JOIN "Outlet" o ON sm."outletId" = o.id
      WHERE o.code = ${outletCode}
    ),
    target_items AS (
      SELECT ir."itemId", i.name as "itemName",
        ROW_NUMBER() OVER (ORDER BY ABS(ir."nominalDeviasi") DESC) as item_rank
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE o.code = ${outletCode}
        AND ir."monthLabel" = ${month}
        ${weekFilter}
        AND ir."absNominalDeviasi" IS NOT NULL
        AND ir."absNominalDeviasi" > 0
    ),
    peer_outlets AS (
      SELECT o.id, o.code, o.name, sm.sales
      FROM sales_mode sm
      JOIN "Outlet" o ON sm."outletId" = o.id
      CROSS JOIN target t
      WHERE ABS(sm.sales - t.sales) <= t.sales * 0.1
      ORDER BY CASE WHEN o.code = ${outletCode} THEN 0 ELSE 1 END,
               ABS(sm.sales - t.sales)
      LIMIT ${peerLimit + 1}
    )
    SELECT
      ti."itemName",
      o.code as "outletCode",
      o.name as "outletName",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasi",
      COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBom",
      -- FIX CALC-5: Excel convention: LOSS = negative nominalLossSurplus
      -- FIX VERIFY3-8: add qtyDeviasi NULL fallback
      CASE WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
           WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as "direction",
      CASE WHEN o.code = ${outletCode} THEN true ELSE false END as "isTarget",
      ti.item_rank as "itemRank"
    FROM target_items ti
    CROSS JOIN peer_outlets po
    LEFT JOIN "InventoryRecord" ir
      ON ir."outletId" = po.id
      AND ir."itemId" = ti."itemId"
      AND ir."monthLabel" = ${month}
      ${weekFilter}
    JOIN "Outlet" o ON po.id = o.id
    WHERE ti.item_rank <= ${topItems}
    GROUP BY ti."itemName", ti."itemId", ti.item_rank, o.code, o.name
    ORDER BY ti.item_rank, o.code
  `;

  return rows.map((r: any) => ({
    itemName: r.itemName,
    outletCode: r.outletCode,
    outletName: r.outletName,
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyBom: Number(r.qtyBom),
    nominalDeviasi: Number(r.nominalDeviasi),
    devBom: Number(r.devBom),
    direction: r.direction,
    isTarget: Boolean(r.isTarget),
  }));
}

// ============================================================
//  Peer Trend — multi-period trend comparison: target vs
//  peer average across all weekLabels in the current month.
//  peerOutletCodes comes from queryPeerComparison result.
//  NOTE: Unlike queryPeerComparison / queryPeerItemComparison,
//  this query does NOT apply the MAX(weekLabel) cumulative fix
//  because the goal is to show the per-week breakdown itself
//  (each week is one data point on the trend chart). The
//  cumulative nature of weeks (schema lines 35-39) means each
//  successive week already includes prior weeks, so the trend
//  shows how the cumulative ratio evolves across the month.
// ============================================================
export interface PeerTrendRow {
  weekLabel: string;
  targetDevBom: number;
  peerAvgDevBom: number;
  targetNominal: number;
  peerAvgNominal: number;
}

export async function queryPeerTrend(
  outletCode: string,
  month: string,
  week: string,
  peerOutletCodes: string[]
): Promise<PeerTrendRow[]> {
  // Prisma.join requires ≥1 element; outletCode is always present,
  // so allCodes always has at least one entry.
  const allCodes = [outletCode, ...peerOutletCodes];

  const rows = await db.$queryRaw<any[]>`
    WITH outlet_weekly AS (
      SELECT
        ir."weekLabel",
        o.code as "outletCode",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        SUM(ir."nominalDeviasi") as "nominalDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month}
        AND o.code IN (${Prisma.join(allCodes)})
      GROUP BY ir."weekLabel", o.code
    )
    SELECT
      ow."weekLabel",
      COALESCE(MAX(CASE WHEN ow."outletCode" = ${outletCode} THEN ow."devBom" END), 0) as "targetDevBom",
      COALESCE(AVG(CASE WHEN ow."outletCode" != ${outletCode} THEN ow."devBom" END), 0) as "peerAvgDevBom",
      COALESCE(MAX(CASE WHEN ow."outletCode" = ${outletCode} THEN ow."nominalDeviasi" END), 0) as "targetNominal",
      COALESCE(AVG(CASE WHEN ow."outletCode" != ${outletCode} THEN ow."nominalDeviasi" END), 0) as "peerAvgNominal"
    FROM outlet_weekly ow
    GROUP BY ow."weekLabel"
    ORDER BY ow."weekLabel"
  `;

  return rows.map((r: any) => ({
    weekLabel: r.weekLabel,
    targetDevBom: Number(r.targetDevBom),
    peerAvgDevBom: Number(r.peerAvgDevBom),
    targetNominal: Number(r.targetNominal),
    peerAvgNominal: Number(r.peerAvgNominal),
  }));
}

// ============================================================
//  Resto Recommendation Engine — rank all outlets by priority
//  8 signals weighted into Priority Score (0-100)
//  Returns top N outlets needing attention + analysis summary
// ============================================================
export interface RestoRecommendation {
  outletCode: string;
  outletName: string;
  area: string;
  priorityScore: number;
  priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  signals: {
    devBomRatio: number;
    deviasiGrowth: number | null;
    abnormalCount: number;
    residualRatio: number;
    lossToSales: number;
    directionFlip: boolean;
    trendDeteriorating: boolean;
    itemConcentration: number;
    toleranceBreachCount: number;
    toleranceBreachHighCount: number;
    zScoreAbnormalCount: number;
    overExplainedCount: number;
    highLossItemCount: number;
    noToleranceItems: number;
    benchmarkHighCount: number;
  };
  metrics: {
    sales: number;
    nominalDeviasi: number;
    devBom: number;
    totalLoss: number;
    totalSurplus: number;
    residualQty: number;
    itemCount: number;
    direction: string;
    topItem: string | null;
    topItemNominal: number;
  };
  analysis: string[];   // auto-generated analysis bullet points
  signalScores?: Array<{ name: string; score: number; weight: number; value: string }>; // 15 signal breakdown
}

export async function queryRestoRecommendations(
  month: string,
  week: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 5
): Promise<RestoRecommendation[]> {
  const f = buildSqlFilters(filters);

  // Fetch current period outlet aggregates + previous period + historical avg
  // FIX: add historical comparison (same weekLabel across ALL previous months)
  const [currRows, prevRows, histRows] = await Promise.all([
    db.$queryRaw<any[]>`
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
        SELECT
          ir."outletId",
          SUM(ir."nominalDeviasi") as "nominalDeviasi",
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "devBom",
          SUM(ABS(ir."qtyBom")) as "qtyBom",
          SUM(ABS(ir."qtyDeviasi")) as "qtyDeviasi",
          SUM(ABS(ir."qtyWaste")) as "qtyWaste",
          SUM(ABS(ir."qtySusut")) as "qtySusut",
          SUM(ABS(ir."qtyTrial")) as "qtyTrial",
          SUM(ir."absQtyLossSurplus") as "qtyLossSurplus",
          -- FIX Bug 1A: grossAbsNominal = SUM(ABS(nominalDeviasi)) for correct itemConcentration denominator
          SUM(ir."absNominalDeviasi") as "grossAbsNominal",
          -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalLoss",
          SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalSurplus",
          -- FIX CALC-3: use nominalLossSurplus < 0 (LOSS) instead of stored ir.direction (which may be inverted)
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END) as "residualNominal",
          -- FIX CALC2-2: qtyDeviasiLoss = SUM(ABS(qtyDeviasi) WHERE LOSS) — for correct residualRatio (LOSS/LOSS)
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ir."absQtyDeviasi" ELSE 0 END) as "qtyDeviasiLoss",
          COUNT(DISTINCT ir."itemId") as "itemCount",
          COUNT(CASE WHEN ir."absNominalDeviasi" > 0 THEN 1 END) as "deviatingItems",
          -- FIX CALC-2: use ABS() on both sides — pctQtyDeviasiToBom and tolerancePct are SIGNED in Excel
          -- (both negative for LOSS items). Without ABS, -0.11 > -0.005 is FALSE even though magnitude is larger.
          COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > ABS(ir."tolerancePct") THEN 1 END) as "toleranceBreachCount",
          COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > ABS(ir."tolerancePct") * 2 THEN 1 END) as "toleranceBreachHighCount",
          -- zScore and benchmarkFlag are NOT in InventoryRecord table — they're in PeriodComparison.
          -- FIX: threshold changed from 0.20 to 0.50 per user request
          -- Use ABS(pctQtyDeviasiToBom) > 0.50 as proxy for "abnormal" (high deviation ratio vs BOM)
          -- FIX CALC-2: ABS() needed because pctQtyDeviasiToBom is SIGNED (negative for LOSS)
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.50 THEN 1 END) as "zScoreAbnormalCount",
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.25 THEN 1 END) as "zScoreWarningCount",
          -- benchmarkFlag not available — use high devBom as proxy
          -- FIX: threshold changed from 0.30 to 0.50 per user request
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.50 THEN 1 END) as "benchmarkHighCount",
          0 as "benchmarkWarningCount",
          COUNT(CASE WHEN ir."qtyDeviasi" IS NOT NULL AND ir."qtyDeviasi" != 0 AND ABS(ir."qtyWaste") + ABS(ir."qtySusut") + ABS(ir."qtyTrial") > ABS(ir."qtyDeviasi") THEN 1 END) as "overExplainedCount",
          -- FIX REC-1: was MAX() returning 0/1; now COUNT() returns actual number of items without tolerance
          COUNT(CASE WHEN ir."tolerancePct" IS NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL THEN 1 END) as "hasNoTolerance",
          -- FIX CALC-4: LOSS = negative nominalLossSurplus. High loss = < -10jt
          COUNT(CASE WHEN ir."nominalLossSurplus" < -10000000 THEN 1 END) as "highLossItem",
          -- FIX CALC-5: compute outlet direction from net nominalLossSurplus (Excel convention: < 0 = LOSS)
          -- FIX VERIFY3-8: add qtyDeviasi NULL fallback
          CASE
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
            ELSE 'NEUTRAL'
          END as "outletDirection"
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
        o.code as "outletCode", o.name as "outletName", o.area,
        COALESCE(sm.sales, 0) as "sales",
        COALESCE(oa."nominalDeviasi", 0) as "nominalDeviasi",
        COALESCE(oa."devBom", 0) as "devBom",
        COALESCE(oa."totalLoss", 0) as "totalLoss",
        COALESCE(oa."totalSurplus", 0) as "totalSurplus",
        COALESCE(oa."residualQty", 0) as "residualQty",
        COALESCE(oa."qtyLossSurplus", 0) as "qtyLossSurplus",
        COALESCE(oa."itemCount", 0) as "itemCount",
        COALESCE(oa."deviatingItems", 0) as "deviatingItems",
        COALESCE(oa."qtyDeviasi", 0) as "totalQtyDeviasi",
        COALESCE(oa."grossAbsNominal", 0) as "grossAbsNominal",
        COALESCE(oa."qtyDeviasiLoss", 0) as "qtyDeviasiLoss",
        COALESCE(oa."residualNominal", 0) as "residualNominal",
        COALESCE(oa."toleranceBreachCount", 0) as "toleranceBreachCount",
        COALESCE(oa."toleranceBreachHighCount", 0) as "toleranceBreachHighCount",
        COALESCE(oa."zScoreAbnormalCount", 0) as "zScoreAbnormalCount",
        COALESCE(oa."zScoreWarningCount", 0) as "zScoreWarningCount",
        COALESCE(oa."benchmarkHighCount", 0) as "benchmarkHighCount",
        COALESCE(oa."benchmarkWarningCount", 0) as "benchmarkWarningCount",
        COALESCE(oa."overExplainedCount", 0) as "overExplainedCount",
        COALESCE(oa."hasNoTolerance", 0) as "hasNoTolerance",
        COALESCE(oa."highLossItem", 0) as "highLossItem",
        oa."outletDirection" as "direction",
        ti."topItem",
        COALESCE(ti."topItemNominal", 0) as "topItemNominal"
      FROM outlet_aggs oa
      JOIN "Outlet" o ON oa."outletId" = o.id
      LEFT JOIN sales_mode sm ON oa."outletId" = sm."outletId"
      LEFT JOIN top_items ti ON oa."outletId" = ti."outletId"
      ORDER BY ABS(COALESCE(oa."nominalDeviasi", 0)) DESC
    `,
    prevWeek && prevMonth
      ? db.$queryRaw<any[]>`
        SELECT
          o.code as "outletCode",
          SUM(ir."nominalDeviasi") as "prevNominalDeviasi",
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "prevDevBom",
          -- FIX CALC-5: compute prev direction from net nominalLossSurplus (Excel convention: < 0 = LOSS)
          -- FIX VERIFY3-8: add qtyDeviasi NULL fallback
          CASE
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
            ELSE 'NEUTRAL'
          END as "prevDirection"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}
          ${f}
        GROUP BY o.code
      `
      : Promise.resolve([]),
    // FIX: Historical average — same weekLabel across ALL months BEFORE current month
    // Computes mean + count of historical periods for each outlet
    db.$queryRaw<any[]>`
      SELECT
        o.code as "outletCode",
        AVG(ABS(ir."nominalDeviasi")) as "histAvgNominalDeviasi",
        COUNT(DISTINCT ir."monthLabel") as "histPeriodCount"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."weekLabel" = ${week}
        AND ir."monthLabel" != ${month}
        ${f}
      GROUP BY o.code
    `,
  ]);

  // Build prev lookup
  const prevMap = new Map<string, any>();
  for (const r of prevRows) {
    prevMap.set(r.outletCode, r);
  }

  // Build historical lookup
  const histMap = new Map<string, { avgNominalDeviasi: number; periodCount: number }>();
  for (const r of histRows) {
    histMap.set(r.outletCode, {
      avgNominalDeviasi: Number(r.histAvgNominalDeviasi) || 0,
      periodCount: Number(r.histPeriodCount) || 0,
    });
  }

  // Compute network averages for ratio
  const networkAvgDevBom = currRows.length > 0
    ? currRows.reduce((s, r) => s + Number(r.devBom), 0) / currRows.length
    : 0;
  // REC-7: totalNetworkDeviasi was computed but never used — removed

  // Compute Priority Score per outlet
  const recommendations: RestoRecommendation[] = currRows.map((r: any) => {
    const outletCode = r.outletCode;
    const prev = prevMap.get(outletCode);
    const devBom = Number(r.devBom);
    const nominalDeviasi = Number(r.nominalDeviasi);
    const totalLoss = Number(r.totalLoss);
    const totalSurplus = Number(r.totalSurplus);
    const residualQty = Number(r.residualQty);
    const qtyLossSurplus = Number(r.qtyLossSurplus);
    const sales = Number(r.sales);
    const itemCount = Number(r.itemCount);
    const deviatingItems = Number(r.deviatingItems);
    const totalQtyDeviasi = Number(r.totalQtyDeviasi);
    const residualNominal = Number(r.residualNominal || 0);
    const toleranceBreachCount = Number(r.toleranceBreachCount || 0);
    const toleranceBreachHighCount = Number(r.toleranceBreachHighCount || 0);
    const zScoreAbnormalCount = Number(r.zScoreAbnormalCount || 0);
    const overExplainedCount = Number(r.overExplainedCount || 0);
    const hasNoTolerance = Number(r.hasNoTolerance || 0);
    const highLossItem = Number(r.highLossItem || 0);
    const benchmarkHighCount = Number(r.benchmarkHighCount || 0);
    const direction = r.direction || 'NEUTRAL';
    const topItem = r.topItem;
    const topItemNominal = Number(r.topItemNominal);

    // Signal 1: Dev/BOM vs Peer (12%)
    const devBomRatio = networkAvgDevBom > 0 ? devBom / networkAvgDevBom : 0;
    const s1Score = Math.min(100, devBomRatio * 33);

    // Signal 2: Deviasi Growth (10%) — HYBRID: MoM + Historical
    // FIX: compare vs BOTH previous month AND historical average, take worst case
    const prevNominal = prev ? Number(prev.prevNominalDeviasi) : null;
    const deviasiGrowth = prevNominal != null && Math.abs(prevNominal) > 0
      ? (Math.abs(nominalDeviasi) - Math.abs(prevNominal)) / Math.abs(prevNominal)
      : null;

    // Historical comparison: current vs avg of same week across all previous months
    const histData = histMap.get(outletCode);
    const histAvgNominal = histData?.avgNominalDeviasi ?? null;
    const histPeriodCount = histData?.periodCount ?? 0;
    const deviasiGrowthHistorical = histAvgNominal != null && histAvgNominal > 0 && histPeriodCount >= 2
      ? (Math.abs(nominalDeviasi) - histAvgNominal) / histAvgNominal
      : null;

    // HYBRID: take the WORST (higher) of MoM vs Historical
    const deviasiGrowthHybrid = [deviasiGrowth, deviasiGrowthHistorical]
      .filter((g): g is number => g != null)
      .reduce((max, g) => Math.max(max, g), 0);

    const s2Score = deviasiGrowthHybrid > 0
      ? Math.min(100, deviasiGrowthHybrid * 100)
      : 0;

    // Signal 3: Z-Score Abnormal Count (10%) — items with z-score > 2
    const abnormalCount = zScoreAbnormalCount;
    const s3Score = Math.min(100, zScoreAbnormalCount * 20);

    // Signal 4: Residual Ratio (10%)
    // FIX CALC2-2: use qtyDeviasiLoss (LOSS-only) as denominator, not totalQtyDeviasi (ALL items).
    // residualQty is LOSS-only, so ratio should be LOSS/LOSS for correct proportion.
    const qtyDeviasiLoss = Number(r.qtyDeviasiLoss || 0);
    const residualRatio = qtyDeviasiLoss > 0 ? Math.abs(residualQty) / qtyDeviasiLoss : 0;
    const s4Score = Math.min(100, residualRatio * 100);

    // Signal 5: Loss/Sales Ratio (8%)
    // FIX METRICS-1: when sales=0 but totalLoss > 0, this is a data quality anomaly
    // (outlet with losses but no sales recorded). Score should be MAX (100), not 0.
    const lossToSales = sales > 0 ? totalLoss / sales : 0;
    const s5Score = sales > 0
      ? Math.min(100, lossToSales * 1000)
      : (totalLoss > 0 ? 100 : 0);

    // Signal 6: Direction Flip (8%)
    const prevDirection = prev?.prevDirection || null;
    const directionFlip = prevDirection != null && direction !== prevDirection && direction !== 'NEUTRAL' && prevDirection !== 'NEUTRAL';
    const s6Score = directionFlip ? 100 : 0;

    // Signal 7: Trend (8%) — HYBRID: deteriorating if EITHER MoM or Historical shows deterioration
    const trendDeteriorating = (deviasiGrowth != null && deviasiGrowth > 0.2)
      || (deviasiGrowthHistorical != null && deviasiGrowthHistorical > 0.2);
    const s7Score = trendDeteriorating ? 100 : 0;

    // Signal 8: Item Concentration (5%)
    // FIX Bug 1A: use grossAbsNominal (SUM(ABS(nominalDeviasi))) as denominator, not |SUM(nominalDeviasi)|
    // which cancels out LOSS+SURPLUS. Also clamp to [0, 1] so donut chart values are always valid.
    const grossAbsNominal = Number(r.grossAbsNominal || 0);
    const itemConcentration = grossAbsNominal > 0 && topItemNominal > 0
      ? Math.min(1, topItemNominal / grossAbsNominal)
      : 0;
    const s8Score = Math.min(100, itemConcentration * 100);

    // Signal 9: Tolerance Breach High (8%) — TOLERANCE_BREACH_HIGH rule
    const s9Score = Math.min(100, toleranceBreachHighCount * 25);

    // Signal 10: Over-Explained / Fraud Indicator (7%) — OVER_EXPLAINED rule
    const s10Score = Math.min(100, overExplainedCount * 50);

    // Signal 11: High Loss Nominal Items (5%) — HIGH_LOSS_NOMINAL rule (>10M per item)
    const s11Score = Math.min(100, highLossItem * 20);

    // Signal 12: No Tolerance Set (3%) — TOLERANCE_NOT_SET rule
    // FIX REC-6: was binary 0/50; now scales with count (was inconsistent with other count-based signals)
    const s12Score = Math.min(100, hasNoTolerance * 20);

    // Signal 13: REMOVED (DEEP-AUDIT-LOGIC #2) — was identical to S3 (both used
    // ABS(pctQtyDeviasiToBom) > 0.50). Weight 3% redistributed to S1 (Dev/BOM vs Peer)
    // which IS the real benchmark comparison. S3 still captures high-deviation items.
    // const s13Score = ... (removed)

    // Signal 14: Residual Nominal Impact (2%) — financial impact of unexplained
    const s14Score = Math.min(100, (residualNominal / 1_000_000) * 5);

    // Signal 15: Tolerance Breach REGULAR (1%) — items that breach tolerance but NOT severely.
    // FIX (DEEP-AUDIT-LOGIC #3): was `toleranceBreachCount` which includes high-breach items
    // (S9). Every high-breach item was double-counted (9% combined weight). Now excludes
    // high-breach items: regular = total - high.
    const regularBreachCount = Math.max(0, toleranceBreachCount - toleranceBreachHighCount);
    const s15Score = Math.min(100, regularBreachCount * 5);

    // Weighted Priority Score (14 signals, total 100%)
    // FIX: S13 removed (3% redistributed to S1: 12% → 15%). S15 now excludes high-breach.
    const priorityScore = Math.round(
      s1Score * 0.15 + s2Score * 0.10 + s3Score * 0.10 + s4Score * 0.10 +
      s5Score * 0.08 + s6Score * 0.08 + s7Score * 0.08 + s8Score * 0.05 +
      s9Score * 0.08 + s10Score * 0.07 + s11Score * 0.05 +
      s12Score * 0.03 + s14Score * 0.02 + s15Score * 0.01
    );

    const priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH' =
      priorityScore >= 55 ? 'TINGGI' : priorityScore >= 30 ? 'SEDANG' : 'RENDAH';

    // Auto-generate analysis bullets
    const analysis: string[] = [];
    if (devBomRatio > 2) analysis.push(`Dev/BOM ${(devBom * 100).toFixed(1)}% adalah ${devBomRatio.toFixed(1)}× peer average (${(networkAvgDevBom * 100).toFixed(1)}%)`);
    if (deviasiGrowth != null && deviasiGrowth > 0.2) {
      const momPct = (deviasiGrowth * 100).toFixed(0);
      const histPct = deviasiGrowthHistorical != null ? (deviasiGrowthHistorical * 100).toFixed(0) : null;
      if (histPct != null) {
        analysis.push(`Nominal Deviasi naik ${momPct}% vs bulan lalu, ${histPct}% vs rata-rata historis (${histPeriodCount} bulan)`);
      } else {
        analysis.push(`Nominal Deviasi naik ${momPct}% vs periode sebelumnya`);
      }
    } else if (deviasiGrowthHistorical != null && deviasiGrowthHistorical > 0.2) {
      analysis.push(`Nominal Deviasi naik ${(deviasiGrowthHistorical * 100).toFixed(0)}% vs rata-rata historis (${histPeriodCount} bulan) — trend jangka panjang memburuk`);
    }
    if (zScoreAbnormalCount > 0) analysis.push(`${zScoreAbnormalCount} item dengan deviasi > 50% BOM (proxy z-score abnormal — indikasi perilaku tidak wajar)`);
    // FIX: removed residual ratio bullet per user request
    // if (residualRatio > 0.4) analysis.push(`Residual ${(residualRatio * 100).toFixed(0)}% — ${Math.abs(residualQty).toLocaleString('id-ID')} dari ${qtyDeviasiLoss.toLocaleString('id-ID')} total deviasi LOSS tidak terjelaskan`);
    if (lossToSales > 0.03) analysis.push(`Loss/Sales ${(lossToSales * 100).toFixed(1)}% — rugi Rp ${totalLoss.toLocaleString('id-ID')} dari penjualan Rp ${sales.toLocaleString('id-ID')}`);
    if (directionFlip) analysis.push(`Arah deviasi berubah: ${prevDirection} → ${direction}`);
    if (itemConcentration > 0.3 && topItem) analysis.push(`Item "${topItem}" kontribusi ${(itemConcentration * 100).toFixed(0)}% dari total deviasi`);
    if (toleranceBreachHighCount > 0) analysis.push(`${toleranceBreachHighCount} item melebihi toleransi > 2× (TOLERANCE_BREACH_HIGH)`);
    if (overExplainedCount > 0) analysis.push(`${overExplainedCount} item Waste+Susut+Trial melebihi total deviasi — indikasi salah input atau fraud`);
    if (highLossItem > 0) analysis.push(`${highLossItem} item dengan nominal loss > Rp 10Jt (HIGH_LOSS_NOMINAL)`);
    if (hasNoTolerance > 0) analysis.push(`${hasNoTolerance} item belum diset toleransinya — tidak bisa deteksi breach`);
    if (benchmarkHighCount > 0) analysis.push(`${benchmarkHighCount} item dengan deviasi > 50% BOM (proxy benchmark high — jauh di atas normal)`);
    if (toleranceBreachCount > 0 && toleranceBreachHighCount === 0) analysis.push(`${toleranceBreachCount} item melebihi toleransi (TOLERANCE_BREACH)`);
    // FIX: removed 2 residual bullets per user request (not needed in analysis):
    // - "Residual X% — Y dari Z total deviasi LOSS tidak terjelaskan" (was line 851)
    // - "Dampak residual Rp X — tidak terjelaskan secara finansial (RESIDUAL_NOMINAL)" (was line 861)
    // REC-3: removed unreachable Signal 7 bullet (trendDeteriorating requires deviasiGrowth > 0.2,
    // but the bullet condition excluded deviasiGrowth > 0.2 — logically impossible). Signal 2 already covers this case.
    if (analysis.length === 0) analysis.push('Tidak ada anomaly signifikan terdeteksi');

    return {
      outletCode,
      outletName: r.outletName,
      area: r.area,
      priorityScore,
      priorityLevel,
      signals: {
        devBomRatio,
        deviasiGrowth,
        abnormalCount,
        residualRatio,
        lossToSales,
        directionFlip,
        trendDeteriorating,
        itemConcentration,
        toleranceBreachCount,
        toleranceBreachHighCount,
        zScoreAbnormalCount,
        overExplainedCount,
        highLossItemCount: highLossItem,
        noToleranceItems: hasNoTolerance,
        benchmarkHighCount,
      },
      metrics: {
        sales,
        nominalDeviasi,
        devBom,
        totalLoss,
        totalSurplus,
        residualQty,
        itemCount,
        direction,
        topItem,
        topItemNominal,
      },
      analysis,
      // FIX DRILLDOWN: expose signal scores + weights for Priority Summary breakdown
      signalScores: [
        { name: 'Dev/BOM vs Peer', score: Math.round(s1Score), weight: 0.15, value: `${devBomRatio.toFixed(2)}×` },
        { name: 'Deviasi Growth', score: Math.round(s2Score), weight: 0.10, value: `MoM: ${deviasiGrowth != null ? (deviasiGrowth * 100).toFixed(0) + '%' : '—'} | Hist: ${deviasiGrowthHistorical != null ? (deviasiGrowthHistorical * 100).toFixed(0) + '%' : '—'}` },
        { name: 'Deviasi >50% BOM', score: Math.round(s3Score), weight: 0.10, value: `${zScoreAbnormalCount} item` },
        { name: 'Residual Ratio', score: Math.round(s4Score), weight: 0.10, value: `${(residualRatio * 100).toFixed(0)}%` },
        { name: 'Loss/Sales', score: Math.round(s5Score), weight: 0.08, value: `${(lossToSales * 100).toFixed(1)}%` },
        { name: 'Direction Flip', score: Math.round(s6Score), weight: 0.08, value: directionFlip ? 'YA' : 'Tidak' },
        { name: 'Trend Memburuk', score: Math.round(s7Score), weight: 0.08, value: trendDeteriorating ? 'YA' : 'Tidak' },
        { name: 'Item Concentration', score: Math.round(s8Score), weight: 0.05, value: `${(itemConcentration * 100).toFixed(0)}%` },
        { name: 'Tol Breach High', score: Math.round(s9Score), weight: 0.08, value: `${toleranceBreachHighCount} item` },
        { name: 'Over-Explained', score: Math.round(s10Score), weight: 0.07, value: `${overExplainedCount} item` },
        { name: 'High Loss Nominal', score: Math.round(s11Score), weight: 0.05, value: `${highLossItem} item` },
        { name: 'No Tolerance', score: Math.round(s12Score), weight: 0.03, value: `${hasNoTolerance} item` },
        { name: 'Residual Nominal', score: Math.round(s14Score), weight: 0.02, value: `Rp ${Math.round(residualNominal / 1000000)}jt` },
        { name: 'Tol Breach Reg', score: Math.round(s15Score), weight: 0.01, value: `${regularBreachCount} item` },
      ],
    };
  });

  // Sort by priority score desc, take top N
  return recommendations
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, limit);
}
