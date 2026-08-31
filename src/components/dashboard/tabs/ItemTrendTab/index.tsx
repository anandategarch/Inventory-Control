'use client';

// ============================================================
//  ItemTrendTab — "Trend Item" tab (TREND-FRONTEND).
//  --------------------------------------------------------
//  Per-item QTY fluctuation timeline across ALL periods, with
//  Z-Score (signed) + historical baseline overlay.
//
//  Layout (top → bottom):
//    1. Search bar (debounced autocomplete via /api/item-search)
//       + 4-option metric selector (QTY Deviasi / Waste / Susut / Trial)
//    2. Selected-item badge (with clear button) + cache/fetch badges
//    3. Rank badge row (Phase 1) — shows the item's national rank in
//       topDeviasiRank (Rank #N Nasional Deviasi / Rank #M BOM /
//       K outlet terdampak top-50). Only shown when an item is
//       selected AND analysisData is available.
//    4. Empty state if no item selected
//    5. Line chart (Recharts, lazy-loaded):
//         - X  = period (Jun W4, Jul W4, …)
//         - Y1 = selected metric's QTY value (solid amber line)
//         - Y2 = Z-Score (right axis; color-coded dots)
//         - ReferenceLine (dashed, muted) per-period = historical mean
//         - Dot color: red (z>2), amber (1<z≤2), yellow (0<z≤1),
//                      green (z≤0), muted (z=null)
//         - Click dot/area → setDrillPeriod (Phase 2)
//    6. Sortable data table (Period | QTY BOM | QTY Deviasi signed |
//       Z-Score | Status | Outlets | Pola | Records)
//         - Pola column (Phase 1): Massal ≥10 / Regional ≥5 / Lokal ≥2 / Tunggal =1
//         - Row click → setDrillPeriod (Phase 2)
//         - drillPeriod-matching row highlighted
//    7. ItemPeerComparison panel (Phase 2) — renders below the table
//       when both `selectedItem` AND `drillPeriod` are set. Fetches
//       from /api/item-peer-comparison and shows 4 analysis cards +
//       peer table. Rows in the peer table are clickable → switches
//       to Resto Analysis tab with that outlet focused.
//
//  Data flow:
//    useItemTrend (TanStack Query) → /api/item-trend
//    ItemAutocomplete (TanStack Query) → /api/item-search?mode=autocomplete
//    ItemPeerComparison (TanStack Query) → /api/item-peer-comparison
//
//  State ownership (Phase 1 — Navigation Bridge):
//    `selectedItem` lives in the Zustand store (`trendSelectedItem`)
//    so external components (e.g. RankingNasionalCard) can pre-select
//    an item via `setTrendSelectedItem` + `setActiveTab('trend')`.
//    This replaces the previous local useState, but the API is
//    unchanged from the SearchBar's perspective (still receives
//    `selectedItem` + `setSelectedItem` as props).
//
//  Patterns reused from existing dashboard:
//    - React.memo + ErrorBoundary + FetchAware (RestoTab pattern)
//    - zScoreColor + zScoreBadge (HistoricalZScoreCard pattern)
//    - Metric selector toggle buttons (HistoricalZScoreCard pattern)
//    - next/dynamic lazy-load for Recharts (DashboardTab pattern)
//    - useDeferredValue debounce (GlobalItemSearchModal pattern)
//
//  Barrel: This file IS the barrel for `@/components/dashboard/tabs/ItemTrendTab`
//  (folder + index.tsx — TypeScript moduleResolution "bundler" resolves
//  automatically). Re-exports sub-components + types for reuse.
// ============================================================

import { memo, useState, useMemo, useCallback, useDeferredValue, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Info, Loader2, Package, TrendingUp, Award } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useItemTrend, type ItemTrendMetric, type ItemTrendPeriod } from '@/hooks/useAnalysis';
import type { AnalysisData, DeviasiRankItem } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';

// Sub-components + helpers extracted in this folder split (Task ID 3-c).
import { ItemTrendSearchBar } from './ItemTrendSearchBar';
import { ItemTrendTable } from './ItemTrendTable';
import { METRICS, type AutocompleteResult, type SortKey, type SortDir } from './types';
import { periodSortKey } from './periodHelpers';
// Phase 2 — peer comparison drill-down panel.
import { ItemPeerComparison } from './ItemPeerComparison';

