'use client';

// ============================================================
//  DashboardHeader — sticky 2-tier header extracted from page.tsx
//  --------------------------------------------------------
//  Tier 1: logo + title + action buttons (Export / Cari Item /
//          Keyboard shortcuts tooltip) + status badges
//  Tier 1.5 (VH-1, spec §4 L0): global period label — one line
//          summarizing the active filter period, promoted from
//          the ExecutiveSummary badge so the period is visible
//          without scrolling into the analysis. Built ONLY from
//          the store's existing period strings (no new date
//          formatting).
//  Tier 2: FilterBar (bare, no Card wrapper) — only when hasData
// ============================================================

import { useEffect, useRef } from 'react';
import { FilterBar } from '@/components/filters/FilterBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Activity, Boxes, Clock3, FileDown, Keyboard, Loader2, RefreshCw, SlidersHorizontal,
} from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import type { AnalysisData, StatusData } from '@/hooks/useAnalysis';

export interface DashboardHeaderProps {
  status: StatusData | undefined;
  hasData: boolean;
  isExporting: boolean;
  analysisFetching: boolean;
  analysisData: AnalysisData | undefined;
  /** VH-6 (Grafana/Metabase/Superset pattern): TanStack Query's
   *  dataUpdatedAt — epoch-ms of when the analysis payload last resolved.
   *  Drives the "Diperbarui HH.MM" freshness badge (Metabase-style
   *  "Updated X ago"). 0 = not fetched yet (badge hidden). */
  dataUpdatedAt: number;
  onExportClick: () => void;
  /** VH-6: true refresh (POST /api/refresh + invalidateAllData — the
   *  same flow as ⌘/Ctrl+R) — finally has a VISIBLE affordance like every
   *  BI tool's refresh control next to the time picker. */
  onRefreshClick: () => void;
}

