'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useAnalysis, useStatus, prefetchAnalysis, type AnalysisParams } from '@/hooks/useAnalysis';
import { FilterBar } from '@/components/filters/FilterBar';
import { ExecutiveSummary, HealthAlert } from '@/components/dashboard/ExecutiveSummary';
import { TopItemsByNominal, TopItemsByDevBom, TopOutlets } from '@/components/dashboard/TopItems';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import {
  OutletHealthRanking, ItemConsistencyAnalysis, AreaComparison,
} from '@/components/dashboard/AdvancedAnalysis';
import { ErrorBoundary } from '@/components/ui/error-boundary';
// Phase 4 FIX: RestoAnalysis lazy-loaded — it pulls in PrioritySummaryCard →
// SignalChart → recharts (5.4MB). Without lazy-load, Recharts is in the main
// bundle despite the other dynamic() calls.
const RestoAnalysis = dynamic(() => import('@/components/dashboard/RestoAnalysis').then(m => m.RestoAnalysis), { ssr: false, loading: () => <LoadingChart /> });
import { RestoRecommendationCard } from '@/components/dashboard/RestoRecommendationCard';
import { GlobalItemSearchModal } from '@/components/dashboard/GlobalItemSearchModal';
import { ParetoDashboard } from '@/components/dashboard/ParetoDashboard';
import { ExportDialog } from '@/components/dashboard/ExportDialog';
const AuditLogDialog = dynamic(() => import('@/components/filters/AuditLogDialog').then(m => m.AuditLogDialog), { ssr: false, loading: () => null });
// CostAccounting components removed — tab Cost Accounting dihapus
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';
import { CardDrillDown } from '@/components/dashboard/CardDrillDown';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Phase 4: Lazy-load heavy chart components (Recharts = 5.4MB)
// ssr: false — charts are client-only (use ResponsiveContainer which needs window)
import dynamic from 'next/dynamic';

const LoadingChart = () => (
  <div className="flex flex-col items-center justify-center h-48 space-y-3">
    <Skeleton className="h-full w-full rounded-lg" />
  </div>
);

const GrowthComparison = dynamic(() => import('@/components/dashboard/Charts').then(m => m.GrowthComparison), { ssr: false, loading: () => <LoadingChart /> });
const DeviationBreakdownChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.DeviationBreakdownChart), { ssr: false, loading: () => <LoadingChart /> });
const LossVsSurplusChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.LossVsSurplusChart), { ssr: false, loading: () => <LoadingChart /> });
const TrendChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.TrendChart), { ssr: false, loading: () => <LoadingChart /> });
const MultiPeriodComparisonCard = dynamic(() => import('@/components/dashboard/AnalysisCards').then(m => m.MultiPeriodComparisonCard), { ssr: false, loading: () => <LoadingChart /> });
const HistoricalZScoreCard = dynamic(() => import('@/components/dashboard/HistoricalZScoreCard').then(m => m.HistoricalZScoreCard), { ssr: false, loading: () => <LoadingChart /> });
const AreaItemHeatmap = dynamic(() => import('@/components/dashboard/AreaItemHeatmap').then(m => m.AreaItemHeatmap), { ssr: false, loading: () => <LoadingChart /> });
const PeerComparison = dynamic(() => import('@/components/dashboard/PeerComparison').then(m => m.PeerComparison), { ssr: false, loading: () => <LoadingChart /> });
const ItemDeepDive = dynamic(() => import('@/components/dashboard/ItemDeepDive').then(m => m.ItemDeepDive), { ssr: false, loading: () => (
  <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-amber-500" /></div>
) });
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';
import { EmptyState, LoadingState, ErrorState, SectionHeader, ScrollToTop } from '@/components/dashboard/shared';
import {
  Activity, Boxes, BarChart3, ShieldAlert,
  MapPin,
  Calendar, Loader2, Store,
  FileDown,
  History,
  Keyboard,
  Search,
  TrendingDown,
} from 'lucide-react';

