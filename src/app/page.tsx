'use client';

// ============================================================
//  page.tsx — Dashboard shell (refactored from 734-line god file)
//  --------------------------------------------------------
//  This file is now a thin orchestrator. All UI sections live in
//  dedicated modules under src/components/dashboard/* and the
//  business logic lives in two hooks under src/hooks/*. The page
//  wires them together + owns the modal/drawer state that needs
//  to be visible to multiple children.
//
//  Module map:
//    • DashboardHeader      — sticky header (logo, actions, FilterBar)
//    • DashboardFooter      — sticky footer (stats + drill hint)
//    • tabs/DashboardTab    — main overview (10+ sections, lazy charts)
//    • tabs/RestoTab        — per-outlet deep dive (lazy RestoAnalysis)
//    • tabs/PeerTab         — peer comparison (lazy)
//    • tabs/ParetoTab       — 80/20 Pareto analysis
//    • tabs/ItemTrendTab    — per-item QTY timeline + Z-Score (NEW — TREND-FRONTEND)
//    • useDashboardEffects  — 2 useEffects (atomic auto-select + cache warming)
//    • useDashboardActions  — export/refresh handlers + keyboard shortcuts
//    • shared/index.tsx     — LoadingChart, SectionHeader, EmptyState, etc.
// ============================================================

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useAnalysis, useStatus } from '@/hooks/useAnalysis';
import { useDashboardEffects } from '@/hooks/useDashboardEffects';
import { useDashboardActions } from '@/hooks/useDashboardActions';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardFooter } from '@/components/dashboard/DashboardFooter';
// PERF-FIX: DashboardTab is the DEFAULT tab — statically import so recharts
// chunk is bundled upfront (no lazy delay on first render).
// Other tabs stay lazy (user navigates to them explicitly).
import { DashboardTab } from '@/components/dashboard/tabs/DashboardTab';
import { Suspense, lazy } from 'react';
const RestoTab = lazy(() => import('@/components/dashboard/tabs/RestoTab').then(m => ({ default: m.RestoTab })));
const PeerTab = lazy(() => import('@/components/dashboard/tabs/PeerTab').then(m => ({ default: m.PeerTab })));
const ParetoTab = lazy(() => import('@/components/dashboard/tabs/ParetoTab').then(m => ({ default: m.ParetoTab })));
const ItemTrendTab = lazy(() => import('@/components/dashboard/tabs/ItemTrendTab').then(m => ({ default: m.ItemTrendTab })));
import { ExportDialog } from '@/components/dashboard/ExportDialog';
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import {
  EmptyState, LoadingState, ErrorState, ScrollToTop,
} from '@/components/dashboard/shared';
import {
  Activity, BarChart3, Loader2, Store, TrendingDown, TrendingUp,
} from 'lucide-react';

// ItemDeepDive — lazy-loaded (heavy). Custom spinner fallback.
const ItemDeepDive = dynamic(() => import('@/components/dashboard/ItemDeepDive').then(m => m.ItemDeepDive), { ssr: false, loading: () => (
  <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-amber-500" /></div>
) });

