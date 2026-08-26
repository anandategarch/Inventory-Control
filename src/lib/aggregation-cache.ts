// ============================================================
//  Aggregation Cache — DB-level caching for expensive queries.
//  Uses the AggregationCache table (Prisma model) to persist
//  computed results across serverless cold starts.
//
//  FIX Medium #1 (from MASTER_CONTEXT.md): analysis route takes
//  6-8s. In-memory cache (LRUCache) is unreliable in serverless
//  (each cold start = fresh memory). DB cache survives cold starts
//  and is shared across all serverless instances.
//
//  TTL: 5 minutes (300s) by default. Configurable per cache key.
//  Cache invalidation: explicit via invalidateCache() on data
//  mutations (ingest, settings change, direction migration).
//
//  FIX M3 (AUDIT-5): in-flight Promise dedup — if two concurrent
//  requests miss the cache for the same key, only one computes;
//  the second awaits the first's result.
// ============================================================
import { db } from './db';
import { logger } from './logger';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// FIX M3: in-flight Promise map — prevents cache stampede.
// When a request misses the cache and starts computing, we store
// the Promise here. Subsequent requests for the same key await
// the same Promise instead of computing in parallel.
const inflightPromises = new Map<string, Promise<unknown>>();

/**
 * Build a cache key from the filter parameters.
 * Format: "analysis|2026-08|WEEK 1|WEEK 1|||Juli 2026|JAWA TIMUR 1|MLG|1016.MLGJAK|MINYAK MIE|Andi"
 *
 * FIX (BUG-KELOMPOK-CACHE): kelompok was missing from the cache key → requests
 * with different kelompok filters shared the same cache entry → cache poisoning
 * (e.g., user A selects kelompok="MLG" then user B with no filter gets A's
 * filtered result, or vice-versa). Adding kelompok to the key fixes this.
 */
export function buildCacheKey(parts: {
  route: string;
  month?: string | null;
  week?: string | null;
  compareWeek?: string | null;
  compareMonth?: string | null;
  area?: string | null;
  kelompok?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  pic?: string | null;
}): string {
  const filter = [
    parts.month || 'ALL',
    parts.week || 'ALL',
    parts.compareWeek || 'NONE',
    parts.compareMonth || 'NONE',
    parts.area && parts.area !== 'all' ? parts.area : 'ALL',
    // FIX (BUG-BE-5 / BUG-PERF-7): normalize 'all' → 'ALL' so that `?kelompok=all`
    // and no kelompok param produce the SAME cache key. Without this, they'd
    // create 2 separate cache entries for the same logical request → cache miss.
    // Also normalize to uppercase for case-insensitive consistency with the
    // SQL filter (which uses UPPER()).
    parts.kelompok && parts.kelompok !== 'all' ? parts.kelompok.toUpperCase() : 'ALL',
    parts.outletCode && parts.outletCode !== 'all' ? parts.outletCode : 'ALL',
    parts.itemName || 'ALL',
    parts.pic || 'ALL',
  ].join('|');
  return `${parts.route}|${filter}`;
}

/**
 * Try to read a cached result from the DB.
 * Returns parsed JSON if cache hit (and not expired), null otherwise.
 */
export async function getCached<T>(cacheKey: string, ttlMs: number = DEFAULT_TTL_MS): Promise<T | null> {
  try {
    const row = await db.aggregationCache.findUnique({ where: { cacheKey } });
    if (!row) return null;
    const ageMs = Date.now() - row.computedAt.getTime();
    if (ageMs > ttlMs) {
      // Expired — delete stale entry (fire-and-forget)
      db.aggregationCache.delete({ where: { cacheKey } }).catch((e) => {
        logger.error('[cache] expired entry delete failed', { error: e instanceof Error ? e.message : String(e) });
      });
      return null;
    }
    return JSON.parse(row.payload) as T;
  } catch (e) {
    // Non-blocking: if cache read fails (DB error, JSON parse error),
    // just return null and let the caller compute fresh.
    logger.error('[cache] getCached error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Store a computed result in the DB cache.
 * Fire-and-forget — doesn't block the response.
 */
export function setCached(cacheKey: string, payload: unknown): void {
  try {
    const json = JSON.stringify(payload);
    // upsert: insert or update if exists (cacheKey is unique)
    db.aggregationCache.upsert({
      where: { cacheKey },
      create: { cacheKey, payload: json, computedAt: new Date() },
      update: { payload: json, computedAt: new Date() },
    }).catch((e) => {
      // Non-blocking: if cache write fails, just log
      logger.error('[cache] setCached error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
    });
  } catch (e) {
    // Synchronous error (JSON.stringify failed) — non-blocking
    logger.error('[cache] setCached sync error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
  }
}

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
  promise.finally(() => {
    inflightPromises.delete(cacheKey);
  }).catch(() => {
    // Swallow — the original caller handles the error
  });
  return promise;
}

/**
 * Invalidate cache entries matching a pattern.
 * Use after data mutations (ingest, settings change, direction migration).
 * Pass a prefix to invalidate all entries for a route (e.g. "analysis|").
 */
export async function invalidateCache(prefix?: string): Promise<void> {
  try {
    if (prefix) {
      // Delete all entries where cacheKey starts with prefix
      const result = await db.aggregationCache.deleteMany({
        where: { cacheKey: { startsWith: prefix } },
      });
      logger.info(`[cache] invalidated ${result.count} entries with prefix "${prefix}"`);
    } else {
      // Delete all entries
      const result = await db.aggregationCache.deleteMany({});
      logger.info(`[cache] invalidated ${result.count} entries (all)`);
    }
  } catch (e) {
    logger.error('[cache] invalidateCache error', { error: e instanceof Error ? e.message : String(e) });
  }
}
