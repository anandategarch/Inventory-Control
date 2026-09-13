// ============================================================
//  store — AggregationCache DB read/write + TTL + cleanup
//  --------------------------------------------------------
//  Extracted from the former src/lib/aggregation-cache.ts monolith
//  (REFACTOR-1-a pure-move split). Low-level DB access to the
//  AggregationCache table: read (fresh/stale-aware), write (raw +
//  stringified), and the opportunistic bulk cleanup. TTL constants
//  live here.
// ============================================================
import { db } from '../db';
import { logger } from '../logger';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
//  handles bulk deletion of rows older than 90 min (FIX AUDIT-PERF-5 —
//  was 30 min; see CLEANUP_TTL_MS below).
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

// ============================================================
//  P3-HYG-1: getCachedRawWithMeta — returns the cached payload as the
//  RAW JSON string (NO JSON.parse). For routes whose cache-hit response
//  is the payload serialized back to JSON anyway (/api/analysis — the
//  ~1MB dashboard payload), the old flow paid DOUBLE serialization on
//  every hit: JSON.parse(row.payload) (1MB string → object) inside
//  getCachedWithMeta, then NextResponse.json() (object → 1MB string)
//  again. That's ~20-40ms of pure CPU per hit at 1MB — repeated for
//  every tab switch / filter change that lands on a warm cache.
//  The raw path serves the stored string directly: zero parse, zero
//  stringify (the route injects its `cached`/`stale` envelope flags
//  via O(1) string surgery on the leading `{`).
//
//  Semantics mirror getCachedWithMeta: SWR-aware (expired rows are
//  returned marked stale, NOT deleted — the background recompute
//  upserts in place; cleanupExpiredCache handles final deletion).
// ============================================================
export async function getCachedRawWithMeta(
  cacheKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ raw: string; stale: boolean } | null> {
  try {
    const row = await db.aggregationCache.findUnique({ where: { cacheKey } });
    if (!row) return null;
    const stale = Date.now() - row.computedAt.getTime() > ttlMs;
    return { raw: row.payload, stale };
  } catch (e) {
    // Non-blocking: if cache read fails (DB error), return null and let
    // the caller compute fresh. No JSON.parse here, so no parse errors.
    logger.error('[cache] getCachedRawWithMeta error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
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
    await setCachedRaw(cacheKey, json, awaitWrite);
  } catch (e) {
    // Synchronous error (JSON.stringify failed) — non-blocking
    logger.error('[cache] setCached sync error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ============================================================
//  PERF (H-8 QUICK WIN 5 — single stringify): setCachedRaw — store an
//  ALREADY-serialized JSON string. The /api/analysis cold path used to pay
//  DOUBLE serialization of the ~1MB payload: setCached() stringified the
//  object (serialize #1, ~15-40ms), then NextResponse.json() stringified the
//  same object again (serialize #2). The route now stringifies ONCE, stores
//  the string via this helper, and serves the SAME string to the client —
//  mirroring the zero-parse warm path (P3-HYG-1 getCachedRawWithMeta) on
//  the cold path too. The stored bytes are identical to what setCached()
//  would write, so cache-hit behavior is unchanged.
// ============================================================
export async function setCachedRaw(cacheKey: string, rawJson: string, awaitWrite: boolean = false): Promise<void> {
  try {
    // upsert: insert or update if exists (cacheKey is unique)
    const writePromise = db.aggregationCache.upsert({
      where: { cacheKey },
      create: { cacheKey, payload: rawJson, computedAt: new Date() },
      update: { payload: rawJson, computedAt: new Date() },
    });
    if (awaitWrite) {
      // For critical caches — block until write completes so next request hits cache
      await writePromise.catch((e) => {
        logger.error('[cache] setCachedRaw (awaited) error', { error: e instanceof Error ? e.message : String(e) });
      });
    } else {
      // Fire-and-forget — non-blocking
      writePromise.catch((e) => {
        logger.error('[cache] setCachedRaw error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
      });
    }
  } catch (e) {
    // Synchronous error — non-blocking
    logger.error('[cache] setCachedRaw sync error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
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
// FIX (AUDIT-PERF-5): raised 30 min → 90 min. Stale rows must survive long
// enough for stale-while-revalidate to SERVE them while the background
// recompute runs (the analysis recompute alone can take 6-8s+; a burst of
// keys revalidating concurrently delays individual recomputes further).
// At the old 30 min cutoff, cleanup could delete a row mid-SWR (right after
// the stale hit, before setCached upserted the fresh payload) → next request
// pays the full cold recompute — exactly what SWR exists to prevent.
const CLEANUP_TTL_MS = 90 * 60 * 1000; // 90 min — keep stale rows so SWR can serve them during background recompute

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
