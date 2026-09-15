'use client';

// ============================================================
//  OutletPriorityPanel — lens data hook
//  (split from OutletPriorityPanel.tsx — SPLIT-G; pure code motion)
//
//  One hook owning the data side of the four lenses:
//    - Prioritas: /api/recommendations via useRecommendations
//      (the SHARED hook — dedupes with ExecutiveStatus + the
//      Resto tab's scoped query; same outletCode scoping as the
//      old card) + the D6 adaptive default count.
//    - Kondisi: analysis payload outletHealthRanking, worst-first.
//    - Peluang Rp: /api/benchmark-opportunity, LENS-GATED fetch
//      (fires only when the lens is first activated).
//    - Perubahan (CHANGE-1): /api/change-analysis, LENS-GATED
//      fetch — same pattern as Peluang Rp.
// ============================================================

import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useRecommendations, type RestoRecommendation } from '@/hooks/useRecommendations';
import type { BenchmarkOpportunityResponse } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';
import type { ChangeAnalysisResponse, ChangeOutletStat } from '@/components/dashboard/narrative/ChangeItemTable';
import type { AnalysisData } from '@/hooks/useAnalysis';
import type { Lens } from './lens-model';

export interface UseLensDataParams {
  lens: Lens;
  data: AnalysisData;
  outletCode: string | null;
  monthLabel: string | null;
  currentWeek: string | null;
  kelompok: string | null;
}

export function useLensData({ lens, data, outletCode, monthLabel, currentWeek, kelompok }: UseLensDataParams) {
  // ------------------------------------------------------------
  //  Lens 1 — Prioritas (shared recommendations fetch; same queryKey
  //  + outletCode scoping as the old RestoRecommendationCard, so it
  //  dedupes with ExecutiveStatus + the Resto tab's scoped query).
  // ------------------------------------------------------------
  const { data: resp, isLoading: recLoading, error: recError, refetch: recRefetch } = useRecommendations(outletCode);
  // P3-HYG-7a: pin list identities so the memos below are stable.
  const recommendations = useMemo<RestoRecommendation[]>(() => resp?.recommendations ?? [], [resp?.recommendations]);

  const totalDev = data.costImpact?.totalCost ?? null;

  // D6 adaptive default (same rule as the old card + ItemPriorityPanel):
  // top-3, or 5 when the top-3's |nominal deviasi| is < 50% of the
  // network total (costImpact.totalCost; fallback plain 3 when absent).
  const defaultCount = useMemo(() => {
    if (recommendations.length <= 3) return 3;
    if (totalDev != null && totalDev > 0) {
      const top3 = recommendations.slice(0, 3).reduce((sum, r) => sum + Math.abs(r.metrics.nominalDeviasi), 0);
      if (top3 / totalDev < 0.5) return 5;
    }
    return 3;
  }, [recommendations, totalDev]);

  // ------------------------------------------------------------
  //  Lens 2 — Kondisi (analysis payload; worst-first like the Area
  //  tab's full table — lowest healthScore first).
  // ------------------------------------------------------------
  const healthRanking = useMemo(
    () => (data.outletHealthRanking || []).slice().sort((a, b) => a.healthScore - b.healthScore),
    [data.outletHealthRanking],
  );

  // ------------------------------------------------------------
  //  Lens 3 — Peluang Rp (LENS-GATED fetch: enabled only when the
  //  lens is active — no new eager initial-load request. Same params
  //  + staleTime as the Peer tab's BenchmarkOpportunityCard query,
  //  so an already-visited Peer tab shares the cache entry.)
  // ------------------------------------------------------------
  const isPeluang = lens === 'peluang';
  const { data: oppResp, isLoading: oppLoading, error: oppError, refetch: oppRefetch } = useQuery<BenchmarkOpportunityResponse>({
    queryKey: ['peer-comparison', 'benchmark-opportunity', monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      if (!monthLabel || !currentWeek) throw new Error('Periode belum dipilih');
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/benchmark-opportunity?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<BenchmarkOpportunityResponse>;
    },
    enabled: isPeluang && Boolean(monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  const opportunities = useMemo(
    () => (oppResp?.topOutlets || []).slice().sort((a, b) => b.opportunityRp - a.opportunityRp),
    [oppResp?.topOutlets],
  );

  // ------------------------------------------------------------
  //  Lens 4 — Perubahan (CHANGE-1, LENS-GATED fetch — same pattern
  //  as Peluang Rp: fires only when the lens is first activated).
  // ------------------------------------------------------------
  const isPerubahan = lens === 'perubahan';
  const { data: chgResp, isLoading: chgLoading, error: chgError, refetch: chgRefetch } = useQuery<ChangeAnalysisResponse>({
    queryKey: ['change-analysis', monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      if (!monthLabel || !currentWeek) throw new Error('Periode belum dipilih');
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/change-analysis?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<ChangeAnalysisResponse>;
    },
    enabled: isPerubahan && Boolean(monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  // DATA_KURANG rows stay out of the list — the footer counts them.
  const changeOutlets = useMemo(
    () => (chgResp?.outlets || []).filter((o: ChangeOutletStat) => o.status !== 'DATA_KURANG'),
    [chgResp?.outlets],
  );

  return {
    // Lens 1 — Prioritas
    recommendations,
    recLoading,
    recError,
    recRefetch,
    defaultCount,
    totalDev,
    // Lens 2 — Kondisi
    healthRanking,
    // Lens 3 — Peluang Rp
    oppResp,
    oppLoading,
    oppError,
    oppRefetch,
    opportunities,
    // Lens 4 — Perubahan
    chgResp,
    chgLoading,
    chgError,
    chgRefetch,
    changeOutlets,
  };
}
