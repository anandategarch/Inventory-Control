'use client';

// ============================================================
//  RestoAnalysis — main component
//  Shows: outlet header + Priority Summary + Resto Profile (6
//  cards) + Menu Analysis + Bahan Analysis (3 rankings) +
//  Ranking Nasional + Item Detail Modal.
//
//  Phase 3 split: sub-components live in ./resto-analysis/*
//  (shared helpers/types/modal/menu/ranking).
//  SPLIT-G: this file is now the folder entry (index.tsx) — the
//  card-level JSX blocks live in sibling modules (state-cards,
//  outlet-header-card, profile-cards, bahan-analysis-card).
//  Import path '@/components/dashboard/RestoAnalysis' resolves
//  here (folder + index.tsx) — caller imports unchanged. This
//  file re-exports types for backward compatibility.
// ============================================================

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Gauge, Store } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { PrioritySummaryCard } from '@/components/dashboard/PrioritySummaryCard';
import { SectionHeader } from '@/components/dashboard/shared';
import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import { useMemo, useState } from 'react';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useStatus } from '@/hooks/useAnalysis';
import { useRecommendations, useSharedRecommendationForOutlet } from '@/hooks/useRecommendations';

import type {
  OutletItemsResponse,
  RestoProfile, ItemRow, ItemHistoryTimelineRow, ItemHistoryResponse,
} from '@/components/dashboard/resto-analysis/types';
import { MenuAnalysis } from '@/components/dashboard/resto-analysis/menu-analysis';
import { RankingNasionalCard } from '@/components/dashboard/resto-analysis/ranking-nasional';
import { ItemDetailModal } from '@/components/dashboard/resto-analysis/item-detail-modal';
import { NoOutletCard, NoPeriodCard, LoadingCard, ErrorCard } from './state-cards';
import { OutletHeaderCard } from './outlet-header-card';
import { ProfileCards } from './profile-cards';
import { BahanAnalysisCard } from './bahan-analysis-card';

// Backward-compat re-exports (no external file imports types from here today,
// but keep them exported so future imports don't break).
// H-11 (#4b): RecommendationResponse dropped from this re-export list — the
// recommendations fetch moved to the shared hook
// (src/hooks/useRecommendations.ts) which owns the canonical response type.
export type {
  OutletItemsResponse,
  RestoProfile, ItemRow, ItemHistoryTimelineRow, ItemHistoryResponse,
};

