'use client';

// ============================================================
//  ItemTrendTab — "Trend Item" tab (TREND-FRONTEND)
//  --------------------------------------------------------
//  Per-item QTY fluctuation timeline across ALL periods, with
//  Z-Score (signed) + historical baseline overlay.
//
//  SPLIT-B: this file is now a thin orchestrator (composition of
//  hooks + subcomponents — pure code motion, no behavior change):
//    hooks/useItemTrendAutocomplete  — search state + 300ms debounce
//                                      + Stage-1 autocomplete query
//    hooks/useDrillPeriodSync        — Phase 2 drill-period state
//    hooks/useItemRankTrend          — Phase 3 rank query (/item-trend-rank)
//    hooks/useItemTrendDerived       — periods/satuan/chronological/
//                                      flips/flipScore/sortedRows/summary
//    hooks/useTrendTableSort         — table sort state + toggleSort
//    components/TrendHeader          — card header (badges, search row,
//                                      metric selector, summary, rank badges)
//    components/TrendContentStates   — empty/error/loading/no-data states
//    components/TrendDataView        — loaded-data composition (summary
//                                      card, tracker, charts, table, matrix,
//                                      peer drill-down)
//    FlipRanking/                    — Phase C cross-item widget (bottom)
//
//  State ownership (Phase 1 — Navigation Bridge):
//    `selectedItem` lives in the Zustand store (`trendSelectedItem`)
//    so external components (e.g. RankingNasionalCard) can pre-select
//    an item via `setTrendSelectedItem` + `setActiveTab('item')`
//    (VH-2: the trend view merged into the 'item' tab).
//    This replaces the previous local useState, but the API is
//    unchanged from the SearchBar's perspective (still receives
//    `selectedItem` + `setSelectedItem` as props).
//
//  Barrel: This file IS the barrel for `@/components/dashboard/tabs/ItemTrendTab`
//  (folder + index.tsx — TypeScript moduleResolution "bundler" resolves
//  automatically). Re-exports sub-components + types for reuse.
// ============================================================

import { memo, useState, useCallback } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useItemTrend, type ItemTrendMetric, type ItemTrendPeriod } from '@/hooks/useAnalysis';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { Card, CardContent } from '@/components/ui/card';
// Phase C (FLIP-FE) — cross-item flip ranking widget.
import { FlipRanking } from './FlipRanking';
// SPLIT-B — hooks + view blocks (pure move from this file).
import { useItemTrendAutocomplete } from './hooks/useItemTrendAutocomplete';
import { useDrillPeriodSync } from './hooks/useDrillPeriodSync';
import { useItemRankTrend } from './hooks/useItemRankTrend';
import { useItemTrendDerived } from './hooks/useItemTrendDerived';
import { useTrendTableSort } from './hooks/useTrendTableSort';
import { TrendHeader } from './components/TrendHeader';
import {
  TrendEmptyState,
  TrendErrorState,
  TrendLoadingState,
  TrendNoDataState,
} from './components/TrendContentStates';
import { TrendDataView } from './components/TrendDataView';

// Re-export sub-components + types so callers importing from
// '@/components/dashboard/tabs/ItemTrendTab' can access them.
export { ItemTrendSearchBar } from './ItemTrendSearchBar';
export { ItemTrendTable } from './ItemTrendTable';
export { ItemPeerComparison } from './ItemPeerComparison';
export { ItemTrendRankChart } from './ItemTrendRankChart';
export { FlipMatrix } from './FlipMatrix';
export { FlipRanking } from './FlipRanking';
export { zScoreColor, zScoreStatus } from './zScoreHelpers';
export { periodSortKey, periodShortLabel } from './periodHelpers';
// Phase A+B (FLIP-FE) — flip detection re-exports.
export {
  computeFlipAnalyses,
  computeItemFlipScore,
  getFlipForPeriod,
  getFlipsForPeriod,
  groupPeriodsByWeek,
  formatDisparity,
  flipBadge,
  periodKey as flipPeriodKey,
} from './flipHelpers';
export type { MetricOption, AutocompleteResult, SortKey, SortDir, FlipAnalysis, ItemFlipScore } from './types';
export type { ItemPeerComparisonProps, ItemPeerRow, ItemPeerAverages, ItemPeerComparisonResponse } from './ItemPeerComparison';
export type { ItemTrendRankChartProps } from './ItemTrendRankChart';
export type { FlipMatrixProps } from './FlipMatrix';
export { METRICS } from './types';

// ============================================================
//  ItemTrendTab — main component (orchestrator)
// ============================================================

interface ItemTrendTabProps {
  /** Phase 1 — Rank Badge: analysis data from /api/analysis (used to
   *  look up the selected item's national rank in topDeviasiRank).
   *  Optional — when omitted, the rank badge row is hidden. */
  analysisData?: AnalysisData;
}

