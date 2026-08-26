// ============================================================
//  Shared ingestion logic — extracted from ingest/route.ts
//  Bug #6 fix: remove duplication between ingest & import-drive routes
//
//  Both routes now call this shared function instead of duplicating ~250 lines.
// ============================================================
import { logger } from './logger';
import { db } from '@/lib/db';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ } from '@/engine/validator';
import { parseOutletCode } from '@/lib/outlet';
import { convertExcelToCsv, getCachedCsvPath, csvCacheExists } from '@/lib/excel-to-csv';
import { parseCsvStream } from '@/lib/csv-parser';
import { hashFile } from '@/lib/excel';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export interface IngestResult {
  fileName: string;
  status: 'INGESTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqStatus: string;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
}

// Vercel: /tmp is the only writable directory in serverless
// Local: use data/inventory folder
export const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : process.env.VERCEL
    ? '/tmp/inventory'
    : path.resolve(process.cwd(), 'data/inventory');

// Bug 1 fix: Path Traversal protection
export function safePath(inputPath: string): string | null {
  const resolved = path.resolve(inputPath);
  const dataDirResolved = path.resolve(DATA_DIR);
  if (resolved.startsWith(dataDirResolved + path.sep) || resolved === dataDirResolved) {
    return resolved;
  }
  if (process.env.VERCEL) {
    // FIX (AUDIT-SECURITY-PERF H3): was `resolved.startsWith('/tmp/')` — too broad,
    // attacker could access ANY file under /tmp/. Restrict to allowed subdirs only.
    const ALLOWED_TMP_SUBDIRS = ['/tmp/inventory/', '/tmp/ingest-process/'];
    if (ALLOWED_TMP_SUBDIRS.some(d => resolved.startsWith(d))) {
      return resolved;
    }
  }
  if (inputPath.includes('..') || inputPath.startsWith('~') || path.isAbsolute(inputPath) && !resolved.startsWith(dataDirResolved)) {
    logger.error("[ingest] Path traversal blocked", { error: inputPath });
    return null;
  }
  return path.join(dataDirResolved, inputPath);
}

// Bug 3 fix: Race condition — in-process lock
const ingestionLocks = new Set<string>();
function acquireIngestionLock(key: string): boolean {
  if (ingestionLocks.has(key)) return false;
  ingestionLocks.add(key);
  return true;
}
function releaseIngestionLock(key: string): void {
  ingestionLocks.delete(key);
}

