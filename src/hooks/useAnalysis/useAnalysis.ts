'use client';

// ============================================================
//  useAnalysis — main hook for /api/analysis
//  --------------------------------------------------------
//  Source: extracted from src/hooks/useAnalysis.ts (split by
//  Task ID 3-a). Includes:
//    - buildAnalysisSearchParams / buildAnalysisQueryKey
//    - ANALYSIS_STALE_TIME / ANALYSIS_GC_TIME constants
//    - useAnalysis (TanStack Query hook)
//    - prefetchAnalysis (imperative prefetch helper)
//    - usePrefetchAnalysis (React hook wrapper around prefetchAnalysis)
//
//  The shared fetchAnalysis() helper lives in ./fetchAnalysis.ts so
//  both useAnalysis + prefetchAnalysis can call it without circular
//  import issues.
// ============================================================
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { AnalysisParams } from './types';
import { fetchAnalysis, type RetryableError } from './fetchAnalysis';

// PERF-OPT: Build the URLSearchParams for an analysis request.
// Mirrors the param-building logic that used to live inline in useAnalysis
// so prefetch + live fetch produce identical query strings.
function buildAnalysisSearchParams(params: AnalysisParams): URLSearchParams {
  const p = new URLSearchParams();
  if (params.month) p.set('month', params.month);
  if (params.week) p.set('week', params.week);
  // Encode cross-month compare as "WEEK|||Month" so server can resolve month
  if (params.compareWeek) {
    if (params.compareMonth && params.compareMonth !== params.month) {
      p.set('compareWeek', `${params.compareWeek}|||${params.compareMonth}`);
    } else {
      p.set('compareWeek', params.compareWeek);
    }
  }
  if (params.area) p.set('area', params.area);
  if (params.kelompok) p.set('kelompok', params.kelompok);
  if (params.item) p.set('item', params.item);
  if (params.pic) p.set('pic', params.pic);
  return p;
}

// PERF-OPT: build the canonical analysis query key.
// Exported so prefetch callers can use the EXACT same key shape as useAnalysis.
export function buildAnalysisQueryKey(params: AnalysisParams) {
  return ['analysis', params] as const;
}

// ============================================================
//  FIX (RETRYABLE-1): shouldRetryAnalysis — retry predicate for the
//  main dashboard query, extracted as a pure function (repo test
//  convention — cf. use-toast reducer test) so the production
//  incident chain is unit-testable:
//    server errorResponse (retryable flag) → fetchAnalysis (Error
//    property) → THIS predicate.
//  History: the old inline predicate matched substrings of the RAW
//  error text ('connection', 'timeout', 'ECHECKOUTRETRIES', …) —
//  text that only reaches the client in DEV mode. In production
//  errorResponse hides it ("Gagal memproses permintaan") → 0
//  auto-retry for transient pool/statement timeouts (insiden
//  "Gagal Memuat Analisis" saat filter resto, 21 Okt 2026; the
//  analysis query was the ONLY query without self-heal — every
//  other query uses the global providers.tsx retry:1). The server
//  now sends a machine-readable `retryable` flag; honor it FIRST.
// ============================================================
export function shouldRetryAnalysis(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false; // max 3 retries (was 2 — increased for pool errors)
  if ((error as RetryableError)?.retryable === true) return true;
  const msg = error instanceof Error ? error.message : '';
  // DEV-mode / raw-text legacy path — retry on 504/502/503, timeout,
  // Server error (Vercel platform HTML), or connection pool errors:
  return msg.includes('504') || msg.includes('502') || msg.includes('503') ||
    msg.includes('timeout') || msg.includes('Server error') ||
    msg.includes('ECHECKOUTRETRIES') || msg.includes('connection');
}

// PERF-OPT: staleTime + gcTime constants. Bumped from 60s → 120s staleTime
// (analysis is heavy — 6-8s cold) and added 10-min gcTime so the data stays
// in memory across tab switches / filter toggles.
export const ANALYSIS_STALE_TIME = 120_000; // 2 min
export const ANALYSIS_GC_TIME = 600_000;     // 10 min

