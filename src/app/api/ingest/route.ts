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
    let files: string[] = [];

    if (body.filePath) {
      files = [body.filePath];
    } else if (body.dir) {
      files = await findExcelFiles(body.dir);
    } else if (body.fileName) {
      files = [path.join(DATA_DIR, body.fileName)];
    } else {
      files = await findExcelFiles();
    }

    if (files.length === 0) {
      return NextResponse.json({
        success: false,
        message: `No .xlsx or .csv files found in ${DATA_DIR}.`,
      }, { status: 404 });
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
      try {
        const ext = path.extname(filePath).toLowerCase();
        const fileName = path.basename(filePath);

        // Compute file hash
        const fileHash = await hashFile(filePath);

        // Check if already ingested
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
          // Clean up stale stub
          await db.dQIssue.deleteMany({ where: { sourceFileId: existing.id } });
          await db.inventoryRecord.deleteMany({ where: { sourceFileId: existing.id } });
          await db.week.deleteMany({ where: { sourceFileId: existing.id } });
          await db.sourceFile.delete({ where: { id: existing.id } });
        }

        // ===== STEP 1: Convert Excel → CSV (if .xlsx) =====
        let csvPath: string;
        let isExcel = ext === '.xlsx';

        if (isExcel) {
          // Check for cached CSV (from previous conversion)
          const cachedCsv = getCachedCsvPath(filePath, fileHash);
          if (csvCacheExists(cachedCsv)) {
            csvPath = cachedCsv;
          } else {
            // Convert Excel → CSV
            csvPath = cachedCsv;
            // Write to temp file first, rename on success
            const tmpPath = csvPath + '.tmp';
            // Create empty file first (appendFileSync needs existing file)
            const { createWriteStream } = await import('fs');
            const ws = createWriteStream(tmpPath);
            ws.close();
            await new Promise(resolve => ws.on('close', resolve));

            try {
              await convertExcelToCsv(filePath, tmpPath);
              // Rename tmp → final
              await fs.rename(tmpPath, csvPath);
            } catch (e) {
              // Clean up tmp file on error
              try { await fs.unlink(tmpPath); } catch {}
              throw e;
            }
          }
        } else {
          // Already CSV
          csvPath = filePath;
        }

        // Parse month from filename
        const monthInfo = parseMonthFromFilename(fileName);
        const monthLabel = monthInfo?.monthLabel || fileName.replace(/\.(xlsx|csv)$/i, '');
        const monthKey = monthInfo?.monthKey || 'unknown';

        // ===== STEP 2: Create SourceFile record =====
        const sourceFile = await db.sourceFile.create({
          data: {
            fileName, filePath,
            monthLabel, monthKey, fileHash,
            rowCount: 0, dqStatus: 'OK',
          },
        });

        // ===== STEP 3: Stream parse CSV → validate → normalize → insert =====
        // Process row by row to keep memory low
        const seenKeys = new Set<string>();
        const allIssues: any[] = [];

        // Maps for weeks/outlets/items (built lazily as we encounter them)
        const weekDbMap = new Map<string, number>();
        const outletDbMap = new Map<string, number>();
        const itemDbMap = new Map<string, number>();

        // Batch insert buffer
        const BATCH_SIZE = 500;
        let batchRecords: any[] = [];
        let totalInserted = 0;
        let totalRows = 0;

        for await (const rawRow of parseCsvStream(csvPath)) {
          totalRows++;
          const rowNumber = totalRows + 1;

          // Validate
          const issues = validateRow(rawRow, rowNumber, seenKeys);
          allIssues.push(...issues);

          // Normalize
          const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel);
          const derived = deriveRecord(n);

          // Ensure week exists
          const wk = n.weekLabel || 'UNKNOWN';
          if (!weekDbMap.has(wk)) {
            const periods: Record<string, { start: number; end: number }> = {
              'WEEK 1': { start: 1, end: 7 }, 'WEEK 2': { start: 8, end: 14 }, 'WEEK 3': { start: 15, end: 31 },
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

          // Batch insert when buffer is full
          if (batchRecords.length >= BATCH_SIZE) {
            await db.inventoryRecord.createMany({ data: batchRecords });
            totalInserted += batchRecords.length;
            batchRecords = []; // clear buffer, let GC collect
          }
        }

        // Insert remaining records
        if (batchRecords.length > 0) {
          await db.inventoryRecord.createMany({ data: batchRecords });
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
            detail: `${fileName} → CSV (${isExcel ? 'converted' : 'direct'}): ${totalInserted} rows`,
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
      }
    }

    return NextResponse.json({ success: true, results, durationMs: Date.now() - startedAt });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function GET() {
  return POST({ json: async () => ({}) } as NextRequest);
}
