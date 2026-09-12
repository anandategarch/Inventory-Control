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
//    an item via `setTrendSelectedItem` + `setActiveTab('item')`
//    (VH-2: the trend view merged into the 'item' tab).
//    This replaces the previous local useState, but the API is
//    unchanged from the SearchBar's perspective (still receives
//    `selectedItem` + `setSelectedItem` as props).
//
//  Patterns reused from existing dashboard:
//    - React.memo + ErrorBoundary (RestoTab pattern)
//    - zScoreColor + zScoreBadge (HistoricalZScoreCard pattern)
//    - Metric selector toggle buttons (HistoricalZScoreCard pattern)
//    - next/dynamic lazy-load for Recharts (DashboardTab pattern)
//    - 300ms timer debounce before the autocomplete request fires
//
//  Barrel: This file IS the barrel for `@/components/dashboard/tabs/ItemTrendTab`
//  (folder + index.tsx — TypeScript moduleResolution "bundler" resolves
//  automatically). Re-exports sub-components + types for reuse.
// ============================================================

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Info, Loader2, Package, TrendingUp, Award, AlertTriangle } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useItemTrend, type ItemTrendMetric, type ItemTrendPeriod } from '@/hooks/useAnalysis';
import type { AnalysisData, DeviasiRankItem } from '@/hooks/useAnalysis';
import { fmtDecimal } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { Callout } from '@/components/ui/callout';
import { Tracker } from '@/components/dashboard/shared/Tracker';
// SHADCN-PATTERNS (Pattern 4) — reusable structured EmptyState. Replaces
// the manual `flex flex-col items-center justify-center` divs with a
// single component that takes icon + title + description + optional
// action. Loaded from `@/components/ui/empty-state` (UI library — distinct
// from the page-level `EmptyState` in `@/components/dashboard/shared`).
import { EmptyState } from '@/components/ui/empty-state';

// Sub-components + helpers extracted in this folder split (Task ID 3-c).
import { ItemTrendSearchBar } from './ItemTrendSearchBar';
import { ItemTrendTable } from './ItemTrendTable';
import { METRICS, type AutocompleteResult, type SortKey, type SortDir } from './types';
import { periodSortKey } from './periodHelpers';
// Phase A+B (FLIP-FE) — flip detection helpers + matrix.
import {
  computeFlipAnalyses,
  computeItemFlipScore,
  getFlipForPeriod,
  periodKey as flipPeriodKey,
  type FlipAnalysis,
  type ItemFlipScore,
} from './flipHelpers';
import { FlipMatrix } from './FlipMatrix';
import { FlipRanking } from './FlipRanking';
// Phase 2 — peer comparison drill-down panel.
import { ItemPeerComparison } from './ItemPeerComparison';
// Phase 3 — compact rank trend chart (inverted Y-axis, sits below main chart).
import { ItemTrendRankChart } from './ItemTrendRankChart';

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
  // FIX (BUG-1-01): rankBom is now `number | null` — use type predicate to
  // filter nulls so Math.min gets a clean number[].
  const rankNominal = matches.length > 0
    ? Math.min(...matches.map(m => m.rankNominal))
    : null;
  const rankBomCandidates = matches
    .map(m => m.rankBom)
    .filter((r): r is number => r != null && r > 0);
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
//  Phase A+B (FLIP-FE) — Flip Summary Card
//  --------------------------------------------------------
//  Compact card summarizing the item's flip pattern across all
//  same-week pairs (W4 Jul vs W4 Agu, W4 Agu vs W4 Sep, …).
//
//  Layout:
//    ┌────────────────────────────────────────────────┐
//    │ 🔀 Flip Pattern Analysis                       │
//    │ {N} same-week pairs:                           │
//    │ 🟢 {Sempurna} Sempurna · 🟡 {Dominan} Dominan │
//    │ · ⚪ {Konsisten} Konsisten                     │
//    │ Avg Disparity: {X}% · Risk: 🟡 {LEVEL}         │
//    └────────────────────────────────────────────────┘
//
//  Color coding:
//    risk=high     → red border + red "HIGH" badge
//    risk=moderate → amber border + amber "MODERATE" badge
//    risk=low      → emerald border + emerald "LOW" badge
// ============================================================

