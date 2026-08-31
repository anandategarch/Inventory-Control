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
 * Format: "analysis␟2026-08␟WEEK 1␟WEEK 1␟Juli 2026␟JAWA TIMUR 1␟MLG␟1016.MLGJAK␟MINYAK MIE␟Andi"
 *
 * FIX (BUG-KELOMPOK-CACHE): kelompok was missing from the cache key → requests
 * with different kelompok filters shared the same cache entry → cache poisoning
 * (e.g., user A selects kelompok="MLG" then user B with no filter gets A's
 * filtered result, or vice-versa). Adding kelompok to the key fixes this.
 *
 * FIX (BUG-EDGE-4): Use ASCII Unit Separator (\x1f) as delimiter instead of `|`.
 * The old `|` separator could cause key collision if any filter value contained
 * `|` (e.g., month="a|b" + week="c" → same key as month="a" + week="b|c").
 * \x1f is a control character that will never appear in user input, making
 * the key collision-proof.
 *
 * FIX (BUG-BE-5 / BUG-PERF-7): normalize 'all' → 'ALL' + uppercase kelompok
 * so that `?kelompok=all` and no kelompok param produce the SAME cache key.
 *
 * PERF-CACHE-01..04: `extra` field for route-specific params that affect the
 * response but aren't part of the standard filter set (e.g. pareto's parentDim/
 * childDim, recommendations' limit, resto-bahan-matrix's priority+limit,
 * export-report's sections, heatmap's metric+itemLimit+mode). Omitting these
 * from the key caused cache poisoning (two requests with different params
 * sharing one cache entry → wrong response served).
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
  // PERF-CACHE: route-specific params that affect the response shape/content.
  // Joined as `key=value` pairs (sorted by key for determinism) after the
  // standard filter components. Empty/undefined values are omitted.
  extra?: Record<string, string | number | null | undefined>;
}): string {
  // FIX (BUG-EDGE-4): \x1f (ASCII Unit Separator) — never appears in user input.
  const SEP = '\x1f';
  const filter = [
    parts.month || 'ALL',
    parts.week || 'ALL',
    parts.compareWeek || 'NONE',
    parts.compareMonth || 'NONE',
    parts.area && parts.area !== 'all' ? parts.area : 'ALL',
    parts.kelompok && parts.kelompok !== 'all' ? parts.kelompok.toUpperCase() : 'ALL',
    parts.outletCode && parts.outletCode !== 'all' ? parts.outletCode : 'ALL',
    parts.itemName || 'ALL',
    parts.pic || 'ALL',
  ];
  // PERF-CACHE: append route-specific extras (sorted for determinism).
  // Format: "key=value" — value is stringified; null/undefined/empty → skipped.
  if (parts.extra) {
    const extras = Object.keys(parts.extra).sort()
      .map((k) => {
        const v = parts.extra![k];
        if (v === null || v === undefined || v === '') return null;
        return `${k}=${String(v)}`;
      })
      .filter((s): s is string => s !== null);
    if (extras.length > 0) {
      filter.push(extras.join(','));
    }
  }
  return `${parts.route}${SEP}${filter.join(SEP)}`;
}

/**
 * Try to read a cached result from the DB.
 * Returns parsed JSON if cache hit (and not expired), null otherwise.
 * On expiry, the stale row is deleted (fire-and-forget) so the table
 * doesn't accumulate dead entries between cleanup cycles.
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

// ============================================================
//  PERF-CACHE-09: getCachedWithMeta — returns the cached payload
//  along with a `stale` flag, WITHOUT deleting the row on expiry.
//  Used by withCacheAndDedup to implement stale-while-revalidate
//  (SWR): an expired entry is still returned (marked stale) so the
//  caller can serve it immediately + trigger a background recompute.
//
//  Unlike getCached (which deletes expired rows), this helper keeps
//  the row so the SWR background recompute can update it in place
//  via setCached (upsert). The cleanup helper (cleanupExpiredCache)
//  handles bulk deletion of rows older than 30 min.
// ============================================================
export async function getCachedWithMeta<T>(
  cacheKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ data: T; stale: boolean } | null> {
  try {
    const row = await db.aggregationCache.findUnique({ where: { cacheKey } });
    if (!row) return null;
    const ageMs = Date.now() - row.computedAt.getTime();
    const stale = ageMs > ttlMs;
    return { data: JSON.parse(row.payload) as T, stale };
  } catch (e) {
    logger.error('[cache] getCachedWithMeta error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Store a computed result in the DB cache.
 * Fire-and-forget by default — doesn't block the response.
 * Pass `awaitWrite: true` for critical caches (export-report) where the next
 * request might arrive before the write completes.
 */
