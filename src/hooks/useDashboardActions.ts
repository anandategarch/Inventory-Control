'use client';

// ============================================================
//  useDashboardActions — extracted from page.tsx lines 220-343.
//  --------------------------------------------------------
//  Owns:
//    • handleExport  — fires /api/export-report, downloads the
//      .docx, surfaces a toast. Memoized via useCallback.
//    • handleRefresh — invalidates 6 query keys (analysis,
//      status, outlet-items, item-history, peer-comparison,
//      recommendations) + fires a toast. Memoized.
//    • isExporting   — local UI state toggled by handleExport.
//    • Global keyboard shortcuts useEffect (Cmd/Ctrl+E, R, K,
//      1/2/3/4, Escape).
//
//  Parent (DashboardPage) still owns `exportDialogOpen` +
//  `itemSearchOpen` + `auditLogOpen` state because the modals
//  themselves are rendered at page level — we pass the setters
//  in so the keyboard handler can close them on Escape.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import type { AnalysisData, StatusData } from '@/hooks/useAnalysis';

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
  setItemSearchOpen: (open: boolean) => void;
  setDrilldown: (d: { outletCode: string | null; itemName: string | null }) => void;
  setSourceModal: (b: boolean) => void;
  setDeepDiveItem: (d: { itemName: string | null; outletCode: string | null }) => void;
}

export interface UseDashboardActionsResult {
  handleExport: (selectedSections: string[]) => Promise<void>;
  handleRefresh: () => void;
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
  setItemSearchOpen,
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

  // UX-ENHANCE: Global keyboard shortcuts.
  // Cmd/Ctrl+E → open export dialog
  // Cmd/Ctrl+R → refresh data (prevents browser refresh)
  // Cmd/Ctrl+K → open global item search (cross-outlet analysis)
  // 1 / 2 / 3 / 4 / 5 / 6 → switch tabs (Dashboard / Resto Analysis / Peer Comparison / Pareto / Trend / Diagnosis)
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
        handleRefresh();
        return;
      }
      // Cmd/Ctrl+K → open global item search
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setItemSearchOpen(true);
        return;
      }
      // 1 / 2 / 3 / 4 / 5 / 6 → switch tabs (only when not typing in an input)
      // FIX #6: Also block when a SearchableComboBox dropdown is open
      // (Radix uses [data-state=open] / [role=combobox][aria-expanded=true]).
      const isDropdownOpen = Boolean(
        document.querySelector('[role="combobox"][aria-expanded="true"], [data-state="open"][role="listbox"], [data-state="open"][role="combobox"]')
      );
      if (!mod && !isTyping && !e.altKey && !isDropdownOpen && (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4' || e.key === '5' || e.key === '6')) {
        const tabMap: Record<string, string> = { '1': 'dashboard', '2': 'resto', '3': 'peer', '4': 'pareto', '5': 'trend', '6': 'diagnosis' };
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
        setDeepDiveItem({ itemName: null, outletCode: null });
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [analysisData, handleRefresh, setActiveTab, setExportDialogOpen, setItemSearchOpen, setDrilldown, setSourceModal, setDeepDiveItem]);

  return { handleExport, handleRefresh, isExporting };
}
