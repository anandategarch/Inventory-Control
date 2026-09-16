'use client';

// ============================================================
//  useDashboardActions — extracted from page.tsx lines 220-343.
//  --------------------------------------------------------
//  Owns:
//    • handleExport  — fires /api/export-report, downloads the
//      .pdf, surfaces a toast. Memoized via useCallback.
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
  // EXPORT-PDF: the Resto Analysis tab's active outlet (focusOutlet from a
  // table row click || outletCode from the FilterBar dropdown) — the export
  // follows the SAME outlet the user sees in Resto Analysis (user request:
  // "filter resto nya dari Filter resto analisis").
  focusOutlet: string | null;
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
  focusOutlet,
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
  //
  // FIX (BUG-3-b A2/A3/A4): the export flow used to (a) wait on the fetch
  // forever — server hang = spinner until the browser/CDN 504s, (b) accept
  // any 200 body as a valid .pdf (0-byte/HTML files were saved + a fake
  // success toast fired), (c) revoke the object URL synchronously right after
  // a.click() — on WebKit/Safari that races the download and can cancel it
  // ("toast sukses tapi file tak ada"). Now: 120s AbortController timeout,
  // blob size + content-type validation, deferred revoke, and an in-progress
  // toast (dismissed on completion) so the user knows the wait is normal.
  // EXPORT-PDF: output switched .docx → .pdf (server returns
  // application/pdf from pdf-builder). The outlet follows the Resto Analysis
  // filter (focusOutlet || outletCode — same activeOutlet the Resto
  // Analysis tab renders), so "what I see in Resto Analysis" == "what the
  // report contains" (user request: filter resto dari Filter resto analisis).
  const handleExport = useCallback(async (selectedSections: string[]) => {
    if (!analysisData) return;
    // Resto Analysis convention (RestoAnalysis.tsx: activeOutlet =
    // focusOutlet || outletCode) — focusOutlet wins while set; the FilterBar
    // dropdown's setOutlet clears it (useDashboard.ts), so both paths agree.
    const activeOutlet = focusOutlet || outletCode;
    setExportDialogOpen(false);
    setIsExporting(true);
    // FIX (BUG-3-b A2): in-progress feedback — the dialog closes immediately
    // and the header spinner alone gave no expectation-setting. useToast's
    // toast() returns { dismiss, update }; we only need dismiss-on-completion.
    const pending = toast({
      title: '⏳ Menyiapkan laporan...',
      description: 'Laporan lengkap bisa memakan waktu hingga ±1 menit — jangan tutup halaman.',
    });
    try {
      const params = new URLSearchParams({ month: monthLabel || '', week: currentWeek || '' });
      if (comparisonWeek) params.set('compareWeek', comparisonWeek);
      if (comparisonMonth) params.set('compareMonth', comparisonMonth);
      if (area) params.set('area', area);
      if (kelompok) params.set('kelompok', kelompok);
      if (activeOutlet) params.set('outlet', activeOutlet);
      if (itemName) params.set('item', itemName);
      if (pic) params.set('pic', pic);
      params.set('sections', selectedSections.join(','));
      // Report design version (busts the CDN/edge cache after a design
      // change — keep in sync with the `rv` extra in /api/export-report's
      // cache key). Ignored server-side (Zod strips unknown params).
      // REFINE-3: rv 5 — heat text fix, section 6 anomali, vs Rata-rata
      // Area column, weekly composition + accumulation charts, renumbering.
      // REFINE-4: rv 6 — Rata-rata Absolute + magnitude comparisons, 6.2
      // flip detection, section 5 signed cells + abs heat, section 9
      // per-pair grouping, 8.2 resto setara terms, plain-percent Selisih.
      // HEAT-SIGN: rv 7 — section 5 heat cells encode the SIGN (red ramp =
      // loss side, green ramp = surplus side; magnitude picks the step).
      // PEERTOP/PEERTOP-R1: rv 8 — NEW PDF section 8.3 (Top Item Resto
      // Setara — bersama vs khusus; Ranking Resto di antara Resto yang
      // Selevel per Item; QTY Deviasi signed; Rata-rata Absolute |QTY|) +
      // 8.4 removed. This bump was MISSING when PEERTOP landed — same URL
      // hit the CDN's old cached response AND the server's stale SWR row
      // (user: "kok di laporan PDF tidak ada perubahan?").
      // PEERTOP-R2: rv 9 — 8.3 re-titled "Item di Resto lain (yang setara
      // penjualan <nama resto>) jika dilihat dari TOP Item nya"; headers
      // pakai NAMA resto (Rangking/Nominal/QTY Deviasi (KWGGAL), 8.2 juga);
      // "Top di" = top-3 resto by |nominal|, target ikut bila termasuk.
      // PEERTOP-R3: rv 10 — bug fix "Top di" (user: "misal resto target
      // 11/11 tapi juga muncul di top di"): basis kini RANK() yang sama
      // dengan kolom Rangking — target muncul di Top di persis ketika
      // itemRank ≤ 3.
      // BUGHUNT-Q1: rv 11 — "Rata-rata Historical" tabel 3.3-3.6 kini
      // per-periode (SUM per periode lalu AVG, bukan AVG per baris mentah
      // yang understated k× untuk multi-record per periode); angka kolom
      // historis + persentase fmtVsHist berubah.
      // PDFCOLOR-1: rv 12 — minus-RED on VALUE columns (user: "terkait
      // minus atau penurunan harusnya warna merah"): KPI hero cards,
      // current/previous columns of sections 1/2/7, 3.3-3.6 QTY columns,
      // 4.1/4.2 nominal columns, 6.1/6.2 signed columns, 8.2 QTY columns
      // (8.3 already was minus-red). The S7 trend table now agrees with
      // its own red diverging bars. Render-only — no data change.
      params.set('rv', '12');

      // FIX (BUG-3-b A3): AbortController + 120s timeout — a hung export no
      // longer spins forever; the fetch is aborted and the user gets a
      // friendly message instead of waiting for a platform 504.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);
      let res: Response;
      try {
        res = await fetch(`/api/export-report?${params.toString()}`, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const contentType = res.headers.get('content-type') || '';
      const blob = await res.blob();
      // FIX (BUG-3-b A4): validate the payload before declaring success —
      // a 200 with an empty body or non-PDF content (proxy error page,
      // JSON error that slipped through) used to be saved as a corrupt
      // "Laporan_*.pdf" with a success toast on top.
      if (blob.size === 0) throw new Error('File kosong dari server — coba lagi');
      if (!contentType.includes('pdf')) {
        throw new Error(`Server mengirim file yang bukan PDF [${contentType || 'tanpa content-type'}] — coba lagi`);
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // FIX: filename include periode + nama resto (jika outlet dipilih)
      // Format: Laporan_[OutletName]_[Month]_[Week]_[comparePeriod?].pdf
      const outletName = activeOutlet
        ? status?.outlets?.find(o => o.code === activeOutlet)?.name?.replace(/\s+/g, '_') || activeOutlet
        : 'Semua_Resto';
      const compareSuffix = comparisonWeek ? `_vs_${comparisonWeek.replace(/\s+/g, '')}` : '';
      a.download = `Laporan_${outletName}_${(monthLabel || 'unknown').replace(/\s+/g, '_')}_${currentWeek || ''}${compareSuffix}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // FIX (BUG-3-b A1): WebKit/Safari race — revoking the object URL
      // synchronously after click() can cancel the download before it
      // starts. Defer 60s (well past any browser's download-start window);
      // no manual clear needed, the timer firing post-unmount is harmless.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      pending.dismiss();
      toast({ title: '✅ Export berhasil', description: `${selectedSections.length} section · Laporan PDF telah diunduh` });
    } catch (e: unknown) {
      pending.dismiss();
      // FIX (BUG-3-b A3): map AbortError to a friendly Indonesian message
      // (pattern: fetchAnalysis.ts) instead of "The user aborted a request".
      if (e instanceof Error && e.name === 'AbortError') {
        toast({
          title: '❌ Export gagal',
          description: 'Server timeout (120 detik). Laporan terlalu berat — coba lagi atau kurangi pilihan section.',
          variant: 'destructive',
        });
      } else {
        toast({ title: '❌ Export gagal', description: (e instanceof Error ? e.message : 'Unknown error'), variant: 'destructive' });
      }
    } finally {
      setIsExporting(false);
    }
  }, [analysisData, monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, focusOutlet, itemName, pic, toast, status, setExportDialogOpen]);

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
    // FIX (BUG-3-b A6): check res.ok — a 429 (rate limit) or 5xx used to be
    // reported as "Cache server dibersihkan" while the server cache was in
    // fact still warm. Be honest about it: client queries are still
    // invalidated (same data as before), just without the server-side clear.
    let refreshOk = true;
    let refreshStatus = 0;
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (!res.ok) {
        refreshOk = false;
        refreshStatus = res.status;
      }
    } catch {
      // Non-fatal — proceed to client-side invalidation regardless.
      refreshOk = false;
    }
    invalidateAllData(queryClient);
    // PERF (H-8 QW3): hidden tabs the user never opened have no active
    // TanStack observers, so their keys are marked stale WITHOUT a refetch;
    // only visited tabs (keep-alive mounted) refresh in background.
    toast({
      title: '🔄 Data diperbarui',
      description: refreshOk
        ? 'Cache server dibersihkan — data dihitung ulang (butuh beberapa detik).'
        : `Cache server gagal dibersihkan${refreshStatus ? ` (HTTP ${refreshStatus})` : ''} — menampilkan data yang ada.`,
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
      // FIX (BUG-HUNT C18/BUG-3-07): guard with isTyping — typing Ctrl+E inside
      // an input used to hijack the keystroke and open the export dialog.
      if (mod && (e.key === 'e' || e.key === 'E')) {
        if (isTyping) return;
        e.preventDefault();
        if (analysisData) setExportDialogOpen(true);
        return;
      }
      // Cmd/Ctrl+R → refresh data (prevent browser refresh)
      if (mod && (e.key === 'r' || e.key === 'R')) {
        if (isTyping) return;
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
        // FIX (BUG-HUNT C18/BUG-3-08): also block while a Radix Popover/Dialog
        // (e.g. QuickSettings) is open — focus sits inside the popper content,
        // and the old check only matched combobox/listbox, so digits switched
        // the tab BEHIND the open popover.
        const focusInOverlay = Boolean(
          (document.activeElement as HTMLElement | null)?.closest?.('[data-radix-popper-content-wrapper], [role="dialog"]')
        );
        if (focusInOverlay) return;
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
