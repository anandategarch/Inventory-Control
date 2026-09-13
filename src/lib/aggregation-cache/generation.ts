// ============================================================
//  generation — cache generation counter (FIX BUG-2-b)
//  --------------------------------------------------------
//  Extracted from the former src/lib/aggregation-cache.ts monolith
//  (REFACTOR-1-a pure-move split). Owns the module-level generation
//  state read by ./swr.ts (withCacheAndDedup's generation guard) and
//  bumped by ./invalidate.ts (every invalidation path).
// ============================================================

// FIX (BUG-2-b): generation counter — bumped by EVERY invalidation path
// (invalidateCache / invalidateAnalysisCache in ./invalidate.ts). A computation
// captures it BEFORE it starts; if the counter has advanced by the time it
// finishes, the result is (at least partly) PRE-mutation data and must NOT
// be written back — otherwise the invalidation is silently undone (stale
// data re-cached under a fresh computedAt, served for another full TTL —
// BUG-1-c #2, the "data lama setelah upload" symptom). In-flight awaiters
// use the same check to refuse results computed before an invalidation
// they should have seen.
let cacheGeneration = 0;

/**
 * FIX (BUG-2-b): read the current cache generation. Used by callers that
 * write cache rows OUTSIDE withCacheAndDedup (background-recompute guards
 * its setCachedRaw write-back with this) to detect invalidations that
 * landed while they were computing.
 */
export function getCacheGeneration(): number {
  return cacheGeneration;
}

/**
 * FIX (BUG-2-b): advance the generation counter. INTERNAL — called ONLY by
 * the invalidation paths in ./invalidate.ts (invalidateCache +
 * invalidateAnalysisCache; each per-route call bumps again — the counter
 * is monotonic and must never go back). Synchronous, no DB touch, so the
 * bump lands BEFORE the awaited deleteMany batch.
 */
export function bumpCacheGeneration(): void {
  cacheGeneration++;
}
