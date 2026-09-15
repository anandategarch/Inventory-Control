// ============================================================
//  pipeline/import-stage — PHASE 3: Import weeks (triggered by the
//  "Lanjut Import" button on the confirmation panel). Moved verbatim
//  from use-upload-pipeline.ts (SPLIT-C pure code motion — zero
//  behavior change): the import-all request payload, per-week
//  statusLog lines, temp-file cleanup, result assembly, and the
//  full 18-key invalidation are unchanged; only the closure
//  variables became destructured PipelineDeps fields.
// ============================================================

import { invalidateAllData } from '@/lib/query-invalidation';
import { IMPORT_TIMEOUT_MS, isAbortError } from './abort';
import type { PipelineDeps, UploadResult, WeekResult } from './types';

export async function runImport(deps: PipelineDeps): Promise<void> {
  const {
    detectData,
    numberLocale,
    fileMetaRef,
    cancelRequestedRef,
    fetchWithTimeout,
    toast,
    queryClient,
    setImporting,
    setError,
    setProgress,
    setStatusLog,
    setResult,
    setDetectData,
  } = deps;

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
}
