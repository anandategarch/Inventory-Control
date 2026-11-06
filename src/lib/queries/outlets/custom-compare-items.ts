// ============================================================
//  Custom Comparison Items — per-item breakdown of ONE focus outlet
//  vs a USER-PICKED comparator set  (CUSTOM-COMPARE — NEW)
//  --------------------------------------------------------
//  User request: "misal aku pilih resto mlgpar terus sebagai pembanding
//  nya aku pilih resto lain lagi yaitu bdgsek nah ini bisa export laporan
//  pdf. atau aku juga bisa filter beberapa resto atau filter pakai area"
//  — section 13.3 of the PDF export. The PEER section (9.2) averages the
//  ±10% similar-sales band; THIS query averages the exact outlets the
//  user picked (resto list and/or the outlet populations of chosen
//  areas — the caller expands areas to codes first).
//
//  Aggregation convention — IDENTICAL to queryPeerComparisonItems (9.2)
//  so the two tables read the same way (CC-PARITY-1, BUGHUNT-COMPARE
//  P2 — the focus side now aggregates the SAME row population as 9.2's
//  target CTE: deviation-carrying records only):
//    - FOCUS side   = sums over rows with absNominalDeviasi > 0
//      (9.2's `target_top_items` WHERE clause verbatim — zero-dev rows
//      used to dilute the % Dev/BOM denominator and surface all-zero-dev
//      items as {0,0,0} instead of the '—' blind-spot display)
//    - COMPARATOR side = sums over ALL rows (9.2's peer side — unchanged)
//    - qtyDeviasi  = SUM(ABS(qtyDeviasi))    (magnitude, per outlet-item)
//    - devBom      = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom)) per outlet
//    - nominal     = SUM(ABS(nominalDeviasi))
//    - compareAvg  = MEAN over comparator outlets of their per-outlet
//      values (two-level math, same as 9.2's peerAvg; a single
//      comparator — bdgsek — degenerates to its own numbers).
//
//  Row selection — the UNION of both sides' top items: ranked by
//  GREATEST(|focus nominal|, |comparator avg nominal|) DESC, capped at
//  topN. A comparator-only top item (a focus blind spot — 9.3's concept)
//  surfaces with target = null instead of being crowded out.
//
//  Called DIRECTLY (uncached) by the export pipeline — the
//  queryItemConsistency precedent (LEAGUE-AREA): the query is scoped to
//  a handful of outlets (JOIN sel), the route-level 5-min PDF cache +
//  rv + deploy-SHA forks already dedupe repeat exports, and no new q-*
//  namespace means no invalidation-array coupling. Outlet codes arrive
//  pre-validated (≤30 codes, control-char-free) from the Zod schema.
// ============================================================
import { Prisma } from '@prisma/client';
import { withStatementTimeout } from '../shared';

export interface CustomCompareItemRow {
  itemName: string;
  /** MAX(ir."satuan") over the item's records at the selected outlets. */
  satuan: string | null;
  /** Per-item values at the FOCUS outlet — null when it has no records of
   *  the item (the blind-spot row — the PDF prints '\u2014'). */
  target: {
    qtyDeviasi: number;
    devBom: number;
    nominal: number;
  } | null;
  /** Mean over comparator outlets' per-item values — null when NO
   *  comparator carries the item. */
  compareAvg: {
    qtyDeviasi: number;
    devBom: number;
    nominal: number;
  } | null;
  /** How many comparator outlets carry the item (0 = compareAvg null). */
  compareCount: number;
}

