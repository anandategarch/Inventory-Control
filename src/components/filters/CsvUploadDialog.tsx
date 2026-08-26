'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, FileText, Loader2, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { useState, useRef, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';

interface CsvUploadDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CsvUploadDialog({ open, onOpenChange }: CsvUploadDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog closes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setResult(null);
      setSelectedFile(null);
      setDragging(false);
    }
  }

  const handleFileSelect = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast({ title: '❌ Format tidak didukung', description: 'Hanya file CSV yang diperbolehkan.', variant: 'destructive' });
      return;
    }
    setSelectedFile(file);
    setResult(null);
  }, [toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  async function handleUpload() {
    if (!selectedFile) return;
    setUploading(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      const res = await fetch('/api/upload', { method: 'POST', body: formData });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout.`);
      }

      const d = await res.json();
      setResult(d);

      if (d.success) {
        toast({
          title: '✅ Import berhasil',
          description: `${d.results[0]?.rowCount || 0} baris diimport`,
        });
        queryClient.invalidateQueries({ queryKey: ['status'] });
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
      } else {
        toast({ title: '❌ Import gagal', description: d.error || d.results?.[0]?.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    } catch (e: any) {
      setResult({ success: false, error: e?.message || String(e) });
      toast({ title: '❌ Import gagal', description: e?.message || 'Kesalahan jaringan', variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  }

  function handleClose() {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import CSV
          </DialogTitle>
          <DialogDescription>
            Drag &amp; drop atau pilih file CSV untuk diimport ke database.
            Nama file harus mengandung bulan (mis. &quot;17.MEI 2026.csv&quot;).
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3 py-2">
            {/* Drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
              />
              <Upload className={`h-10 w-10 mx-auto mb-2 ${dragging ? 'text-primary' : 'text-muted-foreground/50'}`} />
              <p className="text-sm font-medium">
                {selectedFile ? selectedFile.name : 'Drag & drop CSV di sini'}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {selectedFile
                  ? `${(selectedFile.size / 1024).toFixed(0)} KB — klik untuk ganti`
                  : 'atau klik untuk pilih file'}
              </p>
            </div>

            {/* Tips */}
            <div className="rounded-md border border-sky-200 bg-sky-50 dark:bg-sky-950/20 dark:border-sky-900 p-2.5 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-sky-600 shrink-0 mt-0.5" />
              <div className="text-[11px] text-sky-700 dark:text-sky-300">
                <strong>Tips:</strong> File harus format CSV dengan header yang sama seperti Excel asli.
                Jika upload bulan yang sama, data lama akan otomatis diganti.
              </div>
            </div>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="py-2 space-y-3">
            {result.success ? (
              <>
                <div className="flex items-center gap-2 text-emerald-600">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">Import Berhasil</span>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
                  {result.results?.map((r: any, i: number) => (
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
                        {r.status === 'INGESTED' ? `${r.rowCount} baris` : r.status}
                        {r.dqErrors > 0 && ` · ${r.dqErrors}E/${r.dqWarnings}W`}
                      </span>
                    </div>
                  ))}
                  {result.durationMs && (
                    <div className="border-t pt-2 flex justify-between">
                      <span className="text-muted-foreground">Durasi:</span>
                      <span className="font-medium">{(result.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-red-600">
                  <XCircle className="h-5 w-5" />
                  <span className="font-medium">Import Gagal</span>
                </div>
                <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-xs text-red-700 dark:text-red-400">
                  {result.error || result.results?.[0]?.error || 'Error tidak diketahui'}
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={handleClose}>Tutup</Button>
              {!result.success && (
                <Button variant="default" onClick={() => { setResult(null); setSelectedFile(null); }}>
                  Coba Lagi
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose} disabled={uploading}>Batal</Button>
              <Button onClick={handleUpload} disabled={!selectedFile || uploading}>
                {uploading ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Mengupload...</>
                ) : (
                  <><Upload className="h-3.5 w-3.5 mr-1" /> Import</>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