export function RestoAnalysis({ analysisData }: { analysisData?: AnalysisData }) {
  // H-11 (#4b): area/kelompok/pic no longer destructured here — the
  // recommendations fetch moved to the shared hook (which reads them from
  // useDashboard itself); the outlet-items query doesn't use them.
  // UX-RESTOFILTER-1 (user request 2025-12): area/kelompok/pic ARE back for
  // the in-tab Filter Resto outlet list consistency filter, plus
  // setFocusOutlet for the picker itself.
  const { focusOutlet, outletCode, monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, pic, setFocusOutlet } = useDashboard(useShallow((s) => ({
    focusOutlet: s.focusOutlet,
    outletCode: s.outletCode,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonWeek: s.comparisonWeek,
    comparisonMonth: s.comparisonMonth,
    area: s.area,
    kelompok: s.kelompok,
    pic: s.pic,
    setFocusOutlet: s.setFocusOutlet,
  })));
  // Use focusOutlet (from table click) OR outletCode (from FilterBar dropdown)
  const activeOutlet = focusOutlet || outletCode;
  const [rankingTab, setRankingTab] = useState('financial');
  const [selectedItem, setSelectedItem] = useState<{ outletCode: string; itemName: string } | null>(null);

  // UX-RESTOFILTER-1: outlet list for the in-tab picker. Mirrors the global
  // FilterBar exactly — useStatus cache (no extra request) + the same
  // area/pic/kelompok consistency filter (BUG-FE-2), so the dropdown never
  // offers an outlet the active filters would hide.
  const { data: status } = useStatus();
  const outletOptions = useMemo(() => (status?.outlets || []).filter((o) => {
    if (area && o.area !== area) return false;
    if (pic && o.pic !== pic) return false;
    if (kelompok) {
      // Same extraction as backend + FilterBar: last dot-segment, first 3 chars
      const segs = o.code.split('.');
      const oKelompok = (segs[segs.length - 1] || '').substring(0, 3).toUpperCase();
      if (oKelompok !== kelompok.toUpperCase()) return false;
    }
    return true;
  }), [status?.outlets, area, pic, kelompok]);

  /** UX-RESTOFILTER-1: the in-tab Resto picker — picks the outlet this tab
   *  analyzes (setFocusOutlet scopes ONLY this tab; it does not refilter
   *  the whole dashboard the way the global FilterBar outlet does). */
  const restoPicker = (className: string) => (
    <SearchableComboBox
      options={outletOptions.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}`, description: o.area }))}
      value={activeOutlet}
      onValueChange={(code) => setFocusOutlet(code)}
      placeholder="Pilih resto..."
      searchPlaceholder="Cari resto (kode/nama)..."
      emptyText="Resto tidak ditemukan."
      allOptionLabel={`Semua / Reset pilihan (${outletOptions.length})`}
      buttonClassName={className}
      ariaLabel="Filter resto"
    />
  );

  const { data, isLoading, isFetching, error, refetch } = useQuery<OutletItemsResponse>({
    queryKey: ['outlet-items', activeOutlet, monthLabel, currentWeek, comparisonWeek, comparisonMonth],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      p.set('week', currentWeek!);
      if (comparisonWeek) p.set('compareWeek', comparisonWeek);
      if (comparisonMonth) p.set('compareMonth', comparisonMonth);
      const res = await fetch(`/api/outlet-items?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<OutletItemsResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
    // PERF-FE (PAKET A): outlet data only changes on ingest / manual refresh
    // (handleRefresh invalidates ['outlet-items']) — not every 30s. Without
    // an explicit staleTime this fell back to the 30s global default and
    // refetched whenever the user re-entered the Resto tab after >30s.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    // FIX (BUG-FE-5): keepPreviousData for smooth transition on filter change
    placeholderData: keepPreviousData,
  });

  // H-11 (#4b): ONE recommendations fetch for the whole app. First PEEK the
  // shared (unscoped) response the Dashboard's Resto Prioritas card already
  // cached — when the focused outlet is in that top-5 list, NO extra request
  // is made at all (dashboard → click resto → Resto tab = zero extra fetch,
  // previously a limit=1 refetch of data the app already had). Only when the
  // outlet is NOT in the shared list does the scoped query fire — and it uses
  // the SAME key + limit shape as the Dashboard card, so when a global outlet
  // filter is active both tabs dedupe into ONE request + ONE server cache
  // row (was: limit 5 vs limit 1 → two cache rows, double compute).
  // FIX INT-1 (kept): area + pic + kelompok params ride along in the shared
  // hook so Signal 1 (Dev/BOM vs Peer) uses the correct network scope.
  const sharedReco = useSharedRecommendationForOutlet(activeOutlet);
  const { data: recoData } = useRecommendations(activeOutlet, {
    enabled: Boolean(activeOutlet) && !sharedReco,
  });
  const recommendation = sharedReco
    ?? (recoData?.success && recoData.recommendations && recoData.recommendations.length > 0
      ? recoData.recommendations[0]
      : null);

  if (!activeOutlet) {
    return <NoOutletCard>{restoPicker('w-full')}</NoOutletCard>;
  }

  // Bug 6.9 fix: show "select period" message instead of error when week not selected
  if (!monthLabel || !currentWeek) {
    return <NoPeriodCard />;
  }

  if (isLoading) {
    return <LoadingCard />;
  }

  if (error || !data?.success) {
    // P23 D5: 'Unknown' fallback → 'Tidak diketahui'; P23 D6 (LEFTOVER #5):
    // wire the outlet-items query's refetch into ErrorCard's "Coba Lagi"
    // button (same wiring as peer-table-card's onRetryMain).
    return <ErrorCard message={error?.message || data?.error || 'Tidak diketahui'} onRetry={() => { void refetch(); }} />;
  }

  // CRITICAL null guards: server occasionally returns partial payloads (e.g. during
  // ingest race conditions).
  // FIX (BUG-2-a #2): `data.restoProfile ?? ({} as RestoProfile)` was a FAKE
  // guard — the `as` cast only silenced the compiler while the nested
  // `profile.investigation.healthScore` (and ~21 more `profile.x.y` accesses
  // in the 6 Profil Outlet cards below) still threw TypeError on exactly the
  // partial-payload case this comment documents. `profile` is now honestly
  // `RestoProfile | null`: the 6 profile cards + the header health ring
  // render ONLY with a full profile, a partial-state notice takes their
  // place, and the rest of the tab (Bahan Analysis, Menu Analysis, Ranking
  // Nasional) keeps rendering.
  const profile: RestoProfile | null = data.restoProfile ?? null;
  const rankings: { financial: ItemRow[]; operational: ItemRow[]; unexplained: ItemRow[] } =
    data.rankings ?? { financial: [], operational: [], unexplained: [] };
  const currentRanking = rankings[rankingTab as keyof typeof rankings] || [];

  return (
    <div className="space-y-4">
      {/* UX-RESTOFILTER-1 (user request 2025-12): Filter Resto — in-tab outlet
          picker. Switching outlets here scopes ONLY this tab (focusOutlet),
          unlike the global FilterBar outlet which refilters the dashboard. */}
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="py-2.5">
          <div className="flex flex-row items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
              <Store className="h-3.5 w-3.5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">Filter Resto</p>
              <p className="text-[11px] text-muted-foreground">Pilih outlet untuk dianalisis — periode mengikuti Bulan/Minggu aktif.</p>
            </div>
            <div className="w-80">{restoPicker('w-full')}</div>
          </div>
        </CardContent>
      </Card>

      {/* Header */}
      <OutletHeaderCard data={data} profile={profile} isFetching={isFetching} isLoading={isLoading} />

      {/* FIX DRILLDOWN: Priority Summary card — shows WHY this outlet is priority
          (score, level, signals, analysis bullets, 15-signal breakdown).
          UX-DRILLDOWN-1: outletItems prop dropped — the per-signal drill-down
          charts were removed from the card. */}
      <PrioritySummaryCard recommendation={recommendation} />

      {/* Resto Profile — 6 Sections */}
      {/* VH-7: section header — the tab interior tells a story per section
          (Metabase "a tab = a set of related questions"). */}
      <SectionHeader
        icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
        title="Profil Outlet"
        description="Bagaimana kondisi outlet terpilih — performa, perilaku, historis, benchmark, dan risiko item?"
      />
      {/* FIX (BUG-2-a #2): the 6 profile cards only render with a full
          restoProfile — on a partial payload (ingest race) a partial-state
          notice takes their place instead of the old `as`-cast TypeError
          that killed the whole Resto tab. */}
      <ProfileCards profile={profile} allItems={data.allItems} />

      {/* Menu Analysis — Phase 3: Group by menu + outlier detection */}
      {activeOutlet && (
        <MenuAnalysis outletCode={activeOutlet} monthLabel={monthLabel || ''} currentWeek={currentWeek || ''} onSelectItem={setSelectedItem} allItemsData={data} />
      )}

      {/* Bahan Analysis — 3 Rankings */}
      <BahanAnalysisCard
        rankingTab={rankingTab}
        onRankingTabChange={setRankingTab}
        currentRanking={currentRanking}
        onSelectItem={setSelectedItem}
        activeOutlet={activeOutlet}
      />

      {/* Ranking Item Nasional — top 30 deviasi items for this outlet (national rank + peer benchmark) */}
      {activeOutlet && (
        <RankingNasionalCard key={activeOutlet} focusOutlet={activeOutlet} analysisData={analysisData} outletDeviasiRank={data?.topDeviasiRank} />
      )}

      {/* Item Detail Modal — Phase 2: Historical + Benchmark per bahan */}
      {selectedItem && (
        <ItemDetailModal
          outletCode={selectedItem.outletCode}
          itemName={selectedItem.itemName}
          month={monthLabel || ''}
          week={currentWeek || ''}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}
