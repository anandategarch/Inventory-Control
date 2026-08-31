// ============================================================
//  Top Items — Shared CTE builder for deviasi-rank queries
//  --------------------------------------------------------
//  queryTopItemsByDeviasiRank (national top-N) and
//  queryTopItemsByDeviasiRankForOutlet (per-outlet top-N) share
//  ~90% of their CTE structure:
//    - The per-(item,outlet) aggregate CTE (12 SUM/CASE columns)
//    - The national-rank CTE (ROW_NUMBER() OVER ABS(nominalDeviasi)
//      DESC + qtyBom-rank CASE)
//
//  The two paths diverge ONLY in the top-N filter CTE that follows:
//    - National:  top_items AS (SELECT * FROM ranked WHERE rankNominal <= N)
//    - Per-outlet: outlet_top AS (SELECT *, ROW_NUMBER() OVER (PARTITION
//      BY outletCode ...) as outletRank FROM ranked_all WHERE outletCode = X
//      WHERE outletRank <= N)
//
//  This module extracts the shared base CTEs into a single builder
//  to avoid drift between the two query paths. Behaviorally identical
//  to the inlined CTEs in the original top-items.ts (Task 1-d split):
//  the ${f} filter fragment is always interpolated; when `filters`
//  is null, an empty Prisma.sql fragment is used (renders to nothing —
//  PostgreSQL treats the empty interpolation as whitespace).
//
//  INTERNAL — not re-exported from the top-items/index.ts barrel.
//  Only ./by-deviasi-rank.ts imports this module.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, type SqlFilterOpts } from '../../shared';

export interface DeviasiRankBaseCteOpts {
  /** Month label (e.g. "MEI 2026"). */
  month: string;
  /** Week label (e.g. "WEEK 1"). */
  week: string;
  /**
   * When provided, the first CTE applies these filters (national top-N
   * query restricts to area/kelompok/outlet/PIC). When null, ALL outlets
   * are included (per-outlet query needs the full network for national
   * ranking + peer benchmark).
   */
  filters: SqlFilterOpts | null;
  /** Identifier for the per-(item,outlet) aggregate CTE. */
  firstCteName: 'item_per_outlet' | 'all_item_per_outlet';
  /** Identifier for the ranked CTE that reads from firstCteName. */
  rankedCteName: 'ranked' | 'ranked_all';
}

/**
 * Builds the two shared base CTEs for the deviasi-rank queries:
 *
 *   <firstCteName> AS (
 *     -- per-(item,outlet) aggregates: qtyDeviasi, qtyWaste,
 *     -- qtyLossSurplus, pctLossSurplusToBom, qtyBom, nominalDeviasi,
 *     -- absQtyDeviasi (12 SUM/CASE columns, grouped by item+outlet+pic)
 *   ),
 *   <rankedCteName> AS (
 *     -- adds rankNominal (ROW_NUMBER OVER ABS(nominalDeviasi) DESC) +
 *     -- rankBom (ROW_NUMBER PARTITION BY qtyBom!=0 ORDER BY ABS(qtyBom) DESC)
 *   )
 *
 * Returns a Prisma.Sql fragment (WITHOUT leading `WITH`). The caller
 * wraps it: `WITH ${baseCte}, <topNCte> AS (...), bucket_avg AS (...)
 * SELECT ...`.
 *
 * The caller is responsible for:
 *   1. Defining the top-N filter CTE (DIFFERENT shape for national vs
 *      per-outlet — see by-deviasi-rank.ts).
 *   2. Defining bucket_avg (references the top-N CTE + firstCteName).
 *   3. The final SELECT + LEFT JOIN bucket_avg.
 */
export function buildDeviasiRankBaseCte(opts: DeviasiRankBaseCteOpts): Prisma.Sql {
  // Prisma.raw is safe here: firstCteName/rankedCteName come from a
  // constrained string-literal union (not user input) — they're SQL
  // identifiers we control. Mirrors the alias-handling pattern in
  // ../../shared.ts buildSqlFilters (Prisma.raw(alias)).
  const firstCteName = Prisma.raw(opts.firstCteName);
  const rankedCteName = Prisma.raw(opts.rankedCteName);
  // Empty Prisma.sql fragment renders to nothing in the assembled SQL —
  // produces byte-identical output to the original ForOutlet query which
  // had no ${f} interpolation at all.
  const f = opts.filters ? buildSqlFilters(opts.filters) : Prisma.sql``;
  return Prisma.sql`
    ${firstCteName} AS (
      SELECT
        i.name as "itemName",
        o.code as "outletCode",
        o.name as "outletName",
        pic.pic,
        MAX(ir."satuan") as "satuan",
        SUM(ir."qtyDeviasi") as "qtyDeviasi",
        SUM(ir."qtyWaste") as "qtyWaste",
        SUM(ir."qtyLossSurplus") as "qtyLossSurplus",
        -- FIX Bug 3A: use ABS(qtyLossSurplus) so percentage is always positive (signed display handled by direction)
        -- FIX CALC-11: use SUM(ABS(qtyBom)) > 0 (not SUM(qtyBom) != 0 — can be 0 with canceling +/- values)
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN ABS(SUM(ir."qtyLossSurplus")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "pctLossSurplusToBom",
        SUM(ir."qtyBom") as "qtyBom",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        -- Store ABS qtyDeviasi for dynamic bucket average
        ABS(SUM(ir."qtyDeviasi")) as "absQtyDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
      WHERE ir."monthLabel" = ${opts.month} AND ir."weekLabel" = ${opts.week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY i.name, o.code, o.name, pic.pic
    ),
    ${rankedCteName} AS (
      SELECT ipo.*,
        ROW_NUMBER() OVER (ORDER BY ABS(ipo."nominalDeviasi") DESC) as "rankNominal",
        CASE WHEN ipo."qtyBom" != 0
          THEN ROW_NUMBER() OVER (PARTITION BY CASE WHEN ipo."qtyBom" != 0 THEN 1 ELSE 0 END ORDER BY ABS(ipo."qtyBom") DESC)
          ELSE NULL END as "rankBom"
      FROM ${firstCteName} ipo
    )
  `;
}
