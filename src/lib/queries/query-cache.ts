// ============================================================
//  query-cache — shared per-query AggregationCache wrapper
//  --------------------------------------------------------
//  PERF (TAHAP-2 / P2-9): the /api/export-report pipeline used to
//  re-run the exact same heavy queries the /api/analysis pipeline had
//  just computed (rule evaluation, variance, merged KPIs, trend,
//  category tops) under a DIFFERENT route-level cache key — clicking
//  "Export Report" right after viewing the dashboard paid the whole
//  query bill again.
//
//  This helper caches an individual QUERY RESULT in AggregationCache
//  under its own `q-*` key. Both pipelines wrap their calls with the
//  same queryId + params, so the second consumer hits the stored row
//  (~5-15ms) instead of recomputing seconds of SQL.
//
//  Why per-query (not sharing the analysis payload): the analysis
//  response is a SHAPED payload with its own versioned contract
//  (ANALYSIS_PAYLOAD_SCHEMA_VERSION + REQUIRED_PAYLOAD_MARKERS). Making
//  export parse that payload would couple two routes' contracts — any
//  analysis shape change would silently break the DOCX. Caching each
//  query's OWN row shape keeps the contracts independent.
//
//  Freshness: TTL 30 min — the same bound the analysis payload cache
//  uses (data is immutable between mutations). All mutation paths call
//  invalidateAnalysisCache(), which also clears every `q-*` route
//  prefix listed there.
//
//  awaitWrite=false: the analysis cold path must NOT block ~50-150ms
//  per query waiting for these auxiliary cache writes (its own payload
//  write is awaited separately). A fast-following consumer that misses
//  the in-flight write simply recomputes — same behavior as before.
// ============================================================
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import type { SqlFilterOpts } from './shared';

/** Match the analysis payload TTL (data immutable between mutations). */
export const SHARED_QUERY_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Run `computeFn` behind the shared per-query cache.
 *
 * `queryId` must be a stable `q-*` identifier ALSO listed in
 * invalidateAnalysisCache()'s routes array (aggregation-cache.ts) so
 * mutations clear it.
 *
 * All response-affecting inputs must be reflected in the key:
 * period (month/week + optional compare pair), the SQL filters, and
 * any extra params (e.g. limit, thresholds fingerprint).
 */
export async function cachedSharedQuery<T>(
  queryId: string,
  params: {
    month: string;
    week: string;
    compareWeek?: string | null;
    compareMonth?: string | null;
    filters: SqlFilterOpts;
    extra?: Record<string, string | number | null | undefined>;
  },
  computeFn: () => Promise<T>,
): Promise<T> {
  const f = params.filters;
  const cacheKey = buildCacheKey({
    route: queryId,
    month: params.month,
    week: params.week,
    compareWeek: params.compareWeek ?? null,
    compareMonth: params.compareMonth ?? null,
    area: f.area ?? null,
    kelompok: f.kelompok ?? null,
    outletCode: f.outletCode ?? null,
    itemName: f.itemName ?? null,
    pic: null,
    extra: {
      ...params.extra,
      // picOutletCodes is an already-resolved outlet-code list — include it
      // (sorted, so identical sets share one key) instead of the raw pic name.
      ...(f.picOutletCodes && f.picOutletCodes.length > 0
        ? { picCodes: [...f.picOutletCodes].sort().join(',') }
        : {}),
    },
  });
  const { data } = await withCacheAndDedup<T>(cacheKey, SHARED_QUERY_CACHE_TTL_MS, computeFn, false);
  return data;
}