export function useAnalysis(params: AnalysisParams) {
  // NOTE (BUG-FE-10): the old comment claimed this was "memoized" via useMemo,
  // but it's just a plain const. TanStack Query caches by queryKey (not queryFn
  // reference), so this is functionally fine — the queryFn closure captures
  // searchParams, and since queryKey includes all params, a param change
  // triggers a new queryFn invocation with the updated searchParams. No fix needed.
  const searchParams = buildAnalysisSearchParams(params);

  return useQuery({
    queryKey: buildAnalysisQueryKey(params),
    queryFn: () => fetchAnalysis(searchParams),
    enabled: Boolean(params.month && params.week),
    placeholderData: keepPreviousData,
    // FIX (504-RETRY): retry once on 504/timeout — gateway proxy may timeout
    // before the heavy query (with outlet filter) completes. The 2nd attempt
    // usually hits the in-flight cache or completes faster (DB warm).
    // FIX (BUG6-POOL): also retry on ECHECKOUTRETRIES (connection pool exhaustion).
    // FIX (RETRYABLE-1): predicate extracted to shouldRetryAnalysis (above) —
    // honors the production `retryable` flag first, then the legacy dev-mode
    // substring matches.
    retry: (failureCount, error) => shouldRetryAnalysis(failureCount, error),
    retryDelay: (attemptIndex) => Math.min(2000 * (attemptIndex + 1), 5000), // 2s, 4s, 5s — longer delays for pool recovery
    // PERF-OPT: staleTime 60s → 120s. Analysis is expensive (6-8s cold,
    // 100ms warm). 2 min keeps the data fresh enough for filter toggles
    // without re-fetching on every tab switch.
    staleTime: ANALYSIS_STALE_TIME,
    // PERF-OPT: gcTime 5min (default) → 10min. Keeps the data in memory
    // longer so navigating back to a previously-viewed period is instant.
    gcTime: ANALYSIS_GC_TIME,
    // PERF-FE: analysis is heavy (6-8s cold) — don't auto-refetch when the
    // user switches browser tabs and comes back. The 2-min staleTime keeps
    // data fresh for filter toggles; an explicit "refresh" button covers
    // the manual-refresh case. Without this, every tab-switch + 2-min-stale
    // window triggers a 6-8s reload that blocks the UI.
    refetchOnWindowFocus: false,
  });
}

// ============================================================
//  PERF-OPT: prefetchAnalysis
//  --------------------------------------------------------
//  Used by:
//    1. FilterBar — on hover over a month/week dropdown option,
//       prefetch the analysis for that period so the click is instant.
//    2. page.tsx — on first successful status load, prefetch the
//       default (latest) period so the dashboard's first paint
//       doesn't wait for the user to interact.
//
//  Implementation: queryClient.prefetchQuery with the SAME queryKey
//  shape as useAnalysis. TanStack Query dedupes — if a real useAnalysis
//  call is already in flight for the same key, prefetch is a no-op.
// ============================================================
export function prefetchAnalysis(
  queryClient: QueryClient,
  params: AnalysisParams,
): void {
  if (!params.month || !params.week) return;
  const searchParams = buildAnalysisSearchParams(params);
  void queryClient.prefetchQuery({
    queryKey: buildAnalysisQueryKey(params),
    queryFn: () => fetchAnalysis(searchParams),
    staleTime: ANALYSIS_STALE_TIME,
    gcTime: ANALYSIS_GC_TIME,
  });
}

// ============================================================
//  PERF-OPT: usePrefetchAnalysis — React hook wrapper around
//  prefetchAnalysis. Returns a stable callback that can be passed
//  to onMouseEnter handlers without re-creating closures every render.
// ============================================================
export function usePrefetchAnalysis() {
  const queryClient = useQueryClient();
  return useCallback(
    (params: AnalysisParams) => prefetchAnalysis(queryClient, params),
    [queryClient],
  );
}
