'use client';

// ============================================================
//  PeerComparison — data hook (P1 parallel queries + memos)
//  (split from PeerComparison.tsx — SPLIT-G; pure code motion)
//
//  All 3 analysis queries fire on mount (main + items in
//  parallel; trend waits for peerCodes from main — stable peer
//  set across weeks), plus the network-wide benchmark
//  opportunity query. Derived state (peer set split, peer
//  averages, pre-computed card values) is memoized here so the
//  thin orchestrator stays readable.
//
//  Hooks are unconditional — the original component called all
//  of these BEFORE its `!activeOutlet` early return; the hook
//  preserves that ordering (rules-of-hooks safe).
// ============================================================

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ItemComparisonResponse, TrendResponse, PeerAverages, PeerRow, PeerTopItemsResponse } from '@/components/dashboard/peer-comparison/types';
import type { BenchmarkOpportunityResponse } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';
import {
  computePeerEfficiencyScore,
  computePeerGapRows,
  computePeerScatterPoints,
  computePeerRankItems,
} from '@/components/dashboard/peer-computation';

export interface UsePeerQueriesParams {
  activeOutlet: string | null;
  monthLabel: string | null;
  currentWeek: string | null;
  kelompok: string | null;
}

export function usePeerQueries({ activeOutlet, monthLabel, currentWeek, kelompok }: UsePeerQueriesParams) {
  // Fixed: mode='week' (follows currentWeek from main FilterBar), peerLimit=50.
  // No dropdowns — peer scope is always top 50 by sales proximity for the
  // selected week.
  const mode: 'week' | 'month' = 'week';
  const peerLimit = 50;

  // ============================================================
  //  P1 PARALLEL QUERIES — all 3 useQuery hooks fire on mount.
  //  Previously the items + trend sub-components were gated by
  //  `targetRow &&` (only mounted AFTER the main query resolved),
  //  creating a 3-stage waterfall: main → items → trend.
  //  Now: main + items fire in parallel (independent inputs:
  //  outlet/month/week/mode); trend waits for peerCodes from main
  //  (stable peer set across weeks requires the main query's peer
  //  list — `enabled` waits for peerCodes to avoid a wasted first
  //  fetch with empty peers that would auto-compute per-week and
  //  then immediately refetch).
  // ============================================================
  const { data: mainData, isLoading: mainLoading, isFetching: mainFetching, error: mainError, refetch: refetchMain } = useQuery({
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok added to queryKey so TanStack
    // refetches when kelompok changes. Without this, switching kelompok would
    // show stale (unfiltered) peer data.
    queryKey: ['peer-comparison', activeOutlet, monthLabel, currentWeek, peerLimit, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('limit', String(peerLimit));
      // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): pass kelompok so peer scope respects the global filter.
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      // FIX (BUG-H cross-domain): these routes return JSON {success:false,
      // error} bodies on 429/4xx/5xx, so the content-type guard above passes
      // and the error payload used to be returned as query DATA (error
      // swallowed — error state never set). Same fix as useRecommendations /
      // useItemTrend: throw on !res.ok so TanStack surfaces the error state.
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
    // PERF-FE (PAKET A): peer data only changes on ingest / manual refresh
    // (handleRefresh invalidates ['peer-comparison']) — not every 30s.
    // Without an explicit staleTime these queries fell back to the 30s
    // global default, so re-entering the tab after >30s refetched all
    // three queries even though nothing had changed.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    // FIX #20: keepPreviousData so switching outlet shows smooth transition
    // (old peers stay visible) instead of a full loading skeleton flash.
    placeholderData: keepPreviousData,
  });

  // Derive peer set from main query result (empty while loading).
  // `peerCodes` is consumed by the trend query below for a stable
  // peer set across weeks (avoids per-week auto-compute drift).
  // FIX (AUDIT-FRONTEND-V2): memoize derived state — was recomputed on every render.
  const peers: PeerRow[] = useMemo(() => mainData?.peers || [], [mainData]);
  const targetRow = useMemo(() => peers.find((p) => p.isTarget), [peers]);
  const otherPeers = useMemo(() => peers.filter((p) => !p.isTarget), [peers]);
  const peerCodes = useMemo(() => otherPeers.map((p) => p.outletCode), [otherPeers]);
  const peerCodesKey = useMemo(() => peerCodes.join(','), [peerCodes]);

  // Items query — independent inputs, fires in parallel with main.
  const { data: itemsData, isLoading: itemsLoading, error: itemsError } = useQuery({
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok added to queryKey + URL params.
    queryKey: ['peer-comparison', 'items', activeOutlet, monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('topItems', '5');
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison/items?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      // FIX (BUG-H cross-domain): see main query — JSON error body must not
      // become query data.
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<ItemComparisonResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
    // PERF-FE (PAKET A): see main query — 5 min staleTime + 10 min gcTime
    // instead of the 30s default refetch-on-remount storm.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  // Trend query — depends on peerCodes from main for stable peer
  // set across weeks. `enabled` waits for peerCodes.
  const { data: trendData, isLoading: trendLoading, error: trendError } = useQuery({
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok added to queryKey + URL params.
    // peerCodesKey already changes when kelompok changes (main query refetches
    // → peerCodes recomputed), but adding kelompok explicitly makes the cache
    // key stable + explicit.
    queryKey: ['peer-comparison', 'trend', activeOutlet, monthLabel, peerCodesKey, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (peerCodes.length > 0) p.set('peers', peerCodes.slice(0, 20).join(','));
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison/trend?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      // FIX (BUG-H cross-domain): see main query — JSON error body must not
      // become query data.
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<TrendResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && peerCodes.length > 0),
    // PERF-FE (PAKET A): see main query — 5 min staleTime + 10 min gcTime
    // instead of the 30s default refetch-on-remount storm.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  // Benchmark Opportunity query (ANA-1-E — "Peluang Perbaikan (Rp)").
  // Network-wide per-area metric: does NOT depend on the target outlet or
  // its peer set, so the queryKey omits activeOutlet (switching focus outlet
  // re-uses the same cache entry — the number is identical by definition).
  // Fires in parallel with main/items (independent inputs: month/week/kelompok).
  const { data: opportunityData, isLoading: opportunityLoading, error: opportunityError, refetch: refetchOpportunity } = useQuery({
    queryKey: ['peer-comparison', 'benchmark-opportunity', monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      // Guard instead of non-null assertion — `enabled` guarantees both are
      // defined by the time this runs, but the runtime check keeps TS strict
      // happy without adding a new lint warning.
      if (!monthLabel || !currentWeek) throw new Error('Periode belum dipilih');
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      if (currentWeek) p.set('week', currentWeek);
      // Same kelompok scoping as the sibling peer modules.
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/benchmark-opportunity?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      // FIX (BUG-H cross-domain): see main query — JSON error body must not
      // become query data.
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<BenchmarkOpportunityResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    // PERF-FE (PAKET A): same staleTime/gcTime as the sibling peer queries —
    // data only changes on ingest / manual refresh, not every 30s.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    // keepPreviousData so month/week switches keep the old number visible
    // while the new one loads (same as the main query).
    placeholderData: keepPreviousData,
  });

  // Top Items query (PEERTOP-2) — "top item di tiap peer": each peer
  // outlet's own top-N items + the cross-peer union. Independent inputs
  // (outlet/month/week/mode/kelompok), fires in parallel with main/items.
  // `limit` MUST equal peerLimit above so the peer band (ORDER BY sales
  // proximity, LIMIT limit+1) is IDENTICAL to the main query's — perPeer
  // entries then map 1:1 onto the Peer Table rows.
  const { data: topItemsData, isLoading: topItemsLoading, error: topItemsError } = useQuery({
    // kelompok in queryKey + URL params — same BUG2-RESTO-1 / FIX-P1-PEER-1
    // rationale as the sibling queries.
    queryKey: ['peer-comparison', 'top-items', activeOutlet, monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      // Guard instead of non-null assertion (same convention as the
      // benchmark-opportunity query above) — `enabled` guarantees both are
      // defined by the time this runs, but the runtime check keeps TS strict
      // happy without adding a new lint warning.
      if (!activeOutlet || !monthLabel) throw new Error('Outlet dan periode belum dipilih');
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet);
      p.set('month', monthLabel);
      if (currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('topN', '5');
      p.set('limit', String(peerLimit));
      // Same kelompok scoping as the sibling peer modules.
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison/top-items?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      // FIX (BUG-H cross-domain): see main query — JSON error body must not
      // become query data.
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<PeerTopItemsResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
    // PERF-FE (PAKET A): see main query — 5 min staleTime + 10 min gcTime
    // instead of the 30s default refetch-on-remount storm.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  // Peer averages object (used by subcomponents) — memoized
  // FIX (rules-of-hooks): moved BEFORE early return so hooks are called unconditionally.
  const peerAverages: PeerAverages = useMemo(() => {
    const cnt = otherPeers.length;
    const avg = (field: keyof PeerRow) =>
      cnt > 0 ? otherPeers.reduce((s, p) => s + (p[field] as number), 0) / cnt : 0;
    return {
      sales: avg('sales'),
      nominalDeviasi: avg('nominalDeviasi'),
      devBom: avg('devBom'),
      totalLoss: avg('totalLoss'),
      totalSurplus: avg('totalSurplus'),
      qtyWaste: avg('qtyWaste'),
      qtySusut: avg('qtySusut'),
      qtyTrial: avg('qtyTrial'),
      qtyLossSurplus: avg('qtyLossSurplus'),
      residualQty: avg('residualQty'),
      itemCount: avg('itemCount'),
    };
  }, [otherPeers]);

  // Pre-computed card values — memoized to preserve original performance
  // characteristics (the old EfficiencyScoreCard memoized internally).
  // Hooks are unconditional — safe to compute even when targetRow is null
  // (the JSX guards against rendering with null target).
  const efficiencyScore = useMemo(
    () => targetRow ? computePeerEfficiencyScore(targetRow, peerAverages) : 0,
    [targetRow, peerAverages],
  );
  const gapRows = useMemo(
    () => targetRow ? computePeerGapRows(targetRow, otherPeers) : [],
    [targetRow, otherPeers],
  );
  // scatterPoints + rankData use `peers` directly (the JSX guards the render
  // with `otherPeers.length > 0`, so we don't need to gate inside useMemo —
  // when peers is empty, the result is just an empty array / null).
  const scatterPoints = useMemo(
    () => computePeerScatterPoints(peers, targetRow?.outletCode, peerAverages),
    [peers, targetRow, peerAverages],
  );
  const rankData = useMemo(
    () => targetRow ? computePeerRankItems(targetRow, peers) : null,
    [targetRow, peers],
  );

  return {
    // Main peer query
    mainData,
    mainLoading,
    mainFetching,
    mainError,
    refetchMain,
    // Derived peer set
    peers,
    targetRow,
    otherPeers,
    // Items-level comparison query
    itemsData,
    itemsLoading,
    itemsError,
    // Trend query
    trendData,
    trendLoading,
    trendError,
    // Top items query (PEERTOP-2 — "Top Items Across Peers" + Peer Table
    // expand rows)
    topItemsData,
    topItemsLoading,
    topItemsError,
    // Benchmark opportunity query
    opportunityData,
    opportunityLoading,
    opportunityError,
    refetchOpportunity,
    // Pre-computed card values
    peerAverages,
    efficiencyScore,
    gapRows,
    scatterPoints,
    rankData,
  };
}
