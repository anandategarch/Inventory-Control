'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2, X, Pencil, ArrowRight, Wand2, Keyboard } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface WeekResult {
  weekLabel: string;
  status: 'IMPORTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
  durationMs: number;
}

interface UploadResult {
  fileName: string;
  monthLabel: string;
  monthKey: string;
  fileSize: number;
  fileHash: string;
  weeksInFile: string[];
  existingWeeks: string[];
  importedWeeks: WeekResult[];
  totalInserted: number;
  totalSkipped: number;
  durationMs: number;
  message?: string;
}

interface FileUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Detect result shape (kept loose since backend may add fields)
interface DetectResult {
  fileName: string;
  manualMode: boolean;
  monthLabel: string;
  monthKey: string;
  weeksInFile: string[];
  existingWeeks: string[];
  weeksToImport: string[];
  rowCountPerWeek: Record<string, number>;
  message?: string;
}

// Client-side manual filename validation.
// Must contain an Indonesian month name + 2-4 digit year, and end with .xlsx/.csv.
// AUDIT-RENAME-9 fix: aligned with server-side MONTH_MAP in src/lib/excel.ts
// (server also accepts: may, agt, pebruari, okteber, nopember)
const MONTH_NAMES = [
  'januari','jan','februari','pebruari','feb','maret','mar','april','apr',
  'mei','may','juni','jun','juli','jul','agustus','agu','agt',
  'september','sep','oktober','okt','okteber','november','nopember','nov','desember','des',
];

function validateManualFileName(raw: string): { ok: boolean; error?: string; cleaned?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Nama file tidak boleh kosong.' };
  // Strip filesystem-unsafe chars (mirror server-side sanitize)
  const cleaned = trimmed.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^\.+/, '').trim();
  if (!cleaned) return { ok: false, error: 'Nama file mengandung karakter tidak valid.' };
  // Ensure extension
  const hasExt = /\.(xlsx|csv)$/i.test(cleaned);
  const withExt = hasExt ? cleaned : `${cleaned}.xlsx`;
  // Must contain month name + year
  const lower = withExt.toLowerCase();
  const hasMonth = MONTH_NAMES.some(m => lower.includes(m));
  const hasYear = /\b(20\d{2}|\d{2})\b/.test(lower);
  if (!hasMonth || !hasYear) {
    return { ok: false, error: 'Format harus "BULAN TAHUN.xlsx". Contoh: "MEI 2026.xlsx" atau "17.JULI 2026.xlsx".', cleaned: withExt };
  }
  return { ok: true, cleaned: withExt };
}

