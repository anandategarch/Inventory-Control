// ============================================================
//  Item Peer Comparison
//  --------------------------------------------------------
//  Returns peer outlets for a specific item scoped to ONE
//  period (month + week). Peers are OTHER outlets that carry
//  the same item AND have ABS(qtyBom) within ±50% of the
//  target outlet's ABS(qtyBom) — same "bucket average" peer
//  selection logic as queryTopItemsByDeviasiRank's bucket_avg
//  CTE (see ./top-items/by-deviasi-rank.ts).
//
//  Target outlet:
//    - If `outletCode` is provided → that outlet is the target.
//    - If omitted → auto-select the outlet with the highest
//      ABS(nominalDeviasi) for this item (worst = most
//      interesting for comparison).
//
//  Returns:
//    - target: ItemPeerRow | null  (null when item/outlet not found)
//    - peers:  ItemPeerRow[]      (excludes the target outlet)
//    - peerAverages: aggregated stats from peers only
//    - autoSelected: true when target was auto-selected
//
//  DESIGN NOTE on buildDeviasiRankBaseCte:
//    The shared CTE builder in ./top-items/shared-cte.ts exposes
//    only itemName/outletCode/outletName/pic/satuan/qtyDeviasi/
//    qtyWaste/qtyLossSurplus/pctLossSurplusToBom/qtyBom(SIGNED)/
//    nominalDeviasi/absQtyDeviasi. This route additionally needs
//    area, qtySusut, qtyTrial, absNominalDeviasi, SUM(ABS(qtyBom))
//    and SUM(nominalLossSurplus) for direction. Rather than join
//    back to InventoryRecord (re-aggregating the same per-(item,
//    outlet) bucket twice), we follow the SAME PATTERN as the
//    shared builder but include all required fields in one pass.
//    The structure mirrors buildDeviasiRankBaseCte's first CTE
//    (same joins, same WHERE, same GROUP BY) so behavior is
//    consistent with the rest of the items/* query family.
// ============================================================
import { Prisma } from '@prisma/client';
import {
  buildSqlFilters,
  DIRECTION_FROM_SUM_SQL,
  withStatementTimeout,
  type SqlFilterOpts,
} from '../shared';

// ------------------------------------------------------------
//  Public types
// ------------------------------------------------------------

export interface ItemPeerRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  /** SUM(ABS(qtyBom)) — always non-negative. */
  qtyBom: number;
  /** SIGNED SUM(qtyDeviasi) — negative = LOSS, positive = SURPLUS.
   *  FIX (BUG-2-08): was backwards (said "negative = SURPLUS, positive = LOSS"). */
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  /** SIGNED SUM(nominalDeviasi). */
  nominalDeviasi: number;
  absNominalDeviasi: number;
  /**
   * SIGNED ratio = SUM(qtyDeviasi) / SUM(ABS(qtyBom)).
   * Null when BOM = 0 (bucket concept doesn't apply).
   */
  devBom: number | null;
  /** LOSS / SURPLUS / NEUTRAL — derived via DIRECTION_FROM_SUM_SQL. */
  direction: string;
  /** True for the target outlet row, false for peer rows. */
  isTarget: boolean;
}

export interface ItemPeerAverages {
  qtyBom: number;
  absQtyDeviasi: number;
  absNominalDeviasi: number;
  devBom: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  /** Count of peers with direction=LOSS. */
  lossOutlets: number;
  /** Count of peers with direction=SURPLUS. */
  surplusOutlets: number;
}

export interface ItemPeerComparisonResult {
  target: ItemPeerRow | null;
  peers: ItemPeerRow[];
  peerAverages: ItemPeerAverages;
  /** True when outletCode was omitted and the worst outlet was auto-selected. */
  autoSelected: boolean;
}

// ------------------------------------------------------------
//  Query options
// ------------------------------------------------------------

export interface ItemPeerComparisonOpts {
  /** Exact item name (matched via `i.name = ${item}`). */
  item: string;
  /** Month label (e.g. "MEI 2026"). */
  month: string;
  /** Week label (e.g. "WEEK 1"). */
  week: string;
  /** Optional target outlet code. If omitted, worst outlet is auto-selected. */
  outletCode?: string | null;
  /** Dashboard filters (area, kelompok, picOutletCodes). outletCode is ignored. */
  filters: SqlFilterOpts;
}

