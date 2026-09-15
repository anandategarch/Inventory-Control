// ============================================================
//  Peer Top Items — "top item di tiap peer" (PEERTOP-1)
//  --------------------------------------------------------
//  Answers the inverse question of the item-level comparison:
//  instead of "MY top items vs peer averages", it returns EACH
//  peer outlet's own top-N items (by SUM(absNominalDeviasi),
//  aggregate per item — one single definition of "top item"),
//  then unions them across the peer band so the frontend/PDF can
//  show which items are a SHARED problem (top in many peers)
//  vs a LOCAL one (top only at the target), plus blind spots
//  (top at peers but absent at the target).
//
//  Peer band = EXACTLY the same CTE pipeline as queryPeerComparison
//  (./peer-comparison.ts): sales ±10% (mode-resolved), kelompok
//  scopes the peer set only (target always included), numeric
//  latest-week fix in month mode, ORDER BY sales proximity with
//  LIMIT ${limit + 1} — so perPeer entries map 1:1 onto the rows
//  of the Peer Table for the same params.
//
//  Result grain:
//    items[]  — union of every outlet's top-N items, aggregated:
//               peerTopCount (how many non-target peers carry the
//               item in THEIR top-N), peer averages on the
//               ABSOLUTE basis (label: "Rata-Rata Absolute"),
//               and the target's own row (rank may exceed topN —
//               "di luar top-N"; null = no deviation records for
//               the item at the target at all).
//    perPeer[] — each outlet's top-N items (target included) for
//               the Peer Table expand-row UI + PDF 8.4.
//    Peers with ZERO deviation records never appear in the SQL
//    result → no perPeer entry (callers show "tidak ada item
//    deviasi" for those codes).
// ============================================================
import { Prisma } from '@prisma/client';
import { DIRECTION_FROM_SUM_SQL, withStatementTimeout } from '../shared';

/** One item in an outlet's top-N (magnitude + direction). */
export interface PeerTopItemEntry {
  itemName: string;
  /** SUM(absNominalDeviasi) at this outlet — magnitude of deviation. */
  absNominal: number;
  /** SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom)) — volume-weighted. */
  devBom: number;
  /** LOSS | SURPLUS | NEUTRAL — SUM(nominalLossSurplus) sign with
   *  SUM(qtyDeviasi) NULL fallback (DIRECTION_FROM_SUM_SQL). */
  direction: string;
}

/** One outlet's top-N items (for the Peer Table expand row + PDF 8.4). */
export interface PeerTopItemsPerOutlet {
  outletCode: string;
  outletName: string;
  isTarget: boolean;
  /** Top-N by SUM(absNominalDeviasi) — rank order (rn asc). */
  items: PeerTopItemEntry[];
}

/** One row of the cross-peer union table ("Top Items Across Peers"). */
export interface PeerTopItemUnionRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  /** Non-target peers carrying this item in THEIR top-N. */
  peerTopCount: number;
  /** Those peers' outlet codes (FE maps codes → names via perPeer). */
  peerTopCodes: string[];
  /** ABSOLUTE-basis average across those peers ("Rata-Rata Absolute"). */
  peerAvgAbsNominal: number;
  peerAvgDevBom: number;
  /** Worst (largest absNominal) among those peers. */
  peerMaxAbsNominal: number;
  /** Target's own row for the item. rank > topN = "di luar top-N";
   *  null = no deviation records for this item at the target. */
  target: { rank: number; absNominal: number; devBom: number; direction: string } | null;
}

export interface PeerTopItemsResult {
  topN: number;
  /** Union rows sorted: peerTopCount desc → target absNominal desc →
   *  peerMaxAbsNominal desc → itemName asc. */
  items: PeerTopItemUnionRow[];
  /** Per-outlet top-N. NOTE: ordered by outletCode from SQL — callers
   *  reorder to match the Peer Table order (sales proximity) if needed. */
  perPeer: PeerTopItemsPerOutlet[];
}

