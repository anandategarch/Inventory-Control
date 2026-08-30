'use client';

// ============================================================
//  DashboardHeader — sticky 2-tier header extracted from page.tsx
//  --------------------------------------------------------
//  Tier 1: logo + title + action buttons (Export / Cari Item /
//          Audit Log / Keyboard shortcuts tooltip) + status badges
//  Tier 2: FilterBar (bare, no Card wrapper) — only when hasData
// ============================================================

import { FilterBar } from '@/components/filters/FilterBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Activity, Boxes, FileDown, FileText, History, Keyboard, Loader2, Search,
} from 'lucide-react';
import type { AnalysisData, StatusData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';

export interface DashboardHeaderProps {
  status: StatusData | undefined;
  hasData: boolean;
  isExporting: boolean;
  analysisFetching: boolean;
  analysisData: AnalysisData | undefined;
  onExportClick: () => void;
  onItemSearchClick: () => void;
  onAuditLogClick: () => void;
}

export function DashboardHeader({
  status,
  hasData,
  isExporting,
  analysisFetching,
  analysisData,
  onExportClick,
  onItemSearchClick,
  onAuditLogClick,
}: DashboardHeaderProps) {
  const { outletCode, monthLabel, currentWeek } = useDashboard(useShallow((s) => ({
    outletCode: s.outletCode,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
  })));

  const handlePdfDownload = () => {
    if (!outletCode || outletCode === 'all' || !monthLabel || !currentWeek) return;
    const params = new URLSearchParams({
      outletCode,
      month: monthLabel,
      week: currentWeek,
    });
    window.open(`/api/report-pdf?${params.toString()}`, '_blank');
  };

  const canDownloadPdf = !!(outletCode && outletCode !== 'all' && monthLabel && currentWeek);
  return (
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
              onClick={onItemSearchClick}
              aria-label="Cari item di semua outlet (Cmd+K)"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Cari Item</span>
              <kbd className="hidden md:inline ml-0.5 px-1 py-0.5 text-[10px] font-mono rounded border bg-muted/60 text-muted-foreground">⌘K</kbd>
            </Button>
          )}
          {analysisFetching && analysisData && (
            <Badge variant="outline" className="text-[11px] h-7 gap-1.5 rounded-full px-2.5 border-amber-300/70 dark:border-amber-800/70 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="hidden sm:inline">Memperbarui...</span>
            </Badge>
          )}
          {analysisData && (
            <Badge variant="outline" className="text-[11px] h-7 hidden lg:inline-flex gap-1.5 rounded-full px-2.5 text-muted-foreground">
              <Activity className="h-3 w-3" />
              <span className="tabular-nums">{analysisData.cached ? 'cache' : 'langsung'} · {analysisData.durationMs}ms</span>
            </Badge>
          )}
          {analysisData && (
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 text-xs font-medium shadow-sm hover:shadow-md bg-amber-600 hover:bg-amber-700 text-white transition-all active:scale-95"
              disabled={isExporting}
              onClick={onExportClick}
              aria-label="Export laporan Word"
            >
              {isExporting ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> <span className="hidden sm:inline">Exporting...</span></>
              ) : (
                <><FileDown className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Export</span></>
              )}
            </Button>
          )}
          {/* PDF Resto Report — download detailed analysis PDF for selected outlet */}
          {canDownloadPdf && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Download PDF Resto"
                  onClick={handlePdfDownload}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors px-2 text-xs font-medium"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">PDF Resto</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">Download laporan PDF untuk resto terpilih</TooltipContent>
            </Tooltip>
          )}
          {/* Audit Log button — zombie revival (AuditLog model had 11 writes, 0 reads) */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Audit Log"
                onClick={onAuditLogClick}
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
  );
}