// ------------------------------------------------------------
//  Raw row shape returned by the SQL
// ------------------------------------------------------------

interface ItemPeerRawRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  pic: string | null;
  qtyBom: number | bigint | Prisma.Decimal;
  qtyDeviasi: number | bigint | Prisma.Decimal;
  qtyWaste: number | bigint | Prisma.Decimal;
  qtySusut: number | bigint | Prisma.Decimal;
  qtyTrial: number | bigint | Prisma.Decimal;
  qtyLossSurplus: number | bigint | Prisma.Decimal;
  nominalDeviasi: number | bigint | Prisma.Decimal;
  absNominalDeviasi: number | bigint | Prisma.Decimal;
  devBom: number | bigint | Prisma.Decimal | null;
  direction: string;
  isTarget: boolean | string | null;
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------

/** Coerce a possibly BigInt/Decimal numeric to a JS number. */
function num(v: number | bigint | Prisma.Decimal | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

/** Coerce a nullable numeric to `number | null`. */
function numOrNull(v: number | bigint | Prisma.Decimal | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

/** Coerce a boolean-ish SQL value to a real JS boolean. */
function bool(v: boolean | string | null | undefined): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  return v === 'true' || v === 't' || v === 'TRUE' || v === '1';
}

// ------------------------------------------------------------
//  Main query
// ------------------------------------------------------------

export async function queryItemPeerComparison(
  opts: ItemPeerComparisonOpts,
): Promise<ItemPeerComparisonResult> {
  const { item, month, week, outletCode, filters } = opts;

  // buildSqlFilters with `itemName: null` — we apply an EXACT match
  // (`i.name = ${item}`) in the WHERE clause below, NOT buildSqlFilters'
  // LIKE (which would over-match "CABAI" → "CABAI FROZEN" + "CABAI MERAH").
  // Same pattern as item-trend.ts queryItemTrendTimeline.
  // outletCode is NOT passed as a filter — it's the TARGET, handled by the
  // `target` CTE below. Passing it here would scope the universe to one
  // outlet and produce zero peers.
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  // Conditional SQL fragments for the `target` CTE.
  // - When outletCode is provided: filter to that outlet, order doesn't
  //   matter (only one row expected).
  // - When omitted: order by ABS(nominalDeviasi) DESC so LIMIT 1 picks
  //   the worst (most interesting) outlet for this item.
  const targetWhere = outletCode
    ? Prisma.sql`WHERE "outletCode" = ${outletCode}`
    : Prisma.sql``;
  const targetOrder = outletCode
    ? Prisma.raw('"outletCode"')
    : Prisma.raw('ABS("nominalDeviasi") DESC');

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<ItemPeerRawRow[]>`
    WITH
    -- ----------------------------------------------------------
    --  item_full: per-(item, outlet) aggregates for ONE item in
    --  ONE period, scoped by user filters. Follows the SAME pattern
    --  as buildDeviasiRankBaseCte's first CTE (same joins, WHERE,
    --  GROUP BY) but adds the fields needed by ItemPeerRow:
    --  area, qtySusut, qtyTrial, absNominalDeviasi, ABS(qtyBom),
    --  and nominalLossSurplus (consumed by DIRECTION_FROM_SUM_SQL).
    -- ----------------------------------------------------------
    item_full AS (
      SELECT
        i.name as "itemName",
        o.code as "outletCode",
        o.name as "outletName",
        MAX(ir.area) as "area",
        pic.pic,
        SUM(ABS(ir."qtyBom")) as "qtyBom",
        SUM(ir."qtyDeviasi") as "qtyDeviasi",
        SUM(ABS(ir."qtyDeviasi")) as "absQtyDeviasi",
        SUM(ir."qtyWaste") as "qtyWaste",
        SUM(ir."qtySusut") as "qtySusut",
        SUM(ir."qtyTrial") as "qtyTrial",
        SUM(ir."qtyLossSurplus") as "qtyLossSurplus",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        SUM(ir."absNominalDeviasi") as "absNominalDeviasi",
        -- direction: shared CASE fragment (uses SUM(nominalLossSurplus)
        -- with qtyDeviasi NULL fallback — see ../shared.ts).
        ${DIRECTION_FROM_SUM_SQL} as "direction"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL
        AND ir."absNominalDeviasi" > 0
        AND i.name = ${item}
        ${f}
      GROUP BY i.name, o.code, o.name, pic.pic
    ),
    -- ----------------------------------------------------------
    --  combined: derived columns (devBom ratio). Direction is
    --  already computed in item_full; just propagate it.
    -- ----------------------------------------------------------
    combined AS (
      SELECT
        iff."outletCode",
        iff."outletName",
        iff."area",
        iff.pic,
        iff."qtyBom",
        iff."qtyDeviasi",
        iff."qtyWaste",
        iff."qtySusut",
        iff."qtyTrial",
        iff."qtyLossSurplus",
        iff."nominalDeviasi",
        iff."absNominalDeviasi",
        -- FIX (CALC-01): devBom = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom)) —
        -- volume-weighted MAGNITUDE ratio (per PRD §5.6). Was using SIGNED
        -- qtyDeviasi (SUM(qtyDeviasi)) which caused peerAvg.devBom to cancel
        -- out when peers had mixed LOSS/SURPLUS, breaking the EfficiencyScore
        -- threshold. Now uses absQtyDeviasi (magnitude) for the ratio.
        -- qtyDeviasi (signed) is still available for direction display.
        -- Null when BOM = 0 (bucket concept doesn't apply).
        CASE WHEN iff."qtyBom" > 0
          THEN iff."absQtyDeviasi" / iff."qtyBom"
          ELSE NULL END as "devBom",
        iff."direction"
      FROM item_full iff
    ),
    -- ----------------------------------------------------------
    --  target: single outlet = the focus of comparison.
    --  - If outletCode provided: filter to it.
    --  - If omitted: ORDER BY ABS(nominalDeviasi) DESC LIMIT 1
    --    picks the worst (most interesting) outlet.
    --  LIMIT 1 ensures at most one row.
    -- ----------------------------------------------------------
    target AS (
      SELECT * FROM combined
      ${targetWhere}
      ORDER BY ${targetOrder}
      LIMIT 1
    )
    -- ----------------------------------------------------------
    --  Final SELECT: target row (isTarget=true) + peer rows
    --  (isTarget=false). Peers are OTHER outlets whose ABS(qtyBom)
    --  falls within ±50% of target's ABS(qtyBom) — same bucket
    --  logic as bucket_avg CTE in by-deviasi-rank.ts.
    --
    --  CROSS JOIN target (max 1 row via LIMIT 1) — when target is
    --  empty (item not found / outletCode mismatched), CROSS JOIN
    --  produces 0 rows → caller returns target=null, peers=[].
    -- ----------------------------------------------------------
    SELECT
      c."outletCode",
      c."outletName",
      c."area",
      c.pic,
      c."qtyBom",
      c."qtyDeviasi",
      c."qtyWaste",
      c."qtySusut",
      c."qtyTrial",
      c."qtyLossSurplus",
      c."nominalDeviasi",
      c."absNominalDeviasi",
      c."devBom",
      c."direction",
      (c."outletCode" = t."outletCode") as "isTarget"
    FROM combined c
    CROSS JOIN target t
    WHERE
      c."outletCode" = t."outletCode"
      OR (
        c."outletCode" != t."outletCode"
        AND ABS(c."qtyBom") > 0
        AND ABS(t."qtyBom") > 0
        AND ABS(c."qtyBom") BETWEEN ABS(t."qtyBom") * 0.5
                                AND ABS(t."qtyBom") * 1.5
      )
    ORDER BY
      CASE WHEN c."outletCode" = t."outletCode" THEN 0 ELSE 1 END,
      ABS(c."nominalDeviasi") DESC
  `);

  // -- Post-processing: split target / peers, compute averages --

  const mapped: ItemPeerRow[] = rows.map((r) => ({
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area ?? '',
    pic: r.pic ?? null,
    qtyBom: num(r.qtyBom),
    qtyDeviasi: num(r.qtyDeviasi),
    qtyWaste: num(r.qtyWaste),
    qtySusut: num(r.qtySusut),
    qtyTrial: num(r.qtyTrial),
    qtyLossSurplus: num(r.qtyLossSurplus),
    nominalDeviasi: num(r.nominalDeviasi),
    absNominalDeviasi: num(r.absNominalDeviasi),
    devBom: numOrNull(r.devBom),
    direction: r.direction,
    isTarget: bool(r.isTarget),
  }));

  // First row is the target (ORDER BY guarantees target first).
  // Empty array → item not found → target=null, peers=[].
  const targetRow = mapped.find((r) => r.isTarget) ?? null;

  // FIX (BUG-2-01 + BUG-2-02): INCLUDE target in peers[] so the frontend
  // can rank the target among peers + render the target dot in the scatter
  // plot. This aligns with the outlet-level /api/peer-comparison API pattern
  // (which includes target in peers). peerAverages is still computed from
  // NON-target peers only (excludes target) so the benchmark isn't skewed.
  const peerRows = mapped; // includes target (isTarget=true)

  const peerAverages = computePeerAverages(mapped.filter((r) => !r.isTarget));

  return {
    target: targetRow,
    peers: peerRows,
    peerAverages,
    autoSelected: !outletCode,
  };
}

