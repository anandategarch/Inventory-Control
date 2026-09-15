'use client';

// ============================================================
//  useItemRankTrend — Stage 3 (Phase 3) rank trend query
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Fires in parallel with the main trend data
//  (independent query key + endpoint). Returns the item's
//  national rank (by ABS(nominalDeviasi)) for each period, used
//  by the compact ItemTrendRankChart below the main chart.
//
//  Same filter shape as the main trend query (item + month/week
//  context + area/kelompok/outlet/pic scoping) so the rank data
//  matches the user's current filter selection.
// ============================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

/** One period in the /api/item-trend-rank response. */
export interface ItemTrendRankPeriod {
  monthLabel: string;
  weekLabel: string;
  monthKey: string | null;
  rankNominal: number;
  totalItems: number;
  absNominal: number;
}

export interface ItemTrendRankResponse {
  success: boolean;
  periods: ItemTrendRankPeriod[];
}

export interface UseItemRankTrendParams {
  selectedItem: string | null;
  currentWeek: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
}

export function useItemRankTrend({
  selectedItem,
  currentWeek,
  area,
  kelompok,
  outletCode,
  pic,
}: UseItemRankTrendParams) {
  const { data: rankData, isFetching: rankFetching } = useQuery({
    // FIX (BUG-3-06): month is NOT included in queryKey — the rank query
    // ignores month (returns ALL months for the selected week). Including
    // month would cause unnecessary refetch + duplicate cache entries
    // when the user changes month.
    queryKey: ['item-trend-rank', selectedItem, currentWeek, area, kelompok, outletCode, pic],
    queryFn: async () => {
      // Guard: enabled=Boolean(selectedItem) guarantees selectedItem is
      // non-null here, but TypeScript can't infer that across the closure.
      // Using a local guard avoids the non-null assertion (`selectedItem!`)
      // while still being type-safe.
      if (!selectedItem) throw new Error('No item selected');
      const p = new URLSearchParams({ item: selectedItem });
      if (currentWeek) p.set('week', currentWeek);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode) p.set('outlet', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/item-trend-rank?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ItemTrendRankResponse>;
    },
    // Only fire when an item is selected — avoids burning a request on tab mount.
    enabled: Boolean(selectedItem),
    // 5-min staleTime matches the server DB cache TTL (same as useItemTrend).
    staleTime: 5 * 60 * 1000,
    // 10-min gcTime — keep the data in memory across tab switches.
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Phase 3 — rank periods (memoized for the same reason as the main trend
  // `periods` in useItemTrendDerived: stable ref avoids downstream re-renders).
  const rankPeriods = useMemo(
    () => rankData?.periods ?? [],
    [rankData?.periods],
  );

  return { rankPeriods, rankFetching };
}
