'use client';

// ============================================================
//  DriveImportDialog — Google Drive import dialog
//  Extracted from FilterBar.tsx (architecture split).
//  Handles: folder/file/sheets tabs, URL input, rename mode,
//  import progress, result display.
// ============================================================

import { useState } from 'react';
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
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { useQueryClient } from '@tanstack/react-query';

interface DriveImportResult {
  fileName: string;
  status: 'INGESTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqStatus?: string;
  dqErrors?: number;
  dqWarnings?: number;
  error?: string;
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
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [driveRenameMode, setDriveRenameMode] = useState<'auto' | 'manual'>('auto');
  const [driveManualName, setDriveManualName] = useState('');
  // FIX (BUG2-INGEST-4): changed 'eu' → 'id' to match backend Zod schema ('auto' | 'id' | 'us').
  // The old 'eu' value was rejected by the backend → 400 error on every Drive import with EU format.
  // Indonesian locale uses European-style number format (1.234,56) so 'id' is the correct equivalent.
  const [driveNumberLocale, setDriveNumberLocale] = useState<'us' | 'id'>('us');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  function handleCloseDialog() {
    onOpenChange(false);
    setDriveUrl('');
    setDriveResult(null);
    setProgressLog([]);
    setDriveRenameMode('auto');
    setDriveManualName('');
    setDriveNumberLocale('us');
  }

  async function handleDriveImport() {
    if (!driveUrl.trim()) return;
    setDriveImporting(true);
    setDriveResult(null);
    setProgressLog([]);
    try {
      const body = JSON.stringify({
        url: driveUrl,
        renameMode: driveRenameMode,
        manualFileName: driveManualName || undefined,
        numberLocale: driveNumberLocale,
      });
      const res = await fetch('/api/import-drive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // FIX (BUG-HUNT-RECENT P0): API returns 'ingestResults', not 'results'
      const ingestResults = data.ingestResults || data.results || [];
      setDriveResult(ingestResults);
      if (ingestResults.some((r: DriveImportResult) => r.status === 'INGESTED')) {
        await invalidateAnalysisCache();
        queryClient.invalidateQueries({ queryKey: ['status'] });
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
        // FIX (BUG-HUNT-RECENT P1): invalidate ALL data-dependent queries (was only 2)
        queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
        queryClient.invalidateQueries({ queryKey: ['item-history'] });
        queryClient.invalidateQueries({ queryKey: ['peer-comparison'] });
        queryClient.invalidateQueries({ queryKey: ['recommendations'] });
        onImported?.();
        toast({ title: '✅ Import berhasil', description: `${ingestResults.filter((r: DriveImportResult) => r.status === 'INGESTED').length} file diimpor` });
      }
    } catch (e: unknown) {
      toast({ title: '❌ Import gagal', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setDriveImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCloseDialog(); else onOpenChange(v); }}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudDownload className="h-5 w-5" />
            Import dari Google Drive
          </DialogTitle>
          <DialogDescription>
            Paste URL Google Drive (folder, file, atau Google Sheets). Sistem akan download dan import otomatis.
          </DialogDescription>
        </DialogHeader>

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

        {/* Import button */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCloseDialog} disabled={driveImporting}>
            Batal
          </Button>
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

        {/* Progress log */}
        {progressLog.length > 0 && (
          <div className="rounded-md border bg-muted/30 p-2 space-y-1 max-h-32 overflow-y-auto">
            {progressLog.map((log, i) => (
              <p key={i} className="text-[11px] text-muted-foreground">{log}</p>
            ))}
          </div>
        )}

        {/* Results */}
        {driveResult && driveResult.length > 0 && (
          <div className="space-y-2">
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
