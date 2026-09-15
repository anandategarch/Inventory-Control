'use client';

// ============================================================
//  TrendHeader — ItemTrendTab card header block
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Renders, top → bottom:
//    1. CardTitle: amber TrendingUp icon + "Trend Item" +
//       FormulaInfo + cache/stale/memuat/memuat-rank badges
//    2. Search row: ItemTrendSearchBar + MetricSelector
//    3. Selected-item badge + summary stats (when item selected)
//    4. RankBadgeRow (Phase 1 — item's national rank, when
//       analysisData is available)
// ============================================================

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Package, TrendingUp } from 'lucide-react';
import type { AnalysisData, ItemTrendData, ItemTrendMetric } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { ItemTrendSearchBar } from '../ItemTrendSearchBar';
import { RankBadgeRow } from '../RankBadgeRow';
import type { TrendSummary } from '../hooks/useItemTrendDerived';
import type { ItemTrendAutocompleteState } from '../hooks/useItemTrendAutocomplete';
import { MetricSelector } from './MetricSelector';

interface TrendHeaderProps {
  /** Dashboard filter context — feeds the search bar + autocomplete. */
  monthLabel: string | null;
  currentWeek: string | null;
  /** Selected item (Zustand `trendSelectedItem`). */
  selectedItem: string | null;
  setSelectedItem: (item: string | null) => void;
  /** Search-bar state from useItemTrendAutocomplete (spread onto the bar). */
  ac: ItemTrendAutocompleteState;
  /** Active metric + setter (4-option toggle). */
  metric: ItemTrendMetric;
  setMetric: (m: ItemTrendMetric) => void;
  /** Main trend query result — drives the cache/stale/memuat badges. */
  trendData: ItemTrendData | undefined;
  trendFetching: boolean;
  /** Phase 3 rank query — drives the "Memuat Rank" badge. */
  rankFetching: boolean;
  rankPeriodCount: number;
  /** Summary stats (selected-item badge row). Null when no periods. */
  summary: TrendSummary | null;
  /** Phase 1 — Rank Badge: analysis data from /api/analysis. Optional —
   *  when omitted, the rank badge row is hidden. */
  analysisData?: AnalysisData;
}

export function TrendHeader({
  monthLabel,
  currentWeek,
  selectedItem,
  setSelectedItem,
  ac,
  metric,
  setMetric,
  trendData,
  trendFetching,
  rankFetching,
  rankPeriodCount,
  summary,
  analysisData,
}: TrendHeaderProps) {
  return (
    <CardHeader className="pb-3">
      <CardTitle className="text-sm flex items-center gap-2.5 flex-wrap">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
          <TrendingUp className="h-3.5 w-3.5" />
        </span>
        Trend Item
        <FormulaInfo
          formula="Z-Score = (|Current| - Mean(|Historical same-week|)) / StdDev"
          description="Tren QTY per item lintas SEMUA periode. Baseline Z-Score memakai weekLabel yang sama di bulan lain (W4 vs W4, bukan W4 vs W1). Positif = di atas rata-rata (lebih buruk), negatif = di bawah (lebih baik). Butuh minimal 4 periode untuk Z-Score."
          example="CABAI FROZEN W4 Juli: |Deviasi|=6789, mean W4 historis=5000, stdDev=1000 → Z=+1.79 (ELEVATED)"
          side="bottom"
        />
        {trendData?.cached && (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
            cache
          </Badge>
        )}
        {trendData?.stale && (
          <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
            stale (memvalidasi ulang)
          </Badge>
        )}
        {trendFetching && (
          <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
            <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
            Memuat
          </Badge>
        )}
        {/* Phase 3 — rank fetching badge. Only shown when rank data is
            being fetched AND no rank periods are available yet (SWR
            pattern — once data is loaded, the badge is hidden even on
            background revalidation to avoid flicker). */}
        {rankFetching && rankPeriodCount === 0 && (
          <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
            <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
            Memuat Rank
          </Badge>
        )}
      </CardTitle>

      {/* Search row + metric selector */}
      <div className="flex flex-row items-center gap-2 mt-2">
        <ItemTrendSearchBar
          query={ac.query}
          setQuery={ac.setQuery}
          showDropdown={ac.showDropdown}
          setShowDropdown={ac.setShowDropdown}
          debouncedQuery={ac.debouncedQuery}
          selectedItem={selectedItem}
          setSelectedItem={setSelectedItem}
          acResults={ac.acResults}
          acLoading={ac.acLoading}
          monthLabel={monthLabel}
          currentWeek={currentWeek}
          inputRef={ac.inputRef}
          dropdownRef={ac.dropdownRef}
        />

        {/* Metric selector (toggle buttons — matches HistoricalZScoreCard style) */}
        <MetricSelector metric={metric} setMetric={setMetric} />
      </div>

      {/* Selected item badge + summary stats */}
      {selectedItem && summary && (
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-1">
          <Badge variant="secondary" className="text-xs gap-1">
            <Package className="h-3 w-3" />
            {selectedItem}
          </Badge>
          <span>·</span>
          <span><span className="font-medium tabular-nums text-foreground">{summary.periodCount}</span> periode</span>
          <span>·</span>
          <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">{summary.abnormalCount} abnormal</span>
          <span>·</span>
          <span className="text-amber-600 dark:text-amber-400 font-medium tabular-nums">{summary.warningCount} warning</span>
          <span>·</span>
          <span className="text-yellow-600 dark:text-yellow-400 font-medium tabular-nums">{summary.elevatedCount} elevated</span>
          {summary.withZScore < summary.periodCount && (
            <>
              <span>·</span>
              <span className="text-muted-foreground/70 tabular-nums">
                {summary.periodCount - summary.withZScore} tanpa baseline
              </span>
            </>
          )}
        </div>
      )}

      {/* Phase 1 — Rank Badge row. Only shows when an item is selected AND
          analysisData is available. Hidden for items not in topDeviasiRank
          (shows a muted "Rank > 50" badge instead). */}
      {selectedItem && analysisData && (
        <RankBadgeRow itemName={selectedItem} analysisData={analysisData} />
      )}

      {/* Phase A+B (FLIP-FE) — Flip Summary Card moved to CardContent (UI-10). */}
    </CardHeader>
  );
}
