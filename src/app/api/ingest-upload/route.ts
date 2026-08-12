// ============================================================
//  /api/ingest-upload — Chunked upload Excel file from computer
//  - Vercel body size limit: 4.5MB per request
//  - Solution: split file into 4MB chunks, upload sequentially
//  - Backend reassembles chunks, then processes file
//  - Last chunk triggers: parse Excel → detect weeks → import missing
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { analysisCache } from '@/lib/cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ } from '@/engine/validator';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WeekImportResult {
  weekLabel: string;
  status: 'IMPORTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
  durationMs: number;
}

interface UploadResult {
  fileName: string;
  monthLabel: string;
  monthKey: string;
  fileSize: number;
  fileHash: string;
  weeksInFile: string[];
  existingWeeks: string[];
  importedWeeks: WeekImportResult[];
  totalInserted: number;
  totalSkipped: number;
  durationMs: number;
  message?: string;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // Rate limiting
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-upload:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit.' },
        { status: 429 }
      );
    }

    // Parse multipart form data
    const formData = await req.formData();
    const chunk = formData.get('chunk') as File | null;
    const chunkIndexStr = formData.get('chunkIndex') as string | null;
    const totalChunksStr = formData.get('totalChunks') as string | null;
    const fileName = formData.get('fileName') as string | null;
    const fileHash = formData.get('fileHash') as string | null;
    const fileSizeStr = formData.get('fileSize') as string | null;

    if (!chunk || chunkIndexStr === null || totalChunksStr === null || !fileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields (chunk, chunkIndex, totalChunks, fileName, fileHash).' },
        { status: 400 }
      );
    }

    const chunkIndex = parseInt(chunkIndexStr);
    const totalChunks = parseInt(totalChunksStr);
    const fileSize = parseInt(fileSizeStr || '0');

    // Validate file type from fileName
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.csv') {
      return NextResponse.json(
        { success: false, error: `Format file tidak didukung: ${ext}. Hanya .xlsx dan .csv.` },
        { status: 400 }
      );
    }

    // Validate total file size (50MB max)
    if (fileSize > 50 * 1024 * 1024) {
      return NextResponse.json(
        { success: false, error: `File terlalu besar: ${(fileSize / 1024 / 1024).toFixed(1)}MB. Maksimal 50MB.` },
        { status: 400 }
      );
    }

    // Ensure tmp dir exists
    const tmpDir = '/tmp/ingest-upload';
    if (!existsSync(tmpDir)) {
      await fs.mkdir(tmpDir, { recursive: true });
    }

    // Append chunk to temp file
    const partPath = path.join(tmpDir, `${fileHash}.part`);
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());
    await fs.appendFile(partPath, chunkBuffer);

    // If not last chunk, return progress
    if (chunkIndex < totalChunks - 1) {
      return NextResponse.json({
        success: true,
        received: chunkIndex,
        totalChunks,
        progress: ((chunkIndex + 1) / totalChunks) * 100,
      });
    }

    // ============================================================
    // LAST CHUNK — reassemble and process
    // ============================================================

    // Validate filename format (Wajib: "17.MEI 2026.xlsx")
    const monthInfo = parseMonthFromFilename(fileName);
    if (!monthInfo) {
      await fs.unlink(partPath).catch(() => {});
      return NextResponse.json(
        {
          success: false,
          error: `Nama file tidak sesuai format. Contoh valid: "17.MEI 2026.xlsx", "JULI 2026.xlsx", "13.JAN 26.xlsx". Nama file Anda: "${fileName}"`,
        },
        { status: 400 }
      );
    }

    // Rename .part to final extension
    const finalPath = path.join(tmpDir, `${fileHash}${ext}`);
    await fs.rename(partPath, finalPath);

    // Verify file size
    const actualSize = (await fs.stat(finalPath)).size;
    if (actualSize !== fileSize) {
      await fs.unlink(finalPath).catch(() => {});
      return NextResponse.json(
        { success: false, error: `File size mismatch: expected ${fileSize}, got ${actualSize}. Upload corrupt.` },
        { status: 400 }
      );
    }

    // Parse Excel to detect weeks
    const parsed = await parseExcelFile(finalPath);
    const weeksInFileSet = new Set<string>();
    for (const sheet of parsed.sheets) {
      for (const row of sheet.rows) {
        const wk = String(row.weekLabel ?? '').trim().toUpperCase();
        if (wk) weeksInFileSet.add(wk);
      }
    }
    const weeksInFile = [...weeksInFileSet].sort();

    if (weeksInFile.length === 0) {
      await fs.unlink(finalPath).catch(() => {});
      return NextResponse.json(
        { success: false, error: 'Tidak ada week label (WEEK 1/2/3/4) ditemukan di file.' },
        { status: 400 }
      );
    }

    // Check DB: which weeks already exist for this month?
    const existingFiles = await db.sourceFile.findMany({
      where: { monthLabel: monthInfo.monthLabel },
      select: { id: true, fileName: true },
    });
    const existingWeeksSet = new Set<string>();
    for (const sf of existingFiles) {
      const weeks = await db.week.findMany({
        where: { sourceFileId: sf.id },
        select: { weekLabel: true },
      });
      for (const w of weeks) existingWeeksSet.add(w.weekLabel);
    }
    const existingWeeks = [...existingWeeksSet].sort();

    // Determine which weeks to import (missing ones)
    const weeksToImport = weeksInFile.filter(w => !existingWeeksSet.has(w));

    if (weeksToImport.length === 0) {
      await fs.unlink(finalPath).catch(() => {});
      const result: UploadResult = {
        fileName,
        monthLabel: monthInfo.monthLabel,
        monthKey: monthInfo.monthKey,
        fileSize,
        fileHash,
        weeksInFile,
        existingWeeks,
        importedWeeks: [],
        totalInserted: 0,
        totalSkipped: weeksInFile.length,
        durationMs: Date.now() - startedAt,
        message: `Semua week (${weeksInFile.join(', ')}) sudah ada di database untuk ${monthInfo.monthLabel}. Tidak ada yang diimport.`,
      };
      return NextResponse.json({ success: true, result });
    }

    // Import each missing week (partial commit per week)
    const importResults: WeekImportResult[] = [];
    let totalInserted = 0;

    for (const weekLabel of weeksToImport) {
      const weekStart = Date.now();
      try {
        // Collect rows for this week from all sheets
        const weekRows: Record<string, unknown>[] = [];
        for (const sheet of parsed.sheets) {
          for (const row of sheet.rows) {
            const wk = String(row.weekLabel ?? '').trim().toUpperCase();
            if (wk === weekLabel) weekRows.push(row);
          }
        }

        if (weekRows.length === 0) {
          importResults.push({
            weekLabel, status: 'SKIPPED', rowCount: 0,
            dqErrors: 0, dqWarnings: 0, durationMs: Date.now() - weekStart,
            error: 'No rows found for this week',
          });
          continue;
        }

        // Create SourceFile record for this week
        const sourceFile = await db.sourceFile.create({
          data: {
            fileName: `${fileName} [${weekLabel}]`,
            filePath: finalPath,
            monthLabel: monthInfo.monthLabel,
            monthKey: monthInfo.monthKey,
            fileHash: `${fileHash}-${weekLabel}`,
            rowCount: 0,
            dqStatus: 'OK',
          },
        });

        // Create Week record
        const periods: Record<string, { start: number; end: number }> = {
          'WEEK 1': { start: 1, end: 7 }, 'WEEK 2': { start: 8, end: 14 },
          'WEEK 3': { start: 15, end: 31 }, 'WEEK 4': { start: 15, end: 31 },
        };
        const p = periods[weekLabel] || { start: 1, end: 31 };
        const weekRec = await db.week.create({
          data: {
            sourceFileId: sourceFile.id, weekLabel,
            weekKey: `${monthInfo.monthKey}-${weekLabel.replace(/\s+/g, '')}`,
            monthKey: monthInfo.monthKey, periodStart: p.start, periodEnd: p.end,
          },
        });

        // Process rows
        const seenKeys = new Set<string>();
        const allIssues: any[] = [];
        const weekDbMap = new Map<string, number>([[weekLabel, weekRec.id]]);
        const outletDbMap = new Map<string, number>();
        const itemDbMap = new Map<string, number>();
        const BATCH_SIZE = 500;
        let batchRecords: any[] = [];
        let inserted = 0;

        for (let i = 0; i < weekRows.length; i++) {
          const rawRow = weekRows[i];
          const rowNumber = i + 1;

          const issues = validateRow(rawRow, rowNumber, seenKeys);
          allIssues.push(...issues);

          const hasError = issues.some((iss) => iss.severity === 'ERROR');
          if (hasError) continue;

          const n = normalizeRow(rawRow, fileName, rowNumber, monthInfo.monthLabel);
          const derived = deriveRecord(n);

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

          const weekId = weekDbMap.get(weekLabel) ?? 0;
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

          if (batchRecords.length >= BATCH_SIZE) {
            await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
            inserted += batchRecords.length;
            batchRecords = [];
          }
        }

        if (batchRecords.length > 0) {
          await db.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
          inserted += batchRecords.length;
        }

        // Update source file
        const dq = summarizeDQ(allIssues);
        await db.sourceFile.update({
          where: { id: sourceFile.id },
          data: {
            rowCount: inserted,
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

        totalInserted += inserted;
        importResults.push({
          weekLabel, status: 'IMPORTED', rowCount: inserted,
          dqErrors: dq.severityCounts.ERROR, dqWarnings: dq.severityCounts.WARNING,
          durationMs: Date.now() - weekStart,
        });
      } catch (e: any) {
        importResults.push({
          weekLabel, status: 'ERROR', rowCount: 0,
          dqErrors: 1, dqWarnings: 0, durationMs: Date.now() - weekStart,
          error: e?.message || String(e),
        });
      }
    }

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'INGEST_UPLOAD',
        detail: `${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB) → ${monthInfo.monthLabel}: imported ${weeksToImport.join(', ')} | ${totalInserted} rows`,
        duration: Date.now() - startedAt,
      },
    });

    analysisCache.clear();
    await fs.unlink(finalPath).catch(() => {});

    const result: UploadResult = {
      fileName,
      monthLabel: monthInfo.monthLabel,
      monthKey: monthInfo.monthKey,
      fileSize,
      fileHash,
      weeksInFile,
      existingWeeks,
      importedWeeks: importResults,
      totalInserted,
      totalSkipped: existingWeeks.length,
      durationMs: Date.now() - startedAt,
    };

    return NextResponse.json({ success: true, result });
  } catch (e: any) {
    console.error('[ingest-upload] error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
