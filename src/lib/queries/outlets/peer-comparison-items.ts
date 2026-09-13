// ============================================================
//  Peer Comparison Items — item-level peer comparison query
//  --------------------------------------------------------
//  Returns top N items from the target outlet (by ABS(nominalDeviasi)),
//  with the same items' metrics aggregated across all peer outlets
//  in the target's sales ±10% band. Peers carry the item with a
//  comparable BOM volume; "missing" peers (item not in their
//  inventory) are kept as zeroed rows with missing=true.
//
//  MERGE-1-a (audit A1): moved VERBATIM from
//  src/app/api/peer-comparison/items/route.ts (was the inline
//  `computePeerComparisonItems` in the route file) — SQL belongs in
//  src/lib/queries/** per the repo colocation convention (same as
//  analysis/services, export-report/services). The route keeps only
//  request parsing + cache key building + withCacheAndDedup.
//
//  Parameter shape mirrors the sibling queryPeerComparison
//  (./peer-comparison.ts): positional params, kelompok optional.
//  mode: 'week' = filter by weekLabel, 'month' = latest week of the
//  month (cumulative-week MAX fix — see PEER-BACKEND-5 note inside).
// ============================================================
import { Prisma } from '@prisma/client';
import { withStatementTimeout } from '../shared';

// P3-HYG-3: hoisted to module scope (was inside the GET handler of
// /api/peer-comparison/items, then at route module scope — MERGE-1-a moved
// it here with the query). The query's return type + the route's
// cache-wrapper generic both reference GroupedItem.
export interface PeerOutletEntry {
  outletCode: string;
  outletName: string;
  isTarget: boolean;
  qtyDeviasi: number;
  devBom: number;
  nominal: number;
  missing: boolean;
}
export interface GroupedItem {
  itemId: number;
  itemName: string;
  target: { qtyDeviasi: number; devBom: number; nominal: number };
  peers: PeerOutletEntry[];
}

/**
 * P3-HYG-3: the heavy compute extracted from the GET handler so it can be
 * wrapped in withCacheAndDedup. Pure function of its explicit params (all
 * validated + month-resolved by the route BEFORE this runs) — SQL fetch +
 * row grouping + per-item peer stats. Returns the `items` array only;
 * response envelope fields (success/cached/…) are added by the route on
 * every request so cache hits never freeze stale envelope flags.
 *
 * MERGE-1-a (audit A1): moved verbatim from
 * src/app/api/peer-comparison/items/route.ts (computePeerComparisonItems —
 * SQL inline in the route file, violating the queries/** colocation
 * convention). Parameter shape mirrors the sibling queryPeerComparison
 * (./peer-comparison.ts).
 *
 * @param outletCode Focus outlet code — its top-N items anchor the comparison.
 * @param month      Month label (e.g. "MEI 2026") — already month-resolved
 *                   by the route.
 * @param week       Week label (e.g. "WEEK 1"); null in month mode.
 * @param mode       'week' filters by weekLabel; 'month' aggregates to the
 *                   month's LATEST week (weeks are cumulative — see the
 *                   weekFilter note below).
 * @param topItems   Max number of target items to compare (route caps at 20).
 * @param kelompok   Optional kelompok filter — scopes the PEER set only
 *                   (focus outlet always included; FIX BUG2-RESTO-1 /
 *                   FIX-P1-PEER-1). Already 'all'-normalized by the route.
 * @returns `{ items: GroupedItem[] }` — each item carries target metrics +
 *          per-peer rows; runtime rows additionally include peerAvg /
 *          peerBest / gap / peerCount (see ItemComparisonResponse in
 *          components/dashboard/peer-comparison/types.ts for the JSON shape).
 */
