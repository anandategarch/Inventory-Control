// ============================================================
//  inflight — in-flight Promise dedup map (FIX M3)
//  --------------------------------------------------------
//  Extracted from the former src/lib/aggregation-cache.ts monolith
//  (REFACTOR-1-a pure-move split). Owns the module-level map of
//  in-flight computations keyed by cacheKey. Prevents cache stampede:
//  if two concurrent requests miss the cache for the same key, only
//  one computes; the second awaits the first's result.
// ============================================================

// FIX M3: in-flight Promise map — prevents cache stampede.
// When a request misses the cache and starts computing, we store
// the Promise here. Subsequent requests for the same key await the
// same Promise instead of computing in parallel.
const inflightPromises = new Map<string, Promise<unknown>>();

/**
 * FIX M3: Get or create an in-flight Promise for a cache key.
 * If a computation for this key is already running, return its Promise
 * (preventing cache stampede — multiple concurrent requests share one computation).
 * If not, return null (caller should compute, then call setCached + clearInflight).
 */
export function getInflight<T>(cacheKey: string): Promise<T> | null {
  return (inflightPromises.get(cacheKey) as Promise<T> | undefined) ?? null;
}

/**
 * FIX M3: Register an in-flight Promise for a cache key.
 * The Promise is automatically removed from the map when it settles
 * (resolve or reject), so subsequent requests will check the DB cache
 * (which should now be populated by setCached).
 */
export function setInflight<T>(cacheKey: string, promise: Promise<T>): Promise<T> {
  inflightPromises.set(cacheKey, promise);
  // Auto-cleanup when the promise settles
  // FIX (BUG-2-b): delete ONLY if this promise is still the registered one —
  // the in-flight re-enter path (generation mismatch after awaiting a stale
  // compute) can register a NEWER promise for the same key while the older
  // one is still settling; an unconditional delete here would drop the new
  // registration and re-open the stampede window this map exists to close.
  promise.finally(() => {
    if (inflightPromises.get(cacheKey) === promise) {
      inflightPromises.delete(cacheKey);
    }
  }).catch(() => {
    // Swallow — the original caller handles the error
  });
  return promise;
}
