// ============================================================
//  parse-excel — Stage 2 of /api/ingest-process POST pipeline
//  --------------------------------------------------------
//  Extracted from the original 700-line god function (route.ts:54-85 + 211-246 + 347-374 + 595-621).
//
//  Responsibilities:
//    1. Reassemble uploaded file from DB chunks (reassembleFile)
//    2. Parse Excel file into per-sheet rows (parseExcelFile)
//    3. Verify file size matches expected (detect mode only)
//    4. Resolve monthInfo from Excel data if filename was a placeholder
//    5. Group rows by weekLabel (import-all mode)
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { extractMonthFromRows, type ValidatedInput } from './validate-input';

// Re-exported so route.ts can still import reassembleFile from this barrel
// if needed (the DELETE handler doesn't use it but tests might).
export { extractMonthFromRows };

// Reassemble file from DB chunks
export async function reassembleFile(fileHash: string, ext: string): Promise<string> {
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

export interface ParsedExcel {
  filePath: string;
  parsed: Awaited<ReturnType<typeof parseExcelFile>>;
  fileName: string;       // possibly corrected (if placeholder → extracted from data)
  monthInfo: NonNullable<ValidatedInput['monthInfo']>; // resolved (non-null after this stage)
}

// Outcome — either a 400/500 response or the parsed Excel data.
export type ParseExcelOutcome =
  | { kind: 'response'; response: NextResponse }
  | { kind: 'continue'; data: ParsedExcel };

/**
 * Stage 2 — reassemble + parse Excel + resolve monthInfo.
 *
 * Handles 3 cases for monthInfo resolution:
 *   1. monthInfo already resolved from filename → use as-is
 *   2. fileNameIsPlaceholder or monthInfo null AND not manualMode → extract from rows
 *   3. manualMode → respect user's manual name (skip extraction)
 *
 * Returns a 400 response if month cannot be resolved.
 */
export async function parseExcel(input: ValidatedInput, opts?: { verifySize?: number }): Promise<ParseExcelOutcome> {
  const { safeFileHash, fileExt, fileName, rawFileName, manualMode, fileNameIsPlaceholder, monthInfo } = input;

  // Reassemble from DB chunks — uses safeFileHash (validated in stage 1) to prevent path traversal.
  let filePath: string;
  try {
    filePath = await reassembleFile(safeFileHash, fileExt);
    logger.info(`[ingest-process] reassembled to ${filePath}`);
  } catch (e: unknown) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: `Gagal reassemble file: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 }
      ),
    };
  }

  // Verify size (detect mode only) — FIX-A-1 note: client-provided fileSize is advisory only.
  // The real size enforcement happens at upload time (see /api/ingest-upload FIX-A-3) where
  // totalBytes is computed server-side.
  if (opts?.verifySize !== undefined && opts.verifySize > 0) {
    const actualSize = (await fs.stat(filePath)).size;
    if (actualSize !== opts.verifySize) {
      await fs.unlink(filePath).catch(() => {});
      await db.fileChunk.deleteMany({ where: { fileHash: safeFileHash } }).catch(() => {});
      return {
        kind: 'response',
        response: NextResponse.json(
          { success: false, error: `File size mismatch: expected ${opts.verifySize}, got ${actualSize}. Chunks mungkin corrupt. Upload ulang.` },
          { status: 400 }
        ),
      };
    }
  }

  // Parse Excel
  let parsed: Awaited<ReturnType<typeof parseExcelFile>>;
  try {
    parsed = await parseExcelFile(filePath);
    logger.info(`[ingest-process] parsed ${parsed.sheets.length} sheets`);
  } catch (e: unknown) {
    await fs.unlink(filePath).catch(() => {});
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: `Gagal parse Excel: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 }
      ),
    };
  }

  // FIX: If filename is placeholder, extract month from row data.
  // SKIP this auto-extract when user provided manualFileName — they explicitly
  // chose the name, so we respect it (monthInfo already parsed from manual name).
  let resolvedFileName = fileName;
  let resolvedMonthInfo = monthInfo;
  if (!manualMode && (fileNameIsPlaceholder || !resolvedMonthInfo)) {
    const allRows: Array<Record<string, unknown>> = [];
    for (const sheet of parsed.sheets) {
      allRows.push(...sheet.rows);
    }
    const extractedMonth = extractMonthFromRows(allRows);
    if (extractedMonth) {
      resolvedFileName = `${extractedMonth}.xlsx`;
      resolvedMonthInfo = parseMonthFromFilename(resolvedFileName);
      logger.info(`[ingest-process] placeholder filename "${rawFileName}" → extracted month from data → "${resolvedFileName}"`);
    }
  }

  if (!resolvedMonthInfo) {
    await fs.unlink(filePath).catch(() => {});
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: `Nama file tidak sesuai format: "${resolvedFileName}". Tidak bisa extract month dari data juga. Tip: gunakan opsi "Rename Manual" saat upload.` },
        { status: 400 }
      ),
    };
  }

  return {
    kind: 'continue',
    data: { filePath, parsed, fileName: resolvedFileName, monthInfo: resolvedMonthInfo },
  };
}

/**
 * Helper: collect rows matching a specific weekLabel across all sheets.
 */
export function collectRowsForWeek(parsed: ParsedExcel['parsed'], weekLabel: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const sheet of parsed.sheets) {
    for (const row of sheet.rows) {
      const wk = String(row.weekLabel ?? '').trim().toUpperCase();
      if (wk === weekLabel) rows.push(row);
    }
  }
  return rows;
}

/**
 * Helper: detect all unique weekLabels in the parsed Excel + count rows per week.
 */
export function detectWeeksInFile(parsed: ParsedExcel['parsed']): { weeksInFile: string[]; rowCountPerWeek: Record<string, number> } {
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
  return { weeksInFile: [...weeksInFileSet].sort(), rowCountPerWeek };
}

/**
 * Helper: group rows by weekLabel (import-all mode).
 */
export function groupRowsByWeek(parsed: ParsedExcel['parsed'], weeksToImport: string[]): Map<string, Record<string, unknown>[]> {
  const rowsByWeek = new Map<string, Record<string, unknown>[]>();
  for (const sheet of parsed.sheets) {
    for (const row of sheet.rows) {
      const wk = String(row.weekLabel ?? '').trim().toUpperCase();
      if (weeksToImport.includes(wk)) {
        if (!rowsByWeek.has(wk)) rowsByWeek.set(wk, []);
        rowsByWeek.get(wk)!.push(row);
      }
    }
  }
  return rowsByWeek;
}
