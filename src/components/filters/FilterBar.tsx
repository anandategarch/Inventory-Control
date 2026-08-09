'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, RotateCcw, Database, AlertTriangle, CloudDownload, Loader2, CheckCircle2, XCircle, Settings, Folder, FileSpreadsheet } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useStatus } from '@/hooks/useAnalysis';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useQueryClient } from '@tanstack/react-query';
import { SettingsDialog } from '@/components/filters/SettingsDialog';

export function FilterBar() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, setMonth, setWeek, setCompareWeek, setArea, setOutlet, reset } = useDashboard();
  const { data: status, isLoading } = useStatus();
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  // Google Drive import dialog state
  const [driveDialogOpen, setDriveDialogOpen] = useState(false);
  const [driveUrl, setDriveUrl] = useState('');
  const [driveImporting, setDriveImporting] = useState(false);
  const [driveResult, setDriveResult] = useState<any>(null);
  const queryClient = useQueryClient();

  // Settings dialog state
  const [settingsOpen, setSettingsOpen] = useState(false);

  const months = status?.months || [];
  const weeks = (monthLabel && status?.weeksByMonth) ? Object.entries(status.weeksByMonth).find(([k]) => {
    const m = status.months.find((mm) => mm.label === monthLabel);
    return m && k === m.key;
  })?.[1] || [] : [];
  const outlets = (status?.outlets || []).filter((o) => !area || o.area === area);
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
          sortKey: `${m.key}|${w}`,
        });
      }
    }
    allComparePeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  const compareValue = comparisonWeek
    ? `${comparisonWeek}|||${comparisonMonth || monthLabel}`
    : 'auto';

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
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
      } else {
        setIngestMsg(`Failed: ${d.message || d.error}`);
      }
    } catch (e: any) {
      setIngestMsg(`Error: ${e?.message || String(e)}`);
    } finally {
      setIngesting(false);
      setTimeout(() => setIngestMsg(null), 8000);
    }
  }

  async function handleDriveImport() {
    if (!driveUrl.trim()) return;
    setDriveImporting(true);
    setDriveResult(null);
    try {
      const res = await fetch('/api/import-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: driveUrl.trim() }),
      });
      // FIX: Check content-type before parsing — server crash returns HTML
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(
          `Server error (HTTP ${res.status}).\n\n` +
          `Kemungkinan penyebab:\n` +
          `• File terlalu besar — server kehabisan memory (OOM)\n` +
          `• Server timeout — proses terlalu lama\n` +
          `• Server crash — coba refresh halaman dan ulangi\n\n` +
          `Solusi:\n` +
          `• Import 1 file saja (bukan folder)\n` +
          `• Gunakan tab "Google Sheets" untuk import langsung sebagai CSV\n` +
          `• Atau pecah file besar jadi 2-3 file lebih kecil`
        );
      }
      const d = await res.json();
      setDriveResult(d);
      if (d.success) {
        queryClient.invalidateQueries({ queryKey: ['status'] });
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
      }
    } catch (e: any) {
      setDriveResult({ success: false, error: e?.message || String(e) });
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
      <Card className="mb-4">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-xs text-muted-foreground">Month</label>
              <Select value={monthLabel || ''} onValueChange={setMonth} disabled={isLoading}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select month" /></SelectTrigger>
                <SelectContent>
                  {months.map((m) => <SelectItem key={m.key} value={m.label} className="text-xs">{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[100px]">
              <label className="text-xs text-muted-foreground">Current Week</label>
              <Select value={currentWeek || ''} onValueChange={setWeek} disabled={!monthLabel}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Week" /></SelectTrigger>
                <SelectContent>
                  {weeks.map((w) => <SelectItem key={w} value={w} className="text-xs">{w}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Compare Period</label>
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
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" className="text-xs">Auto (previous period)</SelectItem>
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

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Area</label>
              <SearchableComboBox
                options={areas.map((a) => ({ value: a, label: a }))}
                value={area}
                onValueChange={setArea}
                placeholder="All Areas"
                searchPlaceholder="Cari area..."
                emptyText="Area tidak ditemukan."
                allOptionLabel={`All Areas (${areas.length})`}
                buttonClassName="w-full"
              />
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Outlet</label>
              <SearchableComboBox
                options={outlets.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}`, description: o.area }))}
                value={outletCode}
                onValueChange={setOutlet}
                placeholder="All Outlets"
                searchPlaceholder="Cari outlet (kode/nama)..."
                emptyText="Outlet tidak ditemukan."
                allOptionLabel={`All Outlets (${outlets.length})`}
                buttonClassName="w-full"
              />
            </div>

            <div className="flex-1" />

            <Button variant="outline" size="sm" className="h-9" onClick={reset} disabled={!area && !outletCode}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-3.5 w-3.5 mr-1" />
              Settings
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-9"
              onClick={() => { setDriveDialogOpen(true); setDriveResult(null); }}
            >
              <CloudDownload className="h-3.5 w-3.5 mr-1" />
              Import from Drive
            </Button>
            <Button variant="default" size="sm" className="h-9" onClick={handleIngest} disabled={ingesting}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${ingesting ? 'animate-spin' : ''}`} />
              {ingesting ? 'Ingesting...' : 'Refresh Data'}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {status?.stats && (
              <Badge variant="outline" className="text-[10px]">
                <Database className="h-3 w-3 mr-1" />
                {status.stats.totalFiles} files · {status.stats.totalOutlets} outlets · {status.stats.totalItems} items · {status.stats.totalRecords.toLocaleString()} records
              </Badge>
            )}
            {ingestMsg && (
              <Badge variant="secondary" className="text-[10px]">
                <AlertTriangle className="h-3 w-3 mr-1" />
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
              <div className="space-y-3 py-2">
                <Tabs defaultValue="folder">
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
                      className="text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground">
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
                      className="text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground">
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
                      className="text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      💡 Buka spreadsheet di Google Sheets → klik <strong>Share</strong> (kanan atas) → set &quot;Anyone with link&quot; → copy link.
                      <br />
                      Spreadsheet akan otomatis di-export ke format .xlsx (semua sheet dipertahankan).
                    </p>
                  </TabsContent>
                </Tabs>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCloseDialog} disabled={driveImporting}>
                  Cancel
                </Button>
                <Button onClick={handleDriveImport} disabled={driveImporting || !driveUrl.trim()}>
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
    </>
  );
}