export function FileUploadDialog({ open, onOpenChange }: FileUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);       // upload + detect phase
  const [importing, setImporting] = useState(false);       // import loop phase
  const [progress, setProgress] = useState(0);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rename mode state
  const [renameMode, setRenameMode] = useState<'auto' | 'manual'>(renameModeDefault());
  const [manualFileName, setManualFileName] = useState('');
  // Number locale for CSV parsing — default 'auto' (local files could be either)
  const [numberLocale, setNumberLocale] = useState<'auto' | 'id' | 'us'>('auto');
  const manualValidation = useMemo(() => {
    if (renameMode !== 'manual') return { ok: true, cleaned: '' };
    return validateManualFileName(manualFileName);
  }, [renameMode, manualFileName]);

  // Detect result + confirmation gate
  const [detectData, setDetectData] = useState<DetectResult | null>(null);
  // Persist upload metadata across detect → import so the import call doesn't need to re-upload
  const fileMetaRef = useRef<{ fileHash: string; fileSize: number; ext: string }>({ fileHash: '', fileSize: 0, ext: '' });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const reset = useCallback(() => {
    setFile(null);
    setUploading(false);
    setImporting(false);
    setProgress(0);
    setStatusLog([]);
    setResult(null);
    setError(null);
    setRenameMode(renameModeDefault());
    setManualFileName('');
    setNumberLocale('auto');
    setDetectData(null);
    fileMetaRef.current = { fileHash: '', fileSize: 0, ext: '' };
  }, []);

  const handleClose = () => {
    if (uploading || importing) return; // Don't close during processing
    reset();
    onOpenChange(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const ext = selected.name.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx' && ext !== 'csv') {
      setError(`Format file tidak didukung: .${ext}. Hanya .xlsx dan .csv.`);
      return;
    }

    if (selected.size > 50 * 1024 * 1024) {
      setError(`File terlalu besar: ${(selected.size / 1024 / 1024).toFixed(1)}MB. Maksimal 50MB.`);
      return;
    }

    setError(null);
    setFile(selected);
    setResult(null);
    setDetectData(null);
    setStatusLog([]);
    setProgress(0);
    // Pre-fill manual name with the original filename (user can edit)
    setManualFileName(selected.name);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (!dropped) return;

    const ext = dropped.name.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx' && ext !== 'csv') {
      setError(`Format file tidak didukung: .${ext}. Hanya .xlsx dan .csv.`);
      return;
    }

    if (dropped.size > 50 * 1024 * 1024) {
      setError(`File terlalu besar: ${(dropped.size / 1024 / 1024).toFixed(1)}MB. Maksimal 50MB.`);
      return;
    }

    setError(null);
    setFile(dropped);
    setResult(null);
    setDetectData(null);
    setStatusLog([]);
    setProgress(0);
    setManualFileName(dropped.name);
  };

  // ============================================================
  // PHASE 1+2: Upload chunks + Detect weeks (stops at confirmation)
  // ============================================================
  const handleUploadAndDetect = async () => {
    if (!file) return;
    // If manual mode, validate before starting upload
    if (renameMode === 'manual' && !manualValidation.ok) {
      setError(manualValidation.error || 'Nama manual tidak valid.');
      return;
    }

    setUploading(true);
    setProgress(0);
    setStatusLog([`⏳ Mengupload ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)...`]);
    setError(null);
    setResult(null);
    setDetectData(null);

    try {
      // ===== PHASE 1: Upload chunks (fast, each <5s) =====
      const fileBuffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
      const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      setStatusLog(prev => [...prev, `📦 File dipecah jadi ${totalChunks} chunk (4MB per chunk)`]);

      let uploadResult: any = null;

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunkBlob);
        formData.append('chunkIndex', String(i));
        formData.append('totalChunks', String(totalChunks));
        formData.append('fileName', file.name);
        formData.append('fileHash', fileHash);
        formData.append('fileSize', String(file.size));

        const chunkProgress = ((i + 1) / totalChunks) * 40; // 0-40% for upload
        setProgress(chunkProgress);

        if (i > 0) {
          setStatusLog(prev => [...prev, `📦 Upload chunk ${i + 1}/${totalChunks}...`]);
        }

        const res = await fetch('/api/ingest-upload', {
          method: 'POST',
          body: formData,
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          const text = await res.text();
          if (res.status === 413) {
            throw new Error('Chunk terlalu besar. Hubungi admin.');
          }
          throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
        }

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        if (i === totalChunks - 1) {
          uploadResult = data;
        }
      }

      if (!uploadResult || !uploadResult.uploaded) {
        throw new Error('Upload selesai tapi tidak ada konfirmasi dari server.');
      }

      const fileSize = uploadResult.fileSize;
      const ext = uploadResult.ext || '.' + (file.name.split('.').pop()?.toLowerCase() || 'xlsx');
      fileMetaRef.current = { fileHash, fileSize, ext };

      // Determine manualFileName to send (only if mode is manual and valid)
      const manualPayload = renameMode === 'manual' && manualValidation.ok
        ? { manualFileName: manualValidation.cleaned }
        : {};

      // ===== PHASE 2: Detect weeks (parse Excel, 1 request) =====
      setProgress(50);
      setStatusLog(prev => [...prev, '🔍 Parsing Excel, mendeteksi week...']);

      const detectRes = await fetch('/api/ingest-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'detect',
          fileName: file.name,
          fileHash,
          fileSize,
          ext,
          numberLocale,
          ...manualPayload,
        }),
      });

      const ct = detectRes.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const text = await detectRes.text();
        throw new Error(`Server error (HTTP ${detectRes.status}). ${text.slice(0, 300)}`);
      }

      const detectDataResp = await detectRes.json();
      if (!detectRes.ok || !detectDataResp.success) {
        throw new Error(detectDataResp.error || `HTTP ${detectRes.status}`);
      }

      // Use server-corrected fileName (auto-extracted or manual-validated)
      const finalFileName: string = detectDataResp.fileName || file.name;
      const monthLabel: string = detectDataResp.monthLabel || '';

      setProgress(55);
      setStatusLog(prev => [...prev, `📅 Bulan: ${monthLabel}`]);
      setStatusLog(prev => [...prev, `📊 Week di file: ${(detectDataResp.weeksInFile || []).join(', ')}`]);

      if ((detectDataResp.existingWeeks || []).length > 0) {
        setStatusLog(prev => [...prev, `ℹ️ Week sudah ada di DB: ${(detectDataResp.existingWeeks || []).join(', ')}`]);
      }

      // If nothing to import, short-circuit (same as before)
      if ((detectDataResp.weeksToImport || []).length === 0) {
        setStatusLog(prev => [...prev, `✅ Semua week sudah ada. Tidak ada yang diimport.`]);
        setProgress(100);
        await fetch('/api/ingest-process', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileHash }),
        }).catch(() => {});
        queryClient.invalidateQueries({ queryKey: ['status'] });
        toast({ title: 'ℹ️ Tidak ada import', description: 'Semua week sudah ada di DB.' });
        setUploading(false);
        return;
      }

      // ===== STOP HERE — show confirmation panel =====
      setDetectData({
        fileName: finalFileName,
        manualMode: !!detectDataResp.manualMode,
        monthLabel,
        monthKey: detectDataResp.monthKey || '',
        weeksInFile: detectDataResp.weeksInFile || [],
        existingWeeks: detectDataResp.existingWeeks || [],
        weeksToImport: detectDataResp.weeksToImport || [],
        rowCountPerWeek: detectDataResp.rowCountPerWeek || {},
        message: detectDataResp.message,
      });
      setStatusLog(prev => [...prev, '⏸️ Konfirmasi nama & week sebelum import.']);
      setUploading(false);
      // Keep progress at 55% — import will fill 60-100%
    } catch (e: any) {
      setError(e?.message || 'Upload gagal');
      setStatusLog(prev => [...prev, `❌ Error: ${e?.message || 'unknown'}`]);
      toast({
        title: '❌ Upload gagal',
        description: e?.message || 'Unknown error',
        variant: 'destructive',
      });
      setUploading(false);
    }
  };

  // ============================================================
  // PHASE 3: Import weeks (triggered by "Lanjut Import" button)
  // ============================================================
  const handleRunImport = async () => {
    if (!detectData) return;
    const { fileHash, fileSize, ext } = fileMetaRef.current;
    if (!fileHash) {
      setError('Sesi kedaluwarsa. Upload ulang file.');
      return;
    }

    setImporting(true);
    setError(null);
    setProgress(60);

    const fileName = detectData.fileName;
    const weeksToImport = detectData.weeksToImport;
    const rowCountPerWeek = detectData.rowCountPerWeek;
    const importedWeeks: WeekResult[] = [];
    let totalInserted = 0;

    try {
      for (let wi = 0; wi < weeksToImport.length; wi++) {
        const weekLabel = weeksToImport[wi];
        const weekRows = rowCountPerWeek[weekLabel] || 0;

        const weekProgress = 60 + ((wi) / weeksToImport.length) * 40; // 60-100%
        setProgress(weekProgress);

        setStatusLog(prev => [...prev, `⏳ Import ${weekLabel} (${weekRows.toLocaleString()} rows)...`]);

        try {
          const importRes = await fetch('/api/ingest-process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'import',
              fileName,
              fileHash,
              fileSize,
              ext,
              weekLabel,
              numberLocale,
              // Pass manualFileName through to import too, so server uses the same name
              ...(detectData.manualMode ? { manualFileName: fileName } : {}),
            }),
          });

          const contentType = importRes.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            const text = await importRes.text();
            if (importRes.status === 504) {
              throw new Error(`Timeout (504) — import ${weekLabel} terlalu lama. Coba lagi.`);
            }
            throw new Error(`Server error (HTTP ${importRes.status}). ${text.slice(0, 300)}`);
          }

          const importData = await importRes.json();
          if (!importRes.ok || !importData.success) {
            throw new Error(importData.error || `HTTP ${importRes.status}`);
          }

          totalInserted += importData.rowCount || 0;
          importedWeeks.push({
            weekLabel,
            status: 'IMPORTED',
            rowCount: importData.rowCount || 0,
            dqErrors: importData.dqErrors || 0,
            dqWarnings: importData.dqWarnings || 0,
            durationMs: importData.durationMs || 0,
          });

          setStatusLog(prev => [...prev, `✅ ${weekLabel}: ${(importData.rowCount || 0).toLocaleString()} rows imported (${((importData.durationMs || 0) / 1000).toFixed(1)}s) | DQ: ${importData.dqErrors || 0}E ${importData.dqWarnings || 0}W`]);
        } catch (e: any) {
          importedWeeks.push({
            weekLabel,
            status: 'ERROR',
            rowCount: 0,
            dqErrors: 1,
            dqWarnings: 0,
            durationMs: 0,
            error: e?.message || 'unknown',
          });
          setStatusLog(prev => [...prev, `❌ ${weekLabel}: ERROR — ${e?.message || 'unknown'}`]);
        }
      }

      // Cleanup temp file
      await fetch('/api/ingest-process', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileHash }),
      }).catch(() => {});

      setProgress(100);

      const r: UploadResult = {
        fileName,
        monthLabel: detectData.monthLabel,
        monthKey: detectData.monthKey,
        fileSize,
        fileHash,
        weeksInFile: detectData.weeksInFile,
        existingWeeks: detectData.existingWeeks,
        importedWeeks,
        totalInserted,
        totalSkipped: detectData.existingWeeks.length,
        durationMs: 0,
      };
      setResult(r);
      setDetectData(null);

      setStatusLog(prev => [...prev, `✅ Total: ${totalInserted.toLocaleString()} rows inserted`]);

      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['analysis'] });
      queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
      queryClient.invalidateQueries({ queryKey: ["item-history"] });
        queryClient.invalidateQueries({ queryKey: ['peer-comparison'] });

      toast({
        title: '✅ Import berhasil',
        description: `${totalInserted.toLocaleString()} rows dari ${fileName}`,
      });
    } catch (e: any) {
      setError(e?.message || 'Import gagal');
      setStatusLog(prev => [...prev, `❌ Error: ${e?.message || 'unknown'}`]);
      toast({
        title: '❌ Import gagal',
        description: e?.message || 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setImporting(false);
    }
  };

  // "Edit Nama" from confirmation: go back to rename mode, keep detectData for reference
  const handleEditName = () => {
    setDetectData(null);
    setRenameMode('manual');
    // Pre-fill with the current detected filename so user can tweak
    if (detectData?.fileName) {
      setManualFileName(detectData.fileName);
    }
    setStatusLog(prev => [...prev, '✏️ Mode rename manual aktif. Perbaiki nama lalu upload ulang.']);
  };

  const isBusy = uploading || importing;
  const showConfirm = !!detectData && !result;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import File Excel
          </DialogTitle>
          <DialogDescription>
            Upload file Excel dari komputer. Sistem otomatis deteksi week yang belum ada.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* File Drop Zone — hidden once confirmation or result is shown */}
          {!result && !showConfirm && (
            <div
              className="border-2 border-dashed border-muted-foreground/30 rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => !isBusy && fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.csv"
                onChange={handleFileSelect}
                className="hidden"
              />
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileSpreadsheet className="h-12 w-12 text-emerald-600" />
                  <p className="font-semibold">{file.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(1)}MB
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    disabled={isBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                      setManualFileName('');
                    }}
                  >
                    <X className="h-4 w-4" /> Ganti file
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-12 w-12 text-muted-foreground" />
                  <p className="font-semibold">Klik atau drag file ke sini</p>
                  <p className="text-sm text-muted-foreground">
                    Format: .xlsx, .csv (maks 50MB)
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Nama file wajib format: &quot;17.MEI 2026.xlsx&quot; atau &quot;JULI 2026.xlsx&quot;
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Rename Mode Section — only show when file is selected and not yet confirmed/imported */}
          {file && !result && !showConfirm && (
            <div className="border rounded-lg p-3 space-y-3 bg-muted/30">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Pencil className="h-4 w-4" />
                Nama File untuk Import
              </div>

              {/* Mode toggle */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setRenameMode('auto')}
                  className={`text-left p-2.5 rounded-lg border text-sm transition-colors ${
                    renameMode === 'auto'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-muted hover:border-muted-foreground/40'
                  } ${isBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    <Wand2 className="h-3.5 w-3.5" />
                    Auto-Detect
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Sistem extract bulan dari nama file / data Excel
                  </p>
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setRenameMode('manual')}
                  className={`text-left p-2.5 rounded-lg border text-sm transition-colors ${
                    renameMode === 'manual'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-muted hover:border-muted-foreground/40'
                  } ${isBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    <Keyboard className="h-3.5 w-3.5" />
                    Rename Manual
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Ketik nama sendiri (format: BULAN TAHUN.xlsx)
                  </p>
                </button>
              </div>

              {/* Manual input */}
              {renameMode === 'manual' && (
                <div className="space-y-1.5">
                  <Label htmlFor="manual-filename" className="text-xs">
                    Nama file manual
                  </Label>
                  <Input
                    id="manual-filename"
                    value={manualFileName}
                    onChange={(e) => setManualFileName(e.target.value)}
                    placeholder="MEI 2026.xlsx"
                    disabled={isBusy}
                    className="font-mono text-sm"
                    autoComplete="off"
                  />
                  {manualFileName && (
                    <p className={`text-xs ${manualValidation.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {manualValidation.ok
                        ? `✓ Akan disimpan sebagai: ${manualValidation.cleaned}`
                        : `⚠ ${manualValidation.error}`}
                    </p>
                  )}
                </div>
              )}

              {renameMode === 'auto' && (
                <p className="text-xs text-muted-foreground">
                  ℹ️ Jika nama file adalah placeholder (mis. &quot;Loading Google Sheet&quot;), sistem otomatis extract bulan dari data Excel. Jika gagal, switch ke &quot;Rename Manual&quot;.
                </p>
              )}

              {/* Number format selector — for CSV file parsing */}
              <div className="space-y-1.5 pt-1 border-t">
                <Label htmlFor="upload-number-locale" className="text-xs font-semibold">
                  Format Angka (untuk CSV)
                </Label>
                <Select value={numberLocale} onValueChange={(v) => setNumberLocale(v as 'auto' | 'id' | 'us')} disabled={isBusy}>
                  <SelectTrigger id="upload-number-locale" className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-sm">Auto-detect (heuristic)</SelectItem>
                    <SelectItem value="id" className="text-sm">Indonesia: 1.234,56 (titik=ribuan)</SelectItem>
                    <SelectItem value="us" className="text-sm">US: 1,234.56 (koma=ribuan)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  File .xlsx tidak terpengaruh (Excel sudah parse angka). Hanya relevan untuk .csv — pilih sesuai format angka di file.
                </p>
              </div>
            </div>
          )}

          {/* Confirmation Panel — shown after detect, before import */}
          {showConfirm && detectData && (
            <div className="border-2 border-primary/30 rounded-lg p-4 space-y-3 bg-primary/5">
              <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                <CheckCircle2 className="h-4 w-4" />
                Konfirmasi Import
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted-foreground shrink-0">📁 Nama file:</span>
                  <span className="font-mono font-semibold text-right break-all">{detectData.fileName}</span>
                </div>
                {detectData.manualMode && (
                  <p className="text-xs text-blue-600 dark:text-blue-400">✏️ Nama di-set manual</p>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">📅 Bulan:</span>
                  <span className="font-semibold">{detectData.monthLabel}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">📊 Week di file:</span>
                  <span className="font-semibold">{detectData.weeksInFile.join(', ') || '-'}</span>
                </div>
                {detectData.existingWeeks.length > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">ℹ️ Sudah ada:</span>
                    <span className="text-blue-600 dark:text-blue-400 font-medium">{detectData.existingWeeks.join(', ')}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 pt-1 border-t">
                  <span className="text-muted-foreground">📦 Akan diimport:</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">{detectData.weeksToImport.join(', ')}</span>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={handleEditName} className="gap-1.5">
                  <Pencil className="h-3.5 w-3.5" /> Edit Nama
                </Button>
                <Button size="sm" onClick={handleRunImport} disabled={importing} className="gap-1.5 flex-1">
                  {importing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Mengimport...
                    </>
                  ) : (
                    <>
                      Lanjut Import <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Progress */}
          {isBusy && (
            <div className="space-y-2">
              <Progress value={progress} className="h-2" />
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{uploading ? 'Memproses... (bisa 1-5 menit untuk file besar)' : 'Mengimport week...'}</span>
              </div>
            </div>
          )}

          {/* Status Log */}
          {statusLog.length > 0 && (
            <div className="bg-muted/50 rounded-lg p-3 max-h-[300px] overflow-y-auto">
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                Status Log
              </p>
              <div className="space-y-1 font-mono text-xs">
                {statusLog.map((line, i) => (
                  <p key={i} className="leading-relaxed">{line}</p>
                ))}
              </div>
            </div>
          )}

          {/* Result Summary */}
          {result && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-semibold">
                  Import selesai: {result.totalInserted.toLocaleString()} rows
                </span>
              </div>

              {/* Week breakdown */}
              <div className="grid grid-cols-2 gap-2">
                {result.importedWeeks.map((w) => (
                  <div
                    key={w.weekLabel}
                    className={`p-2 rounded-lg border text-sm ${
                      w.status === 'IMPORTED'
                        ? 'border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20'
                        : w.status === 'ERROR'
                        ? 'border-red-200 bg-red-50 dark:bg-red-950/20'
                        : 'border-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{w.weekLabel}</span>
                      {w.status === 'IMPORTED' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                      {w.status === 'ERROR' && <AlertCircle className="h-4 w-4 text-red-600" />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {w.status === 'IMPORTED'
                        ? `${w.rowCount.toLocaleString()} rows`
                        : w.status === 'ERROR'
                        ? w.error || 'Error'
                        : 'Skipped'}
                    </p>
                  </div>
                ))}
              </div>

              {result.existingWeeks.length > 0 && (
                <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 text-sm">
                  ℹ️ Week sudah ada (skipped): {result.existingWeeks.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Info */}
          {!file && !result && !showConfirm && (
            <div className="text-xs text-muted-foreground space-y-1">
              <p>📋 <strong>Cara kerja:</strong></p>
              <p>1. Pilih file Excel (.xlsx) dari komputer</p>
              <p>2. Pilih mode: Auto-Detect (otomatis) atau Rename Manual</p>
              <p>3. Upload + sistem deteksi week yang belum ada</p>
              <p>4. Konfirmasi nama file &amp; week sebelum import</p>
              <p>5. Import hanya week yang belum ada (partial commit per week)</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={handleClose} className="w-full">
              Selesai
            </Button>
          ) : showConfirm ? (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={importing}>
                Batal
              </Button>
              <Button onClick={handleRunImport} disabled={importing} className="gap-2">
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Mengimport...
                  </>
                ) : (
                  <>
                    Lanjut Import <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={isBusy}>
                Batal
              </Button>
              <Button
                onClick={handleUploadAndDetect}
                disabled={!file || isBusy || (renameMode === 'manual' && !manualValidation.ok)}
                className="gap-2"
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Memproses...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Upload &amp; Deteksi
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renameModeDefault(): 'auto' | 'manual' {
  return 'auto';
}
