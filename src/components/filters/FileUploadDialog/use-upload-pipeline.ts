'use client';

// ============================================================
//  use-upload-pipeline — the 3-phase upload state machine behind
//  FileUploadDialog. Moved verbatim from FileUploadDialog.tsx
//  (REFACTOR-1-c pure split — zero behavior change):
//    PHASE 1+2: upload chunks (parallel, 3 concurrent) + detect
//               weeks — stops at the confirmation panel
//    PHASE 3:   import weeks ("Lanjut Import" button)
//  The hook owns ALL pipeline state/actions + progress/error
//  handling; the UI components only read state and call actions.
//  The /api/ingest-upload + /api/ingest-process request/response
//  contracts are byte-for-byte identical to the pre-split file.
// ============================================================

import { useState, useRef, useCallback, useMemo } from 'react';
import type { Dispatch, SetStateAction, ChangeEventHandler, DragEventHandler } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAllData } from '@/lib/query-invalidation';
// FIX (AUDIT8-ROLLBACK-1, Item 7): extract shared upload helpers to a sibling
// module so MONTH_NAMES stays in sync with the server-side MONTH_MAP (was the
// cause of AUDIT-RENAME-9 — client ✓ then server 400 due to month-list drift).
import { validateManualFileName, renameModeDefault } from '../upload-utils';

export interface WeekResult {
  weekLabel: string;
  status: 'IMPORTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
  durationMs: number;
}

export interface UploadResult {
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

// Detect result shape (kept loose since backend may add fields)
export interface DetectResult {
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

// Client-side manual filename validation now lives in ../upload-utils
// (FIX AUDIT8-ROLLBACK-1, Item 7 — was duplicated here, drifting from server).
// Re-exporting would be unused; consumers import directly from upload-utils.

/** Clear, explicitly-typed surface of {@link useUploadPipeline}. */
export interface UploadPipeline {
  // State
  file: File | null;
  uploading: boolean;
  importing: boolean;
  progress: number;
  statusLog: string[];
  result: UploadResult | null;
  error: string | null;
  // Rename mode state
  renameMode: 'auto' | 'manual';
  setRenameMode: Dispatch<SetStateAction<'auto' | 'manual'>>;
  manualFileName: string;
  setManualFileName: Dispatch<SetStateAction<string>>;
  manualValidation: { ok: boolean; cleaned?: string; error?: string };
  // Number locale for CSV parsing — default 'auto' (local files could be either)
  numberLocale: 'auto' | 'id' | 'us';
  setNumberLocale: Dispatch<SetStateAction<'auto' | 'id' | 'us'>>;
  // Detect result + confirmation gate
  detectData: DetectResult | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  // Actions
  reset: () => void;
  handleClose: () => void;
  handleFileSelect: ChangeEventHandler<HTMLInputElement>;
  handleDrop: DragEventHandler;
  handleUploadAndDetect: () => void;
  handleRunImport: () => void;
  handleEditName: () => void;
  clearFile: () => void;
  // FIX (BUG-3-b B3): abort every in-flight phase request + unlock the
  // busy flags — wired to the "Batalkan" button shown while busy.
  cancel: () => void;
  // Derived
  isBusy: boolean;
  showConfirm: boolean;
}

export function useUploadPipeline({ onOpenChange }: { onOpenChange: (open: boolean) => void }): UploadPipeline {
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

  // ============================================================
  // FIX (BUG-3-b B3): per-phase fetch timeouts + user cancellation.
  // ------------------------------------------------------------
  // The 3-phase pipeline had NO timeouts: one hung request (chunk upload,
  // detect, or import) locked the dialog shut — handleClose refused to
  // close while busy and every Batal button was disabled, so the user's
  // only escape was a page reload. Every pipeline fetch now goes through
  // fetchWithTimeout with a phase-appropriate budget, and cancel() aborts
  // ALL in-flight requests (chunks upload with bounded concurrency) and
  // unlocks the busy flags immediately.
  // ============================================================
  const UPLOAD_CHUNK_TIMEOUT_MS = 120_000; // per 4MB chunk request
  const DETECT_TIMEOUT_MS = 60_000;        // parse + week detection
  const IMPORT_TIMEOUT_MS = 300_000;       // import-all (large files are legit slow)

  const abortControllersRef = useRef<Set<AbortController>>(new Set());
  const cancelRequestedRef = useRef(false);

  const fetchWithTimeout = useCallback((url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    abortControllersRef.current.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      abortControllersRef.current.delete(controller);
    });
  }, []);

  const cancel = useCallback(() => {
    cancelRequestedRef.current = true;
    for (const c of abortControllersRef.current) c.abort();
    abortControllersRef.current.clear();
    // Unlock immediately — the aborted phase's catch path sees
    // cancelRequestedRef and stays quiet (no fake "Upload gagal" toast).
    setUploading(false);
    setImporting(false);
  }, []);

