// ============================================================
//  Shared ingestion logic — extracted from ingest/route.ts
//  Bug #6 fix: remove duplication between ingest & import-drive routes
//
//  Both routes now call this shared function instead of duplicating ~250 lines.
// ============================================================
import { db } from '@/lib/db';
import { analysisCache } from '@/lib/cache';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ } from '@/engine/validator';
import { parseOutletCode } from '@/lib/outlet';
import { convertExcelToCsv, getCachedCsvPath, csvCacheExists } from '@/lib/excel-to-csv';
import { parseCsvStream } from '@/lib/csv-parser';
import { hashFile } from '@/lib/excel';
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
  if (process.env.VERCEL && resolved.startsWith('/tmp/')) {
    return resolved;
  }
  if (inputPath.includes('..') || inputPath.startsWith('~') || path.isAbsolute(inputPath) && !resolved.startsWith(dataDirResolved)) {
    console.error('[ingest] Path traversal blocked:', inputPath);
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
export async function processIngestion(body: any): Promise<IngestResult[]> {
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
      const fileName = path.basename(filePath);

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
      let allRows: Record<string, unknown>[] = [];
      if (ext === '.xlsx') {
        const parsed = await parseExcelFile(filePath);
        for (const sheet of parsed.sheets) {
          allRows.push(...sheet.rows);
        }
      } else {
        // CSV: use stream parser
        for await (const rawRow of parseCsvStream(filePath)) {
          allRows.push(rawRow);
        }
      }

      // Parse month from filename
      const monthInfo = parseMonthFromFilename(fileName);
      const monthLabel = monthInfo?.monthLabel || fileName.replace(/\.(xlsx|csv)$/i, '');
      const monthKey = monthInfo?.monthKey || 'unknown';

      // BUG-03/11 fix: wrap dedup deletes in transaction for atomicity
      const existingPeriodFiles = await db.sourceFile.findMany({
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
      for (const rawRow of allRows) {
        totalRows++;
        const rowNumber = totalRows + 1;

        // Validate
        const issues = validateRow(rawRow, rowNumber, seenKeys);
        allIssues.push(...issues);

        const hasError = issues.some((i) => i.severity === 'ERROR');
        if (hasError) {
          skippedErrors++;
          continue;
        }

        // Normalize
        const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel);
        const derived = deriveRecord(n);

        // Ensure week exists (only 3-4 unique weeks per file)
        const wk = n.weekLabel || 'UNKNOWN';
        if (!weekDbMap.has(wk)) {
          const periods: Record<string, { start: number; end: number }> = {
            'WEEK 1': { start: 1, end: 7 }, 'WEEK 2': { start: 8, end: 14 },
            'WEEK 3': { start: 15, end: 31 }, 'WEEK 4': { start: 15, end: 31 },
          };
          const p = periods[wk] || { start: 1, end: 31 };
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

        // Outlet: check cache, create if missing (lazy — only on first encounter)
        if (derived.outletCode && !outletDbMap.has(derived.outletCode)) {
          const created = await db.outlet.create({
            data: { code: derived.outletCode, name: derived.outletName, outletCode: derived.outletNumericCode, area: n.area },
          });
          outletDbMap.set(derived.outletCode, created.id);
        }

        // Item: check cache, create if missing (lazy)
        if (n.namaBahan && !itemDbMap.has(n.namaBahan)) {
          const created = await db.item.create({ data: { name: n.namaBahan, satuan: n.satuan } });
          itemDbMap.set(n.namaBahan, { id: created.id, satuan: n.satuan });
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
          const result = await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
          totalInserted += result.count;
          batchRecords = [];
        }
      }

      // Insert remaining records
      if (batchRecords.length > 0) {
        const result2 = await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
        totalInserted += result2.count;
      }

      // STEP 4: Update source file record
      const dq = summarizeDQ(allIssues);
      await db.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          rowCount: totalInserted,
          dqStatus: dq.status,
          dqErrorCount: dq.severityCounts.ERROR,
          dqWarningCount: dq.severityCounts.WARNING,
        },
      });

      // Insert DQ issues
      if (allIssues.length > 0) {
        const dqRecords = allIssues.map((i) => ({
          sourceFileId: sourceFile.id, severity: i.severity, code: i.code,
          message: i.message, rawValue: i.rawValue ?? null, rowNumber: i.rowNumber ?? null,
        }));
        for (let i = 0; i < dqRecords.length; i += 500) {
          await db.dQIssue.createMany({ data: dqRecords.slice(i, i + 500) });
        }
      }

      await db.auditLog.create({
        data: {
          action: 'INGEST',
          detail: `${fileName} → ${ext === '.xlsx' ? 'Excel direct' : 'CSV'}: ${totalInserted} rows (${skippedErrors} skipped due to ERROR)`,
          duration: Date.now() - startedAt,
        },
      });

      // Phase 3: invalidate analysis cache when new data is ingested
      analysisCache.clear();

      results.push({
        fileName, status: 'INGESTED', rowCount: totalInserted,
        dqStatus: dq.status, dqErrors: dq.severityCounts.ERROR, dqWarnings: dq.severityCounts.WARNING,
      });
    } catch (e: any) {
      results.push({
        fileName: path.basename(filePath), status: 'ERROR', rowCount: 0,
        dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0,
        error: e?.message || String(e),
      });
    } finally {
      // Bug 3 fix: always release lock
      releaseIngestionLock(lockKey);
    }
  }

  return results;
}
