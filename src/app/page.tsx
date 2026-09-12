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
//    • DashboardHeader      — sticky header (logo, period label, actions, FilterBar)
//    • DashboardFooter      — sticky footer (stats + drill hint)
//    • narrative/DashboardNarrative — L2-L5 layers ABOVE the tab strip
//      (executive status → attention → why → diagnosis) — VH-1
//    • tabs/AreaTab         — Area comparison + outlet health ranking
//      (DEFAULT tab, static import — renders from the existing
//      /api/analysis payload, no extra fetch) — VH-2
//    • tabs/RestoTab         — per-outlet deep dive (lazy RestoAnalysis)
//    • tabs/ItemTab          — item priority + trend + pola item (lazy) —
//      merges the old Trend Item tab — VH-2
//    • tabs/PeerTab          — peer comparison (lazy)
//    • tabs/ParetoTab        — 80/20 Pareto analysis
//    • tabs/HistoricalTab    — Z-Score + multi-period + BOM correlation (lazy) — VH-2
//    • tabs/HeatmapTab       — Area × Item heatmap (lazy, self-fetch) — VH-2
//    • useDashboardEffects  — 2 useEffects (atomic auto-select + cache warming)
//    • useDashboardActions  — export/refresh handlers + keyboard shortcuts
//    • shared/index.tsx     — LoadingChart, SectionHeader, LayerHeader, EmptyState, etc.
// ============================================================

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useAnalysis, useStatus } from '@/hooks/useAnalysis';
import { useDashboardEffects } from '@/hooks/useDashboardEffects';
import { useDashboardActions } from '@/hooks/useDashboardActions';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardFooter } from '@/components/dashboard/DashboardFooter';
// VH-1 (Visual Hierarchy): the L2-L5 narrative layers render ABOVE the
// tab strip, OUTSIDE <Tabs> — switching a deep-analysis tab never remounts
// them and the narrative scroll position survives (spec §3 principle 1).
// React.memo'd (same reason as the tab wrappers: skip re-render on
// unrelated Zustand state changes at page level).
import { DashboardNarrative } from '@/components/dashboard/narrative/DashboardNarrative';
// PERF-FIX: AreaTab is the DEFAULT tab (VH-2 — cheapest content: both of
// its components render from the payload /api/analysis already fetched,
// and AdvancedAnalysis pulls no recharts) — statically import so the
// first paint needs no lazy round-trip. Other tabs stay lazy.
import { AreaTab } from '@/components/dashboard/tabs/AreaTab';
import { Suspense, lazy } from 'react';
const RestoTab = lazy(() => import('@/components/dashboard/tabs/RestoTab').then(m => ({ default: m.RestoTab })));
const ItemTab = lazy(() => import('@/components/dashboard/tabs/ItemTab').then(m => ({ default: m.ItemTab })));
const PeerTab = lazy(() => import('@/components/dashboard/tabs/PeerTab').then(m => ({ default: m.PeerTab })));
const ParetoTab = lazy(() => import('@/components/dashboard/tabs/ParetoTab').then(m => ({ default: m.ParetoTab })));
const HistoricalTab = lazy(() => import('@/components/dashboard/tabs/HistoricalTab').then(m => ({ default: m.HistoricalTab })));
const HeatmapTab = lazy(() => import('@/components/dashboard/tabs/HeatmapTab').then(m => ({ default: m.HeatmapTab })));
import { ExportDialog } from '@/components/dashboard/ExportDialog';
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';