function flipRiskClass(level: ItemFlipScore['riskLevel']): string {
  switch (level) {
    case 'high':
      return 'border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 text-red-700 dark:text-red-300';
    case 'moderate':
      return 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300';
    case 'low':
    default:
      return 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300';
  }
}

function flipRiskBadgeClass(level: ItemFlipScore['riskLevel']): string {
  switch (level) {
    case 'high':
      return 'text-red-700 dark:text-red-300 border-red-300 dark:border-red-800 bg-red-100 dark:bg-red-950/40';
    case 'moderate':
      return 'text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800 bg-amber-100 dark:bg-amber-950/40';
    case 'low':
    default:
      return 'text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-950/40';
  }
}

interface FlipSummaryCardProps {
  score: ItemFlipScore;
}

function FlipSummaryCard({ score }: FlipSummaryCardProps) {
  const avgPct = Math.round(score.avgDisparity * 100);
  const riskClass = flipRiskClass(score.riskLevel);
  const riskBadgeClass = flipRiskBadgeClass(score.riskLevel);
  const riskLabel = score.riskLevel.toUpperCase();
  // Hide parts that have zero counts to keep the summary tight.
  const parts: Array<{ emoji: string; label: string; count: number; cls: string }> = [
    { emoji: '🟢', label: 'Sempurna', count: score.sempurnaCount, cls: 'text-emerald-700 dark:text-emerald-400' },
    { emoji: '🟡', label: 'Dominan', count: score.dominanCount, cls: 'text-amber-700 dark:text-amber-400' },
    { emoji: '🔴', label: 'Parsial', count: score.parsialCount, cls: 'text-red-700 dark:text-red-400' },
    { emoji: '⚪', label: 'Konsisten', count: score.konsistenCount, cls: 'text-muted-foreground' },
  ].filter(p => p.count > 0);

  return (
    <div className={`mt-2 rounded-lg border px-3 py-2 ${riskClass}`} data-testid="flip-summary-card">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <span aria-hidden>🔀</span>
        <span>Flip Pattern Analysis</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px] leading-tight">
        <span className="font-medium tabular-nums">{score.totalPairs}</span>
        <span className="text-muted-foreground">pasangan minggu sama:</span>
        {parts.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          parts.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/60">·</span>}
              <span aria-hidden>{p.emoji}</span>
              <span className="tabular-nums">{p.count}</span>
              <span className={p.cls}>{p.label}</span>
            </span>
          ))
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
        <span className="text-muted-foreground">
          Disparitas Rata-rata: <span className="font-medium tabular-nums text-foreground">{avgPct}%</span>
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">Risiko:</span>
        <Badge variant="outline" className={`text-[10px] h-5 px-1.5 font-semibold ${riskBadgeClass}`}>
          {riskLabel}
        </Badge>
        {score.riskScore > 0 && (
          <span className="text-muted-foreground/70 tabular-nums">({score.riskScore}/100)</span>
        )}
      </div>
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
  // PERF-FE (PAKET A): real 300ms debounce. `useDeferredValue` only defers
  // RENDERING — the deferred value still changed on every keystroke, so the
  // autocomplete queryKey below produced a new cache entry (and an HTTP
  // request) per character typed ("ayam goreng" = 9 requests). A timer-based
  // debounce collapses a burst of keystrokes into a single request.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    // Clearing the input propagates instantly (delay 0); typing debounces at
    // 300ms. setState only ever runs inside the timer callback (async), never
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => setDebouncedQuery(query), query === '' ? 0 : 300);
    return () => clearTimeout(t);
  }, [query]);
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

  // Stage 1: autocomplete (debounced 300ms — see the debounce effect above).
  // Fires only when input is ≥2 chars AND no item is currently selected.
  const { data: acData, isLoading: acLoading } = useQuery<{ results: AutocompleteResult[] }>({
    queryKey: ['item-search', 'autocomplete', 'trend-tab', monthLabel, currentWeek, debouncedQuery],
    queryFn: async () => {
      const p = new URLSearchParams({
        mode: 'autocomplete',
        q: debouncedQuery,
        month: monthLabel || '',
        week: currentWeek || '',
      });
      const res = await fetch(`/api/item-search?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(debouncedQuery.length >= 2 && monthLabel && currentWeek && !selectedItem),
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

  // Stage 3 (Phase 3) — rank trend data. Fires in parallel with the main
  // trend data (independent query key + endpoint). Returns the item's
  // national rank (by ABS(nominalDeviasi)) for each period, used by the
  // compact ItemTrendRankChart below the main chart.
  //
  // Same filter shape as the main trend query (item + month/week context
  // + area/kelompok/outlet/pic scoping) so the rank data matches the
  // user's current filter selection.
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
      return res.json() as Promise<{
        success: boolean;
        periods: Array<{
          monthLabel: string;
          weekLabel: string;
          monthKey: string | null;
          rankNominal: number;
          totalItems: number;
          absNominal: number;
        }>;
      }>;
    },
    // Only fire when an item is selected — avoids burning a request on tab mount.
    enabled: Boolean(selectedItem),
    // 5-min staleTime matches the server DB cache TTL (same as useItemTrend).
    staleTime: 5 * 60 * 1000,
    // 10-min gcTime — keep the data in memory across tab switches.
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Memoize the periods array — `trend.data?.periods ?? []` would create
  // a new array reference every render when periods is undefined, causing
  // downstream useMemo hooks to recompute needlessly. Wrapping it here
  // gives downstream a stable ref.
  const periods: ItemTrendPeriod[] = useMemo(
    () => trend.data?.periods ?? [],
    [trend.data?.periods],
  );

  // FIX (SATUAN-BUG): extract item's unit of measure from the first period.
  // All periods for 1 item share the same satuan (it's an item-level attribute).
  // Used by Flip column/matrix tooltips to display the correct unit instead of
  // hardcoded "kg" (which was wrong for non-KG items like PCS, LTR, etc.).
  const satuan = useMemo(() => periods[0]?.satuan ?? null, [periods]);

  // Phase 3 — rank periods (memoized for the same reason as `periods`
  // above: stable ref avoids downstream re-renders).
  const rankPeriods = useMemo(
    () => rankData?.periods ?? [],
    [rankData?.periods],
  );

  // Chronologically sorted periods for the chart + table.
  const chronological = useMemo(
    () => [...periods].sort((a, b) => periodSortKey(a).localeCompare(periodSortKey(b))),
    [periods],
  );

  // Phase A+B (FLIP-FE) — flip analyses + aggregate score for the item.
  // Memoized off `periods` (not `chronological`) because computeFlipAnalyses
  // sorts internally per-week-group. Both `flips` + `flipScore` are passed
  // down to ItemTrendTable (column), ItemTrendLineChart (annotations),
  // and the Flip Summary Card below the rank badge row.
  const flips: FlipAnalysis[] = useMemo(() => computeFlipAnalyses(periods), [periods]);
  const flipScore: ItemFlipScore = useMemo(() => computeItemFlipScore(flips), [flips]);

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
        case 'flip': {
          // Phase A+B (FLIP-FE) — sort by flip disparity.
          // FIX (BUG-FLIP-02): only sort by disparity for ACTUAL flips
          // (isFlip=true). Non-flip pairs (konsisten-naik/turun/stagnan)
          // and `first` periods (no predecessor) sort to the bottom.
          // FIX (BUG2-FLIP-04): use null + custom comparator so non-flip
          // rows ALWAYS sort to bottom regardless of ASC/DESC direction.
          // (was -1 which put non-flips at TOP on ASC — confusing UX).
          const fa = flips ? getFlipForPeriod(flips, flipPeriodKey(a)) : null;
          const fb = flips ? getFlipForPeriod(flips, flipPeriodKey(b)) : null;
          const va = fa && fa.isFlip ? fa.disparityPct : null;
          const vb = fb && fb.isFlip ? fb.disparityPct : null;
          if (va == null && vb == null) cmp = 0;
          else if (va == null) cmp = 1;  // a (non-flip) goes below b
          else if (vb == null) cmp = -1; // b (non-flip) goes below a
          else cmp = va - vb;
          break;
        }
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [chronological, sortKey, sortDir, flips]);

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
    <div className="space-y-4">
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
              cache
            </Badge>
          )}
          {trend.data?.stale && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              stale (memvalidasi ulang)
            </Badge>
          )}
          {trend.isFetching && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
              Memuat
            </Badge>
          )}
          {/* Phase 3 — rank fetching badge. Only shown when rank data is
              being fetched AND no rank periods are available yet (SWR
              pattern — once data is loaded, the badge is hidden even on
              background revalidation to avoid flicker). */}
          {rankFetching && rankPeriods.length === 0 && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
              Memuat Rank
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
            debouncedQuery={debouncedQuery}
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

        {/* Phase A+B (FLIP-FE) — Flip Summary Card moved to CardContent (UI-10). */}
      </CardHeader>

      <CardContent className="p-0">
        {!selectedItem ? (
          // Empty state — prompt user to pick an item.
          // SHADCN-PATTERNS (Pattern 4) — replaced manual `flex flex-col ...`
          // div with <EmptyState>. The amber Tips Callout is passed as the
          // `action` so it renders below the title/description. Keeps the
          // same copy + amber theme as the previous inline block (UI-12
          // palette fix preserved).
          <EmptyState
            icon={TrendingUp}
            // FIX (BUG-SHADCN-01): restore amber icon theme (was muted gray after migration).
            iconClassName="bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
            title="Pilih item untuk melihat trend"
            description="Cari item di kotak pencarian di atas. Tren menampilkan QTY lintas semua periode dengan Z-Score historis (baseline same-week)."
            className="py-12"
            action={
              <Callout
                color="amber"
                icon={Info}
                title="Tips: Z-Score butuh minimal 4 periode"
                // FIX (BUG-SHADCN-02): removed mt-4 — EmptyState already adds mt-4 wrapper for action.
                className="max-w-md text-left"
              >
                <p>
                  Baseline menggunakan weekLabel yang sama di bulan berbeda (W4 vs W4). Item dengan sedikit periode akan menampilkan Z-Score <code className="font-mono">—</code> (tidak cukup data).
                </p>
              </Callout>
            }
          />
        ) : trend.error ? (
          <div className="py-12 px-6 max-w-md mx-auto">
            <Callout
              color="red"
              icon={AlertTriangle}
              title="Gagal memuat trend"
            >
              <p>{trend.error.message}</p>
              {/* FIX (BUG-HUNT C20/B2-13): recovery affordance — ParetoDashboard
                  and the peer table already offer "Coba Lagi" on errors; the trend
                  error was message-only. */}
              <button
                type="button"
                onClick={() => { void trend.refetch(); }}
                className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-red-700"
              >
                Coba Lagi
              </button>
            </Callout>
          </div>
        ) : trend.isLoading && periods.length === 0 ? (
          // FIX (UI-02): standardized loading state padding to py-12.
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            <span className="ml-2 text-xs text-muted-foreground">Memuat trend...</span>
          </div>
        ) : periods.length === 0 ? (
          // SHADCN-PATTERNS (Pattern 4) — replaced manual `flex flex-col ...`
          // div with <EmptyState>. Uses Package icon to distinguish "item
          // exists but no records" from the no-item-selected state above.
          <EmptyState
            icon={Package}
            title="Tidak ada data untuk item ini"
            // FIX (BUG-SHADCN-07): use ReactNode (not string) for bold item name.
            description={<>Item <span className="font-medium">{selectedItem}</span> tidak memiliki record dengan filter aktif.</>}
          />
        ) : (
          <div className="space-y-3">
            {/* FIX (UI-10): Flip Summary Card moved here from CardHeader so
                the header stays compact (header already has 4 stacked rows:
                title+badges, search+metric, selected-item summary, rank badge).
                Padding px-4 pt-2 aligns it with the chart + table grid below. */}
            {selectedItem && periods.length > 1 && (
              <div className="px-4 pt-2">
                <FlipSummaryCard score={flipScore} />
              </div>
            )}

            {/* TREMOR Pattern 3 — Tracker: per-period status blocks.
                Each block colored by Z-Score: emerald (z<-1, baik),
                amber (-1..1, normal), red (z>1, abnormal), zinc (null,
                no baseline). Tooltip shows monthLabel + weekLabel + Z. */}
            {selectedItem && periods.length > 1 && (
              <div className="px-4 pt-3 pb-1">
                <p className="text-[10px] text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <span aria-hidden>📊</span> Period Status Tracker
                  <span className="text-muted-foreground/60">(hijau=baik, amber=normal, merah=abnormal, abu=tanpa data)</span>
                </p>
                <Tracker
                  blocks={chronological.map((p) => {
                    const z = p.zScore;
                    return {
                      color: z == null ? 'zinc' : z < -1 ? 'emerald' : z > 1 ? 'red' : 'amber',
                      tooltip: `${p.monthLabel} ${p.weekLabel}: Z-Score ${z != null ? fmtDecimal(z, 2) : '—'}`,
                    };
                  })}
                />
              </div>
            )}

            {/* Chart section */}
            {/* FIX (UI-01): added pb-3 so chart bottom doesn't touch table border-t */}
            <div className="px-4 pt-2 pb-3">
              <ItemTrendLineChart
                periods={chronological}
                metric={metric}
                onDotClick={handlePeriodDrill}
                flips={flips}
              />

              {/* Phase 3 — Rank Trend chart (compact, below main chart).
                  Shows the item's national rank (by |nominalDeviasi|)
                  per period with an INVERTED Y-axis (rank #1 at top =
                  worst). Only rendered when there are ≥2 rank periods
                  (the chart can't draw a trend line from a single point). */}
              {/* FIX (BUG-3-03): render when >= 1 period so the chart's own
                  1-period message shows (was > 1 which caused silent failure
                  — no chart AND no message for 1-period items). */}
              {rankPeriods.length >= 1 && (
                <div className="mt-2 pt-2 border-t">
                  <ItemTrendRankChart
                    periods={rankPeriods}
                    onDotClick={(p) => setDrillPeriod({ month: p.monthLabel, week: p.weekLabel })}
                  />
                </div>
              )}
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
              flips={flips}
              satuan={satuan}
            />

            {/* Phase B (FLIP-FE) — Flip Matrix (week × month grid).
                Renders below the table + above the ItemPeerComparison
                drill panel. Only renders when there are ≥2 periods
                (a single period can't form a pair). */}
            {selectedItem && periods.length >= 2 && (
              <div className="px-4 pt-3 pb-2">
                <FlipMatrix periods={chronological} flips={flips} satuan={satuan} />
              </div>
            )}

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

    {/* Phase C — Flip Ranking cross-item widget.
        Renders at the bottom of the Trend Item Tab.
        Shows top items by flip risk score (sempurna flips = suspicious).
        Clicking a row selects that item for trend analysis above. */}
    <FlipRanking />
    </div>
  );
}

export const ItemTrendTab = memo(ItemTrendTabImpl);
