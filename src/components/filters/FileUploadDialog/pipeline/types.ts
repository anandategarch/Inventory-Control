// ============================================================
//  pipeline/types — public + internal types for the 3-phase
//  upload state machine behind FileUploadDialog.
//  Moved verbatim from use-upload-pipeline.ts (SPLIT-C pure
//  code motion — zero behavior change). The public types
//  (WeekResult / UploadResult / DetectResult / UploadPipeline)
//  are re-exported from use-upload-pipeline.ts so every
//  existing `from './use-upload-pipeline'` import keeps
//  resolving; PipelineDeps / FileMeta / ManualValidation are
//  internal to the pipeline/ modules.
// ============================================================

import type { ChangeEventHandler, Dispatch, DragEventHandler, RefObject, SetStateAction } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { useToast } from '@/hooks/use-toast';
import type { usePipelineAbort } from './abort';

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
  manualValidation: ManualValidation;
  // Number locale for CSV parsing — default 'auto' (local files could be either)
  numberLocale: 'auto' | 'id' | 'us';
  setNumberLocale: Dispatch<SetStateAction<'auto' | 'id' | 'us'>>;
  // Detect result + confirmation gate
  detectData: DetectResult | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
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

/** Persist upload metadata across detect → import so the import call
 * doesn't need to re-upload (payload of the host hook's fileMetaRef). */
export interface FileMeta {
  fileHash: string;
  fileSize: number;
  ext: string;
}

/** Manual rename validation result (validateManualFileName from
 * ../upload-utils — typed here so PipelineDeps stays self-describing). */
export interface ManualValidation {
  ok: boolean;
  cleaned?: string;
  error?: string;
}

/**
 * Everything the pipeline stage modules need from the host hook.
 * The stages (upload-detect-stage.ts / import-stage.ts /
 * file-selection.ts) receive this instead of closing over hook
 * state — keeping them plain functions while preserving the exact
 * state-flow/step order of the pre-split closures. The host hook
 * rebuilds this object every render (the pre-split stage closures
 * were also re-created every render), and the setters / refs /
 * toast / queryClient / fetchWithTimeout it holds are stable.
 */
export interface PipelineDeps {
  // Current render's state (inputs)
  file: File | null;
  renameMode: 'auto' | 'manual';
  manualValidation: ManualValidation;
  numberLocale: 'auto' | 'id' | 'us';
  detectData: DetectResult | null;
  // Refs
  fileMetaRef: RefObject<FileMeta>;
  cancelRequestedRef: RefObject<boolean>;
  // Infrastructure
  // fetchWithTimeout's exact signature is derived from usePipelineAbort
  // (the single source of truth in ./abort.ts).
  fetchWithTimeout: ReturnType<typeof usePipelineAbort>['fetchWithTimeout'];
  toast: ReturnType<typeof useToast>['toast'];
  queryClient: QueryClient;
  // State setters (host hook state)
  setFile: Dispatch<SetStateAction<File | null>>;
  setUploading: Dispatch<SetStateAction<boolean>>;
  setImporting: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setStatusLog: Dispatch<SetStateAction<string[]>>;
  setResult: Dispatch<SetStateAction<UploadResult | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setDetectData: Dispatch<SetStateAction<DetectResult | null>>;
  setManualFileName: Dispatch<SetStateAction<string>>;
}
