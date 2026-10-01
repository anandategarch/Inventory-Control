// ============================================================
//  Peer Band Predicate — shared ±10% sales-band SQL fragment
//  --------------------------------------------------------
//  GODSPLIT-W4: single source untuk predikat band sales ±10% —
//  sebelumnya 5 situs × 3 varian teks; prasyarat fitur PEER-AREA
//  (scoping peer by area/pulau). Semantik per-situs DIPERTAHANKAN
//  (fallback unbounded vs strict).
//
//  The predicate was duplicated across 5 query sites in 3 textual
//  variants (findings-GODSPLIT-C §4 cluster 2 — "highest-leverage
//  consolidation: the PEER-AREA feature requires changing all 5 in
//  lockstep"). This module is now the SINGLE source; PEER-AREA
//  (band = sales + area/pulau) will only need to touch the builder
//  + its call sites' args, never 5 hand-edited SQL strings again.
//
//  THE 3 VARIANTS (deliberately different — do NOT unify):
//    A (unboundedFallback: true) — sites with a target-with-no-sales
//      fallback CTE (target_fallback): when target sales = 0/NULL
//      the band is UNBOUNDED (999999999) so the fallback target
//      still matches all outlets with sales > 0:
//        peer-comparison.ts (final WHERE, target_combined)
//        peer-top-items.ts (peer_outlets CTE, target_combined)
//    B (plain, t.sales) — strict band: target sales = 0 → band
//      width 0 (only zero-sales outlets could match, and the
//      sibling `COALESCE(sm.sales, 0) > 0` guard excludes those):
//        peer-comparison-items.ts (peer_outlets CTE)
//    C (plain, ts."targetSales" alias) — same strict semantics as
//      B, different column aliases (per-month band CTEs):
//        peer-track-record.ts (band CTE)
//        waste/peer-zscore.ts (band CTE)
//
//  WHY Prisma.raw FOR EVERYTHING: the expressions and bounds are
//  static SQL identifiers/literals controlled by the call sites
//  (never user input) — the same convention as items/peer-bucket.ts
//  and top-items/shared-cte.ts. Interpolating plain JS strings via
//  Prisma.sql would render them as BIND PARAMETERS (`<= $1 * 0.1`),
//  changing the SQL text and the parameter order of the whole
//  statement. raw-only fragments also compose transparently:
//  Prisma merges the fragment's text chunks into the parent
//  template's strings array with ZERO added values, so the final
//  SQL is byte-for-byte identical to the former inline predicate
//  (verified: strings+values deep-equal vs the inline template in
//  tests/queries/peer-band.test.ts).
//
//  Test-safety note (GODSPLIT-W3-B finding): tests/queries/
//  waste-series.test.ts + outlet-monthly-series.test.ts assert
//  `toContain('0.1')` on the $queryRaw call via a deepText helper
//  that recursively flattens nested Prisma.Sql ({strings, values})
//  — a raw-only fragment stays fully visible to those assertions.
//
//  Style precedent: items/peer-bucket.ts (shared SQL predicate
//  builder module, MERGE-1-a / audit A1).
// ============================================================
import { Prisma } from '@prisma/client';

/**
 * Half-width of the peer sales band: target sales × 0.1 (the "±10%").
 * Embedded in the SQL as a literal (`* 0.1`), NOT a bind parameter,
 * so the rendered SQL text stays identical to the former inline
 * predicate.
 */
export const PEER_BAND_TOLERANCE = 0.1;

/**
 * Variant-A fallback bound: when target sales = 0/NULL the band is
 * effectively unbounded (`<= 999999999`) so a target-with-no-sales
 * fallback row still matches every outlet with sales > 0. Only used
 * by sites with a `target_fallback` CTE — see module header.
 */
export const PEER_BAND_UNBOUNDED_FALLBACK = 999999999;

/**
 * Build the ±10% peer sales-band predicate:
 *
 *   Variant A (opts.unboundedFallback === true):
 *     AND ABS(COALESCE(<salesExpr>, 0) - <targetExpr>) <=
 *         CASE WHEN <targetExpr> > 0
 *              THEN <targetExpr> * 0.1
 *              ELSE 999999999 END
 *   Variant B/C (default):
 *     AND ABS(COALESCE(<salesExpr>, 0) - <targetExpr>) <=
 *         <targetExpr> * 0.1
 *
 * Character-identical to the predicate that used to be inlined at
 * the 5 call sites (leading `AND ` included — call sites splice it
 * as a WHERE/CTE conjunct on its own line).
 *
 * @param salesExpr  SQL expression for the candidate outlet's sales
 *                   (e.g. 'sm.sales', 's.sales').
 * @param targetExpr SQL expression for the band's center (the
 *                   target's sales, e.g. 't.sales', 'ts."targetSales"').
 * @param opts       `{ unboundedFallback: true }` selects Variant A
 *                   (unbounded band when target sales = 0/NULL — used
 *                   where a target-with-no-sales fallback exists);
 *                   omit for the strict Variant B/C (band width 0).
 * @returns Prisma.Sql fragment with ZERO bind values — splices into
 *          the caller's tagged template without changing its SQL
 *          text or parameter order.
 */
export function peerBandPredicate(
  salesExpr: string,
  targetExpr: string,
  opts?: { unboundedFallback?: boolean },
): Prisma.Sql {
  // Prisma.raw is safe: expressions are static SQL identifiers/aliases
  // controlled by the call sites (never user input) — same convention
  // as items/peer-bucket.ts (Prisma.raw(targetAlias)).
  const sales = Prisma.raw(salesExpr);
  const target = Prisma.raw(targetExpr);
  // Bounds are embedded as SQL LITERALS (Prisma.raw), not bind
  // parameters — keeps the rendered SQL character-identical to the
  // former inline predicate (peer-bucket.ts precedent).
  const tolerance = Prisma.raw(String(PEER_BAND_TOLERANCE));
  const band = opts?.unboundedFallback
    ? Prisma.sql`CASE WHEN ${target} > 0 THEN ${target} * ${tolerance} ELSE ${Prisma.raw(String(PEER_BAND_UNBOUNDED_FALLBACK))} END`
    : Prisma.sql`${target} * ${tolerance}`;
  return Prisma.sql`AND ABS(COALESCE(${sales}, 0) - ${target}) <= ${band}`;
}