/**
 * @param outletCode Focus outlet code — included in the band via the
 *                   same `o.code = ${outletCode}` OR-clause as the
 *                   kelompok filter (never dropped).
 * @param month      Month label — already month-resolved by the route.
 * @param week       Week label; null in month mode (latest numeric week).
 * @param mode       'week' filters by weekLabel; 'month' uses the month's
 *                   latest week (weeks are cumulative — PEER-BACKEND-5).
 * @param topN       Per-outlet top item count (route clamps 1..10).
 * @param limit      Peer band cap — pass the SAME value as the main
 *                   /api/peer-comparison `limit` so the peer set matches
 *                   the Peer Table 1:1 (LIMIT ${limit + 1} inside).
 * @param kelompok   Optional kelompok filter — scopes the PEER set only.
 *                   Already 'all'-normalized by the route.
 */
export async function queryPeerTopItems(
  outletCode: string,
  month: string,
  week: string | null,
  mode: 'week' | 'month',
  topN: number,
  limit: number,
  kelompok?: string | null,
): Promise<PeerTopItemsResult> {
  // Same numeric latest-week subquery as queryPeerComparison /
  // queryPeerComparisonItems (BUG-3-c R-8: MAX("weekLabel") is
  // lexicographic — "WEEK 9" beats "WEEK 10").
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

  // DB-06: same weekFilter for the OutletPeriodSales alias (precomputed
  // MODE sales) — mirrors the sibling peer queries.
  const weekFilterOps = mode === 'week' && week
    ? Prisma.sql`AND ops."weekLabel" = ${week}`
    : Prisma.sql`AND ops."weekLabel" = ${latestWeekSubquery}`;

  // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only;
  // the focus outlet is ALWAYS included. Same fragment as the siblings.
  const peerKelompokFilter = kelompok
    ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
    : Prisma.sql``;

  // FIX (AUDIT8-ROLLBACK-1, Item 8): heavy multi-CTE scan (all items × all
  // band outlets) — wrapped in withStatementTimeout like the siblings.
  // Row shape produced by the SELECT below. SUM fields may be bigint.
  interface PeerTopItemsRawRow {
    outletCode: string;
    outletName: string;
    isTarget: boolean;
    itemId: number | bigint;
    itemName: string;
    satuan: string | null;
    absNominal: number | bigint;
    devBom: number | bigint;
    direction: string;
    rn: number | bigint;
  }
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<PeerTopItemsRawRow[]>`
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
    -- Same no-sales fallback as queryPeerComparison: target with records
    -- but no sales still gets a peer band (sales 0 → whole network).
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
    peer_outlets AS (
      SELECT o.id as "outletId", o.code as "outletCode", o.name as "outletName",
             COALESCE(sm.sales, 0) as sales,
             CASE WHEN o.code = ${outletCode} THEN true ELSE false END as "isTarget"
      FROM "Outlet" o
      JOIN sales_mode sm ON o.id = sm."outletId"
      CROSS JOIN target_combined t
      WHERE COALESCE(sm.sales, 0) > 0
        AND ABS(COALESCE(sm.sales, 0) - t.sales) <= CASE WHEN t.sales > 0 THEN t.sales * 0.1 ELSE 999999999 END
        ${peerKelompokFilter}
      ORDER BY ABS(COALESCE(sm.sales, 0) - t.sales)
      LIMIT ${limit + 1}
    ),
    -- DEFINITION (PEERTOP-1): "top item" = AGGREGATE per (outlet, item) —
    -- SUM(absNominalDeviasi) — the same definition as target_top_items in
    -- queryPeerComparisonItems, NOT the old single-record MAX used by the
    -- Peer Table's Top Item column (fixed in peer-comparison.ts in the same
    -- commit). One definition everywhere.
    outlet_item_aggs AS (
      SELECT
        ir."outletId",
        ir."itemId",
        i.name as "itemName",
        MAX(ir."satuan") as "satuan",
        SUM(ir."absNominalDeviasi") as "absNominal",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        ${DIRECTION_FROM_SUM_SQL} as "direction",
        ROW_NUMBER() OVER (PARTITION BY ir."outletId" ORDER BY SUM(ir."absNominalDeviasi") DESC) as rn
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month}
        ${weekFilter}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ir."outletId" IN (SELECT "outletId" FROM peer_outlets)
      GROUP BY ir."outletId", ir."itemId", i.name
    )
    SELECT
      po."outletCode",
      po."outletName",
      po."isTarget",
      oia."itemId",
      oia."itemName",
      oia."satuan",
      oia."absNominal",
      oia."devBom",
      oia."direction",
      oia."rn"
    FROM peer_outlets po
    JOIN outlet_item_aggs oia ON oia."outletId" = po."outletId"
    -- Target contributes its FULL item list (any rank) so the union table
    -- can show "di luar top-N" / detect blind spots; peers contribute
    -- only their top-N rows.
    WHERE po."isTarget" OR oia."rn" <= ${topN}
    ORDER BY po."outletCode", oia."rn"
  `);

  // ---- Grouping (pure JS) ------------------------------------------
  // perPeer: outletCode → top-N items (rn asc — rows arrive pre-sorted).
  const perPeerMap = new Map<string, PeerTopItemsPerOutlet>();
  // Target's full item index (any rank) — for union target info.
  const targetRows = new Map<number, { rank: number; absNominal: number; devBom: number; direction: string }>();
  // Union accumulator over rn <= topN rows.
  const unionMap = new Map<number, {
    itemId: number;
    itemName: string;
    satuan: string | null;
    peerAbsSum: number;
    peerDevBomSum: number;
    peerMaxAbsNominal: number;
    peerTopCodes: string[];
    targetTop: { rank: number; absNominal: number; devBom: number; direction: string } | null;
  }>();

  for (const r of rows) {
    const itemId = Number(r.itemId);
    const absNominal = Number(r.absNominal) || 0;
    const devBom = Number(r.devBom) || 0;
    const rank = Number(r.rn) || 0;
    const isTarget = Boolean(r.isTarget);

    if (isTarget && !targetRows.has(itemId)) {
      targetRows.set(itemId, { rank, absNominal, devBom, direction: r.direction });
    }

    if (rank <= topN) {
      // perPeer entry (target included — its own top-N drives the
      // expand row + PDF 8.4 target block).
      let pp = perPeerMap.get(r.outletCode);
      if (!pp) {
        pp = { outletCode: r.outletCode, outletName: r.outletName, isTarget, items: [] };
        perPeerMap.set(r.outletCode, pp);
      }
      pp.items.push({ itemName: r.itemName, absNominal, devBom, direction: r.direction });

      // Union accumulator.
      let u = unionMap.get(itemId);
      if (!u) {
        u = {
          itemId,
          itemName: r.itemName,
          satuan: r.satuan ?? null,
          peerAbsSum: 0,
          peerDevBomSum: 0,
          peerMaxAbsNominal: 0,
          peerTopCodes: [],
          targetTop: null,
        };
        unionMap.set(itemId, u);
      }
      if (isTarget) {
        u.targetTop = { rank, absNominal, devBom, direction: r.direction };
      } else {
        u.peerAbsSum += absNominal;
        u.peerDevBomSum += devBom;
        u.peerMaxAbsNominal = Math.max(u.peerMaxAbsNominal, absNominal);
        u.peerTopCodes.push(r.outletCode);
      }
    }
  }

  const items: PeerTopItemUnionRow[] = Array.from(unionMap.values()).map((u) => {
    const n = u.peerTopCodes.length;
    // ABSOLUTE-basis averages ("Rata-Rata Absolute" label downstream).
    return {
      itemId: u.itemId,
      itemName: u.itemName,
      satuan: u.satuan,
      peerTopCount: n,
      peerTopCodes: u.peerTopCodes,
      peerAvgAbsNominal: n > 0 ? u.peerAbsSum / n : 0,
      peerAvgDevBom: n > 0 ? u.peerDevBomSum / n : 0,
      peerMaxAbsNominal: u.peerMaxAbsNominal,
      // Prefer the target's top-N row (same object as targetRows anyway);
      // fall back to the full index (rank may exceed topN), else null.
      target: u.targetTop ?? targetRows.get(u.itemId) ?? null,
    };
  });

  items.sort((a, b) => {
    if (b.peerTopCount !== a.peerTopCount) return b.peerTopCount - a.peerTopCount;
    const aT = a.target?.absNominal ?? 0;
    const bT = b.target?.absNominal ?? 0;
    if (bT !== aT) return bT - aT;
    if (b.peerMaxAbsNominal !== a.peerMaxAbsNominal) return b.peerMaxAbsNominal - a.peerMaxAbsNominal;
    return a.itemName.localeCompare(b.itemName);
  });

  return { topN, items, perPeer: Array.from(perPeerMap.values()) };
}
