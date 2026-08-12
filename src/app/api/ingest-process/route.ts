// ============================================================
//  /api/ingest-process — Process uploaded Excel file
//  Reassembles file from DB chunks, then:
//  1. mode='detect' → parse Excel, detect weeks, return list
//  2. mode='import' → import ONE specific week (partial commit)
//  3. DELETE → cleanup chunks + temp file
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
export const maxDuration = 300; // Max for Vercel — import can take 1-2 min for large weeks

// Reassemble file from DB chunks
async function reassembleFile(fileHash: string, ext: string): Promise<string> {
  const chunks = await db.fileChunk.findMany({
    where: { fileHash },
    orderBy: { chunkIndex: 'asc' },
    select: { chunkIndex: true, data: true },
  });

  if (chunks.length === 0) {
    throw new Error('No chunks found in DB. Upload ulang file.');
  }

  // Concatenate chunks
  const buffers = chunks.map(c => c.data);
  const combined = Buffer.concat(buffers);

  // Write to /tmp (this is a SINGLE invocation, so /tmp works here)
  const tmpDir = '/tmp/ingest-process';
  if (!existsSync(tmpDir)) {
    await fs.mkdir(tmpDir, { recursive: true });
  }
  const filePath = path.join(tmpDir, `${fileHash}${ext}`);
  await fs.writeFile(filePath, combined);

  return filePath;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-process:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { mode, fileName, fileHash, fileSize, ext } = body;

    if (!mode || !fileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: mode, fileName, fileHash' },
        { status: 400 }
      );
    }

    // Validate filename format
    const monthInfo = parseMonthFromFilename(fileName);
    if (!monthInfo) {
      return NextResponse.json(
        { success: false, error: `Nama file tidak sesuai format: "${fileName}". Contoh: "17.MEI 2026.xlsx"` },
        { status: 400 }
      );
    }

    const fileExt = ext || path.extname(fileName).toLowerCase();

    // ============================================================
    // MODE 1: DETECT — reassemble, parse Excel, return weeks list
    // ============================================================
    if (mode === 'detect') {
      // Reassemble from DB chunks
      const filePath = await reassembleFile(fileHash, fileExt);

      // Verify size
      const actualSize = (await fs.stat(filePath)).size;
      const expectedSize = parseInt(String(fileSize || 0));
      if (expectedSize > 0 && actualSize !== expectedSize) {
        await fs.unlink(filePath).catch(() => {});
        // Clean up chunks
        await db.fileChunk.deleteMany({ where: { fileHash } }).catch(() => {});
        return NextResponse.json(
          { success: false, error: `File size mismatch: expected ${expectedSize}, got ${actualSize}. Chunks mungkin corrupt. Upload ulang.` },
          { status: 400 }
        );
      }

      // Parse Excel
      const parsed = await parseExcelFile(filePath);
      const weeksInFileSet = new Set<string>();
      const rowCountPerWeek: Record<string, number> = {};
      for (const sheet of parsed.sheets) {
        for (const row of sheet.rows) {
          const wk = String(row.weekLabel ?? '').trim().toUpperCase();
          if (wk) {
            weeksInFileSet.add(wk);
            rowCountPerWeek[wk] = (rowCountPerWeek[wk] || 0) + 1;
          }
        }
      }
      const weeksInFile = [...weeksInFileSet].sort();

      if (weeksInFile.length === 0) {
        await fs.unlink(filePath).catch(() => {});
        await db.fileChunk.deleteMany({ where: { fileHash } }).catch(() => {});
        return NextResponse.json(
          { success: false, error: 'Tidak ada week label (WEEK 1/2/3/4) di file.' },
          { status: 400 }
        );
      }

      // Check DB: which weeks already exist?
      const existingFiles = await db.sourceFile.findMany({
        where: { monthLabel: monthInfo.monthLabel },
        select: { id: true },
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
      const weeksToImport = weeksInFile.filter(w => !existingWeeksSet.has(w));

      // Don't delete temp file yet — import mode will need it
      // Don't delete chunks yet — import mode may need to reassemble if on different instance

      return NextResponse.json({
        success: true,
        mode: 'detect',
        monthLabel: monthInfo.monthLabel,
        monthKey: monthInfo.monthKey,
        weeksInFile,
        existingWeeks,
        weeksToImport,
        rowCountPerWeek,
        message: weeksToImport.length === 0
          ? `Semua week (${weeksInFile.join(', ')}) sudah ada untuk ${monthInfo.monthLabel}.`
          : `Siap import ${weeksToImport.length} week: ${weeksToImport.join(', ')}`,
      });
    }

    // ============================================================
    // MODE 2: IMPORT — reassemble, import ONE specific week
    // ============================================================
    if (mode === 'import') {
      const weekLabel = body.weekLabel as string;
      if (!weekLabel) {
        return NextResponse.json(
          { success: false, error: 'weekLabel required for import mode' },
          { status: 400 }
        );
      }

      console.log(`[ingest-process] import ${weekLabel} for ${fileName} (hash: ${fileHash})`);

      // Reassemble from DB chunks
      let filePath: string;
      try {
        filePath = await reassembleFile(fileHash, fileExt);
        console.log(`[ingest-process] reassembled to ${filePath}`);
      } catch (e: any) {
        console.error('[ingest-process] reassemble failed:', e);
        return NextResponse.json(
          { success: false, error: `Gagal reassemble file: ${e?.message}` },
          { status: 500 }
        );
      }

      // Parse Excel
      let parsed;
      try {
        parsed = await parseExcelFile(filePath);
        console.log(`[ingest-process] parsed ${parsed.sheets.length} sheets`);
      } catch (e: any) {
        console.error('[ingest-process] parse failed:', e);
        await fs.unlink(filePath).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Gagal parse Excel: ${e?.message}` },
          { status: 500 }
        );
      }

      // Collect rows for this week
      const weekRows: Record<string, unknown>[] = [];
      for (const sheet of parsed.sheets) {
        for (const row of sheet.rows) {
          const wk = String(row.weekLabel ?? '').trim().toUpperCase();
          if (wk === weekLabel) weekRows.push(row);
        }
      }

      // Clean up temp file (parsed data is in memory now)
      await fs.unlink(filePath).catch(() => {});

      if (weekRows.length === 0) {
        return NextResponse.json({
          success: true,
          mode: 'import',
          weekLabel,
          status: 'SKIPPED',
          rowCount: 0,
          message: `No rows found for ${weekLabel}`,
          durationMs: Date.now() - startedAt,
        });
      }

      // Create SourceFile record
      const sourceFile = await db.sourceFile.create({
        data: {
          fileName: `${fileName} [${weekLabel}]`,
          filePath: '',
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

      // Audit log
      await db.auditLog.create({
        data: {
          action: 'INGEST_WEEK',
          detail: `${fileName} [${weekLabel}]: ${inserted} rows imported`,
          duration: Date.now() - startedAt,
        },
      });

      analysisCache.clear();

      return NextResponse.json({
        success: true,
        mode: 'import',
        weekLabel,
        status: 'IMPORTED',
        rowCount: inserted,
        dqErrors: dq.severityCounts.ERROR,
        dqWarnings: dq.severityCounts.WARNING,
        durationMs: Date.now() - startedAt,
      });
    }

    return NextResponse.json(
      { success: false, error: `Unknown mode: ${mode}. Use 'detect' or 'import'.` },
      { status: 400 }
    );
  } catch (e: any) {
    console.error('[ingest-process] error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}

// Cleanup — delete chunks from DB after all weeks processed
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { fileHash } = body;
    if (fileHash) {
      await db.fileChunk.deleteMany({ where: { fileHash } });
    }
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 });
  }
}