// FIX (H-14/T1): upload + drive-import dialogs hosted at PAGE level. Their
// old host (FilterBar) is only mounted when hasData — exactly the inverse of
// when EmptyState (whose CTA buttons dispatch open-upload-dialog /
// open-drive-dialog) is visible, so on a fresh DB the CTAs were dead. A single
// listener + a single dialog mount here (FilterBar's own buttons now dispatch
// the same events) — no double-open race from ErrorState's CTA either.
// Still dynamic/lazy (same as in FilterBar) to keep them out of the main bundle.
const FileUploadDialog = dynamic(
  () => import('@/components/filters/FileUploadDialog').then(m => ({ default: m.FileUploadDialog })),
  { ssr: false, loading: () => null },
);
const DriveImportDialog = dynamic(
  () => import('@/components/filters/DriveImportDialog').then(m => ({ default: m.DriveImportDialog })),
  { ssr: false, loading: () => null },
);
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  EmptyState, LoadingState, ErrorState, ScrollToTop, LayerHeader,
} from '@/components/dashboard/shared';
import {
  Activity, History, LayoutGrid, Loader2, MapPin, Store, TrendingDown, TrendingUp,
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

  const { data: status, error: statusError } = useStatus();
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

  // H-14/T1: the ONLY listener pair for the EmptyState/ErrorState CTA events
  // (see the dynamic-import note above for why this lives here, not FilterBar).
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [driveDialogOpen, setDriveDialogOpen] = useState(false);
  useEffect(() => {
    const openUpload = () => setUploadDialogOpen(true);
    const openDrive = () => setDriveDialogOpen(true);
    document.addEventListener('open-upload-dialog', openUpload);
    document.addEventListener('open-drive-dialog', openDrive);
    return () => {
      document.removeEventListener('open-upload-dialog', openUpload);
      document.removeEventListener('open-drive-dialog', openDrive);
    };
  }, []);

  // TASK H-3: handleRefresh is now ALSO consumed by the DashboardNarrative
  // tree (TopGrowthCard's stale-payload recovery button) — previously it was
  // only reachable via the Cmd/Ctrl+R keyboard shortcut inside the hook itself.
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
        {statusError ? (
          // FIX (H-14/T2): /api/status failure used to render an infinite fake
          // loading screen (error field was never read; retry is disabled and
          // refetchOnWindowFocus is off, so nothing would ever recover). Show
          // the real error + a retry instead. ErrorState's retry now also
          // invalidates ['status'] so the button actually works here.
          <ErrorState message={statusError instanceof Error ? statusError.message : 'Gagal memuat status server.'} />
        ) : !statusLoaded ? (
          <LoadingState />
        ) : !hasData ? (
          <EmptyState />
        ) : isLoading && !analysis.data ? (
          <LoadingState />
        ) : analysis.error ? (
          <ErrorState message={analysis.error.message} />
        ) : analysis.data ? (
          <div className="space-y-8 md:space-y-10 min-w-0">
            {/* VH-1: inter-layer rhythm — narrative layers above, deep-analysis
                band below, separated by space-y-8 md:space-y-10 (spec §5.3:
                layer gap ≥ 2× the 16px card gap). */}
            <DashboardNarrative data={analysis.data} onRefresh={handleRefresh} />

            {/* ====== L6 — DEEP ANALYSIS band (VH-2) ====== */}
            {/* Spec §3 principle 2 + §5.3: the ONLY "band" zone — the
                full-bleed bg-muted/25 + border-t-2 signals the switch from
                reading (narrative above) to working (deep analysis below).
                -mx-3/px-3 sm:-mx-6/px-6 breaks out of main's horizontal
                padding so the band spans the content column edge-to-edge. */}
            <section id="l6-deep" aria-labelledby="l6-header" className="scroll-mt-32">
              <LayerHeader number="05" title="DEEP ANALYSIS" id="l6-header" />
              <div className="-mx-3 px-3 sm:-mx-6 sm:px-6 border-t-2 border-border bg-muted/25 mt-4 pt-2 pb-4">
                {/* PERF-FE (PAKET A): forceMount + data-[state=inactive]:hidden
                    = keep-alive tabs. Previously Radix unmounted every tab on
                    switch → the whole subtree (charts, tables, local state like
                    the selected peer outlet) was rebuilt from scratch on every
                    tab change. Radix does NOT hide force-mounted inactive
                    content by itself — the Tailwind variant does it. The
                    animate-fade-in-up entrance animation is also gone (it
                    re-ran on every switch and stacked with the globals.css
                    tabpanel animation — double-layered 0.25s+0.3s jank). */}
                {/* PERF (H-8 QUICK WIN 3 — visited-tab gating): on top of
                    keep-alive, each non-default tab's CONTENT only mounts on
                    FIRST VISIT (tracked in the useDashboard store via
                    setActiveTab/setFocusOutlet). Before this, force-mount
                    eagerly mounted ALL tabs on page load — hidden tabs fired
                    their queries (e.g. /api/pareto + /api/flip-ranking ×2,
                    including the unscoped ALL-WEEKS variant — the heaviest
                    form) and loaded their lazy chunks for tabs the user may
                    never open, competing with the cold /api/analysis fetch
                    for connections. Keep-alive semantics are preserved: once
                    visited, the subtree stays mounted. */}
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full min-w-0">
                  <TabsList className="w-full justify-start overflow-x-auto h-auto flex-nowrap bg-muted/40 dark:bg-zinc-900/40 p-1 gap-1 rounded-xl border border-border/60 shadow-sm shadow-black/5 dark:shadow-black/20">
                    <TabsTrigger value="area" className={tabTriggerClass}>
                      <MapPin className="h-3.5 w-3.5" /> Area
                    </TabsTrigger>
                    <TabsTrigger value="resto" className={tabTriggerClass}>
                      <Store className="h-3.5 w-3.5" /> Resto
                    </TabsTrigger>
                    <TabsTrigger value="item" className={tabTriggerClass}>
                      <TrendingUp className="h-3.5 w-3.5" /> Item
                    </TabsTrigger>
                    <TabsTrigger value="peer" className={tabTriggerClass}>
                      <Activity className="h-3.5 w-3.5" /> Peer
                    </TabsTrigger>
                    <TabsTrigger value="pareto" className={tabTriggerClass}>
                      <TrendingDown className="h-3.5 w-3.5" /> Pareto
                    </TabsTrigger>
                    <TabsTrigger value="historical" className={tabTriggerClass}>
                      <History className="h-3.5 w-3.5" /> Historical
                    </TabsTrigger>
                    <TabsTrigger value="heatmap" className={tabTriggerClass}>
                      <LayoutGrid className="h-3.5 w-3.5" /> Heatmap
                    </TabsTrigger>
                  </TabsList>

                  {/* ====== AREA TAB (default — static import, eager render) ====== */}
                  <TabsContent value="area" forceMount aria-label="Area tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
                    <AreaTab data={analysis.data} />
                  </TabsContent>

                  {/* ====== RESTO ANALYSIS TAB (Deep Dive per Resto) ====== */}
                  <TabsContent value="resto" forceMount aria-label="Resto Analysis tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
                    {visitedTabs.includes('resto') ? (
                      <Suspense fallback={<TabSkeleton />}>
                        <RestoTab data={analysis.data} />
                      </Suspense>
                    ) : null}
                  </TabsContent>

                  {/* ====== ITEM TAB (Priority + Trend + Pola — merged VH-2) ====== */}
                  <TabsContent value="item" forceMount aria-label="Item tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
                    {visitedTabs.includes('item') ? (
                      <Suspense fallback={<TabSkeleton />}>
                        <ItemTab data={analysis.data} />
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

                  {/* ====== HISTORICAL TAB (Z-Score + Multi-Periode + BOM Correlation) ====== */}
                  <TabsContent value="historical" forceMount aria-label="Historical tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
                    {visitedTabs.includes('historical') ? (
                      <Suspense fallback={<TabSkeleton />}>
                        <HistoricalTab data={analysis.data} />
                      </Suspense>
                    ) : null}
                  </TabsContent>

                  {/* ====== HEATMAP TAB (Area × Item — self-fetch) ====== */}
                  <TabsContent value="heatmap" forceMount aria-label="Heatmap tab" className="space-y-4 mt-2 data-[state=inactive]:hidden">
                    {visitedTabs.includes('heatmap') ? (
                      <Suspense fallback={<TabSkeleton />}>
                        <HeatmapTab />
                      </Suspense>
                    ) : null}
                  </TabsContent>
                </Tabs>
              </div>
            </section>
          </div>
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

      {/* H-14/T1: upload + drive dialogs — page-level host (single listener) */}
      <FileUploadDialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen} />
      <DriveImportDialog open={driveDialogOpen} onOpenChange={setDriveDialogOpen} />

      {/* Fix #10: Scroll to Top button */}
      <ScrollToTop />
    </div>
  );
}
