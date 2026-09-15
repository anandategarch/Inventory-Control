// ============================================================
//  Peer Comparison — all outlets with similar sales (±10%)
//  Returns full metrics per outlet for side-by-side comparison.
//  mode: 'week' = filter by weekLabel, 'month' = aggregate all weeks
// ============================================================
import { Prisma } from '@prisma/client';
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
  // Fix: in month mode, use only the LATEST week for the month.
  // FIX (BUG-3-c R-8): the LATEST week is picked NUMERICALLY, not
  // lexicographically — MAX("weekLabel") returns "WEEK 9" once WEEK 10+
  // exists ('1' < '9' in text order). The subquery groups the month's
  // distinct labels (a handful) and orders by the integer parsed from the
  // label — NULLS LAST keeps malformed digit-less labels from winning.
  const latestWeekSubquery = Prisma.sql`(
        SELECT ir2."weekLabel" FROM "InventoryRecord" ir2
        WHERE ir2."monthLabel" = ${month}
        GROUP BY ir2."weekLabel"
        ORDER BY SUBSTRING(ir2."weekLabel" FROM '[0-9]+')::int DESC NULLS LAST, ir2."weekLabel" DESC
        LIMIT 1
      )`;
  const weekFilter = mode === 'week' && week
    ? Prisma.sql`AND ir."weekLabel" = ${week}`
    : Prisma.sql`AND ir."weekLabel" = ${latestWeekSubquery}`;

  // DB-06: same weekFilter but for the OutletPeriodSales alias (`ops`).
  // Used by the refactored sales_mode CTE to select the right period's
  // precomputed MODE value. The subquery still queries InventoryRecord (the
  // source of truth for which weeks exist) — numeric latest-week fix (R-8)
  // preserved on both aliases.
  const weekFilterOps = mode === 'week' && week
    ? Prisma.sql`AND ops."weekLabel" = ${week}`
    : Prisma.sql`AND ops."weekLabel" = ${latestWeekSubquery}`;

  // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok filter scopes the PEER set
  // only (which outlets are considered peers). The focus outlet is ALWAYS
  // included via `o.code = ${outletCode}` so targetRow is never dropped
  // (e.g. if focus outlet is outside the selected kelompok). Pattern matches
  // shared.ts:buildSqlFilters kelompok clause — extract last dot-segment,
  // compare first 3 chars (works for both "1030.BDGSET" and "B.1001.MLGPAR").
  const peerKelompokFilter = kelompok
    ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
    : Prisma.sql``;

  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // DB-06: sales_counts → ranked_sales → sales_mode CTE pipeline replaced
  // with pre-computed OutletPeriodSales table. The `weekFilterOps` selects
  // the same period as the original weekFilter (cumulative-week MAX fix
  // preserved). nominalSales is outlet-level denormalized so the precomputed
  // MODE matches the inline CTE output.
  // Row shape produced by the SELECT below. Sales/nominal/qty fields may be
  // bigint (PostgreSQL SUM) — coerced to Number in the .map() step.
  interface PeerComparisonRawRow {
    outletCode: string;
    outletName: string;
    area: string;
    pic: string | null;
    sales: number | bigint;
    nominalDeviasi: number | bigint;
    devBom: number | bigint;
    qtyBom: number | bigint;
    qtyDeviasi: number | bigint;
    qtyWaste: number | bigint;
    qtySusut: number | bigint;
    qtyTrial: number | bigint;
    qtyLossSurplus: number | bigint;
    totalLoss: number | bigint;
    totalSurplus: number | bigint;
    residualQty: number | bigint;
    itemCount: number | bigint;
    topItem: string | null;
    topItemNominal: number | bigint;
    direction: string;
    isTarget: boolean;
  }
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<PeerComparisonRawRow[]>`
    WITH sales_mode AS (
      SELECT ops."outletId", ops."salesMode" as sales
      FROM "OutletPeriodSales" ops
      WHERE ops."monthLabel" = ${month}
        ${weekFilterOps}
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
        -- FIX (CALC-03): expose SUM(nominalLossSurplus) for direction fallback
        -- chain. Was only available via totalLoss/totalSurplus (always >=0),
        -- which made it impossible to distinguish "all NULL" from "net zero".
        SUM(ir."nominalLossSurplus") as "nominalLossSurplusSigned",
        -- FIX CALC-3: use nominalLossSurplus < 0 (LOSS) instead of stored ir.direction (which may be inverted)
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
        COUNT(DISTINCT ir."itemId") as "itemCount"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month}
        ${weekFilter}
      GROUP BY ir."outletId"
    ),
    -- FIX (PEERTOP-1): "top item" is now the AGGREGATE per (outlet, item) —
    -- SUM(absNominalDeviasi) — matching queryPeerComparisonItems'
    -- target_top_items and the new queryPeerTopItems. Was a single RECORD's
    -- absNominalDeviasi (ROW_NUMBER over records), which could disagree with
    -- the item-level cards for the same outlet (one definition everywhere).
    top_items AS (
      SELECT "outletId", "topItem", "topItemNominal" FROM (
        SELECT
          ir."outletId",
          i.id as "itemId",
          i.name as "topItem",
          SUM(ir."absNominalDeviasi") as "topItemNominal",
          ROW_NUMBER() OVER (PARTITION BY ir."outletId" ORDER BY SUM(ir."absNominalDeviasi") DESC) as rn
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE ir."monthLabel" = ${month}
          ${weekFilter}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        GROUP BY ir."outletId", i.id, i.name
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
      -- FIX (CALC-03): direction fallback chain matching DIRECTION_FROM_SUM_SQL.
      -- 1. SUM(nominalLossSurplus) sign (primary — NET direction)
      -- 2. SUM(qtyDeviasi) sign (fallback when nominalLossSurplus is NULL)
      -- 3. NEUTRAL
      -- Was: CASE WHEN totalLoss > totalSurplus — missing the NULL fallback.
      CASE
        WHEN oa."nominalLossSurplusSigned" IS NOT NULL AND oa."nominalLossSurplusSigned" < 0 THEN 'LOSS'
        WHEN oa."nominalLossSurplusSigned" IS NOT NULL AND oa."nominalLossSurplusSigned" > 0 THEN 'SURPLUS'
        WHEN oa."nominalLossSurplusSigned" IS NULL AND oa."qtyDeviasi" < 0 THEN 'LOSS'
        WHEN oa."nominalLossSurplusSigned" IS NULL AND oa."qtyDeviasi" > 0 THEN 'SURPLUS'
        ELSE 'NEUTRAL'
      END as "direction",
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
  `);

  const targetRow = rows.find((r) => r.isTarget);
  const targetSales = targetRow ? Number(targetRow.sales) : 0;

  const peers: PeerComparisonRow[] = rows.map((r) => ({
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
//  Peer Trend — multi-period trend comparison: target vs
//  peer average across all weekLabels in the current month.
//  peerOutletCodes comes from queryPeerComparison result.
//  NOTE: H-10 dead-code cleanup — the unused queryPeerItemComparison
//  helper + PeerItemRow were removed here (superseded by
//  peer-comparison/items/route.ts's inline SQL, which also exposes
//  the `missing` flag this helper lacked). Recover from git history
//  if ever needed. Unlike queryPeerComparison,
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

  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // Row shape produced by the SELECT below.
  interface PeerTrendRawRow {
    weekLabel: string;
    targetDevBom: number | bigint;
    peerAvgDevBom: number | bigint;
    targetNominal: number | bigint;
    peerAvgNominal: number | bigint;
  }
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<PeerTrendRawRow[]>`
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
  `);

  return rows.map((r) => ({
    weekLabel: r.weekLabel,
    targetDevBom: Number(r.targetDevBom),
    peerAvgDevBom: Number(r.peerAvgDevBom),
    targetNominal: Number(r.targetNominal),
    peerAvgNominal: Number(r.peerAvgNominal),
  }));
}

