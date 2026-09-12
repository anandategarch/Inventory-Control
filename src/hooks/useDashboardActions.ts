'use client';

// ============================================================
//  useDashboardActions — extracted from page.tsx lines 220-343.
//  --------------------------------------------------------
//  Owns:
//    • handleExport  — fires /api/export-report, downloads the
//      .docx, surfaces a toast. Memoized via useCallback.
//    • handleRefresh — invalidates the dashboard query keys (analysis,
//      status, outlet-items, item-history, peer-comparison,
//      recommendations) + fires a toast. Memoized.
//    • isExporting   — local UI state toggled by handleExport.
//    • Global keyboard shortcuts useEffect (Cmd/Ctrl+E, R, K,
//      1-7, Escape).
//
//  Parent (DashboardPage) still owns `exportDialogOpen` +
//  `itemSearchOpen` state because the modals
//  themselves are rendered at page level — we pass the setters
//  in so the keyboard handler can close them on Escape.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import type { AnalysisData, StatusData } from '@/hooks/useAnalysis';
import { invalidateAllData } from '@/lib/query-invalidation';

// P3-HYG-6: the open-dropdown DOM probe is only needed for the 1-7 tab
// shortcuts — hoisted to module scope + only evaluated inside that branch
// (was: 3-selector document.querySelector on EVERY keypress, even plain
// typing in inputs, before the isTyping guard had a chance to matter).
const OPEN_DROPDOWN_SELECTOR =
  '[role="combobox"][aria-expanded="true"], [data-state="open"][role="listbox"], [data-state="open"][role="combobox"]';

export interface UseDashboardActionsParams {
  analysisData: AnalysisData | undefined;
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  itemName: string | null;
  pic: string | null;
  status: StatusData | undefined;
  queryClient: QueryClient;
  setActiveTab: (tab: string) => void;
  setExportDialogOpen: (open: boolean) => void;
  setDrilldown: (d: { outletCode: string | null; itemName: string | null }) => void;
  setSourceModal: (b: boolean) => void;
  setDeepDiveItem: (d: { itemName: string | null; outletCode: string | null }) => void;
}

export interface UseDashboardActionsResult {
  handleExport: (selectedSections: string[]) => Promise<void>;
  /**
   * FIX (TASK H-3): now async — awaits the SERVER-side cache clear
   * (POST /api/refresh) before invalidating client queries, so the
   * refetch triggered by invalidation is guaranteed to recompute
   * instead of re-hitting a warm AggregationCache row.
   */
  handleRefresh: () => Promise<void>;
  isExporting: boolean;
}

export function useDashboardActions({
  analysisData,
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
}: UseDashboardActionsParams): UseDashboardActionsResult {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  // PERF-OPT: useCallback keeps handleExport stable across renders so
  // ExportDialog doesn't re-render unnecessarily (it's memoized via React.memo
  // in some shadcn variants; stable callback guarantees it).
  const handleExport = useCallback(async (selectedSections: string[]) => {
    if (!analysisData) return;
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
  }, [analysisData, monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, toast, status, setExportDialogOpen]);

  // UX-ENHANCE + FIX (TASK H-3): Refresh handler — clears the SERVER-side
  // AggregationCache FIRST, then invalidates ALL client query caches.
  // ---------------------------------------------------------------
  // The old handler only invalidated client-side TanStack queries: the
  // refetch re-hit the SAME warm DB-cache row (30-min TTL) and served the
  // identical payload — "refresh" was a no-op whenever the server cache
  // was warm (root cause of the "Top Growth cache lama meskipun sudah
  // refresh" report). POST /api/refresh awaits invalidateAnalysisCache()
  // (deleteMany on all cached routes) before returning, so ordering here
  // is load-bearing: server clear → THEN client invalidation → refetch
  // recomputes fresh.
  // Non-fatal by design: if /api/refresh fails (429 rate limit — 30/min —
  // or transient network), we still invalidate the client queries; the
  // refetch then serves whatever the server has (same as the old behavior).
  // FIX FE-08: Added missing query invalidations (area-item-heatmap, item-trend, drilldown, pareto)
  // FIX FE-08 + H-12: the invalidation herd now lives in ONE place —
  // src/lib/query-invalidation.ts (18 keys: core dashboard payload +
  // heatmap incl. cell-detail + Trend tab incl. flip/rank/search + Pareto
  // + drilldown + price-effect + item-anomali-outlets). H-14/T3 extended
  // the same call to the six other mutation handlers (upload/delete/
  // reset/drive/ingest/settings/pic) which previously carried older
  // 5-6-key subsets — the missed keys stayed stale in keep-alive tabs.
  const handleRefresh = useCallback(async () => {
    try {
      await fetch('/api/refresh', { method: 'POST' });
    } catch {
      // Non-fatal — proceed to client-side invalidation regardless.
    }
    invalidateAllData(queryClient);
    // PERF (H-8 QW3): hidden tabs the user never opened have no active
    // TanStack observers, so their keys are marked stale WITHOUT a refetch;
    // only visited tabs (keep-alive mounted) refresh in background.
    toast({
      title: '🔄 Data diperbarui',
      description: 'Cache server dibersihkan — data dihitung ulang (butuh beberapa detik).',
    });
  }, [queryClient, toast]);

  // UX-ENHANCE: Global keyboard shortcuts.
  // Cmd/Ctrl+E → open export dialog
  // Cmd/Ctrl+R → refresh data (prevents browser refresh)
  // 1-7 → switch tabs (Area / Resto / Item / Peer / Pareto /
  //       Historical / Heatmap)
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
        if (analysisData) setExportDialogOpen(true);
        return;
      }
      // Cmd/Ctrl+R → refresh data (prevent browser refresh)
      if (mod && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        void handleRefresh(); // async since TASK H-3 — intentionally fire-and-forget
        return;
      }
      // 1-7 → switch tabs (only when not typing in an input)
      // FIX #6: Also block when a SearchableComboBox dropdown is open
      // (Radix uses [data-state=open] / [role=combobox][aria-expanded=true]).
      // P3-HYG-6: the querySelector probe now runs ONLY when the key is one
      // of the tab digits — cheap constant folding for every other keypress.
      if (!mod && !isTyping && !e.altKey && (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4' || e.key === '5' || e.key === '6' || e.key === '7')) {
        const isDropdownOpen = Boolean(document.querySelector(OPEN_DROPDOWN_SELECTOR));
        if (isDropdownOpen) return;
        // VH-2 remap: 7 deep-analysis tabs (spec §6.8 — keyboard 1-7).
        const tabMap: Record<string, string> = { '1': 'area', '2': 'resto', '3': 'item', '4': 'peer', '5': 'pareto', '6': 'historical', '7': 'heatmap' };
        setActiveTab(tabMap[e.key]);
        return;
      }
      // Escape → close any open dialog/drawer (Radix handles its own; this
      // covers dashboard-controlled state + ExportDialog as a safety net).
      // FIX #7: Guard with !isTyping so Escape inside a SearchableComboBox
      // search box only closes that dropdown (Radix bubbles Escape to window).
      if (e.key === 'Escape' && !isTyping) {
        setExportDialogOpen(false);
        setDrilldown({ outletCode: null, itemName: null });
        setSourceModal(false);
        setDeepDiveItem({ itemName: null, outletCode: null });
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [analysisData, handleRefresh, setActiveTab, setExportDialogOpen, setDrilldown, setSourceModal, setDeepDiveItem]);

  return { handleExport, handleRefresh, isExporting };
}
