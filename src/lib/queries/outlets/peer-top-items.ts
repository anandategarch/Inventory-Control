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
//               item in THEIR top-N), topDiNames (PEERTOP-R2 user:
//               "TOP DI ini isi top 3 aja resto aja dan jika resto
//               target termasuk masukan juga" — the TOP-3 outlet
//               NAMES by SUM(absNominal) DESC among the item's
//               top-N carriers + the target's own row when it
//               records the item), peer averages on the ABSOLUTE
//               basis (PEERTOP-R1 user: "rata-rata absolute pakai
//               kuantiti deviasi aja diabsolute" → |qtyDeviasi|),
//               and the target's own row (qtyDeviasi = SIGNED raw
//               quantity deviation — "nilai asli", minus = kekurangan;
//               itemRank = the target's rank among ALL band outlets
//               that recorded a deviation for this item — user:
//               "Rangking Resto di antara Resto yang Selevel per
//               Item"; null row = no deviation records for the item
//               at the target at all = blind spot).
//    perPeer[] — each outlet's top-N items (target included) for
//               the Peer Table expand-row UI (PDF 8.4 was REMOVED
//               by user request in PEERTOP-R1).
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
  /** PEERTOP-R2 (user: "TOP DI ini isi top 3 aja resto aja dan jika resto
   *  target termasuk masukan juga"): the "Top di" display — the TOP-3
   *  outlet NAMES by SUM(absNominal) DESC among the item's top-N peer
   *  carriers PLUS the target's own row (any rank) when it records the
   *  item, so the target's name appears exactly when it ranks among the
   *  top 3. Ties broken by name asc for determinism. */
  topDiNames: string[];
  /** Rata-rata |kuantiti deviasi| across those peers — PEERTOP-R1 user:
   *  "RATA-RATA ABSOLUTE RESTO SETARA ... pakai kuantiti deviasi aja
   *  diabsolute" (was avg |nominal|). ABSOLUTE basis kept (label
   *  "Rata-Rata Absolute" downstream). */
  peerAvgAbsQty: number;
  peerAvgDevBom: number;
  /** Worst (largest absNominal) among those peers — sort key only. */
  peerMaxAbsNominal: number;
  /** Target's own row for the item.
   *  rank            — rank in the TARGET's own top list (FE bold/muted
   *                    styling; may exceed topN = "di luar top-N");
   *  qtyDeviasi      — SUM(qtyDeviasi) SIGNED, "kuantiti deviasi nilai
   *                    asli" (null = no qty records; minus = kekurangan
   *                    → rendered red — PEERTOP-R1 replaced the Arah
   *                    column with signed values);
   *  itemRank        — PEERTOP-R1 user: "Rangking Resto di antara Resto
   *                    yang Selevel per Item" — RANK() of the target's
   *                    absNominal among ALL band outlets recording this
   *                    item (ties share a rank);
   *  itemOutletCount — those outlets' count (incl. the target) = the
   *                    ranking denominator ("#3/9").
   *  null row = no deviation records for this item at the target. */
  target: {
    rank: number;
    absNominal: number;
    devBom: number;
    qtyDeviasi: number | null;
    itemRank: number;
    itemOutletCount: number;
  } | null;
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
    /** SUM(qtyDeviasi) — SIGNED raw ("nilai asli"); NULL when the item
     *  has no qty records at this outlet (SUM of all-NULL is NULL). */
    qtyDev: number | bigint | null;
    /** COALESCE(SUM(ABS(qtyDeviasi)), 0) — peer avg absolute basis. */
    absQty: number | bigint;
    devBom: number | bigint;
    direction: string;
    rn: number | bigint;
    /** RANK() of this outlet's absNominal among ALL band outlets
     *  recording this item (PARTITION BY itemId) — only the target
     *  row's value is consumed downstream. */
    itemRank: number | bigint;
    /** Band outlets (incl. the target) recording this item. */
    itemOutletCount: number | bigint;
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
        -- PEERTOP-R1: kuantiti deviasi NILAI ASLI (signed — minus =
        -- kekurangan, rendered red downstream; replaces the Arah column).
        SUM(ir."qtyDeviasi") as "qtyDev",
        -- PEERTOP-R1: |qty deviation| aggregate — the "Rata-Rata Absolute"
        -- basis (user: "pakai kuantiti deviasi aja diabsolute").
        COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) as "absQty",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        ${DIRECTION_FROM_SUM_SQL} as "direction",
        ROW_NUMBER() OVER (PARTITION BY ir."outletId" ORDER BY SUM(ir."absNominalDeviasi") DESC) as rn,
        -- PEERTOP-R1 (user: "Rangking Resto di antara Resto yang Selevel
        -- per Item"): this outlet's rank among ALL band outlets that
        -- recorded a deviation for the item, by SUM(absNominal) DESC
        -- (RANK → ties share a rank). Window functions run AFTER the
        -- GROUP BY, so partitioning by the grouped key is valid.
        RANK() OVER (PARTITION BY ir."itemId" ORDER BY SUM(ir."absNominalDeviasi") DESC) as "itemRank",
        COUNT(*) OVER (PARTITION BY ir."itemId") as "itemOutletCount"
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
      oia."qtyDev",
      oia."absQty",
      oia."devBom",
      oia."direction",
      oia."rn",
      oia."itemRank",
      oia."itemOutletCount"
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
  const targetRows = new Map<number, NonNullable<PeerTopItemUnionRow['target']>>();
  // PEERTOP-R2: the target outlet's NAME (from any target row — the
  // band CTE always names the target; captured for topDiNames).
  let targetOutletName: string | null = null;
  // Union accumulator over rn <= topN rows.
  const unionMap = new Map<number, {
    itemId: number;
    itemName: string;
    satuan: string | null;
    peerAbsQtySum: number;
    peerDevBomSum: number;
    peerMaxAbsNominal: number;
    peerTopCodes: string[];
    // PEERTOP-R2: per-item peer top-N carriers with the fields the
    // topDiNames computation needs (name + magnitude).
    peerCarriers: Array<{ name: string; absNominal: number }>;
    targetTop: NonNullable<PeerTopItemUnionRow['target']> | null;
  }>();

  for (const r of rows) {
    const itemId = Number(r.itemId);
    const absNominal = Number(r.absNominal) || 0;
    // PEERTOP-R1: signed raw qty deviation (null = no qty records) and
    // the per-item cross-outlet ranking carried on every row.
    const qtyDeviasi = r.qtyDev == null ? null : Number(r.qtyDev) || 0;
    const absQty = Number(r.absQty) || 0;
    const itemRank = Number(r.itemRank) || 0;
    const itemOutletCount = Number(r.itemOutletCount) || 0;
    const devBom = Number(r.devBom) || 0;
    const rank = Number(r.rn) || 0;
    const isTarget = Boolean(r.isTarget);

    if (isTarget) {
      if (!targetRows.has(itemId)) {
        targetRows.set(itemId, { rank, absNominal, devBom, qtyDeviasi, itemRank, itemOutletCount });
      }
      if (targetOutletName == null) targetOutletName = r.outletName;
    }

    if (rank <= topN) {
      // perPeer entry (target included — its own top-N drives the
      // expand row UI).
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
          peerAbsQtySum: 0,
          peerDevBomSum: 0,
          peerMaxAbsNominal: 0,
          peerTopCodes: [],
          peerCarriers: [],
          targetTop: null,
        };
        unionMap.set(itemId, u);
      }
      if (isTarget) {
        u.targetTop = { rank, absNominal, devBom, qtyDeviasi, itemRank, itemOutletCount };
      } else {
        // PEERTOP-R1: peer average is on the |qtyDeviasi| basis.
        u.peerAbsQtySum += absQty;
        u.peerDevBomSum += devBom;
        u.peerMaxAbsNominal = Math.max(u.peerMaxAbsNominal, absNominal);
        u.peerTopCodes.push(r.outletCode);
        // PEERTOP-R2: carrier kept with name + magnitude for topDiNames.
        u.peerCarriers.push({ name: r.outletName, absNominal });
      }
    }
  }

  const items: PeerTopItemUnionRow[] = Array.from(unionMap.values()).map((u) => {
    const n = u.peerTopCodes.length;
    // ABSOLUTE-basis averages ("Rata-Rata Absolute" label downstream) —
    // PEERTOP-R1: |kuantiti deviasi| basis (user request).
    // PEERTOP-R2: "Top di" display — top-3 outlet NAMES by |nominal|
    // DESC. Candidates = the item's top-N peer carriers + the target's
    // own row for the item (ANY rank — targetRows holds the full index,
    // so the target still competes even when the item sits outside its
    // own top-N). The target's name appears exactly when it ranks among
    // the top 3 (user: "jika resto target termasuk masukan juga"); ties
    // broken by name asc so the output is deterministic.
    const targetInfo = u.targetTop ?? targetRows.get(u.itemId) ?? null;
    const candidates = [...u.peerCarriers];
    if (targetInfo && targetOutletName != null) {
      candidates.push({ name: targetOutletName, absNominal: targetInfo.absNominal });
    }
    candidates.sort((a, b) => (b.absNominal - a.absNominal) || a.name.localeCompare(b.name));
    return {
      itemId: u.itemId,
      itemName: u.itemName,
      satuan: u.satuan,
      peerTopCount: n,
      peerTopCodes: u.peerTopCodes,
      topDiNames: candidates.slice(0, 3).map((c) => c.name),
      peerAvgAbsQty: n > 0 ? u.peerAbsQtySum / n : 0,
      peerAvgDevBom: n > 0 ? u.peerDevBomSum / n : 0,
      peerMaxAbsNominal: u.peerMaxAbsNominal,
      // Prefer the target's top-N row (same object as targetRows anyway);
      // fall back to the full index (rank may exceed topN), else null.
      target: targetInfo,
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
