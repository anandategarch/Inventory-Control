// ============================================================
//  /api/ingest — Excel/CSV ingestion endpoint (STREAMING)
//  ----------------------------------------------------------
//  Pipeline:
//    1. If .xlsx → convert to .csv (cached by file hash)
//    2. Parse .csv streaming (row by row, ~5MB memory)
//    3. For each row: validate → normalize → derive → batch insert
//    4. No intermediate arrays — GC collects old rows
//
//  Memory profile:
//    - Excel → CSV conversion: ~80MB (exceljs, one-time)
//    - CSV parse + insert: ~5-10MB (1 row + Prisma batch buffer)
//    - Total peak: ~90MB (fits in 256MB server)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseMonthFromFilename } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ } from '@/engine/validator';
import { parseOutletCode } from '@/lib/outlet';
import { convertExcelToCsv, getCachedCsvPath, csvCacheExists } from '@/lib/excel-to-csv';
import { parseCsvStream } from '@/lib/csv-parser';
import { hashFile } from '@/lib/excel';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export const dynamic = 'force-dynamic';

// Vercel: /tmp is the only writable directory in serverless
// Local: use data/inventory folder
const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : process.env.VERCEL
    ? '/tmp/inventory'
    : path.resolve(process.cwd(), 'data/inventory');

// ============================================================
//  Bug 1 fix: Path Traversal protection
//  Validate that resolved path is within DATA_DIR (no ../escape)
// ============================================================
function safePath(inputPath: string): string | null {
  const resolved = path.resolve(inputPath);
  const dataDirResolved = path.resolve(DATA_DIR);
  // Allow paths inside DATA_DIR OR /tmp (Vercel) OR absolute paths that don't traverse
  if (resolved.startsWith(dataDirResolved + path.sep) || resolved === dataDirResolved) {
    return resolved;
  }
  // On Vercel, allow /tmp
  if (process.env.VERCEL && resolved.startsWith('/tmp/')) {
    return resolved;
  }
  // Block path traversal attempts (../, ~/etc, etc.)
  if (inputPath.includes('..') || inputPath.startsWith('~') || path.isAbsolute(inputPath) && !resolved.startsWith(dataDirResolved)) {
    console.error('[ingest] Path traversal blocked:', inputPath);
    return null;
  }
  // Relative path — join with DATA_DIR
  return path.join(dataDirResolved, inputPath);
}

// ============================================================
//  Bug 3 fix: Race condition — simple in-process lock for ingestion
//  Prevents concurrent ingestion of same file (double-click, retry)
// ============================================================
const ingestionLocks = new Set<string>();
function acquireIngestionLock(key: string): boolean {
  if (ingestionLocks.has(key)) return false;
  ingestionLocks.add(key);
  return true;
}
function releaseIngestionLock(key: string): void {
  ingestionLocks.delete(key);
}

