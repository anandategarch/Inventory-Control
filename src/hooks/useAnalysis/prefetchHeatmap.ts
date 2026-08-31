'use client';

// ============================================================
//  PERF-OPT: prefetchHeatmap
//  --------------------------------------------------------
//  Fires a background fetch for the heatmap API so that when the
//  user scrolls down to the heatmap card, data is already cached.
//  Uses the SAME queryKey shape as AreaItemHeatmap's useQuery.
//
//  Source: extracted from src/hooks/useAnalysis.ts (split by
//  Task ID 3-a). Standalone — no internal useAnalysis deps.
// ============================================================
import type { QueryClient } from '@tanstack/react-query';

export function prefetchHeatmap(
  queryClient: QueryClient,
  params: { month: string | null; week: string | null },
): void {
  if (!params.month || !params.week) return;
  const p = new URLSearchParams();
  p.set('month', params.month);
  p.set('week', params.week);
  p.set('metric', 'absNominalDeviasi');
  p.set('itemLimit', '20');
  p.set('mode', 'pareto80');
  void queryClient.prefetchQuery({
    queryKey: ['area-item-heatmap', p.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/area-item-heatmap?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