  /** FIX (BUG-3-b B3): AbortError → friendly Indonesian message (timeout vs
   * user cancel), following the fetchAnalysis.ts pattern. */
  const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

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
    // FIX (BUG-3-b B3): the dialog no longer locks shut while busy — now that
    // an abort mechanism exists, closing mid-phase aborts the in-flight
    // requests first (their catch paths stay quiet via cancelRequestedRef),
    // then resets and closes like any other close.
    if (uploading || importing) cancel();
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

    // FIX (BUG-3-b B3): fresh run — clear any stale cancel flag from a
    // previous aborted attempt.
    cancelRequestedRef.current = false;
    setUploading(true);
    setProgress(0);
    setStatusLog([`⏳ Mengupload ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)...`]);
    setError(null);
    setResult(null);
    setDetectData(null);

    // FIX (BUG-3-b B3): tracks the CURRENT phase's timeout budget so the
    // catch block can report the right number (chunk 120s vs detect 60s).
    // Declared OUTSIDE the try — catch needs to read it.
    let phaseTimeoutMs = UPLOAD_CHUNK_TIMEOUT_MS;
    try {
      // ===== PHASE 1: Upload chunks (fast, each <5s) =====
      const fileBuffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
      const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      setStatusLog(prev => [...prev, `📦 File dipecah jadi ${totalChunks} chunk (4MB per chunk)`]);

      let uploadResult: any = null;

      // PERF-UPLOAD-4: upload chunks in PARALLEL (3 concurrent) instead of one
      // at a time. Each chunk is an independent idempotent upsert keyed by
      // (fileHash, chunkIndex) — order does not matter. The LAST chunk is held
      // back and sent strictly after all others so the server's last-chunk
      // verification (chunk count + total size, PERF-UPLOAD-3) sees the
      // complete file. Sequential upload paid a full network round trip per
      // 4MB chunk; parallel overlaps them → ~3x faster for multi-chunk files.
      const UPLOAD_CONCURRENCY = 3;
      let completedChunks = 0;
      let uploadFailed = false;

      const uploadSingleChunk = async (i: number): Promise<any | null> => {
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

        const res = await fetchWithTimeout('/api/ingest-upload', {
          method: 'POST',
          body: formData,
        }, UPLOAD_CHUNK_TIMEOUT_MS);

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

        completedChunks++;
        setProgress((completedChunks / totalChunks) * 40); // 0-40% for upload
        return data;
      };

      // Upload every chunk EXCEPT the last, with bounded concurrency.
      // A worker pool (shared cursor) keeps exactly ≤3 requests in flight.
      const bodyCount = Math.max(totalChunks - 1, 0); // last chunk sent separately below
      let nextIndex = 0;
      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(UPLOAD_CONCURRENCY, bodyCount); w++) {
        workers.push((async () => {
          while (!uploadFailed) {
            const i = nextIndex++;
            if (i >= bodyCount) break;
            setStatusLog(prev => [...prev, `📦 Upload chunk ${i + 1}/${totalChunks}...`]);
            try {
              await uploadSingleChunk(i);
            } catch (err) {
              uploadFailed = true; // stop dispatching new chunks; error surfaces via Promise.all
              throw err;
            }
          }
        })());
      }
      await Promise.all(workers);

      // Send the LAST chunk strictly after all others — the server treats the
      // last chunk as "upload complete" and runs the count + total-size checks.
      if (totalChunks > 0) {
        setStatusLog(prev => [...prev, `📦 Upload chunk ${totalChunks}/${totalChunks}...`]);
        uploadResult = await uploadSingleChunk(totalChunks - 1);
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
      phaseTimeoutMs = DETECT_TIMEOUT_MS;
      setProgress(50);
      setStatusLog(prev => [...prev, '🔍 Parsing Excel, mendeteksi week...']);

      const detectRes = await fetchWithTimeout('/api/ingest-process', {
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
      }, DETECT_TIMEOUT_MS);

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
    } catch (e: unknown) {
      // FIX (BUG-3-b B3): user-initiated cancel stays quiet (the cancel()
      // action already reset the busy flags) — no error state, no toast.
      if (cancelRequestedRef.current) {
        setUploading(false);
        return;
      }
      // FIX (BUG-3-b B3): timeout abort → friendly message, not
      // "The user aborted a request".
      const msg = isAbortError(e)
        ? `Timeout — server tidak merespons dalam ${phaseTimeoutMs / 1000}s. Coba lagi.`
        : (e instanceof Error ? e.message : 'Upload gagal');
      setError(msg);
      setStatusLog(prev => [...prev, `❌ Error: ${msg}`]);
      toast({
        title: '❌ Upload gagal',
        description: msg,
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

    // FIX (BUG-3-b B3): fresh run — clear any stale cancel flag.
    cancelRequestedRef.current = false;
    setImporting(true);
    setError(null);
    setProgress(60);

    const fileName = detectData.fileName;
    const weeksToImport = detectData.weeksToImport;
    const rowCountPerWeek = detectData.rowCountPerWeek;
    const importedWeeks: WeekResult[] = [];
    let totalInserted = 0;

    try {
      // FIX: use 'import-all' mode — reassemble + parse ONCE for all weeks
      // (was: separate 'import' call per week = reassemble + parse N times = N× slower)
      const totalRows = weeksToImport.reduce((s, w) => s + (rowCountPerWeek[w] || 0), 0);
      setStatusLog(prev => [...prev, `⏳ Import semua week (${totalRows.toLocaleString()} rows total)...`]);
      setProgress(70);

      const importRes = await fetchWithTimeout('/api/ingest-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'import-all',
          fileName,
          fileHash,
          fileSize,
          ext,
          weeksToImport,
          numberLocale,
          ...(detectData.manualMode ? { manualFileName: fileName } : {}),
        }),
      }, IMPORT_TIMEOUT_MS);

      const contentType = importRes.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await importRes.text();
        if (importRes.status === 504) {
          throw new Error(`Timeout (504) — import terlalu lama. Coba lagi atau gunakan Import dari Drive.`);
        }
        throw new Error(`Server error (HTTP ${importRes.status}). ${text.slice(0, 300)}`);
      }