export async function findExcelFiles(dirOverride?: string): Promise<string[]> {
  const dir = dirOverride || DATA_DIR;
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.csv')) && !f.startsWith('~$'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ============================================================
//  processIngestion — shared business logic
//  Bug 1 fix: skip rows with ERROR severity
//  Bug 3 fix: dedup by monthLabel (delete old SourceFile for same period)
//  Bug 3 fix: race condition lock per file
// ============================================================
export async function processIngestion(body: any, fastMode?: boolean): Promise<IngestResult[]> {
  const startedAt = Date.now();
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
      const existingPeriodFiles = monthKey !== 'unknown'
        ? await db.sourceFile.findMany({
            where: { monthKey },
            select: { id: true, fileName: true },
          })
        : await db.sourceFile.findMany({
            where: { monthLabel },
            select: { id: true, fileName: true },
          });
      if (existingPeriodFiles.length > 0) {
        await db.$transaction(
          existingPeriodFiles.flatMap(oldFile => [
            db.dQIssue.deleteMany({ where: { sourceFileId: oldFile.id } }),
            db.inventoryRecord.deleteMany({ where: { sourceFileId: oldFile.id } }),
            db.week.deleteMany({ where: { sourceFileId: oldFile.id } }),
            db.sourceFile.delete({ where: { id: oldFile.id } }),
          ])
        );
      }

      // STEP 2: Create SourceFile record
      const sourceFile = await db.sourceFile.create({
        data: {
          fileName, filePath,
          monthLabel, monthKey, fileHash,
          rowCount: 0, dqStatus: 'OK',
        },
      });

      // STEP 3: Pre-cache ALL outlets & items (avoid per-row DB queries — 50% faster)
      const allOutlets = await db.outlet.findMany({ select: { id: true, code: true } });
      const allItems = await db.item.findMany({ select: { id: true, name: true, satuan: true } });
      const outletDbMap = new Map<string, number>(allOutlets.map(o => [o.code, o.id]));
      const itemDbMap = new Map<string, { id: number; satuan: string | null }>(allItems.map(i => [i.name, { id: i.id, satuan: i.satuan }]));

      const seenKeys = new Set<string>();
      const allIssues: any[] = [];
      const weekDbMap = new Map<string, number>();

      const BATCH_SIZE = 2000;
      let batchRecords: any[] = [];
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
          const issues = validateRow(rawRow, rowNumber, seenKeys, (rawRow as any)._sheetName, body.numberLocale || 'auto');
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
          const w = await db.week.upsert({
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
          const outlet = await db.outlet.upsert({
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
          const item = await db.item.upsert({
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
            result = await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
          } catch {
            // SQLite fallback: insert one by one, skip duplicates manually
            let count = 0;
            for (const rec of batchRecords) {
              try { await db.inventoryRecord.create({ data: rec }); count++; } catch {}
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
          result2 = await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
        } catch {
          let count = 0;
          for (const rec of batchRecords) {
            try { await db.inventoryRecord.create({ data: rec }); count++; } catch {}
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
      await db.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          rowCount: totalInserted,
          dqStatus: dq.status,
          dqErrorCount: dq.severityCounts.ERROR,
          dqWarningCount: dq.severityCounts.WARNING,
        },
      });

      // Insert DQ issues — skip entirely in fast mode (allIssues stays empty).
      if (!fastMode && allIssues.length > 0) {
        const dqRecords = allIssues.map((i) => ({
          sourceFileId: sourceFile.id, severity: i.severity, code: i.code,
          message: i.message, rawValue: i.rawValue ?? null, rowNumber: i.rowNumber ?? null,
          sheetName: (i as any).sheetName ?? null, // P1-9 fix
        }));
        for (let i = 0; i < dqRecords.length; i += 500) {
          await db.dQIssue.createMany({ data: dqRecords.slice(i, i + 500) });
        }
      }

      await db.auditLog.create({
        data: {
          action: 'INGEST',
          detail: `${fileName} → ${ext === '.xlsx' ? 'Excel direct' : 'CSV'}: ${totalInserted} rows (${skippedErrors} skipped due to ERROR)${fastMode ? ' [FAST MODE]' : ''}`,
          duration: Date.now() - startedAt,
        },
      });

      // Phase 3: invalidate analysis cache when new data is ingested
      // BUG FIX (BUG-NORECORDS-3): clear statusCache so dropdown shows new months immediately.
      // Previously statusCache had 5-min TTL → user couldn't see newly imported months for 5 min.
      statusCache.clear();
      // FIX Medium #1: invalidate DB-level AggregationCache for analysis route.
      // New data means all cached analysis results are stale.
      invalidateAnalysisCache().catch((e) => logger.error("[cache] invalidate failed", { error: e instanceof Error ? e.message : String(e) }));
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

// ============================================================
//  P2 fix: Shared row-processing function for ImportService unification.
//  Both processIngestion (full file) and ingest-process (per-week) call this.
//  Eliminates ~150 lines of duplicate logic between the two ingestion paths.
// ============================================================

export interface ProcessRowsResult {
  inserted: number;
  skippedErrors: number;
  dqIssues: any[];
}

/**
 * Process rows for import — shared logic for both full-file and per-week ingestion.
 *
 * Takes raw rows, validates + normalizes + derives + ensures outlet/item exists,
 * batch inserts InventoryRecords, returns insertion count + DQ issues.
 *
 * @param rows - Raw rows from Excel/CSV parse
 * @param sourceFileId - SourceFile.id for this import
 * @param weekId - Week.id for these rows
 * @param fileName - Original filename (for normalizeRow)
 * @param monthLabel - Month label (e.g., "MEI 2026")
 * @param startRowNumber - Row number offset (for multi-week imports)
 * @param outletDbMap - Pre-populated outlet cache (code → id)
 * @param itemDbMap - Pre-populated item cache (name → {id, satuan})
 * @param seenKeys - Set of seen (outlet+item+week) keys for dedup
 * @param fastMode - When true, skip validateRow() + DQ issue tracking (pure import, ~3-5x faster)
 * @returns { inserted, skippedErrors, dqIssues }
 */
export async function processRowsForImport(
  rows: Array<Record<string, unknown> & { _sheetName?: string }>,
  sourceFileId: number,
  weekId: number,
  fileName: string,
  monthLabel: string,
  startRowNumber: number = 0,
  outletDbMap?: Map<string, number>,
  itemDbMap?: Map<string, { id: number; satuan: string | null }>,
  seenKeys?: Set<string>,
  fastMode?: boolean,
  numberLocale?: 'auto' | 'id' | 'us',
): Promise<ProcessRowsResult> {
  const _outletDbMap = outletDbMap ?? new Map<string, number>();
  const _itemDbMap = itemDbMap ?? new Map<string, { id: number; satuan: string | null }>();
  const _seenKeys = seenKeys ?? new Set<string>();
  const allIssues: any[] = [];
  const BATCH_SIZE = 500;
  let batchRecords: any[] = [];
  let inserted = 0;
  let skippedErrors = 0;

  for (let i = 0; i < rows.length; i++) {
    const rawRow = rows[i];
    const rowNumber = startRowNumber + i + 1;

    // FAST MODE: skip validateRow() entirely — pure normalize + derive + insert.
    // Validation can be run separately later via /api/dq-check (or similar).
    // ~3-5x faster because validateRow() is the bottleneck for large files.
    if (!fastMode) {
      const issues = validateRow(rawRow, rowNumber, _seenKeys, (rawRow as any)._sheetName, numberLocale || 'auto');
      allIssues.push(...issues);

      const hasError = issues.some((iss) => iss.severity === 'ERROR');
      if (hasError) {
        skippedErrors++;
        continue;
      }
    }

    const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel, numberLocale || 'auto');
    const derived = deriveRecord(n);

    // FIX-A-4 (BUG-5-5): Race-safe outlet creation — use upsert instead of
    // findUnique + create. Two concurrent imports of different weeks for the
    // same NEW outlet code previously raced: both findUnique miss → both create →
    // P2002 unique constraint violation → entire week import fails.
    // Upsert is atomic: if the row exists, update area/name if changed; if not,
    // create it. Either way, no P2002.
    if (derived.outletCode && !_outletDbMap.has(derived.outletCode)) {
      const outlet = await db.outlet.upsert({
        where: { code: derived.outletCode },
        // LOGIC-12 fix: update area + name if outlet moved to different area.
        update: n.area ? { area: n.area, name: derived.outletName } : {},
        create: {
          code: derived.outletCode,
          name: derived.outletName,
          outletCode: derived.outletNumericCode,
          area: n.area,
        },
        select: { id: true },
      });
      _outletDbMap.set(derived.outletCode, outlet.id);
    }

    // FIX-A-4 (BUG-5-5): Race-safe item creation — use upsert instead of
    // findUnique + create to handle concurrent imports of the same new item.
    // Preserves the original behavior of back-filling `satuan` on existing items
    // when the DB row has null satuan and the current row provides one.
    if (n.namaBahan && !_itemDbMap.has(n.namaBahan)) {
      const item = await db.item.upsert({
        where: { name: n.namaBahan },
        // If existing item has no satuan, fill it from the current row.
        // (Prisma returns the row AFTER the upsert, so the returned satuan is the
        // post-update value — either the newly-filled one or the pre-existing one.)
        update: n.satuan ? { satuan: n.satuan } : {},
        create: { name: n.namaBahan, satuan: n.satuan },
        select: { id: true, satuan: true },
      });
      _itemDbMap.set(n.namaBahan, { id: item.id, satuan: item.satuan });
    }

    const outletId = _outletDbMap.get(derived.outletCode) ?? 0;
    const itemEntry = _itemDbMap.get(n.namaBahan);
    const itemId = itemEntry?.id ?? 0;

    if (weekId > 0 && outletId > 0 && itemId > 0) {
      batchRecords.push({
        sourceFileId, weekId, outletId, itemId,
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

    if (batchRecords.length >= BATCH_SIZE) {
      // FIX DB2-2: skipDuplicates is PostgreSQL-only — try/catch fallback for SQLite
      let result;
      try {
        result = await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
      } catch {
        let count = 0;
        for (const rec of batchRecords) {
          try { await db.inventoryRecord.create({ data: rec }); count++; } catch {}
        }
        result = { count };
      }
      inserted += result.count;
      batchRecords = [];
    }
  }

  if (batchRecords.length > 0) {
    let result2;
    try {
      result2 = await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
    } catch {
      let count = 0;
      for (const rec of batchRecords) {
        try { await db.inventoryRecord.create({ data: rec }); count++; } catch {}
      }
      result2 = { count };
    }
    inserted += result2.count;
  }

  return { inserted, skippedErrors, dqIssues: allIssues };
}