// ------------------------------------------------------------
//  Peer averages — computed in JS from the peer rows.
//  Single SQL with CTEs returns all rows; aggregates are
//  trivial sums/avgs computed once on the bounded peer set
//  (typically 5-30 rows — no perf concern).
// ------------------------------------------------------------

function computePeerAverages(peers: ItemPeerRow[]): ItemPeerAverages {
  const n = peers.length;
  if (n === 0) {
    return {
      qtyBom: 0,
      absQtyDeviasi: 0,
      absNominalDeviasi: 0,
      devBom: 0,
      qtyWaste: 0,
      qtySusut: 0,
      qtyTrial: 0,
      qtyLossSurplus: 0,
      lossOutlets: 0,
      surplusOutlets: 0,
    };
  }

  const sum = peers.reduce(
    (acc, p) => {
      acc.qtyBom += p.qtyBom;
      acc.absQtyDeviasi += Math.abs(p.qtyDeviasi);
      acc.absNominalDeviasi += p.absNominalDeviasi;
      if (p.devBom !== null) {
        acc.devBomSum += p.devBom;
        acc.devBomCount += 1;
      }
      acc.qtyWaste += p.qtyWaste;
      acc.qtySusut += p.qtySusut;
      acc.qtyTrial += p.qtyTrial;
      acc.qtyLossSurplus += p.qtyLossSurplus;
      if (p.direction === 'LOSS') acc.lossOutlets += 1;
      if (p.direction === 'SURPLUS') acc.surplusOutlets += 1;
      return acc;
    },
    {
      qtyBom: 0,
      absQtyDeviasi: 0,
      absNominalDeviasi: 0,
      devBomSum: 0,
      devBomCount: 0,
      qtyWaste: 0,
      qtySusut: 0,
      qtyTrial: 0,
      qtyLossSurplus: 0,
      lossOutlets: 0,
      surplusOutlets: 0,
    },
  );

  return {
    qtyBom: sum.qtyBom / n,
    absQtyDeviasi: sum.absQtyDeviasi / n,
    absNominalDeviasi: sum.absNominalDeviasi / n,
    // Average of non-null devBom values (peers with BOM=0 contribute NULL).
    devBom: sum.devBomCount > 0 ? sum.devBomSum / sum.devBomCount : 0,
    qtyWaste: sum.qtyWaste / n,
    qtySusut: sum.qtySusut / n,
    qtyTrial: sum.qtyTrial / n,
    qtyLossSurplus: sum.qtyLossSurplus / n,
    lossOutlets: sum.lossOutlets,
    surplusOutlets: sum.surplusOutlets,
  };
}
