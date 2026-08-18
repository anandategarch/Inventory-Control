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
    CROSS JOIN target t
    WHERE COALESCE(sm.sales, 0) > 0
      AND ABS(COALESCE(sm.sales, 0) - t.sales) <= t.sales * 0.1
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
