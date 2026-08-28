// ============================================================
//  Peer Comparison — all outlets with similar sales (±10%)
//  Returns full metrics per outlet for side-by-side comparison.
//  mode: 'week' = filter by weekLabel, 'month' = aggregate all weeks
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, DIRECTION_FROM_SUM_SQL, withStatementTimeout } from '../shared';

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
  limit: number = 10,
  kelompok?: string | null
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

  // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok filter scopes the PEER set
  // only (which outlets are considered peers). The focus outlet is ALWAYS
  // included via `o.code = ${outletCode}` so targetRow is never dropped
  // (e.g. if focus outlet is outside the selected kelompok). Pattern matches
  // shared.ts:buildSqlFilters kelompok clause — extract last dot-segment,
  // compare first 3 chars (works for both "1030.BDGSET" and "B.1001.MLGPAR").
  const peerKelompokFilter = kelompok
    ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
    : Prisma.sql``;

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
      ${peerKelompokFilter}
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
      -- FIX (RESTORE-SHARED-1): use shared DIRECTION_FROM_SUM_SQL fragment from ../shared
      ${DIRECTION_FROM_SUM_SQL} as "direction",
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