export function DashboardHeader({
  status,
  hasData,
  isExporting,
  analysisFetching,
  analysisData,
  dataUpdatedAt,
  onExportClick,
  onRefreshClick,
}: DashboardHeaderProps) {
  // VH-1 (spec §4 L0): the global period label reads the period straight
  // from the store (same leaf-component subscription pattern as FilterBar
  // / RankingNasionalCard). page.tsx already subscribes to these fields
  // for useAnalysis — a local selector here keeps the header in sync even
  // during period transitions without extra prop threading.
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonWeek: s.comparisonWeek,
    comparisonMonth: s.comparisonMonth,
  })));

  // Single line "{month} · {week} · vs {compareWeek} {compareMonth}" —
  // built from the store's existing strings AS-IS (spec forbids new date
  // formatting). Segments only render when their value exists, so the
  // pre-auto-select transient (nulls) never shows "· · vs". VH-4 fix: "vs W4"
  // alone is ambiguous when the compare is the same weekLabel in a DIFFERENT
  // month — append the compare month when it differs (mirrors the Deviasi KPI
  // caption + the Pembanding combobox "W4 — Juni 2026" label).
  const compareLabel = comparisonWeek
    ? (comparisonMonth && comparisonMonth !== monthLabel
        ? `${comparisonWeek} ${comparisonMonth}`
        : comparisonWeek)
    : comparisonMonth;
  const periodParts: string[] = [];
  if (monthLabel) periodParts.push(monthLabel);
  if (currentWeek) periodParts.push(currentWeek);
  if (compareLabel) periodParts.push(`vs ${compareLabel}`);
  const showPeriodLabel = hasData && periodParts.length > 0;

  // VH-4 (spec §4 L6 / §6.5 — layered sticky): publish the header's ACTUAL
  // height as a CSS variable so the L6 tab strip can dock exactly below it
  // (sticky top-[var(--dashboard-header-h)]). Measured with a ResizeObserver —
  // the header height varies with the period line + filter wrap + viewport,
  // so a hardcoded offset would misalign at some breakpoints. Set on
  // <html> so page.tsx's TabsList (a different subtree) can consume it.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () => {
      document.documentElement.style.setProperty('--dashboard-header-h', `${el.offsetHeight}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header ref={headerRef} className="sticky top-0 z-40 border-b border-amber-500/60 bg-gradient-to-b from-background/95 to-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 shadow-sm shadow-black/[0.03] dark:shadow-black/20 min-w-0">
      {/* Tier 1: Brand + actions */}
      <div className="px-6 py-1.5 flex items-center justify-between gap-2 max-w-[1600px] mx-auto">
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
              <Badge variant="outline" className="text-[11px] h-6 inline-flex gap-1 px-1.5 tabular-nums text-muted-foreground shrink-0">
                {status.stats.totalOutlets} outlet
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {analysisFetching && analysisData && (
            <Badge variant="outline" className="text-[11px] h-6 gap-1.5 rounded-full px-2.5 border-amber-300/70 dark:border-amber-800/70 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="inline">Memperbarui...</span>
            </Badge>
          )}
          {analysisData && dataUpdatedAt > 0 && (
            <Badge
              variant="outline"
              // VH-6 (Metabase "Updated X ago" / Grafana last-refresh):
              // data-freshness indicator — "as of when is what I'm looking?".
              // Full timestamp on hover via native title. Rendered only after
              // the client fetch resolves (dataUpdatedAt===0 during prerender
              // → no hydration mismatch possible).
              title={`Data analisis terakhir diperbarui: ${new Date(dataUpdatedAt).toLocaleString('id-ID')}`}
              className="text-[11px] h-6 inline-flex gap-1.5 rounded-full px-2.5 text-muted-foreground tabular-nums shrink-0"
            >
              <Clock3 className="h-3 w-3" />
              Diperbarui {new Date(dataUpdatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
            </Badge>
          )}
          {analysisData && (
            <Badge
              variant="outline"
              // QW-B (Phase C item 5): surface the SWR `stale` flag — backend
              // injects "stale":true when the response came from an EXPIRED
              // DB-cache entry while a background recompute runs (validate-
              // and-resolve.ts). Amber styling + native title so the user
              // knows the numbers on screen may be one generation behind.
              title={analysisData.stale
                ? 'Data dari cache kedaluwarsa — versi terbaru sedang dihitung ulang di latar belakang'
                : undefined}
              className={`text-[11px] h-6 inline-flex gap-1.5 rounded-full px-2.5 ${analysisData.stale
                ? 'border-amber-300/70 dark:border-amber-800/70 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30'
                : 'text-muted-foreground'}`}
            >
              <Activity className="h-3 w-3" />
              <span className="tabular-nums">{analysisData.stale ? 'cache lama' : analysisData.cached ? 'cache' : 'langsung'} · {analysisData.durationMs}ms</span>
            </Badge>
          )}
          {analysisData && (
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 text-xs font-medium shadow-sm hover:shadow-md bg-amber-600 hover:bg-amber-700 text-white transition-all active:scale-95"
              disabled={isExporting}
              onClick={onExportClick}
              aria-label="Export laporan PDF"
            >
              {isExporting ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> <span className="inline">Exporting...</span></>
              ) : (
                <><FileDown className="h-3.5 w-3.5" /> <span className="inline">Export</span></>
              )}
            </Button>
          )}
          {/* VH-6 (Grafana/Metabase/Superset): visible TRUE-refresh control.
              Previously the only affordance was the hidden ⌘/Ctrl+R shortcut
              (FilterBar's "Refresh Data" is a server re-ingest, not a display
              refresh). Icon-button, same visual language as the keyboard-help
              button next to it — refresh is a frequent action but shouldn't
              compete with Export (the primary amber CTA). */}
          {analysisData && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onRefreshClick}
                  aria-label="Muat ulang data"
                  // FIX (BUG-HUNT C3/B3): busy state — the button used to stay
                  // enabled with a static icon during POST /api/refresh +
                  // invalidation (rapid double-clicks fired duplicate refreshes).
                  // Spin + disable while the analysis query refetches, matching
                  // the affordance the FilterBar's Sinkron button already has.
                  disabled={analysisFetching}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-60"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${analysisFetching ? 'animate-spin' : ''}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">Muat Ulang Data (⌘/Ctrl+R)</TooltipContent>
            </Tooltip>
          )}
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
                <li className="flex items-center justify-between gap-3"><span>Export PDF</span><kbd className="font-mono">⌘/Ctrl + E</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Refresh data</span><kbd className="font-mono">⌘/Ctrl + R</kbd></li>
                {/* VH-2: 8 deep-analysis tabs — remapped from the old 1-5
                    (spec §6.8: keyboard 1-8 + tooltip updated to match).
                    FIX (UIUX-A T5): entry Tab Waste/8 ditambahkan — shortcut-nya
                    sudah ada & berfungsi sejak BUGHUNT-R2 (tabMap '8': 'waste'),
                    tapi help ini belum mendokumentasikannya. */}
                <li className="flex items-center justify-between gap-3"><span>Tab Area</span><kbd className="font-mono">1</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Resto</span><kbd className="font-mono">2</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Item</span><kbd className="font-mono">3</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Peer</span><kbd className="font-mono">4</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Pareto</span><kbd className="font-mono">5</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Historical</span><kbd className="font-mono">6</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Heatmap</span><kbd className="font-mono">7</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tab Waste</span><kbd className="font-mono">8</kbd></li>
                <li className="flex items-center justify-between gap-3"><span>Tutup dialog</span><kbd className="font-mono">Esc</kbd></li>
              </ul>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Tier 1.5 (VH-1): global period label — spec §4 L0
          ("text-xs font-medium text-muted-foreground tracking-wide
          tabular-nums"). Rendered only when a period is resolved and data
          exists; changing the filter updates it without scrolling. */}
      {showPeriodLabel && (
        <div className="px-6 max-w-[1600px] mx-auto">
          <p className="text-xs font-medium text-muted-foreground tracking-wide tabular-nums">
            {periodParts.join(' · ')}
          </p>
        </div>
      )}

      {/* Tier 2: FilterBar (bare, no Card wrapper) — only shown when data exists.
          VH-4: id="l1-filter" completes the §6.6 anchor set (l1-filter … l6-deep).
          FIX (UIUX-A T3): Tier-2 kini responsif — desktop (md+) FilterBar inline
          (layout & lebar IDENTIK dengan sebelumnya); mobile (<md) disembunyikan di
          balik satu tombol "Filter & Aksi" yang membuka bottom Sheet berisi
          FilterBar yang sama. Header sticky mobile turun ±377px → ±140px (56% →
          ~17% viewport 375×667); ResizeObserver --dashboard-header-h menyesuaikan
          otomatis (mekanisme itu tidak disentuh). Dua instansi FilterBar aman:
          keduanya store-driven (useFilterBarState baca store yang sama), status
          query ter-dedupe queryKey oleh TanStack, dialog management di dalamnya
          lazy-load dan hanya terbuka via klik pada instansi yang terlihat —
          CSS-only visibility (hidden md:block vs md:hidden), nol hydration branch. */}
      {hasData && (
        <div id="l1-filter">
          {/* Desktop (md+): FilterBar inline — layout & lebar identik dengan sebelumnya */}
          <div className="hidden md:block px-6 pb-1.5 max-w-[1600px] mx-auto">
            <FilterBar />
          </div>
          {/* Mobile (<md): satu tombol full-width membuka bottom Sheet (FIX UIUX-A T3) */}
          <div className="md:hidden px-6 pb-1.5 max-w-[1600px] mx-auto">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 w-full gap-1.5 text-xs">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Filter & Aksi
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="h-auto max-h-[85vh] overflow-y-auto px-4 pb-4">
                <SheetHeader className="pb-2 border-b">
                  <SheetTitle className="text-sm">Filter & Aksi</SheetTitle>
                  <SheetDescription className="text-xs">
                    Filter periode & organisasi, upload/import file, dan pengaturan data.
                  </SheetDescription>
                </SheetHeader>
                <FilterBar />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      )}
    </header>
  );
}