// Re-export sub-components + types so callers importing from
// '@/components/dashboard/tabs/ItemTrendTab' can access them.
export { ItemTrendSearchBar } from './ItemTrendSearchBar';
export { ItemTrendTable } from './ItemTrendTable';
export { ItemPeerComparison } from './ItemPeerComparison';
export { zScoreColor, zScoreStatus } from './zScoreHelpers';
export { periodSortKey, periodShortLabel } from './periodHelpers';
export type { MetricOption, AutocompleteResult, SortKey, SortDir } from './types';
export type { ItemPeerComparisonProps, ItemPeerRow, ItemPeerAverages, ItemPeerComparisonResponse } from './ItemPeerComparison';
export { METRICS } from './types';

// Recharts is 5.4MB — lazy-load the chart component so it stays out of
// the main bundle. LoadingChart fallback reserves layout space.
const ItemTrendLineChart = dynamic(() => import('../ItemTrendLineChart').then(m => m.ItemTrendLineChart), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-72">
      <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
    </div>
  ),
});

// ============================================================
//  Phase 1 — Rank badge (national rank for selected item)
//  --------------------------------------------------------
//  Looks up the selected item in `analysisData.topDeviasiRank`
//  (national top-50 per item-outlet pair). Shows:
//    [Rank #N Nasional (Deviasi)] [Rank #M (BOM)] [K outlet terdampak]
//  When the item is not in the top-50, shows a muted "Rank > 50 Nasional" badge.
//
//  Color thresholds:
//    rank 1-5   → red (severe)
//    rank 6-20  → amber (warning)
//    rank > 20  → muted (elevated but not critical)
// ============================================================

function rankBadgeClass(rank: number | null): string {
  if (rank == null || rank > 50) return 'text-muted-foreground border-border bg-muted/40';
  if (rank <= 5) return 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30';
  if (rank <= 20) return 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30';
  return 'text-muted-foreground border-border bg-muted/40';
}

interface RankBadgeRowProps {
  itemName: string;
  analysisData?: AnalysisData;
}

