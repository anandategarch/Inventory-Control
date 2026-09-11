// ============================================================
//  background-recompute — SWR background recompute for /api/analysis
//  --------------------------------------------------------
//  FIX (AUDIT-PERF-5): true stale-while-revalidate for the analysis route.
//
//  Before: on a stale cache hit, validate-and-resolve served the stale row
//  then fire-and-forget DELETED it — so the next user paid the full
//  20-50-query cold recompute (6-8s) even though the data was still valid.
//
//  After: the stale row is served (<100ms) and this module recomputes the
//  full pipeline IN THE BACKGROUND and upserts the fresh row via setCached.
//  The next request reads the fresh row from the DB cache. Because the
//  pipeline is identical to route.ts stages 2-5 (fetch-records →
//  run-queries → post-process → assemble-response), the recomputed payload
//  is byte-equivalent to a cold compute.
//
//  Safety properties:
//    - Dedup guard: only ONE background recompute per cacheKey at a time
//      (in-memory Set) — a burst of stale hits triggers a single recompute,
//      not one per request.
//    - Non-fatal: errors are logged and swallowed. The stale row stays in
//      place (cleanupExpiredCache eventually ages it out), and the next
//      request re-triggers a recompute.
//    - Data-gone short-circuit: if currSlim is empty (records deleted since
//      the row was cached), we LEAVE the stale row in place and return —
//      the next explicit request runs the miss path and 404s cleanly.
//
//  No import cycle at runtime: this module imports the stage services
//  (fetch-records / run-queries / post-process / assemble-response) as
//  VALUES, but those services import ResolvedParams from
//  validate-and-resolve.ts as a TYPE-ONLY import (erased at compile time) —
//  so the only runtime edge into validate-and-resolve is route.ts.
// ============================================================
import { fetchRecords } from './fetch-records';
import { runQueries } from './run-queries';
import { postProcess } from './post-process';
import { assembleResponse } from './assemble-response';
import { setCachedRaw } from '@/lib/aggregation-cache';
import { logger } from '@/lib/logger';
import type { ResolvedParams } from './validate-and-resolve';

// FIX (AUDIT-PERF-5): dedup guard — only ONE background recompute per key at
// a time. Without this, a burst of concurrent stale hits would each fire a
// full 20-50-query pipeline (a stampede, just delayed by one request).
const recomputingKeys = new Set<string>();

/**
 * FIX (AUDIT-PERF-5): trigger a guarded background recompute of the analysis
 * pipeline for `cacheKey` and upsert the fresh result into AggregationCache.
 *
 * Fire-and-forget (returns synchronously; never throws). At most one
 * recompute runs per cacheKey at a time per server instance.
 */
export function triggerBackgroundRecompute(cacheKey: string, params: ResolvedParams): void {
  if (recomputingKeys.has(cacheKey)) return;
  recomputingKeys.add(cacheKey);
  void (async () => {
    try {
      // fetchRecords MUTATES params in place (fills prevWeek/prevMonth via
      // resolveComparePeriod + re-resolves month/compareMonthExplicit) — pass
      // a copy so the caller's snapshot is never clobbered. startedAt is
      // reset so the recomputed payload's durationMs reflects THIS recompute,
      // not the age of the original request.
      const p: ResolvedParams = { ...params, startedAt: Date.now() };
      const records = await fetchRecords(p);
      // Data gone (deleted since the stale row was cached) — leave the stale
      // row in place; the next explicit request takes the miss path and 404s.
      // PERF (TAHAP-2 / P2-7): currRecordCount is a COUNT probe (the old
      // currSlim array + JS zScore loop is now evaluateHistoricalRulesSql).
      if (records.currRecordCount === 0) return;
      const queries = await runQueries(p, records);
      const processed = await postProcess(p, records, queries);
      const result = assembleResponse(p, records, queries, processed);
      // PERF (H-8 QUICK WIN 5 — single stringify): serialize once and store
      // the raw string (same pattern as the route's cold path). awaitWrite=true
      // — block ~50-150ms so the next request hits the cache.
      await setCachedRaw(cacheKey, JSON.stringify(result), true);
    } catch (e: unknown) {
      // Non-fatal — log and keep the stale row; the next request re-triggers.
      logger.error('[analysis] SWR background recompute failed (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
        cacheKey,
      });
    } finally {
      recomputingKeys.delete(cacheKey);
    }
  })();
}