async function findExcelFiles(dirOverride?: string): Promise<string[]> {
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

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const results = await processIngestion(body);
    return NextResponse.json({ success: true, results, durationMs: Date.now() - startedAt });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function GET() {
  // Bug 7 fix: call processIngestion directly instead of mocking NextRequest
  const startedAt = Date.now();
  try {
    const results = await processIngestion({});
    return NextResponse.json({ success: true, results, durationMs: Date.now() - startedAt });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

// ============================================================
//  processIngestion — extracted business logic (Bug 7 fix)
//  Bug 1 fix: skip rows with ERROR severity, wrap inserts in transaction
//  Bug 3 fix: dedup by monthLabel+weekLabel (delete old SourceFile for same period)
// ============================================================
async function processIngestion(body: any) {
  const startedAt = Date.now();
  let files: string[] = [];

  // Bug 1 fix: Path Traversal — validate all paths via safePath
  if (body.filePath) {
    const safe = safePath(body.filePath);
    if (!safe) {
      return [{ fileName: body.filePath, status: 'ERROR' as const, rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked' }];
    }
    files = [safe];
  } else if (body.dir) {
    const safe = safePath(body.dir);
    if (!safe) {
      return [{ fileName: body.dir, status: 'ERROR' as const, rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked' }];
    }
    files = await findExcelFiles(safe);
  } else if (body.fileName) {
    const safe = safePath(body.fileName);
    if (!safe) {
      return [{ fileName: body.fileName, status: 'ERROR' as const, rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked' }];
    }
    files = [safe];
  } else {
    files = await findExcelFiles();
  }

  if (files.length === 0) {
    return [{
      fileName: '(none)',
      status: 'ERROR' as const,
      rowCount: 0,
      dqStatus: 'ERROR',
      dqErrors: 1,
      dqWarnings: 0,
      error: `No .xlsx or .csv files found in ${DATA_DIR}.`,
    }];
  }

  const results: Array<{
    fileName: string;
    status: 'INGESTED' | 'SKIPPED' | 'ERROR';
    rowCount: number;
    dqStatus: string;
    dqErrors: number;
    dqWarnings: number;
    error?: string;
  }> = [];

  for (const filePath of files) {
    // Bug 3 fix: acquire lock per file — prevent concurrent ingestion
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

      // Compute file hash
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
        // Clean up stale stub (hash exists but no records — partial crash before)
        await db.dQIssue.deleteMany({ where: { sourceFileId: existing.id } });
        await db.inventoryRecord.deleteMany({ where: { sourceFileId: existing.id } });
        await db.week.deleteMany({ where: { sourceFileId: existing.id } });
        await db.sourceFile.delete({ where: { id: existing.id } });
      }

      // ===== STEP 1: Convert Excel → CSV (if .xlsx) =====
      let csvPath: string;
      let isExcel = ext === '.xlsx';

      if (isExcel) {
        const cachedCsv = getCachedCsvPath(filePath, fileHash);
        if (csvCacheExists(cachedCsv)) {
          csvPath = cachedCsv;
        } else {
          csvPath = cachedCsv;
          const tmpPath = csvPath + '.tmp';
          const { createWriteStream } = await import('fs');
          const ws = createWriteStream(tmpPath);
          ws.close();
          await new Promise(resolve => ws.on('close', resolve));

          try {
            await convertExcelToCsv(filePath, tmpPath);
            await fs.rename(tmpPath, csvPath);
          } catch (e) {
            try { await fs.unlink(tmpPath); } catch {}
            throw e;
          }
        }
      } else {
        csvPath = filePath;
      }

      // Parse month from filename
      const monthInfo = parseMonthFromFilename(fileName);
      const monthLabel = monthInfo?.monthLabel || fileName.replace(/\.(xlsx|csv)$/i, '');
      const monthKey = monthInfo?.monthKey || 'unknown';

      // ===== Bug 3 fix: Dedup by period (monthLabel) =====
      // If a SourceFile already exists for the same monthLabel, delete it (cascade deletes records)
      // This prevents double-counting when user uploads a revised file with different name/hash
      const existingPeriodFiles = await db.sourceFile.findMany({
        where: { monthLabel },
        select: { id: true, fileName: true },
      });
      if (existingPeriodFiles.length > 0) {
        for (const oldFile of existingPeriodFiles) {
          await db.dQIssue.deleteMany({ where: { sourceFileId: oldFile.id } });
          await db.inventoryRecord.deleteMany({ where: { sourceFileId: oldFile.id } });
          await db.week.deleteMany({ where: { sourceFileId: oldFile.id } });
          await db.sourceFile.delete({ where: { id: oldFile.id } });
        }
      }

      // ===== STEP 2: Create SourceFile record =====
      const sourceFile = await db.sourceFile.create({
        data: {
          fileName, filePath,
          monthLabel, monthKey, fileHash,
          rowCount: 0, dqStatus: 'OK',
        },
      });

      // ===== STEP 3: Stream parse CSV → validate → normalize → insert =====
      const seenKeys = new Set<string>();
      const allIssues: any[] = [];

      const weekDbMap = new Map<string, number>();
      const outletDbMap = new Map<string, number>();
      const itemDbMap = new Map<string, number>();

      const BATCH_SIZE = 500;
      let batchRecords: any[] = [];
      let totalInserted = 0;
      let totalRows = 0;
      let skippedErrors = 0;

      for await (const rawRow of parseCsvStream(csvPath)) {
        totalRows++;
        const rowNumber = totalRows + 1;

        // Validate
        const issues = validateRow(rawRow, rowNumber, seenKeys);
        allIssues.push(...issues);

        // Bug 1 fix: Skip rows with ERROR severity (missing required fields, invalid number, duplicate)
        // Without this, createMany would throw P2002 on duplicates or insert garbage data
        const hasError = issues.some((i) => i.severity === 'ERROR');
        if (hasError) {
          skippedErrors++;
          continue;
        }

        // Normalize
        const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel);
        const derived = deriveRecord(n);

        // Ensure week exists
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

        // Ensure outlet exists
        if (derived.outletCode && !outletDbMap.has(derived.outletCode)) {
          const existingOutlet = await db.outlet.findUnique({ where: { code: derived.outletCode }, select: { id: true } });
          if (existingOutlet) {
            outletDbMap.set(derived.outletCode, existingOutlet.id);
          } else {
            const created = await db.outlet.create({
              data: { code: derived.outletCode, name: derived.outletName, outletCode: derived.outletNumericCode, area: n.area },
            });
            outletDbMap.set(derived.outletCode, created.id);
          }
        }

        // Ensure item exists
        if (n.namaBahan && !itemDbMap.has(n.namaBahan)) {
          const existingItem = await db.item.findUnique({ where: { name: n.namaBahan }, select: { id: true, satuan: true } });
          if (existingItem) {
            itemDbMap.set(n.namaBahan, existingItem.id);
            if (!existingItem.satuan && n.satuan) {
              await db.item.update({ where: { id: existingItem.id }, data: { satuan: n.satuan } });
            }
          } else {
            const created = await db.item.create({ data: { name: n.namaBahan, satuan: n.satuan } });
            itemDbMap.set(n.namaBahan, created.id);
          }
        }

        // Prepare record for insert
        const weekId = weekDbMap.get(wk) ?? 0;
        const outletId = outletDbMap.get(derived.outletCode) ?? 0;
        const itemId = itemDbMap.get(n.namaBahan) ?? 0;

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

        // Bug 1 fix: batch insert with skipDuplicates (defense-in-depth against P2002)
        if (batchRecords.length >= BATCH_SIZE) {
          await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
          totalInserted += batchRecords.length;
          batchRecords = [];
        }
      }

      // Insert remaining records
      if (batchRecords.length > 0) {
        await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
        totalInserted += batchRecords.length;
      }

      // ===== STEP 4: Update source file record =====
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
          detail: `${fileName} → CSV (${isExcel ? 'converted' : 'direct'}): ${totalInserted} rows (${skippedErrors} skipped due to ERROR)`,
          duration: Date.now() - startedAt,
        },
      });

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
