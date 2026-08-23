'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, RotateCcw, Database, AlertTriangle, CloudDownload, Loader2, CheckCircle2, XCircle, Settings, Folder, FileSpreadsheet, Users, Upload, Pencil } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useStatus } from '@/hooks/useAnalysis';
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

export function FilterBar() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, pic, setMonth, setWeek, setCompareWeek, setArea, setOutlet, setPic, reset } = useDashboard();
  const { data: status, isLoading } = useStatus();
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
  const hasActiveFilter = Boolean(area || outletCode || pic);

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
      <Card id="filter-bar" className="mb-4 rounded-xl border-border/60 shadow-sm overflow-hidden">
        <CardContent className="p-3 sm:p-4">
          {isLoading && (
            <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
              <span>Memuat filter...</span>
            </div>
          )}
          {/* Filters row — left side: dropdowns, right side: actions */}
          <div className="flex flex-col lg:flex-row lg:items-end gap-3 lg:gap-4">
            {/* Filter dropdowns — grouped visually */}
            <div className="flex flex-wrap items-end gap-2 flex-1 min-w-0">
              <span className="hidden lg:inline-flex text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 self-end mb-2.5 mr-1 shrink-0">
                Filter
              </span>
              <div className="flex flex-col gap-1 min-w-[140px]">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Bulan</label>
                <Select value={monthLabel || ''} onValueChange={setMonth} disabled={isLoading}>
                  <SelectTrigger className="h-9 text-xs bg-background hover:bg-muted/40 transition-colors"><SelectValue placeholder="Pilih bulan" /></SelectTrigger>
                  <SelectContent>
                    {months.map((m) => <SelectItem key={m.key} value={m.label} className="text-xs">{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1 min-w-[100px]">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Minggu</label>
                <Select value={currentWeek || ''} onValueChange={setWeek} disabled={!monthLabel}>
                  <SelectTrigger className="h-9 text-xs bg-background hover:bg-muted/40 transition-colors"><SelectValue placeholder="Minggu" /></SelectTrigger>
                  <SelectContent>
                    {weeks.map((w) => <SelectItem key={w} value={w} className="text-xs">{w}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1 min-w-[160px]">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Periode Pembanding</label>
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
                  <SelectTrigger className="h-9 text-xs bg-background hover:bg-muted/40 transition-colors"><SelectValue /></SelectTrigger>
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
              </div>

              <div className="flex flex-col gap-1 min-w-[140px]">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">PIC</label>
                <SearchableComboBox
                  options={pics.map((p) => ({ value: p, label: p }))}
                  value={pic}
                  onValueChange={setPic}
                  placeholder="Semua PIC"
                  searchPlaceholder="Cari PIC..."
                  emptyText="PIC tidak ditemukan."
                  allOptionLabel={`Semua PIC (${pics.length})`}
                  buttonClassName="w-full"
                />
              </div>

              <div className="flex flex-col gap-1 min-w-[140px]">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Area</label>
                <SearchableComboBox
                  options={areas.map((a) => ({ value: a, label: a }))}
                  value={area}
                  onValueChange={setArea}
                  placeholder="Semua Area"
                  searchPlaceholder="Cari area..."
                  emptyText="Area tidak ditemukan."
                  allOptionLabel={`Semua Area (${areas.length})`}
                  buttonClassName="w-full"
                />
              </div>

              <div className="flex flex-col gap-1 min-w-[160px]">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Outlet</label>
                <SearchableComboBox
                  options={outlets.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}`, description: o.area }))}
                  value={outletCode}
                  onValueChange={setOutlet}
                  placeholder="Semua Outlet"
                  searchPlaceholder="Cari outlet (kode/nama)..."
                  emptyText="Outlet tidak ditemukan."
                  allOptionLabel={`Semua Outlet (${outlets.length})`}
                  buttonClassName="w-full"
                />
              </div>

              {hasActiveFilter && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 px-2.5 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors active:scale-95"
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
            <div className="hidden lg:block w-px self-stretch bg-border/60 my-1" aria-hidden />

            {/* Actions — secondary icon-only (with tooltips) + primary actions */}
            <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0">
              <span className="hidden lg:inline-flex text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 mr-0.5">
                Aksi
              </span>

              {/* Secondary icon-only buttons with tooltips */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 w-9 p-0 shadow-sm hover:shadow hover:bg-muted/50 transition-all active:scale-95"
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
                    className="h-9 w-9 p-0 shadow-sm hover:shadow hover:bg-muted/50 transition-all active:scale-95"
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
                    className="h-9 w-9 p-0 shadow-sm hover:shadow hover:bg-muted/50 transition-all active:scale-95"
                    onClick={() => setPicMgmtOpen(true)}
                    aria-label="Kelola PIC"
                  >
                    <Users className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Kelola PIC</TooltipContent>
              </Tooltip>

              {/* Primary actions — Import dari Drive, Upload File, Refresh Data */}
              <div className="h-6 w-px bg-border/60 mx-0.5 hidden sm:block" aria-hidden />

              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-xs font-medium shadow-sm hover:shadow hover:bg-muted/50 transition-all active:scale-95"
                onClick={() => { setDriveDialogOpen(true); setDriveResult(null); setDriveRenameMode('auto'); setDriveManualName(''); setDriveNumberLocale('us'); }}
              >
                <CloudDownload className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                <span className="hidden md:inline">Import Drive</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-xs font-medium shadow-sm hover:shadow hover:bg-muted/50 transition-all active:scale-95"
                onClick={() => setUploadDialogOpen(true)}
              >
                <Upload className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="hidden md:inline">Upload File</span>
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-9 gap-1.5 text-xs font-medium shadow-sm hover:shadow-md bg-amber-600 hover:bg-amber-700 text-white transition-all active:scale-95"
                onClick={handleIngest}
                disabled={ingesting}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${ingesting ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{ingesting ? 'Memproses...' : 'Refresh Data'}</span>
              </Button>
            </div>
          </div>

          {/* Status badges row */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {status?.stats && (
              <Badge variant="outline" className="text-[11px] gap-1 bg-muted/30 font-medium">
                <Database className="h-3 w-3 text-muted-foreground" />
                <span className="tabular-nums">{status.stats.totalFiles}</span> file · <span className="tabular-nums">{status.stats.totalOutlets}</span> outlet · <span className="tabular-nums">{status.stats.totalItems}</span> item · <span className="tabular-nums">{status.stats.totalRecords.toLocaleString()}</span> record
              </Badge>
            )}
            {ingestMsg && (
              <Badge variant="outline" className="text-[11px] gap-1 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30 font-medium">
                <AlertTriangle className="h-3 w-3" />
                {ingestMsg}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Google Drive Import Dialog — with Folder/File/Sheets tabs */}
      <Dialog open={driveDialogOpen} onOpenChange={setDriveDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CloudDownload className="h-5 w-5" />
              Import from Google
            </DialogTitle>
            <DialogDescription>
              Pilih jenis import: <strong>Folder</strong> (semua file .xlsx sekaligus),
              <strong> File Drive</strong> (satu file .xlsx), atau <strong>Google Sheets</strong> (auto-export ke .xlsx).
              Pastikan link share-nya diset ke &quot;Anyone with link can view&quot;.
            </DialogDescription>
          </DialogHeader>

          {!driveResult && (
            <>
              {progressLog.length > 0 && (
                <div className="bg-muted/50 rounded-lg p-3 max-h-[200px] overflow-y-auto mb-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Progress</p>
                  <div className="space-y-1 font-mono text-xs">
                    {progressLog.map((line, i) => (
                      <p key={i} className="leading-relaxed">{line}</p>
                    ))}
                    {driveImporting && (
                      <p className="text-primary flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> Processing...
                      </p>
                    )}
                  </div>
                </div>
              )}
              <div className={`space-y-3 py-2 ${driveImporting ? 'pointer-events-none opacity-50' : ''}`}>
                <Tabs value={driveTab} onValueChange={setDriveTab}>
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="folder" className="text-xs">
                      <Folder className="h-3.5 w-3.5 mr-1.5" /> Folder
                    </TabsTrigger>
                    <TabsTrigger value="file" className="text-xs">
                      <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" /> File Drive
                    </TabsTrigger>
                    <TabsTrigger value="sheets" className="text-xs">
                      <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" /> Google Sheets
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="folder" className="space-y-2 mt-3">
                    <Label htmlFor="folder-url" className="text-xs">Google Drive Folder URL</Label>
                    <Input
                      id="folder-url"
                      placeholder="https://drive.google.com/drive/folders/..."
                      value={driveUrl}
                      onChange={(e) => setDriveUrl(e.target.value)}
                      disabled={driveImporting}
                      maxLength={2000}
                      className="text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      💡 Klik kanan folder di Google Drive → Share → Copy link. Semua file .xlsx di folder akan otomatis didownload.
                    </p>
                  </TabsContent>

                  <TabsContent value="file" className="space-y-2 mt-3">
                    <Label htmlFor="file-url" className="text-xs">Google Drive File URL</Label>
                    <Input
                      id="file-url"
                      placeholder="https://drive.google.com/file/d/.../view"
                      value={driveUrl}
                      onChange={(e) => setDriveUrl(e.target.value)}
                      disabled={driveImporting}
                      maxLength={2000}
                      className="text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      💡 Klik kanan file di Google Drive → Share → Copy link. Hanya file ini yang akan diproses.
                      <br />
                      Cocok untuk import file bulan terbaru, atau re-import file yang sebelumnya gagal.
                    </p>
                  </TabsContent>

                  <TabsContent value="sheets" className="space-y-2 mt-3">
                    <Label htmlFor="sheets-url" className="text-xs">Google Sheets URL</Label>
                    <Input
                      id="sheets-url"
                      placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                      value={driveUrl}
                      onChange={(e) => setDriveUrl(e.target.value)}
                      disabled={driveImporting}
                      maxLength={2000}
                      className="text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      💡 Buka spreadsheet di Google Sheets → klik <strong>Share</strong> (kanan atas) → set &quot;Anyone with link&quot; → copy link.
                      <br />
                      Spreadsheet akan otomatis di-export ke format .xlsx (semua sheet dipertahankan).
                    </p>
                  </TabsContent>
                </Tabs>
              </div>

              {/* Rename option — fixes "Loading Google Sheet" filename issue.
                  Only shown for single-file tabs (file/sheets), NOT folder. */}
              {renameAllowedForTab ? (
                <div className="border rounded-lg p-2.5 space-y-2 bg-muted/20">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Pencil className="h-3.5 w-3.5" />
                    Nama File
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={driveImporting}
                      onClick={() => setDriveRenameMode('auto')}
                      className={`text-left p-2 rounded-lg border text-xs transition-colors ${
                        driveRenameMode === 'auto'
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                          : 'border-muted hover:border-muted-foreground/40'
                      } ${driveImporting ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="font-medium">Auto-Detect</div>
                      <p className="text-muted-foreground mt-0.5">Pakai nama dari Google Drive</p>
                    </button>
                    <button
                      type="button"
                      disabled={driveImporting}
                      onClick={() => setDriveRenameMode('manual')}
                      className={`text-left p-2 rounded-lg border text-xs transition-colors ${
                        driveRenameMode === 'manual'
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                          : 'border-muted hover:border-muted-foreground/40'
                      } ${driveImporting ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="font-medium">Rename Manual</div>
                      <p className="text-muted-foreground mt-0.5">Ketik nama sendiri</p>
                    </button>
                  </div>
                  {driveRenameMode === 'manual' && (
                    <div className="space-y-1">
                      <Input
                        value={driveManualName}
                        onChange={(e) => setDriveManualName(e.target.value)}
                        placeholder="JULI 2026.xlsx"
                        disabled={driveImporting}
                        className="font-mono text-xs h-8"
                        autoComplete="off"
                        aria-label="Nama file manual"
                      />
                      <p className={`text-[11px] ${driveManualValid ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {driveManualValid
                          ? '✓ Format OK — nama akan dipakai untuk import'
                          : '⚠ Format: BULAN TAHUN.xlsx (contoh: MEI 2026.xlsx)'}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="border rounded-lg p-2.5 bg-muted/20 text-[11px] text-muted-foreground">
                  💡 Rename Manual hanya tersedia untuk tab <strong>File Drive</strong> atau <strong>Google Sheets</strong>. Folder import memproses banyak file sekaligus.
                </div>
              )}

              {/* Number format selector — controls how CSV string numbers are parsed.
                  Default 'us' for Google exports (1,234.56). User can switch to 'id'
                  if their Google Sheet uses Indonesian locale (1.234,56). */}
              <div className="border rounded-lg p-2.5 space-y-1.5 bg-muted/20">
                <Label htmlFor="number-locale" className="text-xs font-semibold flex items-center gap-1.5">
                  <Pencil className="h-3.5 w-3.5" />
                  Format Angka (CSV)
                </Label>
                <Select value={driveNumberLocale} onValueChange={(v) => setDriveNumberLocale(v as 'auto' | 'id' | 'us')}>
                  <SelectTrigger id="number-locale" className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="us" className="text-xs">US: 1,234.56 (koma=ribuan, titik=desimal)</SelectItem>
                    <SelectItem value="id" className="text-xs">Indonesia: 1.234,56 (titik=ribuan, koma=desimal)</SelectItem>
                    <SelectItem value="auto" className="text-xs">Auto-detect (heuristic, mungkin salah)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Google Sheets export biasanya US. Ubah ke Indonesia kalau angka di file pakai format titik=ribuan.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCloseDialog} disabled={driveImporting}>
                  Cancel
                </Button>
                <Button
                  onClick={handleDriveImport}
                  disabled={driveImporting || !driveUrl.trim() || !driveManualValid}
                >
                  {driveImporting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      Downloading & Processing...
                    </>
                  ) : (
                    <>
                      <CloudDownload className="h-3.5 w-3.5 mr-1" />
                      Import Now
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          )}

          {driveResult && (
            <div className="space-y-3 py-2">
              {driveResult.success ? (
                <>
                  <div className="flex items-center gap-2 text-emerald-600">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Import Completed</span>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Files downloaded:</span>
                      <span className="font-medium">{driveResult.downloadSummary?.success || 0} / {driveResult.downloadSummary?.total || 0}</span>
                    </div>
                    {driveResult.downloadSummary?.failed > 0 && (
                      <div className="flex justify-between text-amber-600">
                        <span>Failed downloads:</span>
                        <span className="font-medium">{driveResult.downloadSummary.failed}</span>
                      </div>
                    )}
                    <div className="border-t pt-2 mt-2">
                      <p className="text-muted-foreground mb-1">Ingestion results:</p>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {driveResult.ingestResults?.map((r: any, i: number) => (
                          <div key={i} className="flex items-center justify-between gap-2 py-1">
                            <div className="flex items-center gap-2 min-w-0">
                              {r.status === 'INGESTED' ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                              ) : r.status === 'SKIPPED' ? (
                                <span className="text-muted-foreground text-xs shrink-0">≡</span>
                              ) : (
                                <XCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />
                              )}
                              <span className="truncate">{r.fileName}</span>
                            </div>
                            <span className="text-muted-foreground shrink-0">
                              {r.status === 'INGESTED' ? `${r.rowCount} rows` : r.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="border-t pt-2 mt-2 flex justify-between">
                      <span className="text-muted-foreground">Duration:</span>
                      <span className="font-medium">{(driveResult.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-red-600">
                    <XCircle className="h-5 w-5" />
                    <span className="font-medium">Import Failed</span>
                  </div>
                  <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-xs text-red-700 dark:text-red-400">
                    {driveResult.error}
                  </div>
                </>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={handleCloseDialog}>
                  Close
                </Button>
                {!driveResult.success && (
                  <Button variant="default" onClick={() => setDriveResult(null)}>
                    Try Again
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