function ItemTrendTabImpl({ analysisData }: ItemTrendTabProps) {
  // Pull dashboard filters (month/week + filter context) so the trend
  // respects the user's current selection. The trend API takes month+week
  // purely for cache-key context (the response covers ALL periods), and
  // area/kelompok/outlet/pic to scope the records.
  //
  // Phase 1 — Navigation Bridge: also pull `trendSelectedItem` +
  // `setTrendSelectedItem` + `setFocusOutlet` from the store so external
  // components can pre-select an item (RankingNasionalCard) and so the
  // peer table rows can navigate to the Resto Analysis tab.
  const {
    monthLabel, currentWeek, area, kelompok, outletCode, pic,
    trendSelectedItem: selectedItem, setTrendSelectedItem: setSelectedItem,
    setFocusOutlet,
  } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
    trendSelectedItem: s.trendSelectedItem,
    setTrendSelectedItem: s.setTrendSelectedItem,
    setFocusOutlet: s.setFocusOutlet,
  })));

  // Local UI state (not in Zustand — only the Trend Item tab cares about these).
  const [metric, setMetric] = useState<ItemTrendMetric>('qtyDeviasi');

  // Stage 1: autocomplete (debounced 300ms) — search bar state + query.
  const ac = useItemTrendAutocomplete({ monthLabel, currentWeek, selectedItem });

  // Stage 2: trend data (only fires when an item is selected).
  const trend = useItemTrend({
    itemName: selectedItem,
    metric,
    month: monthLabel,
    week: currentWeek,
    area,
    kelompok,
    outletCode,
    pic,
  });

  // Stage 3 (Phase 3) — rank trend data (parallel with the main trend query).
  const { rankPeriods, rankFetching } = useItemRankTrend({
    selectedItem,
    currentWeek,
    area,
    kelompok,
    outletCode,
    pic,
  });

  // Phase 2 — drill period state (auto-syncs with the dashboard period).
  const { drillPeriod, setDrillPeriod } = useDrillPeriodSync(monthLabel, currentWeek);

  // Table sort state (default period asc — chronological, matches chart).
  const { sortKey, sortDir, toggleSort } = useTrendTableSort();

  // Derived data: periods/satuan/chronological/flips/flipScore/sortedRows/summary.
  const { periods, satuan, chronological, flips, flipScore, sortedRows, summary } =
    useItemTrendDerived({ data: trend.data, sortKey, sortDir });

  // Phase 2 — drill-down callbacks. Both row click + chart dot click set
  // the same `drillPeriod` state, which triggers ItemPeerComparison to
  // fetch + render.
  const handlePeriodDrill = useCallback((p: ItemTrendPeriod) => {
    setDrillPeriod({ month: p.monthLabel, week: p.weekLabel });
  }, [setDrillPeriod]);

  // Phase 2 — peer table row click. Uses setFocusOutlet which both sets
  // the focus outlet AND switches activeTab to 'resto' (see useDashboard).
  const handleOutletClick = useCallback((outletCode: string) => {
    setFocusOutlet(outletCode);
  }, [setFocusOutlet]);

  // ----------------------------------------------------------
  //  Render
  // ----------------------------------------------------------

  return (
    <div className="space-y-4">
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <TrendHeader
        monthLabel={monthLabel}
        currentWeek={currentWeek}
        selectedItem={selectedItem}
        setSelectedItem={setSelectedItem}
        ac={ac}
        metric={metric}
        setMetric={setMetric}
        trendData={trend.data}
        trendFetching={trend.isFetching}
        rankFetching={rankFetching}
        rankPeriodCount={rankPeriods.length}
        summary={summary}
        analysisData={analysisData}
      />

      <CardContent className="p-0">
        {!selectedItem ? (
          <TrendEmptyState />
        ) : trend.error ? (
          <TrendErrorState message={trend.error.message} onRetry={() => { void trend.refetch(); }} />
        ) : trend.isLoading && periods.length === 0 ? (
          <TrendLoadingState />
        ) : periods.length === 0 ? (
          <TrendNoDataState selectedItem={selectedItem} />
        ) : (
          <TrendDataView
            selectedItem={selectedItem}
            periods={periods}
            chronological={chronological}
            metric={metric}
            flips={flips}
            flipScore={flipScore}
            satuan={satuan}
            rankPeriods={rankPeriods}
            sortedRows={sortedRows}
            sortKey={sortKey}
            sortDir={sortDir}
            toggleSort={toggleSort}
            drillPeriod={drillPeriod}
            setDrillPeriod={setDrillPeriod}
            onPeriodDrill={handlePeriodDrill}
            outletCode={outletCode}
            area={area}
            kelompok={kelompok}
            pic={pic}
            onOutletClick={handleOutletClick}
          />
        )}
      </CardContent>
    </Card>

    {/* Phase C — Flip Ranking cross-item widget.
        Renders at the bottom of the Trend Item Tab.
        Shows top items by flip risk score (sempurna flips = suspicious).
        Clicking a row selects that item for trend analysis above. */}
    <FlipRanking />
    </div>
  );
}

export const ItemTrendTab = memo(ItemTrendTabImpl);