      const importData = await importRes.json();
      if (!importRes.ok || !importData.success) {
        throw new Error(importData.error || `HTTP ${importRes.status}`);
      }

      totalInserted = importData.totalInserted || 0;
      const weeksResult = importData.importedWeeks || [];
      for (const w of weeksResult) {
        importedWeeks.push({
          weekLabel: w.weekLabel,
          status: w.status,
          rowCount: w.rowCount || 0,
          dqErrors: w.dqErrors || 0,
          dqWarnings: w.dqWarnings || 0,
          durationMs: w.durationMs || 0,
        });
        if (w.status === 'IMPORTED') {
          setStatusLog(prev => [...prev, `✅ ${w.weekLabel}: ${(w.rowCount || 0).toLocaleString()} rows imported (${((w.durationMs || 0) / 1000).toFixed(1)}s) | DQ: ${w.dqErrors || 0}E ${w.dqWarnings || 0}W`]);
        } else {
          setStatusLog(prev => [...prev, `⏭️ ${w.weekLabel}: ${w.status}`]);
        }
      }
      setStatusLog(prev => [...prev, `📊 Total: ${totalInserted.toLocaleString()} rows dalam ${((importData.durationMs || 0) / 1000).toFixed(1)}s`]);

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

      // FIX (H-14/T3): full 18-key invalidation via shared helper — the old
      // 6-key subset here left pareto/heatmap/trend/flip/drilldown/price-effect
      // keys stale in keep-alive tabs after an upload.
      invalidateAllData(queryClient);
      toast({
        title: '✅ Import berhasil',
        description: `${totalInserted.toLocaleString()} rows dari ${fileName}`,
      });
    } catch (e: unknown) {
      // FIX (BUG-3-b B3): user-initiated cancel stays quiet — the server may
      // still finish a partial import; the "week sudah ada" guard makes a
      // retry safe. No fake error toast for a deliberate cancel.
      if (cancelRequestedRef.current) {
        return;
      }
      const msg = isAbortError(e)
        ? `Timeout — import tidak selesai dalam ${IMPORT_TIMEOUT_MS / 1000}s. Coba lagi (week yang sudah masuk akan di-skip) atau gunakan Import dari Drive.`
        : (e instanceof Error ? e.message : 'Import gagal');
      setError(msg);
      setStatusLog(prev => [...prev, `❌ Error: ${msg}`]);
      toast({
        title: '❌ Import gagal',
        description: msg,
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

  // "Ganti file" from the drop zone: drop the selected file + its
  // pre-filled manual name (same two setState calls the old inline
  // button handler performed).
  const clearFile = () => {
    setFile(null);
    setManualFileName('');
  };

  const isBusy = uploading || importing;
  const showConfirm = !!detectData && !result;

  return {
    file,
    uploading,
    importing,
    progress,
    statusLog,
    result,
    error,
    renameMode,
    setRenameMode,
    manualFileName,
    setManualFileName,
    manualValidation,
    numberLocale,
    setNumberLocale,
    detectData,
    fileInputRef,
    reset,
    handleClose,
    handleFileSelect,
    handleDrop,
    handleUploadAndDetect,
    handleRunImport,
    handleEditName,
    clearFile,
    // FIX (BUG-3-b B3): exposed for the "Batalkan" button in the dialog footer.
    cancel,
    isBusy,
    showConfirm,
  };
}
