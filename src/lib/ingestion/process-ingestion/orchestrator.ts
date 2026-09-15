// ============================================================
//  Ingestion — processIngestion() Main Orchestrator
//  --------------------------------------------------------
//  Full-file ingestion path used by /api/ingest + /api/import-drive.
//  Reads .xlsx/.csv from disk, validates + normalizes + derives
//  records, batch-inserts InventoryRecords inside a single atomic
//  transaction (BUG2-INGEST-1), pre-computes OutletPeriodSales MODE
//  (DRY: computeOutletPeriodSales), invalidates caches.
//
//  Bug history preserved in inline comments:
//   - Bug 1 fix: skip rows with ERROR severity
//   - Bug 3 fix: dedup by monthLabel (delete old SourceFile for same period)
//   - Bug 3 fix: race condition lock per file
//   - BUG2-INGEST-1: delete+insert in single transaction (atomic)
//   - BUG-5-5: race-safe upserts (ON CONFLICT DO UPDATE)
//   - BUG2-INGEST-3: tx propagation to all sub-functions
//   - AUDIT-BUG-3: in-memory natural-key dedup (akun NULL ≠ NULL in PG)
//   - AUDIT-BUG-4: insertInventoryRecords — no more silent per-row catch{}
//   - AUDIT-BUG-5: pg advisory lock + in-tx rechecks (cross-instance safe)
//
//  SPLIT-D (pure code motion): was src/lib/ingestion/process-ingestion.ts
//  (565 lines, old file deleted). './process-ingestion' from the ingestion
//  barrel now resolves to this folder's index.ts — same import path for
//  every caller. Stages live in sibling modules:
//    ./resolve-files      — input file resolution (path traversal guard)
//    ./read-rows          — STEP 1 xlsx/csv row reader
//    ./prepare-rows       — PASS 1 CPU-only normalize/derive
//    ./ingest-transaction — the atomic db.$transaction core
// ============================================================
import path from 'path';
import { logger } from '../../logger';
import { db } from '@/lib/db';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { parseMonthFromFilename, hashFile } from '@/lib/excel';
import type { DQIssueRow } from '@/engine/validator';
import { acquireIngestionLock, releaseIngestionLock } from '../ingestion-lock';
import type { IngestResult, IngestRequestBody } from '../types';
import { resolveInputFiles } from './resolve-files';
import { readAllRows } from './read-rows';
import { prepareRows } from './prepare-rows';
import { runIngestTransaction } from './ingest-transaction';

