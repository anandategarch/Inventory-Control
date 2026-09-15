// ============================================================
//  pipeline/upload-detect-stage — PHASE 1+2: Upload chunks
//  (parallel, 3 concurrent) + Detect weeks — stops at the
//  confirmation panel. Moved verbatim from use-upload-pipeline.ts
//  (SPLIT-C pure code motion — zero behavior change): every
//  state update, statusLog line, progress step, request payload,
//  and error/cancel branch is unchanged; only the closure
//  variables became destructured PipelineDeps fields.
// ============================================================

import { DETECT_TIMEOUT_MS, UPLOAD_CHUNK_TIMEOUT_MS, isAbortError } from './abort';
import type { PipelineDeps } from './types';

export async function runUploadAndDetect(deps: PipelineDeps): Promise<void> {
  const {
    file,
    renameMode,
    manualValidation,
    numberLocale,
    fileMetaRef,
    cancelRequestedRef,
    fetchWithTimeout,
    toast,
    queryClient,
    setUploading,
    setProgress,
    setStatusLog,
    setError,
    setResult,
    setDetectData,
  } = deps;

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
}
