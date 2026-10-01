'use client';

// ============================================================
//  DriveImportDialog — Google Drive import dialog
//  Extracted from FilterBar.tsx (architecture split).
//  Handles: folder/file/sheets tabs, URL input, rename mode,
//  import progress, result display.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CloudDownload, Loader2, CheckCircle2, XCircle, Folder, FileSpreadsheet, Pencil } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
// FIX: replaced direct import of invalidateAnalysisCache (server-only,
// pulls pg+dns into client bundle causing build error) with API call
// to /api/refresh which does the same invalidation server-side.
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAllData } from '@/lib/query-invalidation';
// FIX (UIUX-B S7): reuse the FileUpload pipeline's abort helpers (exemplar
// pattern — Verifikasi Bersih #1) instead of duplicating them locally.
import { IMPORT_TIMEOUT_MS, isAbortError } from './FileUploadDialog/pipeline/abort';

interface DriveImportResult {
  fileName: string;
  status: 'INGESTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqStatus?: string;
  dqErrors?: number;
  dqWarnings?: number;
  error?: string;
}

// FIX (UIUX-B S6): shape of /api/import-drive's downloadSummary (route
// ~:131-137) — kept local like DriveImportResult above. Partial download
// failures (folder imports, failed > 0) were never surfaced in the UI.
interface DriveDownloadSummary {
  total: number;
  success: number;
  failed: number;
  failedDetails?: Array<{ fileName: string; error?: string }>;
}

interface DriveImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}

