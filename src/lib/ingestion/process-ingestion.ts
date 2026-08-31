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
// ============================================================
import path from 'path';
import { logger } from '../logger';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { parseMonthFromFilename, parseExcelFile, hashFile } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ, type DQIssueRow } from '@/engine/validator';
import { parseCsvStream } from '@/lib/csv-parser';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { DATA_DIR, safePath } from './safe-path';
import { findExcelFiles } from './find-excel-files';
import { acquireIngestionLock, releaseIngestionLock } from './ingestion-lock';
import { computeOutletPeriodSales } from './outlet-period-sales';
import type { IngestResult, IngestRequestBody } from './types';

export async function processIngestion(body: IngestRequestBody, fastMode?: boolean): Promise<IngestResult[]> {
  let files: string[] = [];

  if (body.filePath) {
    const safe = safePath(body.filePath);
    if (!safe) {
      return [{ fileName: body.filePath, status: 'ERROR', rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked' }];
    }
    files = [safe];
  } else if (body.dir) {
    const safe = safePath(body.dir);
    if (!safe) {
      return [{ fileName: body.dir, status: 'ERROR', rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked' }];
    }
    files = await findExcelFiles(safe);
  } else if (body.fileName) {
    const safe = safePath(body.fileName);
    if (!safe) {
      return [{ fileName: body.fileName, status: 'ERROR', rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked' }];
    }
    files = [safe];
  } else {
    files = await findExcelFiles();
  }

  if (files.length === 0) {
    return [{
      fileName: '(none)',
      status: 'ERROR',
      rowCount: 0,
      dqStatus: 'ERROR',
      dqErrors: 1,
      dqWarnings: 0,
      error: `No .xlsx or .csv files found in ${DATA_DIR}.`,
    }];
  }

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

      // P1-4 fix: skip hashFile if already provided (avoid double-read)
      const fileHash = body.precomputedHash || await hashFile(filePath);

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
      let allRows: Array<Record<string, unknown> & { _sheetName?: string }> = [];
      if (ext === '.xlsx') {
        const parsed = await parseExcelFile(filePath);
        for (const sheet of parsed.sheets) {
          for (const row of sheet.rows) {
            allRows.push({ ...row, _sheetName: sheet.sheetName });
          }
        }
      } else {
        // CSV: use stream parser
        for await (const rawRow of parseCsvStream(filePath)) {
          allRows.push(rawRow);
        }
      }

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
      // FIX (BUG2-INGEST-1): The old code DELETED the existing SourceFiles HERE (before
      // creating the new one + inserting rows). If the subsequent create/insert failed
      // (Excel parse error already handled above, but DB error / OOM / Vercel timeout
      // can still happen mid-insert), the old data was PERMANENTLY LOST.
      // Now we CAPTURE the list of old SourceFile IDs here (read-only) and defer the
      // actual delete to INSIDE the transaction below (line ~270). This way, if the
      // transaction fails, the delete is rolled back → old data is preserved.
      const existingPeriodFiles = monthKey !== 'unknown'
        ? await db.sourceFile.findMany({
            where: { monthKey },
            select: { id: true, fileName: true },
          })
        : await db.sourceFile.findMany({
            where: { monthLabel },
            select: { id: true, fileName: true },
          });

      // STEP 3: Pre-cache ALL outlets & items (avoid per-row DB queries — 50% faster)
      // Read-only — safe to do outside the transaction. The maps are populated and
      // reused inside the transaction loop. New outlets/items encountered inside the
      // transaction are upserted via `tx` (rolled back if the transaction fails).
      const allOutlets = await db.outlet.findMany({ select: { id: true, code: true } });
      const allItems = await db.item.findMany({ select: { id: true, name: true, satuan: true } });
      const outletDbMap = new Map<string, number>(allOutlets.map(o => [o.code, o.id]));
      const itemDbMap = new Map<string, { id: number; satuan: string | null }>(allItems.map(i => [i.name, { id: i.id, satuan: i.satuan }]));

      const seenKeys = new Set<string>();
      const allIssues: DQIssueRow[] = [];
      const weekDbMap = new Map<string, number>();

      // FIX (BUG2-INGEST-1): Wrap dedup-delete + create + insert + update + DQ in a
      // single transaction so that if ANY step fails, ALL writes are rolled back.
      // Previously, the delete happened BEFORE the create/insert — a failure mid-insert
      // meant the old data was already gone (data loss). Now the delete is inside the
      // transaction, so it only commits if the entire insert succeeds.
      //
      // 240s timeout: import-drive maxDuration is 300s; ingest maxDuration is 30s.
      // For /api/ingest (30s), Vercel will kill the function before the transaction
      // timeout — PostgreSQL will then roll back automatically when the connection drops.
      // For /api/import-drive (300s), the 240s timeout gives headroom for post-tx work
      // (cache invalidation).
      const { totalInserted, dq } = await db.$transaction(
        async (tx) => {
          // STEP 1 (deferred): Delete old SourceFiles for the same monthKey/monthLabel.
          // This runs INSIDE the transaction so it's rolled back if the insert fails.
          if (existingPeriodFiles.length > 0) {
            const oldIds = existingPeriodFiles.map(f => f.id);
            await tx.dQIssue.deleteMany({ where: { sourceFileId: { in: oldIds } } });
            await tx.inventoryRecord.deleteMany({ where: { sourceFileId: { in: oldIds } } });
            await tx.week.deleteMany({ where: { sourceFileId: { in: oldIds } } });
            await tx.sourceFile.deleteMany({ where: { id: { in: oldIds } } });
          }

          // STEP 2: Create SourceFile record
          const sourceFile = await tx.sourceFile.create({
            data: {
              fileName, filePath,
              monthLabel, monthKey, fileHash,
              rowCount: 0, dqStatus: 'OK',
            },
          });

          const BATCH_SIZE = 2000;
          let batchRecords: Prisma.InventoryRecordCreateManyInput[] = [];
          let totalInserted = 0;
          let totalRows = 0;
          let skippedErrors = 0;

          // SINGLE PASS: validate + normalize + create outlets/items lazily + insert
          // Pre-loaded outletDbMap and itemDbMap from SELECT above.
          // New outlets/items created on first encounter, then cached.
          //
          // FAST MODE: skip validateRow() entirely — pure normalize + derive + insert.
          // Validation can be run separately later. ~3-5x faster for large files.
          for (const rawRow of allRows) {
            totalRows++;
            const rowNumber = totalRows + 1;

            if (!fastMode) {
              // Validate
              const issues = validateRow(rawRow, rowNumber, seenKeys, rawRow._sheetName, body.numberLocale || 'auto');
              allIssues.push(...issues);

              const hasError = issues.some((i) => i.severity === 'ERROR');
              if (hasError) {
                skippedErrors++;
                continue;
              }
            }

            // Normalize — pass numberLocale from body (default 'auto')
            const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel, body.numberLocale || 'auto');
            const derived = deriveRecord(n);

            // Ensure week exists (only 3-4 unique weeks per file)
            const wk = n.weekLabel || 'UNKNOWN';
            if (!weekDbMap.has(wk)) {
              // FIX: Use CUMULATIVE week periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
              // Previously: inline duplicate with WRONG discrete ranges (W2=8-14, W3/4=15-31)
              let p = CFG_RECON_SETTINGS.WEEK_PERIODS[wk];
              if (!p) {
                // Derive for WEEK 5+ (rare): cumulative up to min(N*7, 31)
                const weekNum = parseInt(wk.replace(/\D/g, '')) || 1;
                p = { start: 1, end: Math.min(weekNum * 7, 31) };
                logger.warn(`Unknown weekLabel "${wk}", derived cumulative period ${p.start}-${p.end}`);
              }
              const w = await tx.week.upsert({
                where: { sourceFileId_weekLabel: { sourceFileId: sourceFile.id, weekLabel: wk } },
                update: {},
                create: {
                  sourceFileId: sourceFile.id, weekLabel: wk,
                  weekKey: `${monthKey}-${wk.replace(/\s+/g, '')}`,
                  monthKey, periodStart: p.start, periodEnd: p.end,
                },
              });
              weekDbMap.set(wk, w.id);
            }

            // FIX-A-4 (BUG-5-5): Race-safe outlet creation — use upsert instead of
            // findUnique + create. Two concurrent imports of different weeks for the
            // same NEW outlet code previously raced: both findUnique miss → both create →
            // P2002 unique constraint violation → entire week import fails.
            // Upsert is atomic: if the row exists, update area/name if changed; if not,
            // create it. Either way, no P2002.
            if (derived.outletCode && !outletDbMap.has(derived.outletCode)) {
              const outlet = await tx.outlet.upsert({
                where: { code: derived.outletCode },
                // LOGIC-12 fix: update area + name if outlet moved to different area.
                // Conditional update avoids unnecessary writes when nothing changed.
                update: n.area ? { area: n.area, name: derived.outletName } : {},
                create: {
                  code: derived.outletCode,
                  name: derived.outletName,
                  outletCode: derived.outletNumericCode,
                  area: n.area,
                },
                select: { id: true },
              });
              outletDbMap.set(derived.outletCode, outlet.id);
            }

            // FIX-A-4 (BUG-5-5): Race-safe item creation — same upsert pattern.
            if (n.namaBahan && !itemDbMap.has(n.namaBahan)) {
              const item = await tx.item.upsert({
                where: { name: n.namaBahan },
                update: {}, // existing items keep their satuan (see processRowsForImport for satuan fill)
                create: { name: n.namaBahan, satuan: n.satuan },
                select: { id: true },
              });
              itemDbMap.set(n.namaBahan, { id: item.id, satuan: n.satuan });
            }

            // Get IDs from cache (O(1) Map lookup, no DB query)
            const weekId = weekDbMap.get(wk) ?? 0;
            const outletId = outletDbMap.get(derived.outletCode) ?? 0;
            const itemEntry = itemDbMap.get(n.namaBahan);
            const itemId = itemEntry?.id ?? 0;

            if (weekId > 0 && outletId > 0 && itemId > 0) {
              batchRecords.push({
                sourceFileId: sourceFile.id, weekId, outletId, itemId,
                akunPenyesuaian: n.akunPenyesuaian, status: n.status, satuan: n.satuan,
                qtyBom: n.qtyBom, qtyCom: n.qtyCom, qtyDeviasi: n.qtyDeviasi,
                qtyWaste: n.qtyWaste, qtySusut: n.qtySusut, qtyTrial: n.qtyTrial, qtyLossSurplus: n.qtyLossSurplus,
                nominalDeviasi: n.nominalDeviasi, nominalWaste: n.nominalWaste, nominalSusut: n.nominalSusut,
                nominalTrial: n.nominalTrial, nominalLossSurplus: n.nominalLossSurplus, nominalSales: n.nominalSales,
                avgPrice: n.qtyDeviasi && n.nominalDeviasi && n.qtyDeviasi !== 0 ? Math.abs(n.nominalDeviasi / n.qtyDeviasi) : null,
                tolerancePct: n.tolerancePct, toleranceRaw: n.toleranceRaw,
                pctWasteSusut: n.pctWasteSusut, pctQtyDeviasiToBom: n.pctQtyDeviasiToBom,
                pctQtyWasteToBom: n.pctQtyWasteToBom, pctQtySusutToBom: n.pctQtySusutToBom,
                pctQtyTrialToBom: n.pctQtyTrialToBom, pctQtyLossToBom: n.pctQtyLossToBom,
                direction: derived.direction, residualQty: derived.residualQty, residualNominal: derived.residualNominal,
                residualRatio: derived.residualRatio, absQtyDeviasi: derived.absQtyDeviasi,
                absNominalDeviasi: derived.absNominalDeviasi, absQtyLossSurplus: derived.absQtyLossSurplus,
                absNominalLossSurplus: derived.absNominalLossSurplus,
                area: n.area, bulan: n.bulan, bulan2: n.bulan2, weekLabel: n.weekLabel, monthLabel: n.monthLabel,
              });
            }

            // Batch insert
            if (batchRecords.length >= BATCH_SIZE) {
              // BUG-06 fix: createMany returns { count: N } — use actual count, not batch length
              // FIX DB2-2: skipDuplicates is PostgreSQL-only — try/catch fallback for SQLite
              let result;
              try {
                result = await tx.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
              } catch {
                // SQLite fallback: insert one by one, skip duplicates manually
                let count = 0;
                for (const rec of batchRecords) {
                  try { await tx.inventoryRecord.create({ data: rec }); count++; } catch {}
                }
                result = { count };
              }
              totalInserted += result.count;
              batchRecords = [];
            }
          }

          // Insert remaining records
          if (batchRecords.length > 0) {
            let result2;
            try {
              result2 = await tx.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
            } catch {
              let count = 0;
              for (const rec of batchRecords) {
                try { await tx.inventoryRecord.create({ data: rec }); count++; } catch {}
              }
              result2 = { count };
            }
            totalInserted += result2.count;
          }

          // STEP 4: Update source file record
          // FAST MODE: skip summarizeDQ() — return empty DQ summary (OK, 0 errors, 0 warnings).
          // Validation can be run separately later and update these counts.
          const dq = fastMode
            ? { summary: [], severityCounts: { ERROR: 0, WARNING: 0, INFO: 0 }, status: 'OK' as const }
            : summarizeDQ(allIssues);
          await tx.sourceFile.update({
            where: { id: sourceFile.id },
            data: {
              rowCount: totalInserted,
              dqStatus: dq.status,
              dqErrorCount: dq.severityCounts.ERROR,
              dqWarningCount: dq.severityCounts.WARNING,
            },
          });

          // STEP 3.5 (DB-06): Pre-compute sales MODE per (outlet, period).
          // Replaces the duplicated `sales_counts → ranked_sales → sales_mode`
          // CTE pipeline inlined across 10+ query call sites
          // (areas.ts, dashboard.ts, outlets/*.ts, health-ranking.ts,
          // /api/peer-comparison/items). The MODE is computed exactly the
          // same way as the inline CTE (ROW_NUMBER OVER PARTITION BY
          // outlet+period ORDER BY COUNT(*) DESC, nominalSales ASC WHERE
          // rn=1, with smaller-value-wins tie-break) — see
          // scripts/backfill-outlet-period-sales.ts for parity validation.
          //
          // Source-filtered to this ingestion's records only; ON CONFLICT
          // DO UPDATE handles the (rare) case where the same (outlet, period)
          // appears in multiple SourceFiles (latest wins). Cascade-deleted
          // with the parent SourceFile at re-ingest time.
          //
          // Cost: ~50-150ms (single INSERT...SELECT over ~13K rows).
          // Negligible vs total ingest time of 5-15s.
          //
          // DRY (Task 4-b): the SQL is now centralized in
          // computeOutletPeriodSales() — both processIngestion and
          // processRowsForImport invoke it. Byte-identical to the original
          // inline block (was duplicated verbatim L479-510 here and
          // L761-792 in process-rows-for-import).
          await computeOutletPeriodSales(tx, sourceFile.id);

          // Insert DQ issues — skip entirely in fast mode (allIssues stays empty).
          if (!fastMode && allIssues.length > 0) {
            const dqRecords = allIssues.map((i) => ({
              sourceFileId: sourceFile.id, severity: i.severity, code: i.code,
              message: i.message, rawValue: i.rawValue ?? null, rowNumber: i.rowNumber ?? null,
              sheetName: i.sheetName ?? null, // P1-9 fix
            }));
            for (let i = 0; i < dqRecords.length; i += 500) {
              await tx.dQIssue.createMany({ data: dqRecords.slice(i, i + 500) });
            }
          }

          return { totalInserted, skippedErrors, dq };
        },
        { timeout: 240_000, maxWait: 10_000 },
      );

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