export async function queryPeerComparisonItems(
  outletCode: string,
  month: string,
  week: string | null,
  mode: 'week' | 'month',
  topItems: number,
  kelompok?: string | null,
): Promise<{ items: GroupedItem[] }> {
    // Same week filter logic as queryPeerComparison (outlets.ts)
    const weekFilter = mode === 'week' && week
      ? Prisma.sql`AND ir."weekLabel" = ${week}`
      : Prisma.sql`AND ir."weekLabel" = (
          SELECT MAX(ir2."weekLabel") FROM "InventoryRecord" ir2
          WHERE ir2."monthLabel" = ${month}
        )`;

    // DB-06: same weekFilter but for the OutletPeriodSales alias (`ops`).
    // Used by the refactored sales_mode CTE to select the right period's
    // precomputed MODE value. Mirrors queryPeerComparison's pattern.
    const weekFilterOps = mode === 'week' && week
      ? Prisma.sql`AND ops."weekLabel" = ${week}`
      : Prisma.sql`AND ops."weekLabel" = (
          SELECT MAX(ir2."weekLabel") FROM "InventoryRecord" ir2
          WHERE ir2."monthLabel" = ${month}
        )`;

    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok filter scopes the PEER set
    // only (peer_outlets CTE). The focus outlet is ALWAYS included via
    // `o.code = ${outletCode}` so it is never dropped from the result set
    // (e.g. if focus outlet is outside the selected kelompok). Pattern
    // matches shared.ts:buildSqlFilters kelompok clause — extract last
    // dot-segment, compare first 3 chars (works for both "1030.BDGSET" and
    // "B.1001.MLGPAR").
    const peerKelompokFilter = kelompok
      ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
      : Prisma.sql``;

    // 1. Find target outlet's sales (mode) within the ±10% peer set.
    //    Reuse the same sales_mode logic from queryPeerComparison.
    // 2. For top N items by absNominalDeviasi in the target outlet, pull
    //    the same items across all peer outlets in the sales ±10% band.
    //
    // The query below joins: target items × peer outlets × item metrics.
    // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
    // (heavy multi-CTE with CROSS JOIN over peer outlets — vulnerable to slow plans).
    // DB-06: sales_counts → ranked_sales → sales_mode CTE pipeline replaced
    // with pre-computed OutletPeriodSales table.
    // Row shape produced by the SELECT below. SUM fields may be bigint.
    interface PeerComparisonItemRawRow {
      itemId: number | bigint;
      itemName: string;
      targetQtyDeviasi: number | bigint;
      targetDevBom: number | bigint;
      targetNominal: number | bigint;
      outletCode: string;
      outletName: string;
      isTarget: boolean;
      peerQtyDeviasi: number | bigint | null;
      peerDevBom: number | bigint | null;
      peerNominal: number | bigint | null;
    }
    const rows = await withStatementTimeout((tx) => tx.$queryRaw<PeerComparisonItemRawRow[]>`
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
      peer_outlets AS (
        SELECT o.id as "outletId", o.code as "outletCode", o.name as "outletName",
               COALESCE(sm.sales, 0) as sales,
               CASE WHEN o.code = ${outletCode} THEN true ELSE false END as "isTarget"
        FROM "Outlet" o
        JOIN sales_mode sm ON o.id = sm."outletId"
        CROSS JOIN target t
        WHERE COALESCE(sm.sales, 0) > 0
          AND ABS(COALESCE(sm.sales, 0) - t.sales) <= t.sales * 0.1
          ${peerKelompokFilter}
      ),
      target_top_items AS (
        SELECT i.id as "itemId", i.name as "itemName",
          SUM(ABS(ir."qtyDeviasi")) as "targetQtyDeviasi",
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "targetDevBom",
          SUM(ABS(ir."nominalDeviasi")) as "targetNominal"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${month}
          ${weekFilter}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        GROUP BY i.id, i.name
        ORDER BY SUM(ir."absNominalDeviasi") DESC
        LIMIT ${topItems}
      )
      SELECT
        tti."itemId",
        tti."itemName",
        tti."targetQtyDeviasi",
        tti."targetDevBom",
        tti."targetNominal",
        po."outletCode",
        po."outletName",
        po."isTarget",
        SUM(ABS(ir."qtyDeviasi")) as "peerQtyDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "peerDevBom",
        SUM(ABS(ir."nominalDeviasi")) as "peerNominal"
      FROM target_top_items tti
      CROSS JOIN peer_outlets po
      LEFT JOIN "InventoryRecord" ir
        ON ir."itemId" = tti."itemId"
        AND ir."outletId" = po."outletId"
        AND ir."monthLabel" = ${month}
        ${weekFilter}
      GROUP BY tti."itemId", tti."itemName", tti."targetQtyDeviasi",
               tti."targetDevBom", tti."targetNominal",
               po."outletId", po."outletCode", po."outletName", po."isTarget"
      ORDER BY tti."targetNominal" DESC, po."outletCode"
    `);

    // Group rows by itemId → { itemName, target, peers: [{outletCode, outletName, isTarget, qtyDeviasi, devBom, nominal}] }
    // (PeerOutletEntry + GroupedItem hoisted to module scope — see above.)
    const itemMap = new Map<number, GroupedItem>();
    for (const r of rows) {
      const itemId = Number(r.itemId);
      if (!itemMap.has(itemId)) {
        itemMap.set(itemId, {
          itemId,
          itemName: r.itemName,
          target: {
            qtyDeviasi: Number(r.targetQtyDeviasi) || 0,
            devBom: Number(r.targetDevBom) || 0,
            nominal: Number(r.targetNominal) || 0,
          },
          peers: [],
        });
      }
      const item = itemMap.get(itemId);
      // `item` is always defined here — we just set it on the first iteration
      // for this itemId. The `if (!item) continue` is a TS-only guard against
      // Map.get's `T | undefined` return type.
      if (!item) continue;
      // Skip NULL rows (item not in that peer outlet's inventory)
      if (r.peerQtyDeviasi === null || r.peerNominal === null) {
        item.peers.push({
          outletCode: r.outletCode,
          outletName: r.outletName,
          isTarget: Boolean(r.isTarget),
          qtyDeviasi: 0,
          devBom: 0,
          nominal: 0,
          missing: true,
        });
      } else {
        item.peers.push({
          outletCode: r.outletCode,
          outletName: r.outletName,
          isTarget: Boolean(r.isTarget),
          qtyDeviasi: Number(r.peerQtyDeviasi) || 0,
          devBom: Number(r.peerDevBom) || 0,
          nominal: Number(r.peerNominal) || 0,
          missing: false,
        });
      }
    }

    const items = Array.from(itemMap.values()).map((item) => {
      const otherPeers = item.peers.filter((p) => !p.isTarget && !p.missing);
      const n = otherPeers.length;
      const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
      const peerAvg = {
        qtyDeviasi: n > 0 ? otherPeers.reduce((s, p) => s + p.qtyDeviasi, 0) / n : 0,
        devBom: n > 0 ? otherPeers.reduce((s, p) => s + p.devBom, 0) / n : 0,
        nominal: n > 0 ? otherPeers.reduce((s, p) => s + p.nominal, 0) / n : 0,
      };
      // Peer best: lowest is best for these bad metrics
      const peerBest = {
        qtyDeviasi: n > 0 ? Math.min(...otherPeers.map((p) => p.qtyDeviasi)) : 0,
        devBom: n > 0 ? Math.min(...otherPeers.map((p) => p.devBom)) : 0,
        nominal: n > 0 ? Math.min(...otherPeers.map((p) => p.nominal)) : 0,
      };
      const gap = {
        qtyDeviasi: item.target.qtyDeviasi - peerBest.qtyDeviasi,
        devBom: item.target.devBom - peerBest.devBom,
        nominal: item.target.nominal - peerBest.nominal,
        nominalPctAboveBest: safeDiv(item.target.nominal - peerBest.nominal, peerBest.nominal),
      };
      return { ...item, peerAvg, peerBest, gap, peerCount: n };
    });

    return { items };
}
