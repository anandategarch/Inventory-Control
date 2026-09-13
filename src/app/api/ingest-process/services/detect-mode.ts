// ============================================================
//  detect-mode — MODE 1 of POST /api/ingest-process
//  --------------------------------------------------------
//  Extracted from the original 963-line route.ts (REFACTOR-1-a
//  pure-move split). Reassemble (or reuse) the uploaded file,
//  parse it, detect the weeks it contains, and report which are
//  new vs already in DB. The shared request preamble (rate limit,
//  Zod, manual rename, fileHash/ext sanitization) lives in
//  route.ts; everything after `if (mode === 'detect')` lives here.
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import fs from 'fs/promises';
import { reassembleFile, reuseTempFile } from './file-reassembly';
import { extractMonthFromRows, type IngestProcessContext } from './shared';

export async function handleDetect(ctx: IngestProcessContext): Promise<NextResponse> {
  // Reassemble from DB chunks — uses ctx.safeFileHash (validated in route.ts) to prevent path traversal.
  // PERF-UPLOAD-5: reuse a leftover /tmp file from a previous invocation when
  // possible (re-upload of an identical file); fall back to chunk reassembly.
  const filePath =
    (await reuseTempFile(ctx.safeFileHash, ctx.fileExt, parseInt(String(ctx.fileSize || 0), 10))) ??
    (await reassembleFile(ctx.safeFileHash, ctx.fileExt));

  // Verify size — FIX-A-1 note: client-provided fileSize is advisory only (used to
  // detect chunk corruption). The real size enforcement happens at upload time
  // (see /api/ingest-upload FIX-A-3) where totalBytes is computed server-side.
  const actualSize = (await fs.stat(filePath)).size;
  const expectedSize = parseInt(String(ctx.fileSize || 0));
  if (expectedSize > 0 && actualSize !== expectedSize) {
    await fs.unlink(filePath).catch(() => {});
    await db.fileChunk.deleteMany({ where: { fileHash: ctx.safeFileHash } }).catch(() => {});
    return NextResponse.json(
      { success: false, error: `File size mismatch: expected ${expectedSize}, got ${actualSize}. Chunks mungkin corrupt. Upload ulang.` },
      { status: 400 }
    );
  }

  // Parse Excel
  const parsed = await parseExcelFile(filePath);

  // FIX: If filename is placeholder, extract month from row data.
  // SKIP this auto-extract when user provided manualFileName — they explicitly
  // chose the name, so we respect it (monthInfo already parsed from manual name).
  if (!ctx.manualMode && (ctx.fileNameIsPlaceholder || !ctx.monthInfo)) {
    const allRows: Array<Record<string, unknown>> = [];
    for (const sheet of parsed.sheets) {
      allRows.push(...sheet.rows);
    }
    const extractedMonth = extractMonthFromRows(allRows);
    if (extractedMonth) {
      ctx.fileName = `${extractedMonth}.xlsx`;
      ctx.monthInfo = parseMonthFromFilename(ctx.fileName);
      logger.info(`[ingest-process] placeholder filename "${ctx.rawFileName}" → extracted month from data → "${ctx.fileName}"`);
    }
  }

  if (!ctx.monthInfo) {
    await fs.unlink(filePath).catch(() => {});
    await db.fileChunk.deleteMany({ where: { fileHash: ctx.safeFileHash } }).catch(() => {});
    return NextResponse.json(
      { success: false, error: `Nama file tidak sesuai format: "${ctx.fileName}". Contoh: "17.MEI 2026.xlsx". Tidak bisa extract month dari data juga. Tip: gunakan opsi "Rename Manual" saat upload.` },
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
    await db.fileChunk.deleteMany({ where: { fileHash: ctx.safeFileHash } }).catch(() => {});
    return NextResponse.json(
      { success: false, error: 'Tidak ada week label (WEEK 1/2/3/4) di file.' },
      { status: 400 }
    );
  }

  // Check DB: which weeks already exist?
  // FIX (DEEP-AUDIT-FLOW-6, DEEP-AUDIT-ENGINE-7): query by monthKey, NOT monthLabel.
  // monthLabel is case-sensitive (e.g., "Juli 2026" vs "JULI 2026"), so a mixed-case DB
  // would falsely report zero existing files → weeksToImport would include already-existing
  // weeks → P2002 unique constraint violation on import. monthKey is always "YYYY-MM"
  // (digits + dash) so case is irrelevant.
  const existingFiles = await db.sourceFile.findMany({
    where: { monthKey: ctx.monthInfo.monthKey },
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
    fileName: ctx.fileName, // FIX: return corrected filename so UI shows it
    manualMode: ctx.manualMode, // let frontend know whether name came from user override
    monthLabel: ctx.monthInfo.monthLabel,
    monthKey: ctx.monthInfo.monthKey,
    weeksInFile,
    existingWeeks,
    weeksToImport,
    rowCountPerWeek,
    message: weeksToImport.length === 0
      ? `Semua week (${weeksInFile.join(', ')}) sudah ada untuk ${ctx.monthInfo.monthLabel}.`
      : `Siap import ${weeksToImport.length} week: ${weeksToImport.join(', ')}`,
  });
}
