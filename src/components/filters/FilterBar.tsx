'use client';

// PERF-FASE1-FE01: Lazy-load 5 modal dialogs via next/dynamic.
// These dialogs are modal-only (rendered when `open` is true), but static
// imports pull their code + ALL transitive deps into the main bundle even
// when the dialogs are never opened. Lazy-loading saves ~80-120KB from the
// initial bundle (FileUploadDialog 841L, DataManagementDialog 486L,
// PicManagementDialog 469L, SettingsDialog 444L, DriveImportDialog 278L).
// The dialog chunk loads on-demand when the user first opens the dialog.
import dynamic from 'next/dynamic';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, RotateCcw, Database, AlertTriangle, CloudDownload, Loader2, Settings, Users, Upload } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useStatus, usePrefetchAnalysis } from '@/hooks/useAnalysis';
import { findAutoCompareForStatus } from '@/lib/auto-compare';
import { Badge } from '@/components/ui/badge';
import { useState, useMemo, useEffect } from 'react';
import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useQueryClient } from '@tanstack/react-query';

// Lazy-loaded dialogs (code-split — only loaded when first opened)
const SettingsDialog = dynamic(
  () => import('@/components/filters/SettingsDialog').then(m => ({ default: m.SettingsDialog })),
  { ssr: false, loading: () => null },
);
const DataManagementDialog = dynamic(
  () => import('@/components/filters/DataManagementDialog').then(m => ({ default: m.DataManagementDialog })),
  { ssr: false, loading: () => null },
);
const PicManagementDialog = dynamic(
  () => import('@/components/filters/PicManagementDialog').then(m => ({ default: m.PicManagementDialog })),
  { ssr: false, loading: () => null },
);
const FileUploadDialog = dynamic(
  () => import('@/components/filters/FileUploadDialog').then(m => ({ default: m.FileUploadDialog })),
  { ssr: false, loading: () => null },
);
const DriveImportDialog = dynamic(
  () => import('@/components/filters/DriveImportDialog').then(m => ({ default: m.DriveImportDialog })),
  { ssr: false, loading: () => null },
);

