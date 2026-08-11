// ============================================================
//  /api/import-drive — Import Excel/CSV from Google Drive URL
//  ----------------------------------------------------------
//  Pipeline:
//    1. Download file(s) from Google Drive (folder/file/sheets)
//    2. For each downloaded file → use SAME ingestion logic as /api/ingest
//       (Excel → CSV conversion → streaming parse → batch insert)
//
//  This route delegates to /api/ingest's logic to avoid duplication.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { importFromDriveUrl } from '@/lib/drive-import';
import { hashFile, parseMonthFromFilename } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ } from '@/engine/validator';
import { convertExcelToCsv, getCachedCsvPath, csvCacheExists } from '@/lib/excel-to-csv';
import { parseCsvStream } from '@/lib/csv-parser';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';

export const dynamic = 'force-dynamic';

// Vercel: /tmp is the only writable directory in serverless
// Local: use data/inventory folder
const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : process.env.VERCEL
    ? '/tmp/inventory'
    : path.resolve(process.cwd(), 'data/inventory');

// ============================================================
//  Ingest a single file (Excel or CSV) using streaming pipeline
//  Same logic as /api/ingest but for a single file
// ============================================================
async function ingestFile(filePath: string): Promise<{
  fileName: string;
  status: 'INGESTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqStatus: string;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
}> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  try {
    const fileHash = await hashFile(filePath);

    // Check if already ingested
    const existing = await db.sourceFile.findUnique({
      where: { fileHash },
      select: { id: true, rowCount: true },
    });
    if (existing) {
      const actualCount = await db.inventoryRecord.count({ where: { sourceFileId: existing.id } });
      if (actualCount > 0) {
        return { fileName, status: 'SKIPPED', rowCount: actualCount, dqStatus: 'OK', dqErrors: 0, dqWarnings: 0 };
      }
      // Clean up stale stub
      await db.dQIssue.deleteMany({ where: { sourceFileId: existing.id } });
      await db.inventoryRecord.deleteMany({ where: { sourceFileId: existing.id } });
      await db.week.deleteMany({ where: { sourceFileId: existing.id } });
      await db.sourceFile.delete({ where: { id: existing.id } });
    }

    // ===== Convert Excel → CSV if needed =====
    let csvPath: string;
    const isExcel = ext === '.xlsx';

    if (isExcel) {
      const cachedCsv = getCachedCsvPath(filePath, fileHash);
      if (csvCacheExists(cachedCsv)) {
        csvPath = cachedCsv;
      } else {
        csvPath = cachedCsv;
        const tmpPath = csvPath + '.tmp';
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

    // Create SourceFile
    const sourceFile = await db.sourceFile.create({
      data: { fileName, filePath, monthLabel, monthKey, fileHash, rowCount: 0, dqStatus: 'OK' },
    });

    // Stream parse CSV → validate → normalize → insert
    const seenKeys = new Set<string>();
    const dedupSet = new Set<string>(); // global dedup across all batches
    const allIssues: any[] = [];
    const weekDbMap = new Map<string, number>();
    const outletDbMap = new Map<string, number>();
    const itemDbMap = new Map<string, number>();
    const BATCH_SIZE = 500;
    let batchRecords: any[] = [];
    let totalInserted = 0;
    let totalRows = 0;

    for await (const rawRow of parseCsvStream(csvPath)) {
      totalRows++;
      const rowNumber = totalRows + 1;
      const issues = validateRow(rawRow, rowNumber, seenKeys);
      allIssues.push(...issues);
      const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel);
      const derived = deriveRecord(n);

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

      if (derived.outletCode && !outletDbMap.has(derived.outletCode)) {
        const existingOutlet = await db.outlet.findUnique({ where: { code: derived.outletCode }, select: { id: true } });
        if (existingOutlet) outletDbMap.set(derived.outletCode, existingOutlet.id);
        else {
          const created = await db.outlet.create({ data: { code: derived.outletCode, name: derived.outletName, outletCode: derived.outletNumericCode, area: n.area } });
          outletDbMap.set(derived.outletCode, created.id);
        }
      }

      if (n.namaBahan && !itemDbMap.has(n.namaBahan)) {
        const existingItem = await db.item.findUnique({ where: { name: n.namaBahan }, select: { id: true, satuan: true } });
        if (existingItem) {
          itemDbMap.set(n.namaBahan, existingItem.id);
          if (!existingItem.satuan && n.satuan) await db.item.update({ where: { id: existingItem.id }, data: { satuan: n.satuan } });
        } else {
          const created = await db.item.create({ data: { name: n.namaBahan, satuan: n.satuan } });
          itemDbMap.set(n.namaBahan, created.id);
        }
      }

      const weekId = weekDbMap.get(wk) ?? 0;
      const outletId = outletDbMap.get(derived.outletCode) ?? 0;
      const itemId = itemDbMap.get(n.namaBahan) ?? 0;

      if (weekId > 0 && outletId > 0 && itemId > 0) {
        // Global dedup by natural key — skip if already seen (first occurrence wins)
        const dedupKey = `${weekId}|${outletId}|${itemId}|${n.akunPenyesuaian || ''}`;
        if (dedupSet.has(dedupKey)) {
          // Skip duplicate — already in batch or already inserted
          continue;
        }
        dedupSet.add(dedupKey);

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
        batchRecords = [];
        // NOTE: Do NOT clear dedupMap — duplicates can span across batches
      }
    }

    // Insert remaining records
    if (batchRecords.length > 0) {
      await db.inventoryRecord.createMany({ data: batchRecords });
      totalInserted += batchRecords.length;
    }

    const dq = summarizeDQ(allIssues);
    await db.sourceFile.update({
      where: { id: sourceFile.id },
      data: { rowCount: totalInserted, dqStatus: dq.status, dqErrorCount: dq.severityCounts.ERROR, dqWarningCount: dq.severityCounts.WARNING },
    });

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
      data: { action: 'INGEST', detail: `Drive import: ${fileName} → CSV: ${totalInserted} rows` },
    });

    return { fileName, status: 'INGESTED', rowCount: totalInserted, dqStatus: dq.status, dqErrors: dq.severityCounts.ERROR, dqWarnings: dq.severityCounts.WARNING };
  } catch (e: any) {
    return { fileName, status: 'ERROR', rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: e?.message || String(e) };
  }
}