export async function queryCustomCompareItems(
  focusCode: string,
  compareCodes: string[],
  month: string,
  week: string,
  topN: number = 15,
): Promise<CustomCompareItemRow[]> {
  // Prisma.join requires ≥1 element — the caller only invokes this with a
  // resolved focusCode AND a non-empty comparator set (the section skips
  // itself otherwise); the guard keeps a degenerate call from rendering an
  // empty Prisma.join (a raw-SQL syntax error).
  const compareCodesClean = [...new Set(compareCodes.filter((c) => c !== focusCode))];
  if (compareCodesClean.length === 0) return [];
  const allCodes = [focusCode, ...compareCodesClean];

  // FIX (AUDIT8-ROLLBACK-1 convention): wrap in withStatementTimeout — a
  // GROUP BY over the period's records, even scoped by the small outlet
  // JOIN, can hit a slow plan on the ~280K-row period.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
    itemName: string;
    satuan: string | null;
    targetQty: number | bigint | null;
    targetDevBom: number | bigint | null;
    targetNominal: number | bigint | null;
    compareQty: number | bigint | null;
    compareDevBom: number | bigint | null;
    compareNominal: number | bigint | null;
    compareCount: number | bigint;
  }[]>`
    WITH sel AS (
      SELECT o.id as "outletId",
        CASE WHEN o.code = ${focusCode} THEN true ELSE false END as "isFocus"
      FROM "Outlet" o
      WHERE o.code IN (${Prisma.join(allCodes)})
    ),
    outlet_item AS (
      -- per-(outlet, item) values over the selected outlets only — the
      -- ABS aggregation convention of queryPeerComparisonItems (9.2).
      -- CC-PARITY-1: the *Dev columns carry the FOCUS-side population
      -- (absNominalDeviasi > 0 rows only — 9.2's target CTE verbatim);
      -- the un-suffixed columns keep 9.2's peer/ALL-rows population for
      -- the comparator side. SUM(...) FILTER over zero matching rows is
      -- NULL (not 0), so a focus item with only zero-dev records maps
      -- to target = null (the '—' blind-spot display) exactly like 9.2's
      -- exclusion semantics.
      SELECT
        ir."outletId",
        ir."itemId",
        MAX(ir."satuan") as "satuan",
        SUM(ABS(ir."qtyDeviasi")) as "qtyDeviasi",
        SUM(ABS(ir."qtyBom")) as "qtyBom",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "devBom",
        SUM(ABS(ir."nominalDeviasi")) as "nominal",
        SUM(ABS(ir."qtyDeviasi")) FILTER (WHERE ir."absNominalDeviasi" > 0) as "qtyDeviasiDev",
        SUM(ABS(ir."qtyBom")) FILTER (WHERE ir."absNominalDeviasi" > 0) as "qtyBomDev",
        CASE WHEN COALESCE(SUM(ABS(ir."qtyBom")) FILTER (WHERE ir."absNominalDeviasi" > 0), 0) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) FILTER (WHERE ir."absNominalDeviasi" > 0)
              / SUM(ABS(ir."qtyBom")) FILTER (WHERE ir."absNominalDeviasi" > 0)
            ELSE 0 END as "devBomDev",
        SUM(ABS(ir."nominalDeviasi")) FILTER (WHERE ir."absNominalDeviasi" > 0) as "nominalDev"
      FROM "InventoryRecord" ir
      JOIN sel s ON ir."outletId" = s."outletId"
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
      GROUP BY ir."outletId", ir."itemId"
    ),
    ranked AS (
      -- top-N items on EITHER side: rank by the bigger of the focus's
      -- and the comparator average's |nominal| (a comparator-only top
      -- item — a focus blind spot — must not be crowded out).
      SELECT
        oi."itemId",
        ROW_NUMBER() OVER (
          ORDER BY GREATEST(
            COALESCE(MAX(CASE WHEN s."isFocus" THEN oi."nominal" END), 0),
            COALESCE(AVG(CASE WHEN NOT s."isFocus" THEN oi."nominal" END), 0)
          ) DESC, MIN(i.name)
        ) as rn
      FROM outlet_item oi
      JOIN sel s ON oi."outletId" = s."outletId"
      JOIN "Item" i ON oi."itemId" = i.id
      GROUP BY oi."itemId"
    )
    SELECT
      i.name as "itemName",
      MAX(oi."satuan") as "satuan",
      -- focus side (null when the focus outlet has no records of the item;
      -- CC-PARITY-1: the *Dev population = 9.2's target CTE, so an item
      -- with only zero-dev focus records also maps to null → the '—'
      -- blind-spot display, 9.2's exclusion semantics)
      MAX(CASE WHEN s."isFocus" THEN oi."qtyDeviasiDev" END) as "targetQty",
      MAX(CASE WHEN s."isFocus" THEN oi."devBomDev" END) as "targetDevBom",
      MAX(CASE WHEN s."isFocus" THEN oi."nominalDev" END) as "targetNominal",
      -- comparator side: mean of the per-outlet values (9.2's peerAvg)
      AVG(CASE WHEN NOT s."isFocus" THEN oi."qtyDeviasi" END) as "compareQty",
      AVG(CASE WHEN NOT s."isFocus" THEN oi."devBom" END) as "compareDevBom",
      AVG(CASE WHEN NOT s."isFocus" THEN oi."nominal" END) as "compareNominal",
      COUNT(DISTINCT CASE WHEN NOT s."isFocus" THEN oi."outletId" END) as "compareCount"
    FROM outlet_item oi
    JOIN sel s ON oi."outletId" = s."outletId"
    JOIN "Item" i ON oi."itemId" = i.id
    JOIN ranked r ON oi."itemId" = r."itemId"
    WHERE r.rn <= ${topN}
    GROUP BY oi."itemId", i.name
    ORDER BY GREATEST(
      COALESCE(MAX(CASE WHEN s."isFocus" THEN oi."nominal" END), 0),
      COALESCE(AVG(CASE WHEN NOT s."isFocus" THEN oi."nominal" END), 0)
    ) DESC, i.name
  `);

  const num = (v: number | bigint | null): number | null =>
    v == null ? null : Number(v) || 0;

  return rows.map((r) => {
    const compareCount = Number(r.compareCount) || 0;
    const tQty = num(r.targetQty);
    const tNominal = num(r.targetNominal);
    const cQty = num(r.compareQty);
    const cNominal = num(r.compareNominal);
    return {
      itemName: r.itemName,
      satuan: r.satuan ?? null,
      target: tQty == null && tNominal == null
        ? null
        : {
            qtyDeviasi: tQty ?? 0,
            devBom: num(r.targetDevBom) ?? 0,
            nominal: tNominal ?? 0,
          },
      compareAvg: compareCount > 0 && (cQty != null || cNominal != null)
        ? {
            qtyDeviasi: cQty ?? 0,
            devBom: num(r.compareDevBom) ?? 0,
            nominal: cNominal ?? 0,
          }
        : null,
      compareCount,
    };
  });
}
