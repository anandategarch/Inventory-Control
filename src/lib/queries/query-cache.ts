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

// ============================================================
//  H-11 (#3) — key-part helpers for the export-shared queries whose
//  inputs are NOT a plain (month, week) pair. Both pipelines (analysis
//  + export-report) MUST derive these parts through the SAME helper so
//  the two call sites can never drift onto different cache keys.
// ============================================================

/**
 * Key parts for the historical-period queries
 * (queryHistoricalStatsMultiMetric / queryHistoricalCategoryAvg).
 *
 * The result depends ONLY on the period LIST (same weekLabel across
 * prior months) + filters — not on which current month produced it —
 * so the fingerprint is derived from the list itself:
 *   month = sorted monthLabels joined '|' (e.g. "April 2026|Mei 2026|Juni 2026")
 *   week  = sorted distinct weekLabels joined '|'
 * An empty list yields ('', '') — callers guard `length > 0` before
 * caching anyway (the queries early-return an empty Map).
 */
export function histPeriodsKeyParts(
  periods: ReadonlyArray<{ monthLabel: string; weekLabel: string }>,
): { month: string; week: string } {
  const months = [...new Set(periods.map((p) => p.monthLabel))].sort((a, b) => a.localeCompare(b));
  const weeks = [...new Set(periods.map((p) => p.weekLabel))].sort((a, b) => a.localeCompare(b));
  return { month: months.join('|'), week: weeks.join('|') };
}

/**
 * Stable fingerprint for the histCriticalKeys array passed to
 * queryHistoricalCriticalItems. Both pipelines derive the keys from the
 * SAME q-rules / q-hist-rules cached rows (identical merge logic:
 * key `outletId|itemId|akunPenyesuaian`, keep highest priority), so the
 * fingerprint matches and the query is shared. Sorted before hashing —
 * the SQL result does not depend on key order, and sorting makes the
 * hash immune to Map iteration-order differences. FNV-1a 32-bit.
 */
export function histCriticalKeysHash(
  keys: ReadonlyArray<{ outletId: number | string; itemId: number | string; akunPenyesuaian: string | null }>,
): string {
  // JSON.stringify per component: distinguishes null from '' and 1 from "1"
  // (a plain `?? ''` join would conflate them — a potential wrong-cache-hit).
  const ids = keys
    .map((k) => JSON.stringify([k.outletId, k.itemId, k.akunPenyesuaian]))
    .sort();
  const s = `${ids.length};${ids.join(';')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Map-aware variant of cachedSharedQuery (H-11 / #3).
 *
 * AggregationCache stores payloads as JSON — `JSON.stringify(Map)` yields
 * `{}`, so a Map-returning query MUST be cached as its entry array and
 * rebuilt on read. Both the analysis and export pipelines use this for
 * queryHistoricalStatsMultiMetric + queryHistoricalCategoryAvg.
 */
export async function cachedSharedQueryMap<K, V>(
  queryId: string,
  params: Parameters<typeof cachedSharedQuery>[1],
  computeFn: () => Promise<Map<K, V>>,
): Promise<Map<K, V>> {
  const entries = await cachedSharedQuery<Array<[K, V]>>(
    queryId,
    params,
    async () => Array.from(await computeFn()) as Array<[K, V]>,
  );
  return new Map(entries);
}