export const maxDuration = 300; // 5 minutes for Railway

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const url = body.url;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing "url" field in request body' }, { status: 400 });
    }

    // Bug 2 fix: SSRF protection — only allow Google Drive / Google Sheets URLs
    const ALLOWED_DOMAINS = [
      'drive.google.com',
      'docs.google.com',
      'drive.usercontent.google.com',
    ];
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ success: false, error: 'URL tidak valid' }, { status: 400 });
    }
    const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
    if (!isAllowed) {
      console.error('[import-drive] SSRF blocked:', parsedUrl.hostname);
      return NextResponse.json({
        success: false,
        error: `URL harus dari Google Drive atau Google Sheets. Domain "${parsedUrl.hostname}" tidak diizinkan.`,
      }, { status: 403 });
    }

    // Step 1: Download files from Google Drive
    let importResult;
    try {
      importResult = await importFromDriveUrl(url, DATA_DIR);
    } catch (downloadErr: any) {
      return NextResponse.json({
        success: false,
        error: `Gagal download dari Google Drive: ${downloadErr?.message || String(downloadErr)}`,
      }, { status: 500 });
    }

    const successful = importResult.downloadedFiles.filter((f) => f.success);
    const failed = importResult.downloadedFiles.filter((f) => !f.success);

    if (successful.length === 0) {
      // Build detailed error message
      const failedDetails = failed.map(f => `${f.fileName}: ${f.error || 'unknown error'}`).join('; ');
      return NextResponse.json({
        success: false,
        error: `No files could be downloaded. Pastikan link share diset "Anyone with link can view". Detail: ${failedDetails}`,
        downloadResults: importResult.downloadedFiles,
      }, { status: 400 });
    }

    // Step 2: Ingest each file using streaming CSV pipeline
    const ingestResults = [];
    for (const file of successful) {
      const result = await ingestFile(file.localPath);
      ingestResults.push(result);
    }

    return NextResponse.json({
      success: true,
      folderId: importResult.folderId,
      downloadSummary: {
        total: importResult.downloadedFiles.length,
        success: successful.length,
        failed: failed.length,
        failedDetails: failed,
      },
      ingestResults,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