function FetchAware({ isFetching, children }: { isFetching: boolean; children: React.ReactNode }) {
  return (
    <div className={`relative transition-all duration-200 ${isFetching ? 'opacity-60 pointer-events-none' : 'opacity-100'}`}>
      {isFetching && (
        <div className="absolute inset-0 z-10 flex items-start justify-end p-2">
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300/70 dark:text-amber-400 dark:border-amber-800/70 bg-background/85 backdrop-blur-sm h-5 shadow-sm">
            <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
            Memperbarui
          </Badge>
        </div>
      )}
      {children}
    </div>
  );
}

// Fix #10: Scroll to Top button — appears after scrolling down 300px

export default function DashboardPage() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, setMonth, setWeek, setCompareWeek, activeTab, setActiveTab, setDrilldown, setSourceModal, setCardDrillDown, setDeepDiveItem } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonWeek: s.comparisonWeek,
    comparisonMonth: s.comparisonMonth,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    itemName: s.itemName,
    pic: s.pic,
    setMonth: s.setMonth,
    setWeek: s.setWeek,
    setCompareWeek: s.setCompareWeek,
    activeTab: s.activeTab,
    setActiveTab: s.setActiveTab,
    setDrilldown: s.setDrilldown,
    setSourceModal: s.setSourceModal,
    setCardDrillDown: s.setCardDrillDown,
    setDeepDiveItem: s.setDeepDiveItem,
  })));
  const { data: status } = useStatus();
  const queryClient = useQueryClient();
  // PERF-OPT: track whether cache warming has already fired for this status
  // payload. Prevents re-prefetching on every status re-render (status has
  // 5-min staleTime, but its reference may update on invalidation).
  const warmedStatusKey = useRef<string | null>(null);

  // Auto-select first available month/week on mount
  useEffect(() => {
    if (!monthLabel && status?.months?.length) {
      setMonth(status.months[status.months.length - 1].label);
    }
  }, [status, monthLabel, setMonth]);

  useEffect(() => {
    if (monthLabel && !currentWeek && status?.weeksByMonth && status?.months) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key];
        if (weeks?.length) setWeek(weeks[weeks.length - 1]);
      }
    }
  }, [status, monthLabel, currentWeek, setWeek]);

  // PERF-OPT: Cache warming — fire prefetch for the latest month/week as
  // soon as status loads (don't wait for the auto-select useEffect chain
  // above to set monthLabel/currentWeek first). Saves ~1 render cycle on
  // initial dashboard load.
  useEffect(() => {
    if (!status?.months?.length || !status?.weeksByMonth) return;
    // Only fire once per status payload (key by latest monthKey + week)
    const latestMonth = status.months[status.months.length - 1];
    if (!latestMonth) return;
    const weeksForLatest = status.weeksByMonth[latestMonth.key] || [];
    if (!weeksForLatest.length) return;
    const latestWeek = weeksForLatest[weeksForLatest.length - 1];
    const warmKey = `${latestMonth.key}|${latestWeek}`;
    if (warmedStatusKey.current === warmKey) return;
    warmedStatusKey.current = warmKey;
    // Only warm if user hasn't already selected a different period
    if (monthLabel || currentWeek) return;
    const params: AnalysisParams = {
      month: latestMonth.label,
      week: latestWeek,
      compareWeek: null, // auto-compare will be resolved server-side
      compareMonth: null,
      area: null,
      outlet: null,
      item: null,
      pic: null,
    };
    prefetchAnalysis(queryClient, params);
  }, [status, queryClient, monthLabel, currentWeek]);

  // Auto-set default periode pembanding = SAME weekLabel in previous month (cumulative weeks)
  // FIX (BUG 1): Was using chronological previous (W4→W2 same month = false positive growth).
  // Now finds same weekLabel in most recent month BEFORE current (W4 Juli → W4 Juni).
  useEffect(() => {
    if (monthLabel && currentWeek && !comparisonWeek && status?.weeksByMonth && status?.months) {
      const allPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }> = [];
      for (const m of status.months) {
        const ws = status.weeksByMonth[m.key] || [];
        for (const w of ws) {
          allPeriods.push({ monthLabel: m.label, weekLabel: w, sortKey: `${m.key}|${String(parseInt(w.replace(/\D/g, '')) || 0).padStart(2, '0')}` });
        }
      }
      allPeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      const currentIdx = allPeriods.findIndex((p) => p.monthLabel === monthLabel && p.weekLabel === currentWeek);
      if (currentIdx >= 0) {
        // Search backwards for same weekLabel in a DIFFERENT month
        let found: { monthLabel: string; weekLabel: string } | null = null;
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (allPeriods[i].weekLabel === currentWeek && allPeriods[i].monthLabel !== monthLabel) {
            found = allPeriods[i];
            break;
          }
        }
        // Fallback: chronological previous period
        if (!found && currentIdx > 0) {
          found = allPeriods[currentIdx - 1];
        }
        if (found) setCompareWeek(found.weekLabel, found.monthLabel);
      }
    }
  }, [status, monthLabel, currentWeek, comparisonWeek, setCompareWeek]);

  // Bug 8 fix: validate currentWeek belongs to monthLabel — reset if invalid
  useEffect(() => {
    if (monthLabel && currentWeek && status?.weeksByMonth && status?.months) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key] || [];
        if (!weeks.includes(currentWeek)) {
          // currentWeek doesn't belong to this month — reset to last available week
          setWeek(weeks.length > 0 ? weeks[weeks.length - 1] : null);
        }
      }
    }
  }, [status, monthLabel, currentWeek, setWeek]);

  const analysis = useAnalysis({
    month: monthLabel,
    week: currentWeek,
    compareWeek: comparisonWeek,
    compareMonth: comparisonMonth,
    area,
    kelompok,
    outlet: outletCode,
    item: itemName,
    pic,
  });

  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);

  // PERF-OPT: useCallback keeps handleExport stable across renders so
  // ExportDialog doesn't re-render unnecessarily (it's memoized via React.memo
  // in some shadcn variants; stable callback guarantees it).
  const handleExport = useCallback(async (selectedSections: string[]) => {
    if (!analysis.data) return;
    setExportDialogOpen(false);
    setIsExporting(true);
    try {
      const params = new URLSearchParams({ month: monthLabel || '', week: currentWeek || '' });
      if (comparisonWeek) params.set('compareWeek', comparisonWeek);
      if (comparisonMonth) params.set('compareMonth', comparisonMonth);
      if (area) params.set('area', area);
      if (kelompok) params.set('kelompok', kelompok);
      if (outletCode) params.set('outlet', outletCode);
      if (itemName) params.set('item', itemName);
      if (pic) params.set('pic', pic);
      params.set('sections', selectedSections.join(','));

      const res = await fetch(`/api/export-report?${params.toString()}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // FIX: filename include periode + nama resto (jika outlet dipilih)
      // Format: Laporan_[OutletName]_[Month]_[Week]_[comparePeriod?].docx
      const outletName = outletCode
        ? status?.outlets?.find(o => o.code === outletCode)?.name?.replace(/\s+/g, '_') || outletCode
        : 'Semua_Resto';
      const compareSuffix = comparisonWeek ? `_vs_${comparisonWeek.replace(/\s+/g, '')}` : '';
      a.download = `Laporan_${outletName}_${(monthLabel || 'unknown').replace(/\s+/g, '_')}_${currentWeek || ''}${compareSuffix}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: '✅ Export berhasil', description: `${selectedSections.length} section · Laporan Word telah diunduh` });
    } catch (e: unknown) {
      toast({ title: '❌ Export gagal', description: (e instanceof Error ? e.message : 'Unknown error'), variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  }, [analysis.data, monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, toast, status]);

  // UX-ENHANCE: Refresh handler — invalidates analysis + status queries and
  // fires a toast. Wired to Cmd/Ctrl+R keyboard shortcut.
  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['analysis'] });
    queryClient.invalidateQueries({ queryKey: ['status'] });
    queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
    queryClient.invalidateQueries({ queryKey: ['item-history'] });
    queryClient.invalidateQueries({ queryKey: ['peer-comparison'] });
    queryClient.invalidateQueries({ queryKey: ['recommendations'] });
    toast({ title: '🔄 Data diperbarui' });
  }, [queryClient, toast]);

  // GLOBAL-ITEM-SEARCH: Cmd+K opens the global item search modal (cross-outlet view).
  const [itemSearchOpen, setItemSearchOpen] = useState(false);

  // UX-ENHANCE: Global keyboard shortcuts.
  // Cmd/Ctrl+E → open export dialog
  // Cmd/Ctrl+R → refresh data (prevents browser refresh)
  // Cmd/Ctrl+K → open global item search (cross-outlet analysis)
  // 1 / 2 / 3 → switch tabs (Dashboard / Resto Analysis / Peer Comparison)
  // Escape → close any open dialog/drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true;

      // Cmd/Ctrl+E → open export dialog
      if (mod && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (analysis.data) setExportDialogOpen(true);
        return;
      }
      // Cmd/Ctrl+R → refresh data (prevent browser refresh)
      if (mod && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        handleRefresh();
        return;
      }
      // Cmd/Ctrl+K → open global item search
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setItemSearchOpen(true);
        return;
      }
      // 1 / 2 / 3 / 4 → switch tabs (only when not typing in an input)
      // FIX #6: Also block when a SearchableComboBox dropdown is open
      // (Radix uses [data-state=open] / [role=combobox][aria-expanded=true]).
      const isDropdownOpen = Boolean(
        document.querySelector('[role="combobox"][aria-expanded="true"], [data-state="open"][role="listbox"], [data-state="open"][role="combobox"]')
      );
      if (!mod && !isTyping && !e.altKey && !isDropdownOpen && (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4')) {
        const tabMap: Record<string, string> = { '1': 'dashboard', '2': 'resto', '3': 'peer', '4': 'pareto' };
        setActiveTab(tabMap[e.key]);
        return;
      }
      // Escape → close any open dialog/drawer (Radix handles its own; this
      // covers dashboard-controlled state + ExportDialog as a safety net).
      // FIX #7: Guard with !isTyping so Escape inside a SearchableComboBox
      // search box only closes that dropdown (Radix bubbles Escape to window).
      if (e.key === 'Escape' && !isTyping) {
        setExportDialogOpen(false);
        setItemSearchOpen(false);
        setDrilldown({ outletCode: null, itemName: null });
        setSourceModal(false);
        setCardDrillDown(null);
        setDeepDiveItem({ itemName: null, outletCode: null });
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [analysis.data, handleRefresh, setActiveTab, setExportDialogOpen, setDrilldown, setSourceModal, setCardDrillDown, setDeepDiveItem]);

  // PERF-OPT: derive isLoading/hasData once per render (cheap booleans — no
  // memoization needed; React already dedupes identical primitives).
  const isLoading = analysis.isLoading || analysis.isFetching;
  const statusLoaded = status !== undefined;
  const hasData = statusLoaded && Boolean(status?.stats?.totalRecords && status.stats.totalRecords > 0);

  // PERF-OPT: analysis.data is already a stable reference from useQuery
  // (TanStack Query preserves the reference unless the underlying data
  // changes — verified by inspecting useQuery source). No useMemo needed.
  // The useCallback above on handleExport is the only memoization that
  // matters here — it keeps ExportDialog from re-rendering on every
  // analysis.isFetching toggle.

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/20 dark:from-background dark:to-zinc-950">
      {/* REDesign-HEADER: Single sticky container (z-40) with 2 compact tiers.
          Tier 1: logo + title + actions (h-9, ~36px)
          Tier 2: FilterBar bare content (h-8 dropdowns, ~36px)
          Saves ~110px vertical vs previous 2-container layout. */}
      <header className="sticky top-0 z-40 border-b border-amber-500/60 bg-gradient-to-b from-background/95 to-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
        {/* Tier 1: Brand + actions */}
        <div className="px-4 sm:px-6 py-1.5 flex items-center justify-between gap-3 max-w-[1600px] mx-auto">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Logo — compact 28px (was 40px) */}
            <div className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 dark:from-amber-400 dark:to-orange-500 text-white shadow-sm shadow-amber-500/20 ring-1 ring-amber-500/20 shrink-0">
              <Boxes className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex items-center gap-2">
              <h1 className="text-sm font-semibold tracking-tight truncate leading-tight text-foreground">
                Inventory Control
              </h1>
              {status?.stats && (
                <Badge variant="outline" className="text-[10px] h-5 hidden sm:inline-flex gap-1 px-1.5 tabular-nums text-muted-foreground shrink-0">
                  {status.stats.totalOutlets} outlet
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* GLOBAL-ITEM-SEARCH: Cmd+K trigger button (always available when data exists) */}
            {hasData && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs font-medium transition-all active:scale-95"
                onClick={() => setItemSearchOpen(true)}
                aria-label="Cari item di semua outlet (Cmd+K)"
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Cari Item</span>
                <kbd className="hidden md:inline ml-0.5 px-1 py-0.5 text-[10px] font-mono rounded border bg-muted/60 text-muted-foreground">⌘K</kbd>
              </Button>
            )}
            {analysis.isFetching && analysis.data && (
              <Badge variant="outline" className="text-[11px] h-7 gap-1.5 rounded-full px-2.5 border-amber-300/70 dark:border-amber-800/70 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="hidden sm:inline">Memperbarui...</span>
              </Badge>
            )}
            {analysis.data && (
              <Badge variant="outline" className="text-[11px] h-7 hidden lg:inline-flex gap-1.5 rounded-full px-2.5 text-muted-foreground">
                <Activity className="h-3 w-3" />
                <span className="tabular-nums">{analysis.data.cached ? 'cache' : 'langsung'} · {analysis.data.durationMs}ms</span>
              </Badge>
            )}
            {analysis.data && (
              <Button
                variant="default"
                size="sm"
                className="h-8 gap-1.5 text-xs font-medium shadow-sm hover:shadow-md bg-amber-600 hover:bg-amber-700 text-white transition-all active:scale-95"
                disabled={isExporting}
                onClick={() => setExportDialogOpen(true)}
                aria-label="Export laporan Word"
              >
                {isExporting ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> <span className="hidden sm:inline">Exporting...</span></>
                ) : (
                  <><FileDown className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Export</span></>
                )}
              </Button>
            )}
            {/* Audit Log button — zombie revival (AuditLog model had 11 writes, 0 reads) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Audit Log"
                  onClick={() => setAuditLogOpen(true)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                >
                  <History className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">Audit Log</TooltipContent>
            </Tooltip>
            {/* UX-ENHANCE: Keyboard shortcuts help tooltip */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Keyboard shortcuts"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                >
                  <Keyboard className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" className="max-w-xs p-3">
                <p className="text-xs font-semibold mb-1.5">Keyboard Shortcuts</p>
                <ul className="space-y-1 text-[11px]">
                  <li className="flex items-center justify-between gap-3"><span>Export Word</span><kbd className="font-mono">⌘/Ctrl + E</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Refresh data</span><kbd className="font-mono">⌘/Ctrl + R</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Cari item (cross-outlet)</span><kbd className="font-mono">⌘/Ctrl + K</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Tab Dashboard</span><kbd className="font-mono">1</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Tab Resto Analysis</span><kbd className="font-mono">2</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Tab Peer Comparison</span><kbd className="font-mono">3</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Tab Pareto</span><kbd className="font-mono">4</kbd></li>
                  <li className="flex items-center justify-between gap-3"><span>Tutup dialog</span><kbd className="font-mono">Esc</kbd></li>
                </ul>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Tier 2: FilterBar (bare, no Card wrapper) — only shown when data exists */}
        {hasData && (
          <div className="px-4 sm:px-6 pb-1.5 max-w-[1600px] mx-auto">
            <FilterBar />
          </div>
        )}
      </header>

      {/* Main content */}
      <main id="main-content" aria-label="Dashboard Inventory Control" className="flex-1 px-4 sm:px-6 pt-2 pb-4 space-y-4 max-w-[1600px] w-full mx-auto">
        {!statusLoaded ? (
          <LoadingState />
        ) : !hasData ? (
          <EmptyState />
        ) : isLoading && !analysis.data ? (
          <LoadingState />
        ) : analysis.error ? (
          <ErrorState message={analysis.error.message} />
        ) : analysis.data ? (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full justify-start overflow-x-auto h-auto flex-wrap bg-muted/40 dark:bg-zinc-900/40 p-1 gap-1 rounded-xl border border-border/60 shadow-md shadow-black/5 dark:shadow-black/20">
              <TabsTrigger value="dashboard" className="text-xs font-medium gap-1.5 relative data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400 data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-1/2 data-[state=active]:after:-translate-x-1/2 data-[state=active]:after:h-0.5 data-[state=active]:after:w-8 data-[state=active]:after:bg-amber-500 data-[state=active]:after:rounded-full data-[state=active]:after:transition-all">
                <BarChart3 className="h-3.5 w-3.5" /> Dashboard
              </TabsTrigger>
              <TabsTrigger value="resto" className="text-xs font-medium gap-1.5 relative data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400 data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-1/2 data-[state=active]:after:-translate-x-1/2 data-[state=active]:after:h-0.5 data-[state=active]:after:w-8 data-[state=active]:after:bg-amber-500 data-[state=active]:after:rounded-full data-[state=active]:after:transition-all">
                <Store className="h-3.5 w-3.5" /> Resto Analysis
              </TabsTrigger>
              <TabsTrigger value="peer" className="text-xs font-medium gap-1.5 relative data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400 data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-1/2 data-[state=active]:after:-translate-x-1/2 data-[state=active]:after:h-0.5 data-[state=active]:after:w-8 data-[state=active]:after:bg-amber-500 data-[state=active]:after:rounded-full data-[state=active]:after:transition-all">
                <Activity className="h-3.5 w-3.5" /> Peer Comparison
              </TabsTrigger>
              <TabsTrigger value="pareto" className="text-xs font-medium gap-1.5 relative data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400 data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-1/2 data-[state=active]:after:-translate-x-1/2 data-[state=active]:after:h-0.5 data-[state=active]:after:w-8 data-[state=active]:after:bg-amber-500 data-[state=active]:after:rounded-full data-[state=active]:after:transition-all">
                <TrendingDown className="h-3.5 w-3.5" /> Pareto
              </TabsTrigger>
            </TabsList>

            {/* ====== DASHBOARD TAB (Overview + Network) ====== */}
            <TabsContent value="dashboard" className="space-y-4 mt-2 animate-fade-in-up">
              {/* Section: Executive Summary */}
              <FetchAware isFetching={analysis.isFetching}>
                <ErrorBoundary label="Executive Summary">
                  <ExecutiveSummary data={analysis.data} />
                </ErrorBoundary>
              </FetchAware>

              {/* Section: Resto Recommendation Engine */}
              <ErrorBoundary label="Resto Prioritas Analisa">
                <RestoRecommendationCard />
              </ErrorBoundary>

              {/* Section: Insights Panel */}
              <FetchAware isFetching={analysis.isFetching}>
                <ErrorBoundary label="Insights Panel">
                  <InsightsPanel data={analysis.data} />
                </ErrorBoundary>
              </FetchAware>

              {/* Section: Health + Growth */}
              <FetchAware isFetching={analysis.isFetching}>
                <section className="grid lg:grid-cols-3 gap-4">
                  <ErrorBoundary label="Health Alert">
                    <HealthAlert data={analysis.data} />
                  </ErrorBoundary>
                  <ErrorBoundary label="Growth Comparison">
                    <GrowthComparison data={analysis.data} />
                  </ErrorBoundary>
                  <ErrorBoundary label="Deviation Breakdown">
                    <DeviationBreakdownChart data={analysis.data} />
                  </ErrorBoundary>
                </section>
              </FetchAware>

              {/* Section: Multi-Period Comparison */}
              <section>
                <SectionHeader
                  icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
                  title="Perbandingan Multi-Periode"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <ErrorBoundary label="Multi-Period Comparison">
                    <MultiPeriodComparisonCard data={analysis.data} />
                  </ErrorBoundary>
                </FetchAware>
              </section>

              {/* Section: Top Items + Top Outlets */}
              <section>
                <SectionHeader
                  icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                  title="Item Prioritas & Top Resto"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <div className="grid lg:grid-cols-3 gap-4">
                    <ErrorBoundary label="Top Items & Outlets">
                      <TopItemsByNominal data={analysis.data} />
                      <TopItemsByDevBom data={analysis.data} />
                      <TopOutlets data={analysis.data} />
                    </ErrorBoundary>
                  </div>
                </FetchAware>
              </section>

              {/* Section: Area Comparison + Outlet Health Ranking */}
              <section className="grid lg:grid-cols-2 gap-4">
                <div>
                  <SectionHeader
                    icon={<MapPin className="h-4 w-4 text-muted-foreground" />}
                    title="Perbandingan Area"
                    isFetching={analysis.isFetching}
                  />
                  <FetchAware isFetching={analysis.isFetching}>
                    <ErrorBoundary label="Area Comparison">
                      <AreaComparison data={analysis.data} />
                    </ErrorBoundary>
                  </FetchAware>
                </div>
                <div>
                  <SectionHeader
                    icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                    title="Ranking Kondisi Resto"
                    isFetching={analysis.isFetching}
                  />
                  <FetchAware isFetching={analysis.isFetching}>
                    <ErrorBoundary label="Outlet Health Ranking">
                      <OutletHealthRanking data={analysis.data} />
                    </ErrorBoundary>
                  </FetchAware>
                </div>
              </section>

              {/* Section: Item Consistency */}
              <section>
                <SectionHeader
                  icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                  title="Pola Item (Systemic / Widespread / Isolated)"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <ErrorBoundary label="Item Consistency Analysis">
                    <ItemConsistencyAnalysis data={analysis.data} />
                  </ErrorBoundary>
                </FetchAware>
              </section>

              {/* Section: Historical Z-Score + Area Trend */}
              <section>
                <SectionHeader
                  icon={<History className="h-4 w-4 text-muted-foreground" />}
                  title="Analisis Historis (Z-Score + Trend per Area)"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <div className="space-y-4">
                    <ErrorBoundary label="Historical Z-Score">
                      <HistoricalZScoreCard data={analysis.data} />
                    </ErrorBoundary>
                  </div>
                </FetchAware>
              </section>

              {/* Section: Heatmap Area × Item */}
              <ErrorBoundary label="Heatmap Area × Item">
                <AreaItemHeatmap />
              </ErrorBoundary>

              {/* Section: Loss/Surplus + Trend */}
              <FetchAware isFetching={analysis.isFetching}>
                <section className="grid lg:grid-cols-2 gap-4">
                  <ErrorBoundary label="Loss vs Surplus + Trend">
                    <LossVsSurplusChart data={analysis.data} />
                    <TrendChart data={analysis.data} />
                  </ErrorBoundary>
                </section>
              </FetchAware>
            </TabsContent>

            {/* ====== RESTO ANALYSIS TAB (Deep Dive per Resto) ====== */}
            <TabsContent value="resto" className="space-y-4 mt-2 animate-fade-in-up">
              {/* FIX #32: wrap RestoAnalysis in FetchAware so the refetch
                  indicator stays visible while the dashboard refreshes. */}
              <FetchAware isFetching={analysis.isFetching}>
                <ErrorBoundary label="Resto Analysis">
                  <RestoAnalysis analysisData={analysis.data} />
                </ErrorBoundary>
              </FetchAware>
            </TabsContent>

            {/* ====== PEER COMPARISON TAB ====== */}
            <TabsContent value="peer" className="space-y-4 mt-2 animate-fade-in-up">
              {/* FIX #32: FetchAware wraps PeerComparison — it has its own
                  internal isFetching indicator too, but this keeps the
                  dashboard-wide refetch indicator visible. */}
              <FetchAware isFetching={analysis.isFetching}>
                <ErrorBoundary label="Peer Comparison">
                  <PeerComparison />
                </ErrorBoundary>
              </FetchAware>
            </TabsContent>

            {/* ====== PARETO TAB (80/20 Analysis) ====== */}
            <TabsContent value="pareto" className="space-y-4 mt-2 animate-fade-in-up">
              {/* FIX #32: FetchAware wraps ParetoDashboard — the component
                  previously had no awareness of the dashboard refetch
                  (its own query has staleTime 120s and doesn't refetch on
                  global filter change). */}
              <FetchAware isFetching={analysis.isFetching}>
                <ErrorBoundary label="Pareto Dashboard">
                  <ParetoDashboard analysisData={analysis.data} />
                </ErrorBoundary>
              </FetchAware>
            </TabsContent>
          </Tabs>
        ) : null}
      </main>

      {/* Footer (sticky bottom) */}
      <footer className="mt-auto border-t border-border/60 bg-background/80 backdrop-blur">
        <div className="px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-medium text-foreground/80">
              <ShieldAlert className="h-3 w-3 text-amber-500" />
              Inventory Control Intelligence
            </span>
            {status?.stats && (
              <span className="hidden sm:inline tabular-nums">
                {status.stats.totalOutlets} outlet · {status.stats.totalItems} item · {status.stats.totalRecords.toLocaleString()} record
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {analysis.data && (
              <span className="tabular-nums">
                Analisis terakhir: {analysis.data.durationMs}ms · {analysis.data.cached ? 'cache' : 'segar'}
              </span>
            )}
            <span className="hidden sm:inline text-muted-foreground flex items-center gap-1">
              <Activity className="h-3 w-3" />
              Klik baris mana saja untuk drill-down ke sumber
            </span>
          </div>
        </div>
      </footer>

      {/* Drill-down drawer */}
      <DrillDownDrawer />
      <SourceDataModal />
      <CardDrillDown data={analysis.data} />
      <ItemDeepDive data={analysis.data} />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        onExport={handleExport}
        isExporting={isExporting}
      />
      {/* GLOBAL-ITEM-SEARCH: cross-outlet item analysis modal (Cmd+K) */}
      <GlobalItemSearchModal open={itemSearchOpen} onOpenChange={setItemSearchOpen} />

      {/* Audit Log dialog — zombie revival (11 writes, 0 reads → now surfaced) */}
      <AuditLogDialog open={auditLogOpen} onOpenChange={setAuditLogOpen} />

      {/* Fix #10: Scroll to Top button */}
      <ScrollToTop />
    </div>
  );
}
