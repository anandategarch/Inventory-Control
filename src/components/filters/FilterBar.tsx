'use client';

// REDesign: Card import removed — FilterBar renders bare content now (parent wraps in sticky container)
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, RotateCcw, Database, AlertTriangle, CloudDownload, Loader2, CheckCircle2, XCircle, Settings, Folder, FileSpreadsheet, Users, Upload, Pencil } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useStatus, usePrefetchAnalysis } from '@/hooks/useAnalysis';
import { Badge } from '@/components/ui/badge';
import { useState, useMemo, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useQueryClient } from '@tanstack/react-query';
import { SettingsDialog } from '@/components/filters/SettingsDialog';
import { DataManagementDialog } from '@/components/filters/DataManagementDialog';
import { PicManagementDialog } from '@/components/filters/PicManagementDialog';
import { FileUploadDialog } from '@/components/filters/FileUploadDialog';
import { DriveImportDialog } from '@/components/filters/DriveImportDialog';

export function FilterBar() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, setMonth, setWeek, setCompareWeek, setArea, setKelompok, setOutlet, setPic, reset } = useDashboard();
  const { data: status, isLoading } = useStatus();
  const prefetchAnalysis = usePrefetchAnalysis();
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  // Google Drive import dialog state
  const [driveDialogOpen, setDriveDialogOpen] = useState(false);
  const [driveUrl, setDriveUrl] = useState('');
  const [driveImporting, setDriveImporting] = useState(false);
  const [driveResult, setDriveResult] = useState<any>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  // Manual rename for Drive import — overrides downloaded filename (fixes "Loading Google Sheet")
  const [driveRenameMode, setDriveRenameMode] = useState<'auto' | 'manual'>('auto');
  const [driveManualName, setDriveManualName] = useState('');
  // Number locale for parsing CSV values — default 'us' (Google exports use US format)
  const [driveNumberLocale, setDriveNumberLocale] = useState<'auto' | 'id' | 'us'>('us');
  // Active Drive import tab: 'folder' | 'file' | 'sheets' — rename only allowed for file/sheets
  const [driveTab, setDriveTab] = useState<string>('folder');
  // Local file upload dialog (alternative to Drive import)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const queryClient = useQueryClient();

  // Client-side validation for Drive manual filename (mirrors server-side validateManualFileName)
  const driveManualValid = useMemo(() => {
    if (driveRenameMode !== 'manual') return true;
    const trimmed = driveManualName.trim();
    if (!trimmed) return false;
    // Must contain an Indonesian month name + 2-4 digit year
    const monthNames = ['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember','jan','feb','mar','apr','jun','jul','agu','sep','okt','nov','des'];
    const lower = trimmed.toLowerCase();
    const hasMonth = monthNames.some(m => lower.includes(m));
    const hasYear = /\b(20\d{2}|\d{2})\b/.test(lower);
    return hasMonth && hasYear;
  }, [driveRenameMode, driveManualName]);

  // Rename is only applicable to single-file imports (file/sheets tabs), NOT folder
  const renameAllowedForTab = driveTab === 'file' || driveTab === 'sheets';

  // Settings dialog state
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Data management & PIC management dialog state
  const [dataMgmtOpen, setDataMgmtOpen] = useState(false);
  const [picMgmtOpen, setPicMgmtOpen] = useState(false);

  // UI-BEAUTIFY-R2: listen for custom events from EmptyState CTAs in page.tsx
  // so the "Upload File" / "Import dari Drive" buttons in the empty state actually open the dialogs.
  useEffect(() => {
    const openUpload = () => setUploadDialogOpen(true);
    const openDrive = () => { setDriveDialogOpen(true); setDriveResult(null); setDriveRenameMode('auto'); setDriveManualName(''); setDriveNumberLocale('us'); };
    document.addEventListener('open-upload-dialog', openUpload);
    document.addEventListener('open-drive-dialog', openDrive);
    return () => {
      document.removeEventListener('open-upload-dialog', openUpload);
      document.removeEventListener('open-drive-dialog', openDrive);
    };
  }, []);

  const months = status?.months || [];
  const weeks = (monthLabel && status?.weeksByMonth) ? Object.entries(status.weeksByMonth).find(([k]) => {
    const m = status.months.find((mm) => mm.label === monthLabel);
    return m && k === m.key;
  })?.[1] || [] : [];
  const pics = status?.pics || [];
  // Filter outlets by area AND pic
  const outlets = (status?.outlets || []).filter((o) => {
    if (area && o.area !== area) return false;
    if (pic && o.pic !== pic) return false;
    return true;
  });
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
        throw new Error(`Server returned non-JSON response (HTTP ${res.status}). The server may have crashed or timed out. Try importing fewer files at once.`);
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
      }
    } catch (e: unknown) {
      setIngestMsg(`Error: ${(e instanceof Error ? e.message : String(e))}`);
    } finally {
      setIngesting(false);
      setTimeout(() => setIngestMsg(null), 8000);
    }
  }

  async function handleDriveImport() {
    if (!driveUrl.trim()) return;
    setDriveImporting(true);
    setDriveResult(null);
    setProgressLog([]);

    // Simulated progress steps (non-streaming, estimated)
    const steps = [
      '⏳ Downloading from Google Drive...',
      '⏳ Parsing Excel...',
      '⏳ Validating data...',
      '⏳ Inserting records to database...',
    ];
    let stepIdx = 0;
    setProgressLog([steps[0]]);
    const stepInterval = setInterval(() => {
      stepIdx++;
      if (stepIdx < steps.length) {
        setProgressLog(prev => [...prev, steps[stepIdx]]);
      }
    }, 5000); // Show next step every 5s

    try {
      const res = await fetch('/api/import-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: driveUrl.trim(),
          numberLocale: driveNumberLocale,
          // Pass manual filename if user chose to rename
          ...(driveRenameMode === 'manual' && driveManualName.trim() ? { manualFileName: driveManualName.trim() } : {}),
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 300)}`);
      }

      const d = await res.json();
      clearInterval(stepInterval);
      setProgressLog([]);
      setDriveResult(d);
      if (d.success) {
        queryClient.invalidateQueries({ queryKey: ['status'] });
        // FIX: Invalidate ALL data-dependent queries after import-drive
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
        queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
        queryClient.invalidateQueries({ queryKey: ["item-history"] });
        queryClient.invalidateQueries({ queryKey: ['peer-comparison'] });
        queryClient.invalidateQueries({ queryKey: ['recommendations'] }); // FIX FLOW-3
      }
    } catch (e: unknown) {
      clearInterval(stepInterval);
      setProgressLog([]);
      setDriveResult({ success: false, error: (e instanceof Error ? e.message : String(e)) });
    } finally {
      setDriveImporting(false);
    }
  }

  function handleCloseDialog() {
    setDriveDialogOpen(false);
    setDriveUrl('');
    setDriveResult(null);
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
          <Select value={monthLabel || ''} onValueChange={setMonth} disabled={isLoading}>
            <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[120px]"><SelectValue placeholder="Bulan" /></SelectTrigger>
                  <SelectContent>
                    {months.map((m) => (
                      <SelectItem
                        key={m.key}
                        value={m.label}
                        className="text-xs"
                        // PERF-OPT: prefetch analysis for this month on hover.
                        // Uses the LAST week of the hovered month (the auto-
                        // select useEffect will pick the same week on click).
                        // TanStack Query dedupes — safe to fire multiple times.
                        onMouseEnter={() => {
                          const weeksForMonth = status?.weeksByMonth?.[m.key] || [];
                          const lastWeek = weeksForMonth[weeksForMonth.length - 1];
                          if (!lastWeek) return;
                          prefetchAnalysis({
                            month: m.label,
                            week: lastWeek,
                            compareWeek: null,
                            compareMonth: null,
                            area,
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

          <Select value={currentWeek || ''} onValueChange={setWeek} disabled={!monthLabel}>
            <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[90px]"><SelectValue placeholder="Minggu" /></SelectTrigger>
                  <SelectContent>
                    {weeks.map((w) => (
                      <SelectItem
                        key={w}
                        value={w}
                        className="text-xs"
                        // PERF-OPT: prefetch analysis for this week on hover.
                        // compareWeek=null lets the server auto-resolve the
                        // previous period (matches what useAnalysis will send
                        // when the user actually clicks).
                        onMouseEnter={() => {
                          if (!monthLabel) return;
                          prefetchAnalysis({
                            month: monthLabel,
                            week: w,
                            compareWeek: null,
                            compareMonth: null,
                            area,
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
          />

          <SearchableComboBox
            options={(status?.kelompokOptions || []).map((k: string) => ({ value: k, label: k }))}
            value={kelompok}
            onValueChange={setKelompok}
            placeholder="Semua Kelompok"
            searchPlaceholder="Cari kelompok..."
            emptyText="Kelompok tidak ditemukan."
            allOptionLabel={`Semua Kelompok (${status?.kelompokOptions?.length || 0})`}
            buttonClassName="min-w-[120px]"
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
            onClick={() => { setDriveDialogOpen(true); setDriveResult(null); setDriveRenameMode('auto'); setDriveManualName(''); setDriveNumberLocale('us'); }}
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
