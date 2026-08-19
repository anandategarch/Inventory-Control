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
    SELECT o.code as "outletCode", o.name as "outletName", COALESCE(oa."absNominal", 0) as "absNominal",
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
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalLoss",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalSurplus",
        SUM(CASE WHEN ir.direction = 'LOSS' THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
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
      CASE WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'SURPLUS'
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

  // Fetch current period outlet aggregates
  const [currRows, prevRows] = await Promise.all([
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
          SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalLoss",
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalSurplus",
          SUM(CASE WHEN ir.direction = 'LOSS' THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
          SUM(CASE WHEN ir.direction = 'LOSS' THEN ABS(ir."residualNominal") ELSE 0 END) as "residualNominal",
          COUNT(DISTINCT ir."itemId") as "itemCount",
          COUNT(CASE WHEN ir."absNominalDeviasi" > 0 THEN 1 END) as "deviatingItems",
          COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."pctQtyDeviasiToBom" > ir."tolerancePct" THEN 1 END) as "toleranceBreachCount",
          COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."pctQtyDeviasiToBom" > ir."tolerancePct" * 2 THEN 1 END) as "toleranceBreachHighCount",
          -- zScore and benchmarkFlag are NOT in InventoryRecord table — they're in PeriodComparison.
          -- Use pctQtyDeviasiToBom > 0.20 as proxy for "abnormal" (high deviation ratio)
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."pctQtyDeviasiToBom" > 0.20 THEN 1 END) as "zScoreAbnormalCount",
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."pctQtyDeviasiToBom" > 0.10 THEN 1 END) as "zScoreWarningCount",
          -- benchmarkFlag not available — use high devBom as proxy
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."pctQtyDeviasiToBom" > 0.30 THEN 1 END) as "benchmarkHighCount",
          0 as "benchmarkWarningCount",
          COUNT(CASE WHEN ir."qtyDeviasi" IS NOT NULL AND ir."qtyDeviasi" != 0 AND ABS(ir."qtyWaste") + ABS(ir."qtySusut") + ABS(ir."qtyTrial") > ABS(ir."qtyDeviasi") THEN 1 END) as "overExplainedCount",
          MAX(CASE WHEN ir."tolerancePct" IS NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL THEN 1 ELSE 0 END) as "hasNoTolerance",
          SUM(CASE WHEN ir."nominalLossSurplus" > 10000000 THEN 1 ELSE 0 END) as "highLossItem",
          ir.direction as "outletDirection"
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
          ${f}
        GROUP BY ir."outletId", ir.direction
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
          ir.direction as "prevDirection"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}
          ${f}
        GROUP BY o.code, ir.direction
      `
      : Promise.resolve([]),
  ]);

  // Build prev lookup
  const prevMap = new Map<string, any>();
  for (const r of prevRows) {
    prevMap.set(r.outletCode, r);
  }

  // Compute network averages for ratio
  const networkAvgDevBom = currRows.length > 0
    ? currRows.reduce((s, r) => s + Number(r.devBom), 0) / currRows.length
    : 0;
  const totalNetworkDeviasi = currRows.reduce((s, r) => s + Math.abs(Number(r.nominalDeviasi)), 0);

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

    // Signal 2: Deviasi Growth (10%)
    const prevNominal = prev ? Number(prev.prevNominalDeviasi) : null;
    const deviasiGrowth = prevNominal != null && Math.abs(prevNominal) > 0
      ? (Math.abs(nominalDeviasi) - Math.abs(prevNominal)) / Math.abs(prevNominal)
      : null;
    const s2Score = deviasiGrowth != null ? Math.min(100, Math.max(0, deviasiGrowth * 100)) : 0;

    // Signal 3: Z-Score Abnormal Count (10%) — items with z-score > 2
    const abnormalCount = zScoreAbnormalCount;
    const s3Score = Math.min(100, zScoreAbnormalCount * 20);

    // Signal 4: Residual Ratio (10%)
    const residualRatio = totalQtyDeviasi > 0 ? Math.abs(residualQty) / totalQtyDeviasi : 0;
    const s4Score = Math.min(100, residualRatio * 100);

    // Signal 5: Loss/Sales Ratio (8%)
    const lossToSales = sales > 0 ? totalLoss / sales : 0;
    const s5Score = Math.min(100, lossToSales * 1000);

    // Signal 6: Direction Flip (8%)
    const prevDirection = prev?.prevDirection || null;
    const directionFlip = prevDirection != null && direction !== prevDirection && direction !== 'NEUTRAL' && prevDirection !== 'NEUTRAL';
    const s6Score = directionFlip ? 100 : 0;

    // Signal 7: Trend (8%)
    const trendDeteriorating = deviasiGrowth != null && deviasiGrowth > 0.2;
    const s7Score = trendDeteriorating ? 100 : 0;

    // Signal 8: Item Concentration (5%)
    const itemConcentration = Math.abs(nominalDeviasi) > 0 && topItemNominal > 0
      ? topItemNominal / Math.abs(nominalDeviasi)
      : 0;
    const s8Score = Math.min(100, itemConcentration * 100);

    // Signal 9: Tolerance Breach High (8%) — TOLERANCE_BREACH_HIGH rule
    const s9Score = Math.min(100, toleranceBreachHighCount * 25);

    // Signal 10: Over-Explained / Fraud Indicator (7%) — OVER_EXPLAINED rule
    const s10Score = Math.min(100, overExplainedCount * 50);

    // Signal 11: High Loss Nominal Items (5%) — HIGH_LOSS_NOMINAL rule (>10M per item)
    const s11Score = Math.min(100, highLossItem * 20);

    // Signal 12: No Tolerance Set (3%) — TOLERANCE_NOT_SET rule
    const s12Score = hasNoTolerance > 0 ? 50 : 0;

    // Signal 13: Benchmark High (3%) — HISTORICAL_HIGH / BENCHMARK_ABOVE_NETWORK
    const s13Score = Math.min(100, benchmarkHighCount * 25);

    // Signal 14: Residual Nominal Impact (2%) — financial impact of unexplained
    const s14Score = Math.min(100, (residualNominal / 1_000_000) * 5);

    // Signal 15: Tolerance Breach (regular) (1%) — TOLERANCE_BREACH rule
    const s15Score = Math.min(100, toleranceBreachCount * 5);

    // Weighted Priority Score (15 signals, total 100%)
    const priorityScore = Math.round(
      s1Score * 0.12 + s2Score * 0.10 + s3Score * 0.10 + s4Score * 0.10 +
      s5Score * 0.08 + s6Score * 0.08 + s7Score * 0.08 + s8Score * 0.05 +
      s9Score * 0.08 + s10Score * 0.07 + s11Score * 0.05 +
      s12Score * 0.03 + s13Score * 0.03 + s14Score * 0.02 + s15Score * 0.01
    );

    const priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH' =
      priorityScore >= 55 ? 'TINGGI' : priorityScore >= 30 ? 'SEDANG' : 'RENDAH';

    // Auto-generate analysis bullets
    const analysis: string[] = [];
    if (devBomRatio > 2) analysis.push(`Dev/BOM ${(devBom * 100).toFixed(1)}% adalah ${devBomRatio.toFixed(1)}× peer average (${(networkAvgDevBom * 100).toFixed(1)}%)`);
    if (deviasiGrowth != null && deviasiGrowth > 0.2) analysis.push(`Nominal Deviasi naik ${(deviasiGrowth * 100).toFixed(0)}% vs periode sebelumnya`);
    if (zScoreAbnormalCount > 0) analysis.push(`${zScoreAbnormalCount} item sangat abnormal (z-score > 2.0) vs perilaku historis`);
    if (residualRatio > 0.4) analysis.push(`Residual ${(residualRatio * 100).toFixed(0)}% — ${Math.abs(residualQty).toLocaleString('id-ID')} dari ${totalQtyDeviasi.toLocaleString('id-ID')} total deviasi tidak terjelaskan`);
    if (lossToSales > 0.03) analysis.push(`Loss/Sales ${(lossToSales * 100).toFixed(1)}% — rugi Rp ${totalLoss.toLocaleString('id-ID')} dari penjualan Rp ${sales.toLocaleString('id-ID')}`);
    if (directionFlip) analysis.push(`Arah deviasi berubah: ${prevDirection} → ${direction}`);
    if (itemConcentration > 0.3 && topItem) analysis.push(`Item "${topItem}" kontribusi ${(itemConcentration * 100).toFixed(0)}% dari total deviasi`);
    if (toleranceBreachHighCount > 0) analysis.push(`${toleranceBreachHighCount} item melebihi toleransi > 2× (TOLERANCE_BREACH_HIGH)`);
    if (overExplainedCount > 0) analysis.push(`${overExplainedCount} item Waste+Susut+Trial melebihi total deviasi — indikasi salah input atau fraud`);
    if (highLossItem > 0) analysis.push(`${highLossItem} item dengan nominal loss > Rp 10Jt (HIGH_LOSS_NOMINAL)`);
    if (hasNoTolerance > 0) analysis.push(`${hasNoTolerance} item belum diset toleransinya — tidak bisa deteksi breach`);
    if (benchmarkHighCount > 0) analysis.push(`${benchmarkHighCount} item jauh di atas rata-rata historis (HISTORICAL_HIGH)`);
    if (toleranceBreachCount > 0 && toleranceBreachHighCount === 0) analysis.push(`${toleranceBreachCount} item melebihi toleransi (TOLERANCE_BREACH)`);
    if (residualNominal > 0) analysis.push(`Dampak residual Rp ${Math.round(residualNominal).toLocaleString('id-ID')} — tidak terjelaskan secara finansial (RESIDUAL_NOMINAL)`);
    if (trendDeteriorating && (deviasiGrowth == null || deviasiGrowth <= 0.2)) analysis.push(`Tren deviasi memburuk — naik signifikan dari periode sebelumnya`);
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
    };
  });

  // Sort by priority score desc, take top N
  return recommendations
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, limit);
}