export async function setCached(cacheKey: string, payload: unknown, awaitWrite: boolean = false): Promise<void> {
  try {
    const json = JSON.stringify(payload);
    // upsert: insert or update if exists (cacheKey is unique)
    const writePromise = db.aggregationCache.upsert({
      where: { cacheKey },
      create: { cacheKey, payload: json, computedAt: new Date() },
      update: { payload: json, computedAt: new Date() },
    });
    if (awaitWrite) {
      // For critical caches — block until write completes so next request hits cache
      await writePromise.catch((e) => {
        logger.error('[cache] setCached (awaited) error', { error: e instanceof Error ? e.message : String(e) });
      });
    } else {
      // Fire-and-forget — non-blocking
      writePromise.catch((e) => {
        logger.error('[cache] setCached error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
      });
    }
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

// ============================================================
//  PERF-CACHE-06: withCacheAndDedup — combines DB cache lookup + in-flight
//  Promise dedup + compute into a single helper. Used by the 4 cached routes
//  that previously lacked in-flight dedup (pareto, recommendations,
//  resto-bahan-matrix, export-report) + the newly-cached heatmap route.
//  /api/analysis keeps its bespoke pipeline (multi-stage with 404 short-circuit)
//  — see validate-and-resolve.ts.
//
//  PERF-CACHE-09 (SWR): Stale-While-Revalidate support.
//  On an EXPIRED cache hit, the stale payload is returned immediately
//  (with `stale: true` flag) and a background recompute is triggered
//  (fire-and-forget). The in-flight Promise (registered before any await)
//  is resolved by the background recompute so concurrent requests awaiting
//  it get FRESH data (not stale). This means:
//    - Request A (first after expiry): gets stale data in <50ms.
//    - Request B (concurrent with A's recompute): awaits in-flight → gets fresh.
//    - Request C (after recompute completes): DB cache is fresh → gets fresh.
//
//  Flow:
//    1. Check in-flight Promise → return its result if exists (await → fresh)
//    2. Register new in-flight Promise (BEFORE any await — closes the race
//       window where 2 concurrent requests both see getInflight=null and
//       both proceed to compute)
//    3. Check DB cache (via getCachedWithMeta — returns fresh + stale):
//       a. Fresh hit → resolve in-flight + return { data, cached: true }
//       b. Stale hit → return { data: stale, cached: true, stale: true }
//          AND fire-and-forget background recompute that resolves in-flight
//          + writes fresh cache via setCached(awaitWrite=true)
//    4. No cache entry → run computeFn() (synchronously, await it)
//       + setCached(awaitWrite=true) + resolve in-flight
//    5. On error: reject in-flight + re-throw
//
//  Returns `{ data, cached, stale? }` — `cached` is true for both in-flight
//  + DB hits (fresh or stale) so callers can set the `cached: true` flag on
//  the response (CONVENTIONS §2). `stale` is true ONLY for SWR returns.
//  Callers MAY surface `stale: true` on the response to let the client know
//  the data is from an expired cache entry (optional — client ignores if
//  it doesn't handle the field).
// ============================================================
export async function withCacheAndDedup<T>(
  cacheKey: string,
  ttlMs: number,
  computeFn: () => Promise<T>,
  awaitWrite: boolean = true,
): Promise<{ data: T; cached: boolean; stale?: boolean }> {
  // 1. In-flight dedup — concurrent request for same key awaits this Promise.
  //    MUST be checked BEFORE any await to close the check-then-act race.
  const inflight = getInflight<T>(cacheKey);
  if (inflight) {
    const data = await inflight;
    return { data, cached: true };
  }

  // 2. Register in-flight Promise BEFORE the DB cache check (next await).
  //    This closes the race: any concurrent request that arrives while we're
  //    awaiting getCachedWithMeta will see this Promise via getInflight + await it.
  let resolveComputation!: (v: T) => void;
  let rejectComputation!: (e: unknown) => void;
  const computationPromise = new Promise<T>((resolve, reject) => {
    resolveComputation = resolve;
    rejectComputation = reject;
  });
  setInflight(cacheKey, computationPromise);

  try {
    // 3. DB cache check — getCachedWithMeta returns BOTH fresh + stale entries
    //    (does NOT delete on expiry, so the SWR path can return the stale data).
    const cachedWithMeta = await getCachedWithMeta<T>(cacheKey, ttlMs);
    if (cachedWithMeta !== null) {
      if (!cachedWithMeta.stale) {
        // 3a. Fresh hit — resolve in-flight (concurrent awaiters get fresh) + return.
        resolveComputation(cachedWithMeta.data);
        return { data: cachedWithMeta.data, cached: true };
      }

      // 3b. PERF-CACHE-09 (SWR): stale hit — return stale immediately +
      //     fire-and-forget background recompute. The in-flight Promise
      //     (registered in step 2) is resolved by the background recompute,
      //     so concurrent requests awaiting it get FRESH data.
      (async () => {
        try {
          const fresh = await computeFn();
          // awaitWrite=true — block ~50-150ms so the next request hits cache.
          await setCached(cacheKey, fresh, true);
          resolveComputation(fresh);
        } catch (e) {
          rejectComputation(e);
        }
      })();
      return { data: cachedWithMeta.data, cached: true, stale: true };
    }

    // 4. No cache entry (fresh or stale) — compute synchronously.
    const data = await computeFn();

    // 5. Cache write — awaitWrite=true blocks ~50-150ms so the next request
    //    hits the cache. awaitWrite=false fires-and-forgets (faster response,
    //    but next request may re-compute if write hasn't completed).
    await setCached(cacheKey, data, awaitWrite);

    // 6. Resolve in-flight + return.
    resolveComputation(data);
    return { data, cached: false };
  } catch (e) {
    // Reject in-flight so concurrent awaiters get the error (not a hang).
    rejectComputation(e);
    throw e;
  }
}

// ============================================================
//  PERF-CACHE-07: cleanupExpiredCache — deletes expired AggregationCache rows.
//  The table grows unbounded otherwise: expired entries are only deleted when
//  read by getCached (lazy cleanup). If a key is never re-read after expiry,
//  its row stays forever. This helper does a bulk DELETE of all rows older
//  than the supplied TTL.
//
//  Invocation: opportunistic — called from /api/status (cheap, frequent route)
//  every CLEANUP_INTERVAL_MS so we don't add a DB write to every status call.
// ============================================================
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 min — cap cleanup frequency
let _lastCleanupAt = 0;
const CLEANUP_TTL_MS = 30 * 60 * 1000; // 30 min — be conservative (don't delete still-warm entries)

export async function cleanupExpiredCache(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - _lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  _lastCleanupAt = now;
  try {
    const cutoff = new Date(now - CLEANUP_TTL_MS);
    const result = await db.aggregationCache.deleteMany({
      where: { computedAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      logger.info(`[cache] cleanupExpiredCache removed ${result.count} stale entries (older than ${cutoff.toISOString()})`);
    }
  } catch (e) {
    // Non-blocking — cleanup is opportunistic; don't fail the caller.
    logger.error('[cache] cleanupExpiredCache error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Invalidate cache entries matching a pattern.
 * Use after data mutations (ingest, settings change, direction migration).
 * Pass a prefix to invalidate all entries for a route (e.g. "analysis|").
 *
 * FIX (BUG2-PERF-1): The old `invalidateCache('analysis|')` calls used the
 * literal `|` character, but buildCacheKey was changed to use `\x1f` (ASCII
 * Unit Separator) in the BUG-EDGE-4 fix. This caused `startsWith('analysis|')`
 * to return false for ALL cache keys → zero entries invalidated → stale cache
 * for the full 5-min TTL after every mutation (ingest, settings, pic, etc.).
 *
 * Fix: export dedicated `invalidateAnalysisCache()` helper that uses the
 * correct delimiter. All callers should use this helper instead of passing
 * raw prefix strings.
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

/**
 * FIX (BUG2-PERF-1): Dedicated helper to invalidate all analysis cache entries.
 * Uses the SAME delimiter (\x1f) as buildCacheKey — do NOT pass raw 'analysis|'
 * to invalidateCache (it won't match any keys).
 *
 * Usage: `await invalidateAnalysisCache();` after any mutation that affects
 * analysis data (ingest, import-drive, settings change, pic change, data delete,
 * migrate-direction).
 */
export async function invalidateAnalysisCache(): Promise<void> {
  // CACHE-01 FIX: Invalidate ALL cached routes — not just analysis.
  // Mutations (ingest, settings, pic, data delete, migrate-direction) affect
  // ALL cached data, not just /api/analysis. Without this, pareto/recommendations/
  // resto-bahan-matrix/export-report serve stale data for 5 min after mutation.
  //
  // PERF-CACHE-08: also invalidate `heatmap` (added in this task — Area × Item
  // matrix reads from the same InventoryRecord table that mutations affect).
  // PERF-API-01/02/03 (Task PERF-API): added `outlet-items`, `item-history`,
  // and `drilldown` to the invalidation list — these routes now use
  // AggregationCache (5-min TTL via withCacheAndDedup) and must be cleared
  // on any mutation alongside the existing 6 routes.
  // TREND-BACKEND: added `item-trend` (per-item QTY fluctuation timeline —
  // reads from InventoryRecord across ALL periods, so mutations affect it).
  // P2-BE: added `item-peer-comparison` (per-item peer outlets scoped to one
  // period — reads from InventoryRecord, so mutations affect it).
  const routes = [
    'analysis', 'pareto', 'recommendations', 'resto-bahan-matrix',
    'export-report', 'heatmap', 'outlet-items', 'item-history', 'drilldown',
    'item-trend', 'item-peer-comparison',
  ];
  await Promise.all(routes.map(r => invalidateCache(`${r}\x1f`)));
}