export function FilterBar() {
  // FIX (PERF-1 / AUDIT-FE): setPeriod replaces setMonth/setWeek in the month/week
  // Select handlers — period changes are now ATOMIC (one store update, one
  // queryKey change, one /api/analysis fetch). setCompareWeek stays for the
  // compare Select (single-field change is already atomic).
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, setPeriod, setCompareWeek, setArea, setKelompok, setOutlet, setPic, reset } = useDashboard(useShallow((s) => ({
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
    setCompareWeek: s.setCompareWeek,
    setArea: s.setArea,
    setKelompok: s.setKelompok,
    setOutlet: s.setOutlet,
    setPic: s.setPic,
    reset: s.reset,
  })));
  const { data: status, isLoading } = useStatus();
  const prefetchAnalysis = usePrefetchAnalysis();
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  // Drive dialog open state (the DriveImportDialog component manages its own internal state)
  const [driveDialogOpen, setDriveDialogOpen] = useState(false);
  // Local file upload dialog
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const queryClient = useQueryClient();

  // Settings dialog state
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Data management & PIC management dialog state
  const [dataMgmtOpen, setDataMgmtOpen] = useState(false);
  const [picMgmtOpen, setPicMgmtOpen] = useState(false);

  // UI-BEAUTIFY-R2: listen for custom events from EmptyState CTAs in page.tsx
  // so the "Upload File" / "Import dari Drive" buttons in the empty state actually open the dialogs.
  useEffect(() => {
    const openUpload = () => setUploadDialogOpen(true);
    const openDrive = () => { setDriveDialogOpen(true); };
    document.addEventListener('open-upload-dialog', openUpload);
    document.addEventListener('open-drive-dialog', openDrive);
    return () => {
      document.removeEventListener('open-upload-dialog', openUpload);
      document.removeEventListener('open-drive-dialog', openDrive);
    };
  }, []);

  // FIX (BUG-FE-9): After data upload/import, the status query invalidates and
  // refetches. If the new dataset doesn't have the currently-selected kelompok
  // (e.g., user uploaded a different region's data), the dropdown would still
  // show the old kelompok as selected but the option would be gone — user can't
  // deselect via dropdown, only via Reset. This effect clears kelompok (and
  // other filter state) if they're no longer valid in the new status data.
  useEffect(() => {
    if (!status) return;
    const kelompokOpts = status.kelompokOptions || [];
    if (kelompok && kelompok !== 'all' && kelompokOpts.length > 0 && !kelompokOpts.some(k => k.kelompok === kelompok)) {
      setKelompok(null);
    }
    if (area && status.areas.length > 0 && !status.areas.includes(area)) {
      setArea(null);
    }
    if (pic && status.pics.length > 0 && !status.pics.includes(pic)) {
      setPic(null);
    }
    if (outletCode && status.outlets.length > 0 && !status.outlets.some((o) => o.code === outletCode)) {
      setOutlet(null);
    }
  }, [status, kelompok, area, pic, outletCode, setKelompok, setArea, setPic, setOutlet]);

  const months = status?.months || [];
  const weeks = (monthLabel && status?.weeksByMonth) ? Object.entries(status.weeksByMonth).find(([k]) => {
    const m = status.months.find((mm) => mm.label === monthLabel);
    return m && k === m.key;
  })?.[1] || [] : [];
  const pics = status?.pics || [];
  // Filter outlets by area AND pic AND kelompok
  // FIX (BUG-FE-2): previously only filtered by area + pic — user could select
  // an outlet outside the selected kelompok → backend returns 0 rows → misleading
  // "no data" error. Now filters by kelompok too, so the dropdown only shows
  // outlets consistent with the active kelompok filter.
  // PERF-05: useMemo outlets filter — was recomputed on every render (e.g., when
  // ingestMsg state changes). Now only recomputes when status/area/pic/kelompok change.
  const outlets = useMemo(() => (status?.outlets || []).filter((o) => {
    if (area && o.area !== area) return false;
    if (pic && o.pic !== pic) return false;
    if (kelompok) {
      // Same extraction as backend: last dot-segment, first 3 chars, uppercase
      const segs = o.code.split('.');
      const oKelompok = (segs[segs.length - 1] || '').substring(0, 3).toUpperCase();
      if (oKelompok !== kelompok.toUpperCase()) return false;
    }
    return true;
  }), [status?.outlets, area, pic, kelompok]);
  const areas = status?.areas || [];

  type Period = { label: string; monthLabel: string; weekLabel: string; sortKey: string };
  const allComparePeriods: Period[] = [];
  if (status?.weeksByMonth && status?.months) {
    for (const m of status.months) {
      const ws = status.weeksByMonth[m.key] || [];
      for (const w of ws) {
        if (m.label === monthLabel && w === currentWeek) continue;
        allComparePeriods.push({
          label: `${w} — ${m.label}`,
          monthLabel: m.label,
          weekLabel: w,
          sortKey: `${m.key}|${String(parseInt(w.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
        });
      }
    }
    allComparePeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  const compareValue = comparisonWeek
    ? `${comparisonWeek}|||${comparisonMonth || monthLabel}`
    : 'auto';
  const hasActiveFilter = Boolean(area || kelompok || outletCode || pic);

  async function handleIngest() {
    setIngesting(true);
    setIngestMsg(null);
    try {
      const res = await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      // FIX: Check content-type before parsing — server crash returns HTML
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server returned non-JSON response (HTTP ${res.status}). ${text.slice(0, 300)}`);
      }
      const d = await res.json();
      if (d.success) {
        const ingested = d.results.filter((r: any) => r.status === 'INGESTED');
        const skipped = d.results.filter((r: any) => r.status === 'SKIPPED');
        const errors = d.results.filter((r: any) => r.status === 'ERROR');
        setIngestMsg(`Ingested: ${ingested.length}, Skipped: ${skipped.length}, Errors: ${errors.length}`);
        queryClient.invalidateQueries({ queryKey: ['status'] });
        // FIX: Invalidate ALL data-dependent queries after ingest
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
        queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
        queryClient.invalidateQueries({ queryKey: ["item-history"] });
        queryClient.invalidateQueries({ queryKey: ['peer-comparison'] });
        queryClient.invalidateQueries({ queryKey: ['recommendations'] }); // FIX FLOW-3
      } else {
        // UI-04 FIX: Show error to user instead of silent failure
        setIngestMsg(`Error: ${d.error || 'Unknown server error'}`);
      }
    } catch (e: unknown) {
      setIngestMsg(`Error: ${(e instanceof Error ? e.message : String(e))}`);
    } finally {
      setIngesting(false);
      setTimeout(() => setIngestMsg(null), 8000);
    }
  }

  // ============================================================
  //  FIX (PERF-1 / AUDIT-FE): atomic period-change handlers.
  //  --------------------------------------------------------
  //  Previously `onValueChange={setMonth}` / `onValueChange={setWeek}`
  //  reset week+compare (store setters null them out), then the
  //  useDashboardEffects chain re-set them across several renders →
  //  useAnalysis's queryKey changed TWICE per interaction → the heavy
  //  /api/analysis payload was double-fetched on every month/week
  //  change. These handlers resolve the full (month, week, compare)
  //  triple up front and commit it with ONE setPeriod() call.
  //
  //  Compare resolution = same-weekLabel search BACKWARDS in a
  //  different month (shared with useDashboardEffects via
  //  src/lib/auto-compare.ts).
  //  FIX (AUDIT-BUG-2): no chronological fallback — cumulative weeks
  //  make cross-week comparisons meaningless. No same-weekLabel prior
  //  month → compare = null (backend handles null compare gracefully).
  // ============================================================
  function handleMonthChange(newMonth: string) {
    // New month's last available week (the same week the auto-select
    // effect / hover-prefetch assume for a month switch).
    const m = status?.months.find((mm) => mm.label === newMonth);
    const weeksForMonth = m && status?.weeksByMonth ? (status.weeksByMonth[m.key] || []) : [];
    const lastWeek = weeksForMonth[weeksForMonth.length - 1] ?? null;
    if (!lastWeek) {
      // Week data not available for the new month — clear week+compare;
      // the combined auto-select effect in useDashboardEffects fills them
      // (still ONE setPeriod from the user's click, one more from the effect).
      setPeriod(newMonth, null, null, null);
      return;
    }
    const compare = findAutoCompareForStatus(status, newMonth, lastWeek);
    setPeriod(newMonth, lastWeek, compare?.weekLabel ?? null, compare?.monthLabel ?? null);
  }

  function handleWeekChange(newWeek: string) {
    if (!monthLabel) return; // Select is disabled without a month — defensive
    const compare = findAutoCompareForStatus(status, monthLabel, newWeek);
    setPeriod(monthLabel, newWeek, compare?.weekLabel ?? null, compare?.monthLabel ?? null);
  }

  return (
    <>
      {/* REDesign-HEADER: FilterBar now renders BARE content (no Card wrapper).
          The parent in page.tsx wraps this in a single sticky container with
          the header — saves ~100px vertical (no double padding, no labels, no stats row). */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
          <span>Memuat filter...</span>
        </div>
      )}
      {/* Filters row — left side: dropdowns, right side: actions */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-3">
        {/* Filter dropdowns — no labels (placeholder in dropdown is clear enough) */}
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          <Select value={monthLabel || ''} onValueChange={handleMonthChange} disabled={isLoading}>
            <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[120px]"><SelectValue placeholder="Bulan" /></SelectTrigger>
                  <SelectContent>
                    {months.map((m) => (
                      <SelectItem
                        key={m.key}
                        value={m.label}
                        className="text-xs"
                        // PERF-OPT: prefetch analysis for this month on hover.
                        // Uses the LAST week of the hovered month (handleMonthChange
                        // picks the same week on click) + the resolved compare so
                        // the prefetch key matches the live key.
                        // TanStack Query dedupes — safe to fire multiple times.
                        onMouseEnter={() => {
                          const weeksForMonth = status?.weeksByMonth?.[m.key] || [];
                          const lastWeek = weeksForMonth[weeksForMonth.length - 1];
                          if (!lastWeek) return;
                          // FIX (BUG-FE-1): include kelompok in prefetch params
                          // so the prefetch queryKey matches the live useAnalysis
                          // queryKey. Without this, prefetch cache entries were
                          // never reused when kelompok was active.
                          // FIX (PERF-1 / AUDIT-FE): also include the RESOLVED
                          // compare period — handleMonthChange now sets it on
                          // click, so compareWeek: null here would make the
                          // hover-prefetch key never match the live key.
                          const compare = findAutoCompareForStatus(status, m.label, lastWeek);
                          prefetchAnalysis({
                            month: m.label,
                            week: lastWeek,
                            compareWeek: compare?.weekLabel ?? null,
                            compareMonth: compare?.monthLabel ?? null,
                            area,
                            kelompok,
                            outlet: outletCode,
                            item: itemName,
                            pic,
                          });
                        }}
                      >
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

          <Select value={currentWeek || ''} onValueChange={handleWeekChange} disabled={!monthLabel}>
            <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[90px]"><SelectValue placeholder="Minggu" /></SelectTrigger>
                  <SelectContent>
                    {weeks.map((w) => (
                      <SelectItem
                        key={w}
                        value={w}
                        className="text-xs"
                        // PERF-OPT: prefetch analysis for this week on hover.
                        // Includes the resolved compare period so the prefetch
                        // key matches what useAnalysis will send when the user
                        // actually clicks (handleWeekChange).
                        onMouseEnter={() => {
                          if (!monthLabel) return;
                          // FIX (BUG-FE-1): include kelompok in prefetch params
                          // FIX (PERF-1 / AUDIT-FE): also include the RESOLVED
                          // compare period — handleWeekChange now sets it on
                          // click (was compareWeek: null, which relied on a
                          // server-side auto-resolve the live query no longer
                          // triggers after the atomic-handler change).
                          const compare = findAutoCompareForStatus(status, monthLabel, w);
                          prefetchAnalysis({
                            month: monthLabel,
                            week: w,
                            compareWeek: compare?.weekLabel ?? null,
                            compareMonth: compare?.monthLabel ?? null,
                            area,
                            kelompok,
                            outlet: outletCode,
                            item: itemName,
                            pic,
                          });
                        }}
                      >
                        {w}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

          <Select
            value={compareValue}
            onValueChange={(v) => {
              if (v === 'auto') {
                setCompareWeek(null, null);
              } else {
                const [wk, ml] = v.split('|||');
                setCompareWeek(wk, ml);
              }
            }}
            disabled={!currentWeek}
          >
            <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[150px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">Otomatis (periode sebelumnya)</SelectItem>
                    {allComparePeriods.map((p) => (
                      <SelectItem
                        key={`${p.weekLabel}|${p.monthLabel}`}
                        value={`${p.weekLabel}|||${p.monthLabel}`}
                        className="text-xs"
                      >
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

          <SearchableComboBox
            options={pics.map((p) => ({ value: p, label: p }))}
            value={pic}
            onValueChange={setPic}
            placeholder="Semua PIC"
            searchPlaceholder="Cari PIC..."
            emptyText="PIC tidak ditemukan."
            allOptionLabel={`Semua PIC (${pics.length})`}
            buttonClassName="min-w-[120px]"
            ariaLabel="Filter PIC"
          />

          <SearchableComboBox
            options={areas.map((a) => ({ value: a, label: a }))}
            value={area}
            onValueChange={setArea}
            placeholder="Semua Area"
            searchPlaceholder="Cari area..."
            emptyText="Area tidak ditemukan."
            allOptionLabel={`Semua Area (${areas.length})`}
            buttonClassName="min-w-[120px]"
            ariaLabel="Filter Area"
          />

          <SearchableComboBox
            options={(status?.kelompokOptions || []).map((k) => ({
              value: k.kelompok,
              label: k.kelompok,
              description: `${k.area} · ${k.outletCount} outlet`,
            }))}
            value={kelompok}
            onValueChange={setKelompok}
            placeholder="Semua Kelompok"
            searchPlaceholder="Cari kelompok..."
            emptyText="Kelompok tidak ditemukan."
            allOptionLabel={`Semua Kelompok (${status?.kelompokOptions?.length || 0})`}
            buttonClassName="min-w-[120px]"
            ariaLabel="Filter Kelompok"
          />

          <SearchableComboBox
            options={outlets.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}`, description: o.area }))}
            value={outletCode}
            onValueChange={setOutlet}
            placeholder="Semua Outlet"
            searchPlaceholder="Cari outlet (kode/nama)..."
            emptyText="Outlet tidak ditemukan."
            allOptionLabel={`Semua Outlet (${outlets.length})`}
            buttonClassName="min-w-[150px]"
            ariaLabel="Filter Outlet"
          />

          {hasActiveFilter && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors active:scale-95"
                  onClick={reset}
                  aria-label="Reset filter aktif"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="ml-1 hidden sm:inline">Reset</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reset filter aktif</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Vertical divider on desktop */}
        <div className="hidden lg:block w-px self-stretch bg-border/60 my-0.5" aria-hidden />

        {/* Actions — secondary icon-only (with tooltips) + primary actions */}
        <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0">
          {/* Secondary icon-only buttons with tooltips */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-muted/50 transition-all active:scale-95"
                onClick={() => setSettingsOpen(true)}
                aria-label="Pengaturan"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Pengaturan</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-muted/50 transition-all active:scale-95"
                onClick={() => setDataMgmtOpen(true)}
                aria-label="Kelola Data"
              >
                <Database className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Kelola Data</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-muted/50 transition-all active:scale-95"
                onClick={() => setPicMgmtOpen(true)}
                aria-label="Kelola PIC"
              >
                <Users className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Kelola PIC</TooltipContent>
          </Tooltip>

          {/* Primary actions — Import dari Drive, Upload File, Refresh Data */}
          <div className="h-5 w-px bg-border/60 mx-0.5 hidden sm:block" aria-hidden />

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs font-medium hover:bg-muted/50 transition-all active:scale-95"
            onClick={() => { setDriveDialogOpen(true); }}
          >
            <CloudDownload className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span className="hidden md:inline">Import Drive</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs font-medium hover:bg-muted/50 transition-all active:scale-95"
            onClick={() => setUploadDialogOpen(true)}
          >
            <Upload className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span className="hidden md:inline">Upload File</span>
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-8 gap-1.5 text-xs font-medium shadow-sm hover:shadow-md bg-amber-600 hover:bg-amber-700 text-white transition-all active:scale-95"
            onClick={handleIngest}
            disabled={ingesting}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${ingesting ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{ingesting ? 'Memproses...' : 'Refresh Data'}</span>
          </Button>
        </div>
      </div>

      {/* Ingest message (inline, no separate stats row — stats already in footer) */}
      {ingestMsg && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="text-[11px] gap-1 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30 font-medium">
            <AlertTriangle className="h-3 w-3" />
            {ingestMsg}
          </Badge>
        </div>
      )}

      {/* Google Drive Import Dialog — with Folder/File/Sheets tabs */}
      {/* Drive Import Dialog — extracted to separate component */}
      <DriveImportDialog open={driveDialogOpen} onOpenChange={setDriveDialogOpen} />
      {/* Settings Dialog */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Data Management Dialog */}
      <DataManagementDialog open={dataMgmtOpen} onOpenChange={setDataMgmtOpen} />

      {/* PIC Management Dialog */}
      <PicManagementDialog open={picMgmtOpen} onOpenChange={setPicMgmtOpen} />

      {/* Local File Upload Dialog — alternative to Drive import, with rename + confirmation */}
      <FileUploadDialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen} />
    </>
  );
}