export async function processIngestion(body: IngestRequestBody, fastMode?: boolean): Promise<IngestResult[]> {
  const resolved = await resolveInputFiles(body);
  if (!resolved.ok) return [resolved.errorResult];
  const files = resolved.files;

  const results: IngestResult[] = [];

  for (const filePath of files) {
    // Bug 3 fix: acquire lock per file
    const lockKey = filePath;
    if (!acquireIngestionLock(lockKey)) {
      results.push({
        fileName: path.basename(filePath), status: 'SKIPPED', rowCount: 0,
        dqStatus: 'OK', dqErrors: 0, dqWarnings: 0,
        error: 'Ingestion already in progress for this file',
      });
      continue;
    }
    try {
      const ext = path.extname(filePath).toLowerCase();
      // Support manual rename: if body.manualFileName is provided, sanitize + validate
      // it before use (defense-in-depth — the API route should have validated already,
      // but processIngestion may be called from other paths in the future).
      let fileName = path.basename(filePath);
      if (body.manualFileName && typeof body.manualFileName === 'string' && body.manualFileName.trim()) {
        // Inline sanitize (avoid circular import with @/lib/filename which imports from excel.ts)
        const sanitized = String(body.manualFileName)
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
          .replace(/^\.+/, '')
          .trim();
        if (sanitized) {
          // Ensure extension
          const hasExt = /\.(xlsx|csv)$/i.test(sanitized);
          fileName = hasExt ? sanitized : `${sanitized}.xlsx`;
        }
      }

      // P1-4 fix note: the file hash is ALWAYS computed here (hashFile) —
      // the old `body.precomputedHash` shortcut had no caller that ever set it
      // (verified via grep: only this file + the type existed), so it was dead
      // weight on the request type. Removed in FIX (BUG-3-c SEDANG-3).
      const fileHash = await hashFile(filePath);

      // Check if already ingested (by hash)
      const existing = await db.sourceFile.findUnique({
        where: { fileHash },
        select: { id: true, rowCount: true },
      });
      if (existing) {
        const actualCount = await db.inventoryRecord.count({ where: { sourceFileId: existing.id } });
        if (actualCount > 0) {
          results.push({
            fileName, status: 'SKIPPED', rowCount: actualCount,
            dqStatus: 'OK', dqErrors: 0, dqWarnings: 0,
          });
          continue;
        }
        // BUG-03 fix: clean up stale stub in transaction
        await db.$transaction([
          db.dQIssue.deleteMany({ where: { sourceFileId: existing.id } }),
          db.inventoryRecord.deleteMany({ where: { sourceFileId: existing.id } }),
          db.week.deleteMany({ where: { sourceFileId: existing.id } }),
          db.sourceFile.delete({ where: { id: existing.id } }),
        ]);
      }

      // STEP 1: Parse Excel directly (skip CSV conversion — 30% faster)
      // P1-9 fix: track sheetName per row for DQ audit
      const allRows = await readAllRows(filePath, ext);

      // Parse month from filename
      const monthInfo = parseMonthFromFilename(fileName);
      // BUG FIX (BUG-NORECORDS-5): normalize monthLabel to Title Case for consistency.
      // upload-data.ts produces UPPERCASE, excel.ts produces Title Case → mixed DB.
      // Always store Title Case (e.g., "Agustus 2026") to match parseMonthFromFilename output.
      const monthLabel = monthInfo?.monthLabel || fileName.replace(/\.(xlsx|csv)$/i, '');
      const monthKey = monthInfo?.monthKey || 'unknown';

      // BUG FIX (BUG-NORECORDS-4): dedup by monthKey instead of monthLabel.
      // Previously dedup was case-sensitive on monthLabel — "AGUSTUS 2026" (from upload-data.ts)
      // didn't match "Agustus 2026" (from dashboard import) → old SourceFile not deleted →
      // duplicate records split by case → query returns 0 for one case variant.
      // monthKey is always "2026-08" (numeric, case-insensitive) → safe dedup.
      //
      // FIX (BUG2-INGEST-1): the dedup-delete runs INSIDE the transaction below (deferred),
      // so a failed create/insert rolls the delete back → old data preserved.
      //
      // FIX (AUDIT-BUG-5): the existingPeriodFiles LIST itself is also queried inside
      // the transaction, AFTER the pg advisory lock — reading it here (before the lock)
      // would use a stale snapshot when a concurrent import of the same month commits
      // while we wait for the lock, leaving TWO SourceFiles for one month
      // (double-counted aggregates).

      // STEP 3: Pre-cache ALL outlets & items (avoid per-row DB queries — 50% faster)
      // Read-only — safe to do outside the transaction. The maps are populated and
      // reused inside the transaction. New outlets/items (codes not in these maps)
      // are resolved INSIDE the transaction by PASS 2's set-based helpers
      // (ensureOutletsExist/ensureItemsExist — rolled back if the transaction fails).
      const allOutlets = await db.outlet.findMany({ select: { id: true, code: true } });
      const allItems = await db.item.findMany({ select: { id: true, name: true, satuan: true } });
      const outletDbMap = new Map<string, number>(allOutlets.map(o => [o.code, o.id]));
      const itemDbMap = new Map<string, { id: number; satuan: string | null }>(allItems.map(i => [i.name, { id: i.id, satuan: i.satuan }]));

      const seenKeys = new Set<string>();
      const allIssues: DQIssueRow[] = [];

      // ============================================================
      // STEP 3.5 (PERF PAKET B / F3) — PASS 1: CPU-only normalization.
      // --------------------------------------------------------
      // Validate (non-fastMode) + normalize + derive every row up front and
      // collect the distinct outlet/item candidates. The transaction below
      // then resolves ALL of them in a handful of set-based queries
      // (ensureOutletsExist/ensureItemsExist — the same helpers the
      // /api/ingest-process path already uses) instead of one sequential
      // upsert per new master-data code (~442 round-trips on the first
      // import of new outlet/item codes, 5-15ms per hop via the pooler).
      // ============================================================
      const { prepared, outletCandidates, itemCandidates } = prepareRows({
        allRows, fileName, monthLabel, fastMode,
        numberLocale: body.numberLocale, seenKeys, allIssues,
      });

      const { totalInserted, dq, duplicateOf, skippedDuplicates } = await runIngestTransaction({
        filePath, fileName, fileHash, monthLabel, monthKey, fastMode,
        prepared, outletCandidates, itemCandidates,
        outletDbMap, itemDbMap, allIssues,
      });

      // FIX (AUDIT-BUG-5): a concurrent import committed this exact file while we
      // waited on the advisory lock — its data is already in (row count verified
      // inside the lock). Report SKIPPED instead of double-importing.
      if (duplicateOf) {
        results.push({
          fileName, status: 'SKIPPED', rowCount: duplicateOf.rowCount,
          dqStatus: 'OK', dqErrors: 0, dqWarnings: 0,
        });
        continue;
      }

      // FIX (AUDIT-BUG-3): surface in-memory duplicate skips (fastMode has no DQ
      // pipeline — without this log the dropped rows would be invisible).
      if (skippedDuplicates > 0) {
        logger.warn(
          `ingest ${fileName}: skipped ${skippedDuplicates} in-batch duplicate row(s) ` +
            '(natural key week|outlet|item|akun — first occurrence kept)',
        );
      }

      // Phase 3: invalidate analysis cache when new data is ingested
      // BUG FIX (BUG-NORECORDS-3): clear statusCache so dropdown shows new months immediately.
      // Previously statusCache had 5-min TTL → user couldn't see newly imported months for 5 min.
      statusCache.clear();
      // FIX Medium #1: invalidate DB-level AggregationCache for analysis route.
      // New data means all cached analysis results are stale.
      // PERF-CACHE-05: await invalidation (was fire-and-forget) — guarantees
      // the client's next read after the mutation returns sees fresh data.
      // The invalidateAnalysisCache helper has its own try/catch, so awaiting
      // is safe (won't reject on DB error — just logs).
      await invalidateAnalysisCache();
      // sees fresh data immediately after ingestion.
      // FIX-DEEP-1C: clear monthResolver cache so subsequent requests see the new
      // monthLabel added by this ingestion. Without this, getMonthResolver() would
      // keep returning the pre-ingestion resolver and queries for the new month
      // would fail to resolve case correctly.
      clearMonthResolverCache();

      results.push({
        fileName, status: 'INGESTED', rowCount: totalInserted,
        dqStatus: dq.status, dqErrors: dq.severityCounts.ERROR, dqWarnings: dq.severityCounts.WARNING,
      });
    } catch (e: unknown) {
      results.push({
        fileName: path.basename(filePath), status: 'ERROR', rowCount: 0,
        dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0,
        error: (e instanceof Error ? e.message : String(e)),
      });
    } finally {
      // Bug 3 fix: always release lock
      releaseIngestionLock(lockKey);
    }
  }

  return results;
}
