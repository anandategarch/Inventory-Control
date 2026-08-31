'use client';

// ============================================================
//  ItemTrendTab — NEW "Trend Item" tab (TREND-FRONTEND).
//  --------------------------------------------------------
//  Per-item QTY fluctuation timeline across ALL periods, with
//  Z-Score (signed) + historical baseline overlay.
//
//  Layout (top → bottom):
//    1. Search bar (debounced autocomplete via /api/item-search)
//       + 4-option metric selector (QTY Deviasi / Waste / Susut / Trial)
//    2. Selected-item badge (with clear button) + cache/fetch badges
//    3. Empty state if no item selected
//    4. Line chart (Recharts, lazy-loaded):
//         - X  = period (Jun W4, Jul W4, …)
//         - Y1 = selected metric's QTY value (solid amber line)
//         - Y2 = Z-Score (right axis; color-coded dots)
//         - ReferenceLine (dashed, muted) per-period = historical mean
//         - Dot color: red (z>2), amber (1<z≤2), yellow (0<z≤1),
//                      green (z≤0), muted (z=null)
//    5. Sortable data table (Period | QTY BOM | QTY Deviasi signed |
//       Z-Score | Status | Outlets | Records)
//
//  Data flow:
//    useItemTrend (TanStack Query) → /api/item-trend
//    ItemAutocomplete (TanStack Query) → /api/item-search?mode=autocomplete
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
import { Info, Loader2, Package, TrendingUp } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useItemTrend, type ItemTrendMetric, type ItemTrendPeriod } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';

// Sub-components + helpers extracted in this folder split (Task ID 3-c).
import { ItemTrendSearchBar } from './ItemTrendSearchBar';
import { ItemTrendTable } from './ItemTrendTable';
import { METRICS, type AutocompleteResult, type SortKey, type SortDir } from './types';
import { periodSortKey } from './periodHelpers';

// Re-export sub-components + types so callers importing from
// '@/components/dashboard/tabs/ItemTrendTab' can access them.
export { ItemTrendSearchBar } from './ItemTrendSearchBar';
export { ItemTrendTable } from './ItemTrendTable';
export { zScoreColor, zScoreStatus } from './zScoreHelpers';
export { periodSortKey, periodShortLabel } from './periodHelpers';
export type { MetricOption, AutocompleteResult, SortKey, SortDir } from './types';
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
//  ItemTrendTab — main component (orchestrator)
// ============================================================

function ItemTrendTabImpl() {
  // Pull dashboard filters (month/week + filter context) so the trend
  // respects the user's current selection. The trend API takes month+week
  // purely for cache-key context (the response covers ALL periods), and
  // area/kelompok/outlet/pic to scope the records.
  const { monthLabel, currentWeek, area, kelompok, outletCode, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
  })));

  // Local UI state (not in Zustand — only the Trend Item tab cares about these).
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [metric, setMetric] = useState<ItemTrendMetric>('qtyDeviasi');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sort state for the table — default period asc (chronological, matches chart).
  const [sortKey, setSortKey] = useState<SortKey>('period');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

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
              />
            </div>

            {/* Data table */}
            <ItemTrendTable
              sortedRows={sortedRows}
              sortKey={sortKey}
              sortDir={sortDir}
              toggleSort={toggleSort}
              metric={metric}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const ItemTrendTab = memo(ItemTrendTabImpl);
