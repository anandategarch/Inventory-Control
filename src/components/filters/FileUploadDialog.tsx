'use client';

import { useState, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

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

export function FileUploadDialog({ open, onOpenChange }: FileUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const reset = useCallback(() => {
    setFile(null);
    setUploading(false);
    setProgress(0);
    setStatusLog([]);
    setResult(null);
    setError(null);
  }, []);

  const handleClose = () => {
    if (uploading) return; // Don't close during upload
    reset();
    onOpenChange(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    // Validate file type
    const ext = selected.name.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx' && ext !== 'csv') {
      setError(`Format file tidak didukung: .${ext}. Hanya .xlsx dan .csv.`);
      return;
    }

    // Validate file size (50MB)
    if (selected.size > 50 * 1024 * 1024) {
      setError(`File terlalu besar: ${(selected.size / 1024 / 1024).toFixed(1)}MB. Maksimal 50MB.`);
      return;
    }

    setError(null);
    setFile(selected);
    setResult(null);
    setStatusLog([]);
    setProgress(0);
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
    setStatusLog([]);
    setProgress(0);
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setProgress(0);
    setStatusLog([`⏳ Mengupload ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)...`]);
    setError(null);
    setResult(null);

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

        const chunkProgress = ((i + 1) / totalChunks) * 50; // 0-50% for upload
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
      const fileName = uploadResult.fileName;
      const ext = uploadResult.ext || '.' + fileName.split('.').pop()?.toLowerCase();

      // ===== PHASE 2: Detect weeks (parse Excel, 1 request) =====
      setProgress(55);
      setStatusLog(prev => [...prev, '🔍 Parsing Excel, mendeteksi week...']);

      const detectRes = await fetch('/api/ingest-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'detect',
          fileName,
          fileHash,
          fileSize,
          ext,
        }),
      });

      const detectData = await detectRes.json();
      if (!detectRes.ok || !detectData.success) {
        throw new Error(detectData.error || `HTTP ${detectRes.status}`);
      }

      const weeksInFile: string[] = detectData.weeksInFile || [];
      const existingWeeks: string[] = detectData.existingWeeks || [];
      const weeksToImport: string[] = detectData.weeksToImport || [];
      const rowCountPerWeek: Record<string, number> = detectData.rowCountPerWeek || {};
      const monthLabel: string = detectData.monthLabel || '';

      setProgress(60);
      setStatusLog(prev => [...prev, `📅 Bulan: ${monthLabel}`]);
      setStatusLog(prev => [...prev, `📊 Week di file: ${weeksInFile.join(', ')}`]);

      if (existingWeeks.length > 0) {
        setStatusLog(prev => [...prev, `ℹ️ Week sudah ada di DB: ${existingWeeks.join(', ')}`]);
      }

      if (weeksToImport.length === 0) {
        setStatusLog(prev => [...prev, `✅ Semua week sudah ada. Tidak ada yang diimport.`]);
        setProgress(100);
        // Cleanup temp file
        await fetch('/api/ingest-process', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileHash }),
        });
        queryClient.invalidateQueries({ queryKey: ['status'] });
        toast({ title: 'ℹ️ Tidak ada import', description: 'Semua week sudah ada di DB.' });
        return;
      }

      // ===== PHASE 3: Import each week (separate request per week) =====
      const importedWeeks: WeekResult[] = [];
      let totalInserted = 0;
      const totalWeeksToImport = weeksToImport.length;

      for (let wi = 0; wi < totalWeeksToImport; wi++) {
        const weekLabel = weeksToImport[wi];
        const weekRows = rowCountPerWeek[weekLabel] || 0;

        const weekProgress = 60 + ((wi) / totalWeeksToImport) * 40; // 60-100%
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
            }),
          });

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

      const totalDuration = Date.now() - 0; // approximate
      setProgress(100);

      const r: UploadResult = {
        fileName,
        monthLabel,
        monthKey: detectData.monthKey || '',
        fileSize,
        fileHash,
        weeksInFile,
        existingWeeks,
        importedWeeks,
        totalInserted,
        totalSkipped: existingWeeks.length,
        durationMs: 0,
      };
      setResult(r);

      setStatusLog(prev => [...prev, `✅ Total: ${totalInserted.toLocaleString()} rows inserted`]);

      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['analysis'] });

      toast({
        title: '✅ Import berhasil',
        description: `${totalInserted.toLocaleString()} rows dari ${fileName}`,
      });
    } catch (e: any) {
      setError(e?.message || 'Upload gagal');
      setStatusLog(prev => [...prev, `❌ Error: ${e?.message || 'unknown'}`]);
      toast({
        title: '❌ Import gagal',
        description: e?.message || 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

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
          {/* File Drop Zone */}
          {!result && (
            <div
              className="border-2 border-dashed border-muted-foreground/30 rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
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

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Progress */}
          {uploading && (
            <div className="space-y-2">
              <Progress value={progress} className="h-2" />
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Memproses... (bisa 1-5 menit untuk file besar)</span>
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
          {!file && !result && (
            <div className="text-xs text-muted-foreground space-y-1">
              <p>📋 <strong>Cara kerja:</strong></p>
              <p>1. Pilih file Excel (.xlsx) dari komputer</p>
              <p>2. Sistem parse nama file → deteksi bulan</p>
              <p>3. Cek database: week mana yang belum ada untuk bulan itu</p>
              <p>4. Import hanya week yang belum ada (partial commit per week)</p>
              <p>5. Jika WEEK 1 & 2 sudah ada, hanya WEEK 4 yang diimport</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={handleClose} className="w-full">
              Selesai
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={uploading}>
                Batal
              </Button>
              <Button onClick={handleUpload} disabled={!file || uploading} className="gap-2">
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Memproses...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Import File
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
