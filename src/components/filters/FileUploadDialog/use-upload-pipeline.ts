'use client';

// ============================================================
//  use-upload-pipeline — the 3-phase upload state machine behind
//  FileUploadDialog (REFACTOR-1-c + SPLIT-C pure splits — zero
//  behavior change):
//    PHASE 1+2: upload chunks (parallel, 3 concurrent) + detect
//               weeks — stops at the confirmation panel
//    PHASE 3:   import weeks ("Lanjut Import" button)
//  The hook owns ALL pipeline state/actions + progress/error
//  handling; the UI components only read state and call actions.
//  The /api/ingest-upload + /api/ingest-process request/response
//  contracts are byte-for-byte identical to the pre-split file.
//
//  SPLIT-C module map (logic moved verbatim into ./pipeline/):
//    types.ts               — public types (re-exported below) +
//                              internal PipelineDeps/FileMeta
//    abort.ts               — per-phase timeouts, fetchWithTimeout,
//                              cancel/abort bookkeeping (BUG-3-b B3)
//    file-selection.ts      — file-picker + drag&drop handlers
//    upload-detect-stage.ts — PHASE 1+2 (runUploadAndDetect)
//    import-stage.ts        — PHASE 3 (runImport)
//  This file stays the public entry: `useUploadPipeline` and the
//  exported types keep the exact same path/signature, so callers
//  (FileUploadDialog/index.tsx, ConfirmPanel, ImportResultSummary)
//  import from './use-upload-pipeline' exactly as before.
// ============================================================

import { useState, useRef, useCallback, useMemo } from 'react';
import type { ChangeEventHandler, DragEventHandler } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
// FIX (AUDIT8-ROLLBACK-1, Item 7): extract shared upload helpers to a sibling
// module so MONTH_NAMES stays in sync with the server-side MONTH_MAP (was the
// cause of AUDIT-RENAME-9 — client ✓ then server 400 due to month-list drift).
import { validateManualFileName, renameModeDefault } from '../upload-utils';
import { usePipelineAbort } from './pipeline/abort';
import { onFileSelect, onFileDrop } from './pipeline/file-selection';
import { runUploadAndDetect } from './pipeline/upload-detect-stage';
import { runImport } from './pipeline/import-stage';
import type { DetectResult, PipelineDeps, UploadPipeline, UploadResult } from './pipeline/types';

// Public types still importable from this module path (barrel re-export).
export type { WeekResult, UploadResult, DetectResult, UploadPipeline } from './pipeline/types';

// Client-side manual filename validation now lives in ../upload-utils
// (FIX AUDIT8-ROLLBACK-1, Item 7 — was duplicated here, drifting from server).
// Re-exporting would be unused; consumers import directly from upload-utils.

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
  // unlocks the busy flags immediately. (Infra lives in ./pipeline/abort.ts)
  // ============================================================
  const unlockBusy = useCallback(() => {
    setUploading(false);
    setImporting(false);
  }, []);
  const { cancelRequestedRef, fetchWithTimeout, cancel } = usePipelineAbort({ onUnlock: unlockBusy });

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

  // Stage deps — rebuilt every render so the plain-function stages in
  // ./pipeline/ see the same fresh state the pre-split closures saw (they
  // were re-created each render too). Setters, refs, toast, queryClient and
  // fetchWithTimeout are stable.
  const deps: PipelineDeps = {
    file,
    renameMode,
    manualValidation,
    numberLocale,
    detectData,
    fileMetaRef,
    cancelRequestedRef,
    fetchWithTimeout,
    toast,
    queryClient,
    setFile,
    setUploading,
    setImporting,
    setProgress,
    setStatusLog,
    setResult,
    setError,
    setDetectData,
    setManualFileName,
  };

  // ============================================================
  // PHASE 1+2: Upload chunks + Detect weeks (stops at confirmation)
  // ============================================================
  const handleFileSelect: ChangeEventHandler<HTMLInputElement> = (e) => onFileSelect(deps, e);
  const handleDrop: DragEventHandler = (e) => onFileDrop(deps, e);

  const handleUploadAndDetect = () => runUploadAndDetect(deps);

  // ============================================================
  // PHASE 3: Import weeks (triggered by "Lanjut Import" button)
  // ============================================================
  const handleRunImport = () => runImport(deps);

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
