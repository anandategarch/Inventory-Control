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
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { summarizeDQ } from '@/engine/validator';
import { processRowsForImport } from '@/lib/ingestion';
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
    select: { chunkIndex: true, data: true, totalChunks: true },
  });

  if (chunks.length === 0) {
    throw new Error('No chunks found in DB. Upload ulang file.');
  }

  // P2-11 fix: validate chunk count matches expected total
  const expectedTotal = chunks[0]?.totalChunks || 0;
  if (expectedTotal > 0 && chunks.length !== expectedTotal) {
    throw new Error(`Chunk count mismatch: expected ${expectedTotal}, got ${chunks.length}. Upload corrupt atau tidak lengkap.`);
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
    const { mode, fileName: rawFileName, fileHash, fileSize, ext } = body;

    if (!mode || !rawFileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: mode, fileName, fileHash' },
        { status: 400 }
      );
    }

    // FIX: Sanitize fileName — if it's a Google Sheets placeholder like "Loading…",
    // "Loading Google Sheet", or contains those words, we need to extract the real
    // month from the Excel data (BULAN/BULAN 2 fields) after parsing.
    const PLACEHOLDER_PATTERNS = [
      /loading/i,
      /google\s*(sheet|spreadsheet|試算表|drive)/i,
      /untitled/i,
    ];
    const isPlaceholderName = (name: string): boolean => {
      const base = name.replace(/\.(xlsx|csv)$/i, '').trim();
      return PLACEHOLDER_PATTERNS.some(p => p.test(base));
    };

    let fileName = rawFileName;
    // Strip Google Sheets suffixes
    fileName = fileName.replace(/\s*-\s*Google\s+(Sheets|試算表|Spreadsheet|Drive).*$/i, '').trim();

    // Helper: extract monthLabel from Excel row data (BULAN / BULAN 2 fields)
    // BULAN field typically contains "171.MEI 26" or "17.MEI 2026"
    // BULAN 2 field typically contains "17.MEI"
    const extractMonthFromRows = (rows: Array<Record<string, unknown>>): string | null => {
      for (const row of rows) {
        const bulan = String(row.bulan ?? row.BULAN ?? '').trim();
        const bulan2 = String(row.bulan2 ?? row['BULAN 2'] ?? row.bulan_2 ?? '').trim();
        // Try BULAN first (has year info)
        for (const candidate of [bulan, bulan2, `${bulan2} 2026`]) {
          if (candidate) {
            const parsed = parseMonthFromFilename(candidate);
            if (parsed) return parsed.monthLabel;
          }
        }
      }
      return null;
    };

    // Check if filename is a placeholder — if so, we'll fix it after parsing Excel
    const fileNameIsPlaceholder = isPlaceholderName(fileName);

    // Try to parse month from filename. If placeholder, this will likely fail —
    // we'll re-parse from Excel data after parseExcelFile.
    let monthInfo = parseMonthFromFilename(fileName);
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
        await db.fileChunk.deleteMany({ where: { fileHash } }).catch(() => {});
        return NextResponse.json(
          { success: false, error: `File size mismatch: expected ${expectedSize}, got ${actualSize}. Chunks mungkin corrupt. Upload ulang.` },
          { status: 400 }
        );
      }

      // Parse Excel
      const parsed = await parseExcelFile(filePath);

      // FIX: If filename is placeholder, extract month from row data
      if (fileNameIsPlaceholder || !monthInfo) {
        const allRows: Array<Record<string, unknown>> = [];
        for (const sheet of parsed.sheets) {
          allRows.push(...sheet.rows);
        }
        const extractedMonth = extractMonthFromRows(allRows);
        if (extractedMonth) {
          fileName = `${extractedMonth}.xlsx`;
          monthInfo = parseMonthFromFilename(fileName);
          console.log(`[ingest-process] placeholder filename "${rawFileName}" → extracted month from data → "${fileName}"`);
        }
      }

      if (!monthInfo) {
        await fs.unlink(filePath).catch(() => {});
        await db.fileChunk.deleteMany({ where: { fileHash } }).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Nama file tidak sesuai format: "${fileName}". Contoh: "17.MEI 2026.xlsx". Tidak bisa extract month dari data juga.` },
          { status: 400 }
        );
      }

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
        fileName, // FIX: return corrected filename so UI shows it
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

      // FIX: If filename is placeholder, extract month from row data
      if (fileNameIsPlaceholder || !monthInfo) {
        const allRows: Array<Record<string, unknown>> = [];
        for (const sheet of parsed.sheets) {
          allRows.push(...sheet.rows);
        }
        const extractedMonth = extractMonthFromRows(allRows);
        if (extractedMonth) {
          fileName = `${extractedMonth}.xlsx`;
          monthInfo = parseMonthFromFilename(fileName);
          console.log(`[ingest-process] import mode: placeholder filename "${rawFileName}" → extracted month from data → "${fileName}"`);
        }
      }

      if (!monthInfo) {
        await fs.unlink(filePath).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Nama file tidak sesuai format: "${fileName}". Tidak bisa extract month dari data juga.` },
          { status: 400 }
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

      // Create Week record — FIX: CUMULATIVE periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
      const p = CFG_RECON_SETTINGS.WEEK_PERIODS[weekLabel] || { start: 1, end: Math.min(parseInt(weekLabel.replace(/\D/g,'')) * 7, 31) };
      const weekRec = await db.week.create({
        data: {
          sourceFileId: sourceFile.id, weekLabel,
          weekKey: `${monthInfo.monthKey}-${weekLabel.replace(/\s+/g, '')}`,
          monthKey: monthInfo.monthKey, periodStart: p.start, periodEnd: p.end,
        },
      });

      // Process rows — P2 fix: use shared processRowsForImport from ingestion.ts
      // (eliminates ~100 lines of duplicate validate/normalize/derive/insert logic)
      const seenKeys = new Set<string>();
      const outletDbMap = new Map<string, number>();
      const itemDbMap = new Map<string, { id: number; satuan: string | null }>();

      const result = await processRowsForImport(
        weekRows,
        sourceFile.id,
        weekRec.id,
        fileName,
        monthInfo.monthLabel,
        0,
        outletDbMap,
        itemDbMap,
        seenKeys,
      );

      const inserted = result.inserted;

      // Update source file
      const dq = summarizeDQ(result.dqIssues);
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
      if (result.dqIssues.length > 0) {
        const dqRecords = result.dqIssues.map((i) => ({
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
    // P2-12 fix: rate limit DELETE to prevent abuse
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-process-delete:${ip}`, 10, 60_000); // 10 per min
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit.' }, { status: 429 });
    }
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