// PERF-FASE5: Tab skeleton fallback for Suspense boundaries.
// Shows a lightweight skeleton while the lazy-loaded tab chunk downloads.
function TabSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-32 rounded-lg border bg-muted/40" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-48 rounded-lg border bg-muted/40" />
        <div className="h-48 rounded-lg border bg-muted/40" />
      </div>
      <div className="h-64 rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function DashboardPage() {
  // FIX (PERF-1 / AUDIT-FE): selector now pulls setPeriod (atomic month+week+
  // compare setter) instead of setMonth/setWeek/setCompareWeek — the effects
  // hook only needs the atomic setter, and the old three-setter chain caused
  // the double /api/analysis fetch on every period change.
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, setPeriod, activeTab, visitedTabs, setActiveTab, setDrilldown, setSourceModal, setDeepDiveItem } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonWeek: s.comparisonWeek,
    comparisonMonth: s.comparisonMonth,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    itemName: s.itemName,
    pic: s.pic,
    setPeriod: s.setPeriod,
    activeTab: s.activeTab,
    // PERF (H-8 QUICK WIN 3): visited-tab gating — see the TabsContent blocks.
    visitedTabs: s.visitedTabs,
    setActiveTab: s.setActiveTab,
    setDrilldown: s.setDrilldown,
    setSourceModal: s.setSourceModal,
    setDeepDiveItem: s.setDeepDiveItem,
  })));

  const { data: status } = useStatus();
  const queryClient = useQueryClient();

  // 2 useEffect hooks: combined auto-select (month+week+compare resolved in
  // ONE atomic setPeriod — PERF-1 fix) + cache warming with resolved compare.
  // Side-effect-only — no return value.
  // H-12: filters are passed in so the heatmap prefetch key matches the
  // heatmap card's live key (prefetchHeatmap filter mismatch fix).
  useDashboardEffects({
    status,
    monthLabel,
    currentWeek,
    comparisonWeek,
    comparisonMonth,
    area,
    kelompok,
    outletCode,
    pic,
    setPeriod,
    queryClient,
  });

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

  // Modal/drawer state lives at page level so the keyboard-shortcut
  // hook can reach the setters AND so the modals can render here.
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // TASK H-3: handleRefresh is now ALSO consumed by the DashboardTab tree
  // (TopGrowthCard's stale-payload recovery button) — previously it was only
  // reachable via the Cmd/Ctrl+R keyboard shortcut inside the hook itself.
  const { handleExport, handleRefresh, isExporting } = useDashboardActions({
    analysisData: analysis.data,
    monthLabel,
    currentWeek,
    comparisonWeek,
    comparisonMonth,
    area,
    kelompok,
    outletCode,
    itemName,
    pic,
    status,
    queryClient,
    setActiveTab,
    setExportDialogOpen,
    setDrilldown,
    setSourceModal,
    setDeepDiveItem,
  });

  // PERF-OPT: derive isLoading/hasData once per render (cheap booleans — no
  // memoization needed; React already dedupes identical primitives).
  const isLoading = analysis.isLoading || analysis.isFetching;
  const statusLoaded = status !== undefined;
  const hasData = statusLoaded && Boolean(status?.stats?.totalRecords && status.stats.totalRecords > 0);

  const tabTriggerClass = "text-xs font-medium gap-1.5 relative data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400 data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-1/2 data-[state=active]:after:-translate-x-1/2 data-[state=active]:after:h-0.5 data-[state=active]:after:w-8 data-[state=active]:after:bg-amber-500 data-[state=active]:after:rounded-full data-[state=active]:after:transition-all";

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/20 dark:from-background dark:to-zinc-950">
      <DashboardHeader
        status={status}
        hasData={hasData}
        isExporting={isExporting}
        analysisFetching={analysis.isFetching}
        analysisData={analysis.data}
        onExportClick={() => setExportDialogOpen(true)}
      />

      {/* Main content */}
      {/* FIX (SHADCN Pattern 2): add `@container/main` so descendants
          (KPI grids, card layouts) can use container queries that
          respond to the main content area's width instead of the
          viewport. Tailwind 4 supports `@container` natively without
          plugin/config — breakpoints @xl/main (576px) etc. map to the
          main element's bounding box, not the window. */}
      <main id="main-content" aria-label="Dashboard Inventory Control" className="@container/main flex-1 px-3 sm:px-6 pt-2 pb-4 space-y-4 max-w-[1600px] w-full mx-auto min-w-0">
        {!statusLoaded ? (
          <LoadingState />
        ) : !hasData ? (
          <EmptyState />
        ) : isLoading && !analysis.data ? (
          <LoadingState />
        ) : analysis.error ? (
          <ErrorState message={analysis.error.message} />
        ) : analysis.data ? (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full min-w-0">
            <TabsList className="w-full justify-start overflow-x-auto h-auto flex-nowrap bg-muted/40 dark:bg-zinc-900/40 p-1 gap-1 rounded-xl border border-border/60 shadow-sm shadow-black/5 dark:shadow-black/20">
              <TabsTrigger value="dashboard" className={tabTriggerClass}>
                <BarChart3 className="h-3.5 w-3.5" /> Dashboard
              </TabsTrigger>
              <TabsTrigger value="resto" className={tabTriggerClass}>
                <Store className="h-3.5 w-3.5" /> Resto Analysis
              </TabsTrigger>
              <TabsTrigger value="peer" className={tabTriggerClass}>
                <Activity className="h-3.5 w-3.5" /> Peer Comparison
              </TabsTrigger>
              <TabsTrigger value="pareto" className={tabTriggerClass}>
                <TrendingDown className="h-3.5 w-3.5" /> Pareto
              </TabsTrigger>
              <TabsTrigger value="trend" className={tabTriggerClass}>
                <TrendingUp className="h-3.5 w-3.5" /> Trend Item
              </TabsTrigger>
            </TabsList>

            {/* ====== DASHBOARD TAB (Overview + Network) ====== */}
            {/* DashboardTab is statically imported (default tab) — no Suspense needed. */}
            {/* PERF-FE (PAKET A): forceMount + data-[state=inactive]:hidden = keep-alive
                tabs. Previously Radix unmounted every tab on switch → the whole
                subtree (charts, tables, local state like the selected peer outlet)
                was rebuilt from scratch on every tab change. Radix does NOT hide
                force-mounted inactive content by itself — the Tailwind variant
                does it. The animate-fade-in-up entrance animation is also gone
                (it re-ran on every switch and stacked with the globals.css
                tabpanel animation — double-layered 0.25s+0.3s jank). */}
            {/* PERF (H-8 QUICK WIN 3 — visited-tab gating): on top of keep-alive,
                each non-default tab's CONTENT only mounts on FIRST VISIT
                (tracked in the useDashboard store via setActiveTab/setFocusOutlet).
                Before this, force-mount eagerly mounted ALL 5 tabs on page load —
                hidden tabs fired /api/pareto + /api/flip-ranking ×2 (including
                the unscoped ALL-WEEKS variant — the heaviest form) and loaded
                their lazy chunks for tabs the user may never open, competing
                with the cold /api/analysis fetch for connections. Keep-alive
                semantics are preserved: once visited, the subtree stays mounted. */}
            <TabsContent value="dashboard" forceMount aria-label="Dashboard tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
              <DashboardTab data={analysis.data} onRefresh={handleRefresh} />
            </TabsContent>

            {/* ====== RESTO ANALYSIS TAB (Deep Dive per Resto) ====== */}
            <TabsContent value="resto" forceMount aria-label="Resto Analysis tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
              {visitedTabs.includes('resto') ? (
                <Suspense fallback={<TabSkeleton />}>
                  <RestoTab data={analysis.data} />
                </Suspense>
              ) : null}
            </TabsContent>

            {/* ====== PEER COMPARISON TAB ====== */}
            <TabsContent value="peer" forceMount aria-label="Peer Comparison tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
              {visitedTabs.includes('peer') ? (
                <Suspense fallback={<TabSkeleton />}>
                  <PeerTab />
                </Suspense>
              ) : null}
            </TabsContent>

            {/* ====== PARETO TAB (80/20 Analysis) ====== */}
            <TabsContent value="pareto" forceMount aria-label="Pareto tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
              {visitedTabs.includes('pareto') ? (
                <Suspense fallback={<TabSkeleton />}>
                  <ParetoTab data={analysis.data} />
                </Suspense>
              ) : null}
            </TabsContent>

            {/* ====== TREND ITEM TAB (Per-item QTY timeline + Z-Score) ====== */}
            <TabsContent value="trend" forceMount aria-label="Trend Item tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
              {visitedTabs.includes('trend') ? (
                <Suspense fallback={<TabSkeleton />}>
                  <ErrorBoundary label="Trend Item">
                    {/* Phase 1 — pass analysisData so the tab can render the
                        Rank Badge row (item's national rank in topDeviasiRank). */}
                    <ItemTrendTab analysisData={analysis.data} />
                  </ErrorBoundary>
                </Suspense>
              ) : null}
            </TabsContent>
          </Tabs>
        ) : null}
      </main>

      <DashboardFooter status={status} analysisData={analysis.data} />

      {/* Drill-down drawer (CardDrillDown removed per user request — cards only) */}
      <DrillDownDrawer />
      <SourceDataModal />
      <ItemDeepDive data={analysis.data} />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        onExport={handleExport}
        isExporting={isExporting}
      />

      {/* Fix #10: Scroll to Top button */}
      <ScrollToTop />
    </div>
  );
}
