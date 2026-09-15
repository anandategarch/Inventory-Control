'use client';

// ============================================================
//  pipeline/abort — per-phase fetch timeouts + user cancellation
//  (FIX BUG-3-b B3), extracted verbatim from use-upload-pipeline.ts
//  (SPLIT-C pure code motion).
//  ------------------------------------------------------------
//  The 3-phase pipeline had NO timeouts: one hung request (chunk
//  upload, detect, or import) locked the dialog shut — handleClose
//  refused to close while busy and every Batal button was disabled,
//  so the user's only escape was a page reload. Every pipeline fetch
//  now goes through fetchWithTimeout with a phase-appropriate budget,
//  and cancel() aborts ALL in-flight requests (chunks upload with
//  bounded concurrency) and unlocks the busy flags immediately.
// ============================================================

import { useCallback, useRef } from 'react';

export const UPLOAD_CHUNK_TIMEOUT_MS = 120_000; // per 4MB chunk request
export const DETECT_TIMEOUT_MS = 60_000;        // parse + week detection
export const IMPORT_TIMEOUT_MS = 300_000;       // import-all (large files are legit slow)

/** FIX (BUG-3-b B3): AbortError → friendly Indonesian message (timeout vs
 * user cancel), following the fetchAnalysis.ts pattern. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Owns the abort bookkeeping shared by all three pipeline phases.
 * `onUnlock` is the host hook's busy-flag reset (setUploading(false) +
 * setImporting(false)) — invoked at the END of cancel(), exactly where
 * the pre-split inline cancel() called the two setters.
 * Return type is inferred (fields: abortControllersRef, cancelRequestedRef,
 * fetchWithTimeout, cancel) so pipeline/types.ts can derive the exact
 * fetchWithTimeout signature from it.
 */
export function usePipelineAbort({ onUnlock }: { onUnlock: () => void }) {
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
    onUnlock();
  }, [onUnlock]);

  return { abortControllersRef, cancelRequestedRef, fetchWithTimeout, cancel };
}