export function DriveImportDialog({ open, onOpenChange, onImported }: DriveImportDialogProps) {
  const [driveUrl, setDriveUrl] = useState('');
  const [driveImporting, setDriveImporting] = useState(false);
  const [driveResult, setDriveResult] = useState<DriveImportResult[] | null>(null);
  const [driveRenameMode, setDriveRenameMode] = useState<'auto' | 'manual'>('auto');
  const [driveManualName, setDriveManualName] = useState('');
  // FIX (BUG2-INGEST-4): changed 'eu' → 'id' to match backend Zod schema ('auto' | 'id' | 'us').
  // The old 'eu' value was rejected by the backend → 400 error on every Drive import with EU format.
  // Indonesian locale uses European-style number format (1.234,56) so 'id' is the correct equivalent.
  const [driveNumberLocale, setDriveNumberLocale] = useState<'us' | 'id'>('us');
  // FIX (UIUX-B S6): downloadSummary from the import response — drives the
  // amber "N file gagal diunduh" banner above the result list.
  const [downloadSummary, setDownloadSummary] = useState<DriveDownloadSummary | null>(null);
  // FIX (UIUX-B S7): Drive import had NO AbortController & NO timeout —
  // unlike the FileUpload pipeline's per-phase fetchWithTimeout. A hung
  // folder import spun forever with Batal disabled, and closing the dialog
  // left the request running. Minimal adoption of the pipeline abort
  // pattern (pipeline/abort.ts): IMPORT_TIMEOUT_MS budget + user cancel +
  // close-mid-flight abort.
  const abortRef = useRef<AbortController | null>(null);
  const timedOutRef = useRef(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // FIX (BUG-3-b B4): driveImporting used to stay true when the dialog was
  // closed/hidden mid-request (parent toggles `open`) — the next open showed
  // a spinning "Importing..." button + disabled Batal with nothing running.
  // Effect cleanup resets the flag whenever the dialog closes.
  useEffect(() => {
    if (!open) setDriveImporting(false);
  }, [open]);

  function handleCloseDialog() {
    // FIX (UIUX-B S7): closing mid-flight (X / overlay / Escape) now aborts
    // the in-flight request too — previously the fetch kept running after the
    // dialog closed (pattern: use-upload-pipeline handleClose → cancel()).
    abortRef.current?.abort();
    onOpenChange(false);
    setDriveUrl('');
    setDriveResult(null);
    // FIX (UIUX-B S6): reset the download summary with the result state.
    setDownloadSummary(null);
    setDriveRenameMode('auto');
    setDriveManualName('');
    setDriveNumberLocale('us');
  }

  async function handleDriveImport() {
    if (!driveUrl.trim()) return;
    setDriveImporting(true);
    setDriveResult(null);
    // FIX (UIUX-B S6): clear the previous attempt's download summary.
    setDownloadSummary(null);
    // FIX (UIUX-B S7): fresh attempt → fresh abort bookkeeping.
    timedOutRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    // FIX (UIUX-B S7): 300s budget — IMPORT_TIMEOUT_MS, the same budget the
    // upload pipeline gives its import phase (the route's maxDuration is
    // also 300s; large folder imports are legit slow).
    const timeoutTimer = setTimeout(() => {
      timedOutRef.current = true;
      controller.abort();
    }, IMPORT_TIMEOUT_MS);
    try {
      const body = JSON.stringify({
        url: driveUrl,
        renameMode: driveRenameMode,
        manualFileName: driveManualName || undefined,
        numberLocale: driveNumberLocale,
      });
      const res = await fetch('/api/import-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      // FIX (BUG-3-b B4): check content-type before res.json() — a server
      // crash / proxy error returns HTML, and the old path surfaced a cryptic
      // "Unexpected token '<'..." parse error (pattern: FilterBar handleIngest).
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // FIX (BUG-HUNT-RECENT P0): API returns 'ingestResults', not 'results'
      const ingestResults = data.ingestResults || data.results || [];
      setDriveResult(ingestResults);
      // FIX (UIUX-B S6): keep the download summary so partial folder
      // downloads (failed > 0) can surface above the result list.
      setDownloadSummary(data.downloadSummary ?? null);
      if (ingestResults.some((r: DriveImportResult) => r.status === 'INGESTED')) {
        // FIX: call /api/refresh to invalidate server-side caches
        // (was: await invalidateAnalysisCache() — direct import pulled pg into client bundle)
        await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
        // FIX (H-14/T3): full 18-key invalidation via shared helper — the old
        // 6-key subset left pareto/heatmap/trend/flip/drilldown/price-effect
        // keys stale in keep-alive tabs after a Drive import.
        invalidateAllData(queryClient);
        onImported?.();
        toast({ title: '✅ Import berhasil', description: `${ingestResults.filter((r: DriveImportResult) => r.status === 'INGESTED').length} file diimpor` });
      }
    } catch (e: unknown) {
      // FIX (UIUX-B S7): AbortError → non-destructive Indonesian toast (user
      // cancel vs timeout), message pattern: pipeline upload-detect-stage;
      // other errors keep the destructive toast exactly as before.
      if (isAbortError(e)) {
        toast({
          title: timedOutRef.current
            ? `Import dibatalkan — waktu tunggu ${IMPORT_TIMEOUT_MS / 60_000} menit habis`
            : '⏹ Import dibatalkan',
        });
      } else {
        // P23 D5: 'Unknown error' fallback → Indonesian.
        toast({ title: '❌ Import gagal', description: e instanceof Error ? e.message : 'Error tidak diketahui', variant: 'destructive' });
      }
    } finally {
      // FIX (UIUX-B S7): clear the timeout, drop the controller, unlock the
      // dialog (order per spec: clearTimeout → abortRef=null → importing=false).
      clearTimeout(timeoutTimer);
      abortRef.current = null;
      setDriveImporting(false);
    }
  }

  // FIX (UIUX-B S6): named failed downloads for the amber banner (concise:
  // names shown inline, full name + reason available on hover via title).
  const failedDownloads = downloadSummary?.failedDetails?.filter((f) => f.fileName) ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCloseDialog(); else onOpenChange(v); }}>
      {/* FIX (UIUX-B S8): max-h + scroll internal (pola DataManagementDialog) */}
      <DialogContent className="max-w-[600px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudDownload className="h-5 w-5" />
            Import dari Google Drive
          </DialogTitle>
          <DialogDescription>
            Paste URL Google Drive (folder, file, atau Google Sheets). Sistem akan download dan import otomatis.
          </DialogDescription>
        </DialogHeader>

        {/* FIX (UIUX-B S8): body wrapper — the input phase (tabs/rename/locale)
            scrolls here; the Batal/Import row stays OUTSIDE so buttons stay
            visible. The result block (below the buttons) already has its own
            internal max-h-48 scroll. */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4">
          <Tabs defaultValue="file">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="file" className="text-xs gap-1.5"><FileSpreadsheet className="h-3.5 w-3.5" /> File</TabsTrigger>
              <TabsTrigger value="folder" className="text-xs gap-1.5"><Folder className="h-3.5 w-3.5" /> Folder</TabsTrigger>
              <TabsTrigger value="sheets" className="text-xs gap-1.5"><FileSpreadsheet className="h-3.5 w-3.5" /> Sheets</TabsTrigger>
            </TabsList>
            <TabsContent value="file" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label className="text-xs">URL Google Drive File</Label>
                <Input
                  value={driveUrl}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  placeholder="https://drive.google.com/file/d/.../view"
                  className="h-9 text-xs"
                />
              </div>
            </TabsContent>
            <TabsContent value="folder" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label className="text-xs">URL Google Drive Folder</Label>
                <Input
                  value={driveUrl}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className="h-9 text-xs"
                />
              </div>
            </TabsContent>
            <TabsContent value="sheets" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label className="text-xs">URL Google Sheets</Label>
                <Input
                  value={driveUrl}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                  className="h-9 text-xs"
                />
              </div>
            </TabsContent>
          </Tabs>

          {/* Rename mode */}
          <div className="space-y-2">
            <Label className="text-xs">Mode Rename</Label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  checked={driveRenameMode === 'auto'}
                  onChange={() => setDriveRenameMode('auto')}
                  className="h-3.5 w-3.5"
                />
                Auto (dari nama file)
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  checked={driveRenameMode === 'manual'}
                  onChange={() => setDriveRenameMode('manual')}
                  className="h-3.5 w-3.5"
                />
                Manual
              </label>
            </div>
            {driveRenameMode === 'manual' && (
              <Input
                value={driveManualName}
                onChange={(e) => setDriveManualName(e.target.value)}
                placeholder="contoh: 17.MEI 2026.xlsx"
                className="h-9 text-xs"
              />
            )}
          </div>

          {/* Number locale */}
          <div className="space-y-2">
            <Label className="text-xs">Format Angka</Label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  checked={driveNumberLocale === 'us'}
                  onChange={() => setDriveNumberLocale('us')}
                  className="h-3.5 w-3.5"
                />
                US (1,234.56)
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  checked={driveNumberLocale === 'id'}
                  onChange={() => setDriveNumberLocale('id')}
                  className="h-3.5 w-3.5"
                />
                ID (1.234,56)
              </label>
            </div>
          </div>
        </div>

        {/* Import button */}
        <div className="flex justify-end gap-2">
          {/* FIX (UIUX-B S7): while importing, Batal becomes an enabled
              "Batalkan Import" (abort) instead of a disabled ghost — a hung
              import no longer locks the dialog (pattern: FileUploadDialog
              footer). Idle behavior is unchanged (Batal → close + reset). */}
          {driveImporting ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => abortRef.current?.abort()}
            >
              <XCircle className="h-3.5 w-3.5" /> Batalkan Import
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={handleCloseDialog}>
              Batal
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleDriveImport}
            disabled={driveImporting || !driveUrl.trim()}
            className="gap-1.5"
          >
            {driveImporting ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing...</>
            ) : (
              <><CloudDownload className="h-3.5 w-3.5" /> Import</>
            )}
          </Button>
        </div>

        {/* Results */}
        {driveResult && driveResult.length > 0 && (
          <div className="space-y-2">
            {/* FIX (UIUX-B S6): partial-download failures (folder imports)
                were invisible — downloadSummary.failed now surfaces above the
                result list. */}
            {downloadSummary && downloadSummary.failed > 0 && (
              <div
                className="flex items-start gap-1.5 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-400"
                title={failedDownloads.map((f) => `${f.fileName}: ${f.error ?? 'unknown'}`).join('; ') || undefined}
              >
                <span className="shrink-0" aria-hidden="true">⚠️</span>
                <span className="min-w-0">
                  {downloadSummary.failed} file gagal diunduh — cek permission share folder
                  {failedDownloads.length > 0 && (
                    <span className="block truncate">{failedDownloads.map((f) => f.fileName).join(', ')}</span>
                  )}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm font-medium">
              {driveResult.every(r => r.status === 'INGESTED') ? (
                <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Semua file berhasil diimpor</>
              ) : driveResult.some(r => r.status === 'ERROR') ? (
                <><XCircle className="h-4 w-4 text-red-600" /> Beberapa file gagal</>
              ) : (
                <><CheckCircle2 className="h-4 w-4 text-amber-500" /> Import selesai dengan warning</>
              )}
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {driveResult.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                  {/* FIX (UIUX-B S6): two-tier row — the per-file error reason
                      (r.error existed on ERROR results but was never rendered)
                      now shows under the file name, with the full reason on
                      hover (title) since the line truncates. */}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {r.status === 'INGESTED' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                      ) : r.status === 'SKIPPED' ? (
                        <span className="text-muted-foreground text-xs shrink-0">≡</span>
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />
                      )}
                      <span className="truncate font-medium">{r.fileName}</span>
                    </div>
                    {r.status === 'ERROR' && r.error && (
                      <p className="text-[10px] text-red-600 dark:text-red-400 truncate" title={r.error}>
                        {r.error}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.rowCount > 0 && <Badge variant="secondary" className="text-[10px]">{r.rowCount.toLocaleString()} rows</Badge>}
                    {r.dqStatus && <Badge variant={r.dqStatus === 'ERROR' ? 'destructive' : 'secondary'} className="text-[10px]">{r.dqStatus}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
