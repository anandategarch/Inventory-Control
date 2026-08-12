// ============================================================
//  /api/ingest-upload — Upload Excel file from computer
//  - Accepts multipart/form-data (file up to 50MB)
//  - Parses filename to detect month (Wajib format: "17.MEI 2026.xlsx")
//  - Parses Excel, detects weeks in file
//  - Checks DB: which weeks already exist for this month?
//  - Imports ONLY missing weeks (partial commit per week)
//  - Returns detailed results per week
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
import { createHash } from 'crypto';

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
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // Rate limiting
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-upload:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit sebelum upload lagi.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'File tidak ditemukan. Pilih file Excel (.xlsx) terlebih dahulu.' },
        { status: 400 }
      );
    }

    // Validate file type
    const fileName = file.name;
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.csv') {
      return NextResponse.json(
        { success: false, error: `Format file tidak didukung: ${ext}. Hanya .xlsx dan .csv.` },
        { status: 400 }
      );
    }

    // Validate file size (50MB max)
    const MAX_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: `File terlalu besar: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maksimal 50MB.` },
        { status: 400 }
      );
    }

    // Validate filename format (Wajib: "17.MEI 2026.xlsx" or "MEI 2026.xlsx")
    const monthInfo = parseMonthFromFilename(fileName);
    if (!monthInfo) {
      return NextResponse.json(
        {
          success: false,
          error: `Nama file tidak sesuai format. Contoh valid: "17.MEI 2026.xlsx", "JULI 2026.xlsx", "13.JAN 26.xlsx". Nama file Anda: "${fileName}"`,
        },
        { status: 400 }
      );
    }

    // Save to /tmp
    const tmpDir = '/tmp/ingest-upload';
    if (!existsSync(tmpDir)) {
      await fs.mkdir(tmpDir, { recursive: true });
    }
    const fileHash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
    const tmpPath = path.join(tmpDir, `${fileHash}${ext}`);
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tmpPath, fileBuffer);

    // Parse Excel to detect weeks
    const parsed = await parseExcelFile(tmpPath);
    const weeksInFileSet = new Set<string>();
    for (const sheet of parsed.sheets) {
      for (const row of sheet.rows) {
        const wk = String(row.weekLabel ?? '').trim().toUpperCase();
        if (wk) weeksInFileSet.add(wk);
      }
    }
    const weeksInFile = [...weeksInFileSet].sort();

    if (weeksInFile.length === 0) {
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
      // All weeks already exist
      await fs.unlink(tmpPath).catch(() => {});
      return NextResponse.json({
        success: true,
        result: {
          fileName,
          monthLabel: monthInfo.monthLabel,
          monthKey: monthInfo.monthKey,
          fileSize: file.size,
          fileHash,
          weeksInFile,
          existingWeeks,
          importedWeeks: [],
          totalInserted: 0,
          totalSkipped: weeksInFile.length,
          durationMs: Date.now() - startedAt,
          message: `Semua week (${weeksInFile.join(', ')}) sudah ada di database untuk ${monthInfo.monthLabel}. Tidak ada yang diimport.`,
        } as UploadResult,
      });
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
            filePath: tmpPath,
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
        let skippedErrors = 0;

        for (let i = 0; i < weekRows.length; i++) {
          const rawRow = weekRows[i];
          const rowNumber = i + 1;

          // Validate
          const issues = validateRow(rawRow, rowNumber, seenKeys);
          allIssues.push(...issues);

          const hasError = issues.some((iss) => iss.severity === 'ERROR');
          if (hasError) {
            skippedErrors++;
            continue;
          }

          // Normalize
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

          // Prepare record
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

        // Insert remaining
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
        // Partial commit: continue to next week even if this one failed
      }
    }

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'INGEST_UPLOAD',
        detail: `${fileName} (${(file.size / 1024 / 1024).toFixed(1)}MB) → ${monthInfo.monthLabel}: imported ${weeksToImport.join(', ')} | ${totalInserted} rows`,
        duration: Date.now() - startedAt,
      },
    });

    // Invalidate analysis cache
    analysisCache.clear();

    // Cleanup temp file
    await fs.unlink(tmpPath).catch(() => {});

    const result: UploadResult = {
      fileName,
      monthLabel: monthInfo.monthLabel,
      monthKey: monthInfo.monthKey,
      fileSize: file.size,
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
