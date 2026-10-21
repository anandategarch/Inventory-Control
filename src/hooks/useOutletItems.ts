'use client';

// ============================================================
//  useOutletItems — the Resto tab's main /api/outlet-items query
//  + hover prefetch (PERF-FILTER1 / C)
//  --------------------------------------------------------
//  Extracted from the inline useQuery in RestoAnalysis/index.tsx so
//  the fetch logic has ONE home shared by the live query AND an
//  imperative prefetch (the same split as useAnalysis/fetchAnalysis
//  + prefetchAnalysis — TanStack dedupes by queryKey, so a prefetch
//  landing while the real query is in flight is a no-op).
//
//  PERF (PERF-FILTER1 C): the Resto tab's outlet picker (SearchableComboBox
//  "Filter Resto") now prefetches THIS query on option hover (250ms
//  debounce) — by click time the heavy outlet payload is usually already
//  in the client cache, so switching resto feels instant instead of the
//  measured 15-17s cold / 40ms warm split.
//
//  Key shape: ['outlet-items', outletCode, month, week, compareWeek,
//  compareMonth] — EXACTLY the array the inline useQuery built (values
//  passed through verbatim, null included), so the prefetch and the live
//  query share one cache entry.
// ============================================================
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { OutletItemsResponse } from '@/components/dashboard/resto-analysis/types';

export interface OutletItemsParams {
  outletCode: string;
  month: string;
  week: string;
  compareWeek?: string | null;
  compareMonth?: string | null;
}

/** PERF-OPT: outlet data only changes on ingest / manual refresh — the
 *  global invalidation covers it. Aligned with the 10-min gcTime so a
 *  filter toggle back to a recently-viewed outlet is instant. */
export const OUTLET_ITEMS_STALE_TIME = 10 * 60_000;
export const OUTLET_ITEMS_GC_TIME = 10 * 60_000;

// PERF-OPT: build the URLSearchParams — mirrors the param-building logic
// that used to live inline in RestoAnalysis so prefetch + live fetch
// produce identical query strings.
function buildOutletItemsSearchParams(params: OutletItemsParams): URLSearchParams {
  const p = new URLSearchParams();
  p.set('outletCode', params.outletCode);
  p.set('month', params.month);
  p.set('week', params.week);
  if (params.compareWeek) p.set('compareWeek', params.compareWeek);
  if (params.compareMonth) p.set('compareMonth', params.compareMonth);
  return p;
}

/** The canonical query key — shared by useOutletItems + prefetchOutletItems. */
export function buildOutletItemsQueryKey(params: OutletItemsParams) {
  return ['outlet-items', params.outletCode, params.month, params.week, params.compareWeek, params.compareMonth] as const;
}

/** The fetch — extracted verbatim from RestoAnalysis's inline queryFn. */
export async function fetchOutletItems(params: OutletItemsParams): Promise<OutletItemsResponse> {
  const p = buildOutletItemsSearchParams(params);
  const res = await fetch(`/api/outlet-items?${p.toString()}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<OutletItemsResponse>;
}

export function useOutletItems(params: OutletItemsParams & { enabled: boolean }) {
  const { enabled, ...rest } = params;
  return useQuery({
    queryKey: buildOutletItemsQueryKey(rest),
    queryFn: () => fetchOutletItems(rest),
    enabled,
    // PERF-FE (PAKET A): outlet data only changes on ingest / manual refresh
    // (handleRefresh invalidates ['outlet-items']) — not every 30s.
    staleTime: OUTLET_ITEMS_STALE_TIME,
    gcTime: OUTLET_ITEMS_GC_TIME,
    // FIX (BUG-FE-5): keepPreviousData for smooth transition on filter change
    placeholderData: keepPreviousData,
  });
}

// ============================================================
//  PERF (PERF-FILTER1 C): prefetchOutletItems — fires the SAME query
//  the tab will run on click, ahead of the click. Used by the Filter
//  Resto picker's onOptionHover (250ms-debounced). TanStack skips the
//  prefetch when the key already holds fresh data, so re-hovering an
//  outlet never re-fires.
// ============================================================
export function prefetchOutletItems(
  queryClient: QueryClient,
  params: OutletItemsParams,
): void {
  void queryClient.prefetchQuery({
    queryKey: buildOutletItemsQueryKey(params),
    queryFn: () => fetchOutletItems(params),
    staleTime: OUTLET_ITEMS_STALE_TIME,
    gcTime: OUTLET_ITEMS_GC_TIME,
  });
}

/** React hook wrapper — stable callback for onMouseEnter handlers. */
export function usePrefetchOutletItems() {
  const queryClient = useQueryClient();
  return useCallback(
    (params: OutletItemsParams) => prefetchOutletItems(queryClient, params),
    [queryClient],
  );
}