function RankBadgeRow({ itemName, analysisData }: RankBadgeRowProps) {
  const matches: DeviasiRankItem[] = useMemo(() => {
    if (!analysisData?.topDeviasiRank) return [];
    return analysisData.topDeviasiRank.filter(it => it.itemName === itemName);
  }, [analysisData, itemName]);

  // Best (lowest) rank for the item across all its outlets in top-50.
  // rankBom may be 0 (not ranked) — filter those out.
  const rankNominal = matches.length > 0
    ? Math.min(...matches.map(m => m.rankNominal))
    : null;
  const rankBomCandidates = matches.map(m => m.rankBom).filter(r => r != null && r > 0);
  const rankBom = rankBomCandidates.length > 0
    ? Math.min(...rankBomCandidates)
    : null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs mt-1">
      <Badge
        variant="outline"
        className={`text-[11px] h-5 px-1.5 gap-1 ${rankBadgeClass(rankNominal)}`}
        title={`Rank nasional by |nominal deviasi| (top 50). Best rank across ${matches.length} outlet terdampak.`}
      >
        <Award className="h-3 w-3" />
        {rankNominal != null ? `Rank #${rankNominal} Nasional (Deviasi)` : 'Rank > 50 Nasional'}
      </Badge>
      <Badge
        variant="outline"
        className={`text-[11px] h-5 px-1.5 ${rankBadgeClass(rankBom)}`}
        title="Rank nasional by |QTY BOM| (top 50)"
      >
        {rankBom != null ? `Rank #${rankBom} (BOM)` : 'Rank BOM > 50'}
      </Badge>
      <Badge variant="secondary" className="text-[11px] h-5 px-1.5 tabular-nums">
        {matches.length} outlet terdampak (top 50)
      </Badge>
    </div>
  );
}

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
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sort state for the table — default period asc (chronological, matches chart).
  const [sortKey, setSortKey] = useState<SortKey>('period');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Phase 2 — drill period state. Tracks which period the user clicked
  // (via row click or chart dot click) for the ItemPeerComparison drill-down.
  // Defaults to the current dashboard month/week when both are set; auto-syncs
  // when the user changes the dashboard period.
  //
  // Implementation: "adjust state during render" pattern (per React docs:
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // This avoids the `react-hooks/set-state-in-effect` lint error + avoids
  // the extra render cycle that `useEffect + setState` would cause. The
  // `prevPeriodKey` state stores the previous month+week combo so we can
  // detect changes; when it differs from the current combo, we update both
  // `prevPeriodKey` (so the next render doesn't loop) and `drillPeriod`
  // (the actual drill target).
  const [drillPeriod, setDrillPeriod] = useState<{ month: string; week: string } | null>(null);
  const [prevPeriodKey, setPrevPeriodKey] = useState<string | null>(null);
  const currentPeriodKey = monthLabel && currentWeek ? `${monthLabel}|${currentWeek}` : null;
  if (currentPeriodKey !== prevPeriodKey) {
    setPrevPeriodKey(currentPeriodKey);
    setDrillPeriod(monthLabel && currentWeek ? { month: monthLabel, week: currentWeek } : null);
  }

  // Close autocomplete dropdown when clicking outside.
  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  // Stage 1: autocomplete (debounced via useDeferredValue — same pattern
  // as GlobalItemSearchModal). Fires only when input is ≥2 chars AND no
  // item is currently selected.
  const { data: acData, isLoading: acLoading } = useQuery<{ results: AutocompleteResult[] }>({
    queryKey: ['item-search', 'autocomplete', 'trend-tab', monthLabel, currentWeek, deferredQuery],
    queryFn: async () => {
      const p = new URLSearchParams({
        mode: 'autocomplete',
        q: deferredQuery,
        month: monthLabel || '',
        week: currentWeek || '',
      });
      const res = await fetch(`/api/item-search?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(deferredQuery.length >= 2 && monthLabel && currentWeek && !selectedItem),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

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

  // Memoize the periods array — `trend.data?.periods ?? []` would create
  // a new array reference every render when periods is undefined, causing
  // downstream useMemo hooks to recompute needlessly. Wrapping it here
  // gives downstream a stable ref.
  const periods: ItemTrendPeriod[] = useMemo(
    () => trend.data?.periods ?? [],
    [trend.data?.periods],
  );

  // Chronologically sorted periods for the chart + table.
  const chronological = useMemo(
    () => [...periods].sort((a, b) => periodSortKey(a).localeCompare(periodSortKey(b))),
    [periods],
  );

  // Table rows (sorted by user-selected column).
  const sortedRows = useMemo(() => {
    const arr = [...chronological];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'period':
          cmp = periodSortKey(a).localeCompare(periodSortKey(b));
          break;
        case 'qtyBom':
          cmp = a.qtyBom - b.qtyBom;
          break;
        case 'qtyDeviasiSigned':
          cmp = a.qtyDeviasiSigned - b.qtyDeviasiSigned;
          break;
        case 'zScore':
          // Treat null zScore as -Infinity so it always sorts to the
          // bottom when desc is on (real anomalies surface to top).
          cmp = (a.zScore ?? -Infinity) - (b.zScore ?? -Infinity);
          break;
        case 'outletCount':
          cmp = a.outletCount - b.outletCount;
          break;
        case 'recordCount':
          cmp = a.recordCount - b.recordCount;
          break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [chronological, sortKey, sortDir]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return prev;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  // Phase 2 — drill-down callbacks. Both row click + chart dot click set
  // the same `drillPeriod` state, which triggers ItemPeerComparison to
  // fetch + render.
  const handlePeriodDrill = useCallback((p: ItemTrendPeriod) => {
    setDrillPeriod({ month: p.monthLabel, week: p.weekLabel });
  }, []);

  // Phase 2 — peer table row click. Uses setFocusOutlet which both sets
  // the focus outlet AND switches activeTab to 'resto' (see useDashboard).
  const handleOutletClick = useCallback((outletCode: string) => {
    setFocusOutlet(outletCode);
  }, [setFocusOutlet]);

  // Summary stats (computed inline — small N, no useCallback needed).
  const summary = periods.length === 0 ? null : (() => {
    const withZ = periods.filter(p => p.zScore != null);
    const abnormalCount = withZ.filter(p => (p.zScore as number) > 3).length;
    const warningCount = withZ.filter(p => {
      const z = p.zScore as number;
      return z > 2 && z <= 3;
    }).length;
    const elevatedCount = withZ.filter(p => {
      const z = p.zScore as number;
      return z > 1 && z <= 2;
    }).length;
    const lastPeriod = chronological[chronological.length - 1] ?? null;
    const firstPeriod = chronological[0] ?? null;
    return {
      periodCount: periods.length,
      abnormalCount,
      warningCount,
      elevatedCount,
      withZScore: withZ.length,
      lastPeriod,
      firstPeriod,
    };
  })();

  const acResults = acData?.results ?? [];

  // ----------------------------------------------------------
  //  Render
  // ----------------------------------------------------------

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
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
          {trend.data?.cached && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
              cached
            </Badge>
          )}
          {trend.data?.stale && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              stale (revalidating)
            </Badge>
          )}
          {trend.isFetching && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
              Memuat
            </Badge>
          )}
        </CardTitle>

        {/* Search row + metric selector */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-2">
          <ItemTrendSearchBar
            query={query}
            setQuery={setQuery}
            showDropdown={showDropdown}
            setShowDropdown={setShowDropdown}
            deferredQuery={deferredQuery}
            selectedItem={selectedItem}
            setSelectedItem={setSelectedItem}
            acResults={acResults}
            acLoading={acLoading}
            monthLabel={monthLabel}
            currentWeek={currentWeek}
            inputRef={inputRef}
            dropdownRef={dropdownRef}
          />

          {/* Metric selector (toggle buttons — matches HistoricalZScoreCard style) */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-muted/40 self-start sm:self-auto">
            {METRICS.map((m) => (
              <button
                key={m.value}
                onClick={() => setMetric(m.value)}
                className={`text-[11px] px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                  metric === m.value
                    ? 'bg-amber-600 text-white shadow-sm'
                    : 'text-muted-foreground hover:bg-muted/60'
                }`}
                aria-pressed={metric === m.value}
              >
                {m.label}
              </button>
            ))}
          </div>
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
      </CardHeader>

      <CardContent className="p-0">
        {!selectedItem ? (
          // Empty state — prompt user to pick an item.
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 mb-3">
              <TrendingUp className="h-7 w-7" />
            </div>
            <p className="text-sm font-medium text-foreground">Pilih item untuk melihat trend</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md leading-relaxed">
              Cari item di kotak pencarian di atas. Tren menampilkan QTY lintas semua periode dengan Z-Score historis (baseline same-week).
            </p>
            <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 max-w-md text-left">
              <Info className="h-4 w-4 text-blue-500 dark:text-blue-400 shrink-0 mt-0.5" />
              <div className="text-[11px] text-blue-700 dark:text-blue-300 space-y-1">
                <p className="font-medium">Tips: Z-Score butuh minimal 4 periode</p>
                <p>Baseline menggunakan weekLabel yang sama di bulan berbeda (W4 vs W4). Item dengan sedikit periode akan menampilkan Z-Score <code className="font-mono">—</code> (tidak cukup data).</p>
              </div>
            </div>
          </div>
        ) : trend.error ? (
          <div className="text-center text-red-600 dark:text-red-400 text-sm py-12 px-6">
            Gagal memuat trend: {trend.error.message}
          </div>
        ) : trend.isLoading && periods.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            <span className="ml-2 text-xs text-muted-foreground">Memuat trend...</span>
          </div>
        ) : periods.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-6">
            <Package className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada data untuk item ini</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Item <span className="font-medium">{selectedItem}</span> tidak memiliki record dengan filter aktif.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {/* Chart section */}
            <div className="px-4 pt-2">
              <ItemTrendLineChart
                periods={chronological}
                metric={metric}
                onDotClick={handlePeriodDrill}
              />
            </div>

            {/* Data table */}
            <ItemTrendTable
              sortedRows={sortedRows}
              sortKey={sortKey}
              sortDir={sortDir}
              toggleSort={toggleSort}
              metric={metric}
              onRowClick={handlePeriodDrill}
              drillPeriod={drillPeriod}
            />

            {/* Phase 2 — ItemPeerComparison drill-down panel.
                Renders when both selectedItem + drillPeriod are set. */}
            {selectedItem && drillPeriod && (
              <div className="px-4 pb-4 pt-3">
                <ItemPeerComparison
                  itemName={selectedItem}
                  month={drillPeriod.month}
                  week={drillPeriod.week}
                  targetOutletCode={outletCode}
                  area={area}
                  kelompok={kelompok}
                  pic={pic}
                  onOutletClick={handleOutletClick}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const ItemTrendTab = memo(ItemTrendTabImpl);
