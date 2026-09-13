// ============================================================
//  Peer BOM Bucket Predicate — shared ±50% "same bucket" SQL fragment
//  --------------------------------------------------------
//  AUDIT A1 / MERGE-1-a: the ±50% qtyBom peer-bucket predicate was
//  implemented 2× (3 call sites) with identical SQL semantics:
//    1. ./item-peer-comparison.ts — final SELECT WHERE (peer outlets
//       for ONE item; aliases: t = target, c = candidate).
//    2. ./top-items/by-deviasi-rank.ts — bucket_avg CTE ×2 (national
//       + per-outlet avgDeviasiByBom; aliases: ti = target,
//       ipo2 = candidate).
//  This module is now the SINGLE source of that predicate,
//  replacing the duplication flagged by audit item A1.
//
//  Bucket definition (verbatim from both former call sites):
//    ABS(candidate."qtyBom") BETWEEN ABS(target."qtyBom") * 0.5
//                               AND ABS(target."qtyBom") * 1.5
//  i.e. a candidate outlet belongs to the target's peer bucket for
//  an item when its per-(item, outlet) SUM(ABS(qtyBom)) magnitude
//  is within [50%, 150%] of the target's — comparing outlets that
//  carry the same item at a similar BOM volume keeps the peer
//  average / peer benchmark meaningful.
//
//  NOTE on guards: call sites own their own
//  `ABS(target.qtyBom) > 0` + `ABS(candidate.qtyBom) > 0` guards
//  (FIX CALC-7 — skip BOM=0 rows, where the bucket concept doesn't
//  apply). They differ in placement between the two consumers
//  (WHERE conjunction vs JOIN ON clause) and are intentionally NOT
//  part of this fragment — only the BETWEEN predicate is shared.
//  Do NOT drop those guards when adding a new call site.
//
//  Style precedent: H-12 (./item-outlet-breakdown.ts — shared SQL
//  fragment module). Aliases are interpolated via Prisma.raw: they
//  are static SQL identifiers controlled by the call sites (never
//  user input) — the same convention as ./top-items/shared-cte.ts
//  (Prisma.raw(opts.firstCteName)).
// ============================================================
import { Prisma } from '@prisma/client';

/** Lower bound multiplier of the peer bucket: target ABS(qtyBom) × 0.5 (the "±50%" half-width). */
export const PEER_BOM_BUCKET_PCT = 0.5;
/**
 * Upper bound multiplier of the peer bucket: target ABS(qtyBom) × 1.5.
 * (NOT `1 / PEER_BOM_BUCKET_PCT` = 2 — the historical bucket is the
 * asymmetric [0.5×, 1.5×] range, kept verbatim by MERGE-1-a.)
 */
export const PEER_BOM_BUCKET_UPPER = 1.5;

/**
 * Build the ±50% BOM peer-bucket predicate:
 *
 *   ABS(<candidateAlias>."qtyBom")
 *     BETWEEN ABS(<targetAlias>."qtyBom") * 0.5
 *         AND ABS(<targetAlias>."qtyBom") * 1.5
 *
 * Character-identical (modulo whitespace) to the predicate that used to be
 * inlined in item-peer-comparison.ts (final SELECT) and by-deviasi-rank.ts
 * (bucket_avg CTE ×2).
 *
 * @param targetAlias   SQL alias of the row the bucket is centered on
 *                      (e.g. 't' in item-peer-comparison, 'ti' in bucket_avg).
 * @param candidateAlias SQL alias of the row being tested for membership
 *                      (e.g. 'c' in item-peer-comparison, 'ipo2' in bucket_avg).
 * @returns Prisma.Sql fragment (no leading AND — the call site adds its own
 *          conjunction). Call sites keep their separate
 *          `ABS(...qtyBom) > 0` guards (see module header, FIX CALC-7).
 */
export function peerBomBucketPredicate(targetAlias: string, candidateAlias: string): Prisma.Sql {
  // Prisma.raw is safe: aliases are static SQL identifiers controlled by the
  // call sites ('t'/'c', 'ti'/'ipo2') — never user input. Same convention as
  // top-items/shared-cte.ts (Prisma.raw(opts.firstCteName)).
  const target = Prisma.raw(targetAlias);
  const candidate = Prisma.raw(candidateAlias);
  // Bounds are embedded as SQL LITERALS (Prisma.raw), not bind parameters:
  // interpolating a raw JS number into Prisma.sql would render `* $1` instead
  // of `* 0.5` — same value, but different SQL text than the pre-refactor
  // query. This keeps the rendered SQL character-identical to the old
  // inline predicate (and ties the constants to the SQL so they cannot drift).
  const lowerBound = Prisma.raw(String(PEER_BOM_BUCKET_PCT));
  const upperBound = Prisma.raw(String(PEER_BOM_BUCKET_UPPER));
  return Prisma.sql`ABS(${candidate}."qtyBom") BETWEEN ABS(${target}."qtyBom") * ${lowerBound} AND ABS(${target}."qtyBom") * ${upperBound}`;
}
