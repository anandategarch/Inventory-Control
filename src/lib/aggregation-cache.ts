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
// ============================================================
import { db } from './db';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build a cache key from the filter parameters.
 * Format: "analysis|2026-08|WEEK 1|WEEK 1|||Juli 2026|JAWA TIMUR 1|1016.MLGJAK|MINYAK MIE|Andi"
 */
export function buildCacheKey(parts: {
  route: string;
  month?: string | null;
  week?: string | null;
  compareWeek?: string | null;
  compareMonth?: string | null;
  area?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  pic?: string | null;
}): string {
  const filter = [
    parts.month || 'ALL',
    parts.week || 'ALL',
    parts.compareWeek || 'NONE',
    parts.compareMonth || 'NONE',
    parts.area || 'ALL',
    parts.outletCode || 'ALL',
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
      db.aggregationCache.delete({ where: { cacheKey } }).catch(() => {});
      return null;
    }
    return JSON.parse(row.payload) as T;
  } catch (e) {
    // Non-blocking: if cache read fails (DB error, JSON parse error),
    // just return null and let the caller compute fresh.
    console.error('[cache] getCached error (non-blocking):', e instanceof Error ? e.message : String(e));
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
      console.error('[cache] setCached error (non-blocking):', e instanceof Error ? e.message : String(e));
    });
  } catch (e) {
    // Synchronous error (JSON.stringify failed) — non-blocking
    console.error('[cache] setCached sync error (non-blocking):', e instanceof Error ? e.message : String(e));
  }
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
      await db.aggregationCache.deleteMany({
        where: { cacheKey: { startsWith: prefix } },
      });
    } else {
      // Delete all entries
      await db.aggregationCache.deleteMany({});
    }
  } catch (e) {
    console.error('[cache] invalidateCache error:', e instanceof Error ? e.message : String(e));
  }
}
