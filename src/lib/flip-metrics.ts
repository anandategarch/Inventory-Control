// ============================================================
//  flip-metrics — THE single flip-pattern formula module (H-11 / #4c)
//  --------------------------------------------------------
//  A "flip" is a balanced reversal between same-week periods
//  (e.g. W4 Jul vs W4 Agu): the SIGNED qty deviasi changes sign
//  between the two periods. The "disparity" score
//  (|P1 + P2| / MAX(|P1|, |P2|)) quantifies how perfectly balanced
//  the reversal is:
//    - 0%  → P1 + P2 == 0 (perfect cancellation — suspicious,
//                          likely an adjustment/cutoff pattern)
//    - 100% → one side dominates the other
//
//  Before H-11 this formula lived in THREE places:
//    1. src/components/dashboard/tabs/ItemTrendTab/flipHelpers.ts
//       (client — ItemTrend tab, per-item chart/table/matrix)
//    2. src/lib/queries/items/flip-ranking.ts (server — /api/flip-ranking)
//    3. FlipRanking.tsx FlipDrillPanel (client — per-outlet drill-down)
//  The three copies were kept "identical" by comment convention only.
//  This module is now the ONE implementation; all three call sites
//  import from here. Pure functions on primitives — no React, no db,
//  safe for both client and server bundles (unit-testable).
// ============================================================

/** Flip category by disparity ratio (flip pairs only). */
export type FlipDisparityCategory = 'sempurna' | 'dominan' | 'parsial';

/** Safe sign helper — returns -1, 0, or +1. */
export function flipSign(n: number): -1 | 0 | 1 {
  if (n < 0) return -1;
  if (n > 0) return 1;
  return 0;
}

/**
 * True iff the signs of P1 and P2 differ AND both are non-zero.
 * (A zero on either side is NOT a flip — a sign change requires
 * both sides to carry a direction.)
 */
export function isFlipPair(v1: number, v2: number): boolean {
  const s1 = flipSign(v1);
  const s2 = flipSign(v2);
  return s1 !== 0 && s2 !== 0 && s1 !== s2;
}

/**
 * Disparity of a (P1, P2) pair: |P1 + P2| / MAX(|P1|, |P2|), clamped
 * to [0, 1]. 0 = perfectly balanced reversal; 1 = one side dominates.
 *
 * The clamp only matters for same-sign pairs (where |net| can exceed the
 * max magnitude); for actual flip pairs it is mathematically a no-op, so
 * server callers (which only compute disparity for flips) behave exactly
 * as before.
 */
export function flipDisparity(v1: number, v2: number): number {
  const net = v1 + v2;
  const maxMagnitude = Math.max(Math.abs(v1), Math.abs(v2));
  return maxMagnitude > 0 ? Math.min(Math.abs(net) / maxMagnitude, 1) : 0;
}

/** flipDisparity × 100 — convenience for display (0-100 range). */
export function flipDisparityPct(v1: number, v2: number): number {
  return flipDisparity(v1, v2) * 100;
}

/**
 * Categorize a flip pair by its disparity ratio (0-1):
 *   < 0.10 → 'sempurna'  (nearly perfect cancellation — suspicious)
 *   < 0.40 → 'dominan'   (one side dominant)
 *   else   → 'parsial'   (partial flip)
 */
export function categorizeFlipDisparity(disparity: number): FlipDisparityCategory {
  if (disparity < 0.10) return 'sempurna';
  if (disparity < 0.40) return 'dominan';
  return 'parsial';
}

/**
 * Aggregate item risk score: min(100, sempurnaCount × 30 + flipCount × 10).
 * (BUG2-FLIP-05 formula — was previously duplicated FE+BE.)
 */
export function flipRiskScore(sempurnaCount: number, flipCount: number): number {
  return Math.min(100, sempurnaCount * 30 + flipCount * 10);
}

/**
 * Aggregate item risk level:
 *   sempurnaCount > 0 → 'high'
 *   flipCount > 0      → 'moderate'
 *   else               → 'low'
 */
export function flipRiskLevel(
  sempurnaCount: number,
  flipCount: number,
): 'low' | 'moderate' | 'high' {
  if (sempurnaCount > 0) return 'high';
  if (flipCount > 0) return 'moderate';
  return 'low';
}
