// ============================================================
//  pipeline/file-selection — file-picker + drag&drop entry points.
//  Moved verbatim from use-upload-pipeline.ts (SPLIT-C pure code
//  motion). The two pre-split handlers had byte-identical
//  validation + state sequences; applySelectedFile preserves that
//  exact order (error-first guards, then the 7-setState cleanup +
//  pre-fill sequence) for both entry points.
// ============================================================

import type { ChangeEvent, DragEvent } from 'react';
import type { PipelineDeps } from './types';

// 50MB client-side cap — matches the "Maksimal 50MB" error copy.
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

function applySelectedFile(deps: PipelineDeps, selected: File | null | undefined): void {
  if (!selected) return;

  const ext = selected.name.split('.').pop()?.toLowerCase();
  if (ext !== 'xlsx' && ext !== 'csv') {
    deps.setError(`Format file tidak didukung: .${ext}. Hanya .xlsx dan .csv.`);
    return;
  }

  if (selected.size > MAX_FILE_SIZE_BYTES) {
    deps.setError(`File terlalu besar: ${(selected.size / 1024 / 1024).toFixed(1)}MB. Maksimal 50MB.`);
    return;
  }

  deps.setError(null);
  deps.setFile(selected);
  deps.setResult(null);
  deps.setDetectData(null);
  deps.setStatusLog([]);
  deps.setProgress(0);
  // Pre-fill manual name with the original filename (user can edit)
  deps.setManualFileName(selected.name);
}

/** File-input onChange handler (host passes it through as
 * `handleFileSelect`). */
export function onFileSelect(deps: PipelineDeps, e: ChangeEvent<HTMLInputElement>): void {
  const selected = e.target.files?.[0];
  applySelectedFile(deps, selected);
}

/** Drop-zone onDrop handler (host passes it through as `handleDrop`). */
export function onFileDrop(deps: PipelineDeps, e: DragEvent): void {
  e.preventDefault();
  const dropped = e.dataTransfer.files[0];
  applySelectedFile(deps, dropped);
}
