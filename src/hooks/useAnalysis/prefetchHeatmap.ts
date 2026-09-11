'use client';

// ============================================================
//  PERF-OPT: prefetchHeatmap
//  --------------------------------------------------------
//  Fires a background fetch for the heatmap API so that when the
//  user scrolls down to the heatmap card, data is already cached.
//  Uses the SAME queryKey shape as AreaItemHeatmap's useQuery.
//
//  FIX (H-12 / prefetchHeatmap filter mismatch): the prefetch used to omit
//  area/kelompok/outlet/pic, so its queryKey matched the card's ONLY when
//  no filter was active — with any filter active the prefetch was a wasted
//  /api/area-item-heatmap round-trip (different key, rows never used) and
//  the card still did its own fetch on mount. The filter params are now
//  accepted and normalized EXACTLY like AreaItemHeatmap/index.tsx's params
//  ('all'/null → omitted, value → included) so the warmed key always
//  matches the card's live key for the same filter state.
//
//  Source: extracted from src/hooks/useAnalysis.ts (split by
//  Task ID 3-a). Standalone — no internal useAnalysis deps.
// ============================================================
import type { QueryClient } from '@tanstack/react-query';

export function prefetchHeatmap(
  queryClient: QueryClient,
  params: {
    month: string | null;
    week: string | null;
    /** Dashboard filters — normalized identically to AreaItemHeatmap's params. */
    area?: string | null;
    kelompok?: string | null;
    outletCode?: string | null;
    pic?: string | null;
  },
): void {
  if (!params.month || !params.week) return;
  const p = new URLSearchParams();
  p.set('month', params.month);
  p.set('week', params.week);
  p.set('metric', 'absNominalDeviasi');
  p.set('itemLimit', '20');
  p.set('mode', 'pareto80');
  // Mirror AreaItemHeatmap/index.tsx's param building EXACTLY (incl. the
  // 'all' sentinel normalization) — the queryKey is p.toString(), so any
  // divergence here desyncs the prefetch from the card's query.
  if (params.area && params.area !== 'all') p.set('area', params.area);
  if (params.kelompok && params.kelompok !== 'all') p.set('kelompok', params.kelompok);
  if (params.outletCode && params.outletCode !== 'all') p.set('outlet', params.outletCode);
  if (params.pic && params.pic !== 'all') p.set('pic', params.pic);
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
