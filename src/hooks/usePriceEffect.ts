'use client';

// ============================================================
//  usePriceEffect — THE single /api/price-effect fetch
//  --------------------------------------------------------
//  Extracted from PriceEffectCard's inline useQuery (same pattern
//  as useRecommendations H-11/#4b) so a SECOND consumer — the
//  GrowthComparison card's "Harga (AVG)" metric + its per-item
//  price drill-down — reuses the SAME queryKey + queryFn.
//
//  TanStack Query dedupes concurrent observers on one key, so
//  PriceEffectCard (DIAGNOSTIC EVIDENCE, primary row) and
//  GrowthComparison (supporting row) sharing this hook means
//  ONE request + ONE cache entry per scope.
//
//  Scope = the dashboard filter state (month/week/compare +
//  area/kelompok/outlet/pic) — identical semantics to the card's
//  original inline query (staleTime 5 min, gcTime 10 min,
//  keepPreviousData, enabled gated on month+week).
// ============================================================

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import { useDashboard } from './useDashboard';
import type { PriceEffectItem, PriceEffectSummary } from '@/lib/queries/price-effect';

export type { PriceEffectItem, PriceEffectSummary };

/** /api/price-effect envelope — PriceEffectResult + route metadata. */
export interface PriceEffectResponse {
  success: boolean;
  summary: PriceEffectSummary;
  items: PriceEffectItem[];
  durationMs: number;
  error?: string;
  cached?: boolean;
  stale?: boolean;
}

/**
 * ONE queryKey builder for every /api/price-effect consumer.
 * The `null` placeholders keep the array shape stable regardless
 * of optional fields (mirrors recommendationsKey).
 */
export function priceEffectKey(scope: {
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonMonth: string | null;
  comparisonWeek: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
}): unknown[] {
  return [
    'price-effect',
    scope.monthLabel ?? null,
    scope.currentWeek ?? null,
    scope.comparisonMonth ?? null,
    scope.comparisonWeek ?? null,
    scope.area ?? null,
    scope.kelompok ?? null,
    scope.outletCode ?? null,
    scope.pic ?? null,
  ];
}

export function usePriceEffect() {
  const { monthLabel, currentWeek, comparisonMonth, comparisonWeek, area, kelompok, outletCode, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonMonth: s.comparisonMonth,
    comparisonWeek: s.comparisonWeek,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
  })));

  return useQuery<PriceEffectResponse>({
    queryKey: priceEffectKey({ monthLabel, currentWeek, comparisonMonth, comparisonWeek, area, kelompok, outletCode, pic }),
    queryFn: async () => {
      const month = monthLabel ?? '';
      const week = currentWeek ?? '';
      if (!month || !week) throw new Error('Bulan dan minggu belum dipilih');
      const p = new URLSearchParams();
      p.set('month', month);
      p.set('week', week);
      if (comparisonWeek && comparisonMonth) {
        p.set('compareWeek', comparisonWeek);
        p.set('compareMonth', comparisonMonth);
      }
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode && outletCode !== 'all') p.set('outlet', outletCode);
      if (pic && pic !== 'all') p.set('pic', pic);
      const res = await fetch(`/api/price-effect?${p.toString()}`);
      if (!res.ok) throw new Error('Gagal memuat data efek harga');
      return res.json() as Promise<PriceEffectResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
}
