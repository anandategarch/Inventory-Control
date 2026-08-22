// ============================================================
//  /api/ingest-process — Process uploaded Excel file
//  Reassembles file from DB chunks, then:
//  1. mode='detect' → parse Excel, detect weeks, return list
//  2. mode='import' → import ONE specific week (partial commit)
//  3. DELETE → cleanup chunks + temp file
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { analysisCache, statusCache } from '@/lib/cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import { validateManualFileName } from '@/lib/filename';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { summarizeDQ } from '@/engine/validator';
import { processRowsForImport } from '@/lib/ingestion';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Max for Vercel — import can take 1-2 min for large weeks

// FIX-A-1 (BUG-5-1): Sanitize fileHash + ext to prevent path traversal in reassembleFile.
// fileHash must be a hex string (SHA-256 / SHA-512 hex) — no '..', '/', ':', etc.
// ext must be in the upload allowlist. Reject otherwise with 400 before any disk I/O.
const SAFE_FILEHASH_RE = /^[a-f0-9]{8,128}$/i;
const SAFE_EXT_ALLOWLIST = new Set(['.xlsx', '.xls', '.csv']);

function validateFileMetadata(fileHash: unknown, ext: unknown): { ok: true; fileHash: string; ext: string } | { ok: false; error: string } {
  if (typeof fileHash !== 'string' || !SAFE_FILEHASH_RE.test(fileHash)) {
    return { ok: false, error: 'Invalid fileHash: must be hex-only (a-f0-9), 8-128 chars.' };
  }
  // ext is optional in detect/import payload — fall back to extension parsed from fileName.
  // If provided, it must be in the allowlist.
  let extStr: string;
  if (ext === undefined || ext === null || ext === '') {
    extStr = ''; // caller resolves from fileName via path.extname
  } else if (typeof ext === 'string') {
    extStr = ext.toLowerCase();
    if (!SAFE_EXT_ALLOWLIST.has(extStr)) {
      return { ok: false, error: `Invalid ext: ${extStr}. Allowed: ${[...SAFE_EXT_ALLOWLIST].join(', ')}.` };
    }
  } else {
    return { ok: false, error: 'Invalid ext: must be a string.' };
  }
  return { ok: true, fileHash, ext: extStr };
}

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
    const { mode, fileName: rawFileName, fileHash, fileSize, ext, manualFileName, numberLocale } = body;

    if (!mode || !rawFileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: mode, fileName, fileHash' },
        { status: 400 }
      );
    }

    // Validate numberLocale if provided (default 'auto' for local file uploads)
    const validLocales = ['auto', 'id', 'us'];
    const locale: 'auto' | 'id' | 'us' = validLocales.includes(numberLocale) ? numberLocale : 'auto';

    // ============================================================
    // Manual rename support (user override for "Loading Google Sheet" etc.)
    // Uses shared validateManualFileName helper from @/lib/filename for
    // consistency with /api/import-drive (AUDIT-RENAME-2,3,4,9 fix).
    // When manual mode is active, the auto-extract-from-Excel-data fallback
    // is SKIPPED — user explicitly chose this name.
    // ============================================================
    let effectiveRawFileName = rawFileName;
    let manualMode = false;
    if (manualFileName && typeof manualFileName === 'string' && manualFileName.trim()) {
      const result = validateManualFileName(manualFileName);
      if (!result.ok) {
        return NextResponse.json(
          { success: false, error: result.error || 'manualFileName tidak valid.' },
          { status: 400 }
        );
      }
      effectiveRawFileName = result.cleaned;
      manualMode = true;
      console.log(`[ingest-process] manual rename: "${rawFileName}" → "${effectiveRawFileName}"`);
    }

    // FIX-A-1 (BUG-5-1): validate fileHash + ext BEFORE reassembleFile to prevent
    // path traversal via malicious fileHash (e.g., "../../etc/cron.d/evil") or ext
    // (e.g., ".php"). Without this, path.join('/tmp/ingest-process', `${fileHash}${ext}`)
    // could escape the intended directory.
    const metaCheck = validateFileMetadata(fileHash, ext);
    if (!metaCheck.ok) {
      return NextResponse.json(
        { success: false, error: metaCheck.error },
        { status: 400 }
      );
    }
    const safeFileHash = metaCheck.fileHash;
    // Resolve final ext: validated client-supplied ext, else fall back to fileName extension.
    const fileExt = metaCheck.ext || path.extname(rawFileName).toLowerCase();
    if (!fileExt || !SAFE_EXT_ALLOWLIST.has(fileExt)) {
      return NextResponse.json(
        { success: false, error: `Unsupported file extension: "${fileExt}". Allowed: ${[...SAFE_EXT_ALLOWLIST].join(', ')}.` },
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

    let fileName = effectiveRawFileName;
    // Strip Google Sheets suffixes (only relevant in auto mode; manual name already cleaned)
    if (!manualMode) {
      fileName = fileName.replace(/\s*-\s*Google\s+(Sheets|試算表|Spreadsheet|Drive).*$/i, '').trim();
    }

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
    // (fileExt already validated above via validateFileMetadata — do NOT recompute from raw `ext`.)

    // ============================================================
    // MODE 1: DETECT — reassemble, parse Excel, return weeks list
    // ============================================================
    if (mode === 'detect') {
      // Reassemble from DB chunks — uses safeFileHash (validated above) to prevent path traversal.
      const filePath = await reassembleFile(safeFileHash, fileExt);

      // Verify size — FIX-A-1 note: client-provided fileSize is advisory only (used to
      // detect chunk corruption). The real size enforcement happens at upload time
      // (see /api/ingest-upload FIX-A-3) where totalBytes is computed server-side.
      const actualSize = (await fs.stat(filePath)).size;
      const expectedSize = parseInt(String(fileSize || 0));
      if (expectedSize > 0 && actualSize !== expectedSize) {
        await fs.unlink(filePath).catch(() => {});
        await db.fileChunk.deleteMany({ where: { fileHash: safeFileHash } }).catch(() => {});
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
      if (!manualMode && (fileNameIsPlaceholder || !monthInfo)) {
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
        await db.fileChunk.deleteMany({ where: { fileHash: safeFileHash } }).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Nama file tidak sesuai format: "${fileName}". Contoh: "17.MEI 2026.xlsx". Tidak bisa extract month dari data juga. Tip: gunakan opsi "Rename Manual" saat upload.` },
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
        await db.fileChunk.deleteMany({ where: { fileHash: safeFileHash } }).catch(() => {});
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
        where: { monthKey: monthInfo.monthKey },
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
        manualMode, // let frontend know whether name came from user override
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

      console.log(`[ingest-process] import ${weekLabel} for ${fileName} (hash: ${safeFileHash})`);

      // Reassemble from DB chunks — uses safeFileHash (validated above) to prevent path traversal.
      let filePath: string;
      try {
        filePath = await reassembleFile(safeFileHash, fileExt);
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

      // FIX: If filename is placeholder, extract month from row data.
      // SKIP auto-extract in manual mode (user explicitly chose the name).
      if (!manualMode && (fileNameIsPlaceholder || !monthInfo)) {
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
          { success: false, error: `Nama file tidak sesuai format: "${fileName}". Tidak bisa extract month dari data juga. Tip: gunakan opsi "Rename Manual" saat upload.` },
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

      // Create SourceFile record — uses safeFileHash (validated) for fileHash composite key.
      const sourceFile = await db.sourceFile.create({
        data: {
          fileName: `${fileName} [${weekLabel}]`,
          filePath: '',
          monthLabel: monthInfo.monthLabel,
          monthKey: monthInfo.monthKey,
          fileHash: `${safeFileHash}-${weekLabel}`,
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
      //
      // ImportSpeed: fastMode=true — skip validateRow() + DQ issue tracking.
      // Pure normalize + derive + insert → ~3-5x faster for large files.
      // DQ validation can be run separately later (e.g., via /api/dq-check).
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
        true, // fastMode: skip DQ validation — pure import for speed
        locale, // numberLocale: 'auto' | 'id' | 'us' for CSV separator parsing
      );

      const inserted = result.inserted;

      // Update source file — always update rowCount (even in fast mode).
      // ImportSpeed: in fast mode, dqIssues is empty → summarizeDQ returns OK / 0 / 0.
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

      // Insert DQ issues — in fast mode, dqIssues is empty so this is a no-op,
      // but the guard makes the intent explicit and avoids the createMany call.
      if (result.dqIssues.length > 0) {
        const dqRecords = result.dqIssues.map((i) => ({
          sourceFileId: sourceFile.id, severity: i.severity, code: i.code,
          message: i.message, rawValue: i.rawValue ?? null, rowNumber: i.rowNumber ?? null,
        }));
        for (let i = 0; i < dqRecords.length; i += 500) {
          await db.dQIssue.createMany({ data: dqRecords.slice(i, i + 500) });
        }
      }

      // Audit log — always created (even in fast mode) for traceability.
      await db.auditLog.create({
        data: {
          action: 'INGEST_WEEK',
          detail: `${fileName} [${weekLabel}]: ${inserted} rows imported [FAST MODE]`,
          duration: Date.now() - startedAt,
        },
      });

      // FIX (DEEP-AUDIT-API-1, DEEP-AUDIT-FLOW-1): clear BOTH caches after import.
      // analysisCache was already cleared; statusCache must also be cleared because
      // /api/status returns month/file/row counts in its dropdown payload — without
      // this, the dashboard month dropdown stays stale for up to 5 min after upload.
      analysisCache.clear();
      statusCache.clear();
      // FIX-DEEP-1C: clear monthResolver cache so subsequent requests see the new
      // monthLabel added by this import. Without this, getMonthResolver() would
      // keep returning the pre-import resolver and the new month's case might
      // not be in the resolver's `exact` set → resolveMonthLabel would fall back
      // to the (possibly different-case) input label → potential mismatch.
      clearMonthResolverCache();

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

    // ============================================================
    // MODE 3: IMPORT-ALL — reassemble + parse ONCE, import ALL weeks in one request
    // FIX: previously each week was imported via separate 'import' call, causing
    // reassemble + parse for EACH week (3x for 3 weeks = 3x slow). This mode
    // does it all in one request → 3x faster, no 504 timeout.
    // ============================================================
    if (mode === 'import-all') {
      const weeksToImport: string[] = body.weeksToImport || [];
      if (weeksToImport.length === 0) {
        return NextResponse.json(
          { success: false, error: 'weeksToImport array required for import-all mode' },
          { status: 400 }
        );
      }

      console.log(`[ingest-process] import-all ${weeksToImport.length} weeks for ${fileName}`);

      // Reassemble ONCE
      let filePath: string;
      try {
        filePath = await reassembleFile(safeFileHash, fileExt);
        console.log(`[ingest-process] reassembled to ${filePath}`);
      } catch (e: unknown) {
        const err = e as Error;
        console.error('[ingest-process] reassemble failed:', err);
        return NextResponse.json(
          { success: false, error: `Gagal reassemble file: ${err?.message}` },
          { status: 500 }
        );
      }

      // Parse ONCE
      let parsed;
      try {
        parsed = await parseExcelFile(filePath);
        console.log(`[ingest-process] parsed ${parsed.sheets.length} sheets`);
      } catch (e: unknown) {
        const err = e as Error;
        console.error('[ingest-process] parse failed:', err);
        await fs.unlink(filePath).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Gagal parse Excel: ${err?.message}` },
          { status: 500 }
        );
      }

      // Extract month if needed
      if (!manualMode && (fileNameIsPlaceholder || !monthInfo)) {
        const allRows: Array<Record<string, unknown>> = [];
        for (const sheet of parsed.sheets) {
          allRows.push(...sheet.rows);
        }
        const extractedMonth = extractMonthFromRows(allRows);
        if (extractedMonth) {
          fileName = `${extractedMonth}.xlsx`;
          monthInfo = parseMonthFromFilename(fileName);
        }
      }

      if (!monthInfo) {
        await fs.unlink(filePath).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Nama file tidak sesuai format: "${fileName}"` },
          { status: 400 }
        );
      }

      // Clean up temp file (parsed data is in memory)
      await fs.unlink(filePath).catch(() => {});

      // Group rows by week
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

      // Shared maps across weeks (outlets/items created in week 1 reused in week 2)
      const seenKeys = new Set<string>();
      const outletDbMap = new Map<string, number>();
      const itemDbMap = new Map<string, { id: number; satuan: string | null }>();
      const importedWeeks: Array<{
        weekLabel: string; status: string; rowCount: number;
        dqErrors: number; dqWarnings: number; durationMs: number;
      }> = [];
      let totalInserted = 0;

      for (const weekLabel of weeksToImport) {
        const weekRows = rowsByWeek.get(weekLabel) || [];
        const weekStart = Date.now();

        if (weekRows.length === 0) {
          importedWeeks.push({
            weekLabel, status: 'SKIPPED', rowCount: 0,
            dqErrors: 0, dqWarnings: 0, durationMs: Date.now() - weekStart,
          });
          continue;
        }

        // Create SourceFile per week
        const sourceFile = await db.sourceFile.create({
          data: {
            fileName: `${fileName} [${weekLabel}]`,
            filePath: '',
            monthLabel: monthInfo.monthLabel,
            monthKey: monthInfo.monthKey,
            fileHash: `${safeFileHash}-${weekLabel}`,
            rowCount: 0,
            dqStatus: 'OK',
          },
        });

        const p = CFG_RECON_SETTINGS.WEEK_PERIODS[weekLabel] || { start: 1, end: Math.min(parseInt(weekLabel.replace(/\D/g, '')) * 7, 31) };
        const weekRec = await db.week.create({
          data: {
            sourceFileId: sourceFile.id, weekLabel,
            weekKey: `${monthInfo.monthKey}-${weekLabel.replace(/\s+/g, '')}`,
            monthKey: monthInfo.monthKey, periodStart: p.start, periodEnd: p.end,
          },
        });

        const result = await processRowsForImport(
          weekRows, sourceFile.id, weekRec.id, fileName,
          monthInfo.monthLabel, 0, outletDbMap, itemDbMap, seenKeys,
          true, locale,
        );

        const dq = summarizeDQ(result.dqIssues);
        await db.sourceFile.update({
          where: { id: sourceFile.id },
          data: {
            rowCount: result.inserted,
            dqStatus: dq.status,
            dqErrorCount: dq.severityCounts.ERROR,
            dqWarningCount: dq.severityCounts.WARNING,
          },
        });

        totalInserted += result.inserted;
        importedWeeks.push({
          weekLabel, status: 'IMPORTED', rowCount: result.inserted,
          dqErrors: dq.severityCounts.ERROR, dqWarnings: dq.severityCounts.WARNING,
          durationMs: Date.now() - weekStart,
        });

        console.log(`[ingest-process] ${weekLabel}: ${result.inserted} rows (${((Date.now() - weekStart) / 1000).toFixed(1)}s)`);
      }

      // Clear caches
      analysisCache.clear();
      statusCache.clear();
      clearMonthResolverCache();

      // Cleanup chunks
      await db.fileChunk.deleteMany({ where: { fileHash: safeFileHash } }).catch(() => {});

      // Audit log
      await db.auditLog.create({
        data: {
          action: 'INGEST_ALL_WEEKS',
          detail: `${fileName}: ${totalInserted} rows across ${importedWeeks.length} weeks [FAST MODE]`,
          duration: Date.now() - startedAt,
        },
      }).catch(() => {});

      return NextResponse.json({
        success: true,
        mode: 'import-all',
        totalInserted,
        importedWeeks,
        durationMs: Date.now() - startedAt,
      });
    }

    return NextResponse.json(
      { success: false, error: `Unknown mode: ${mode}. Use 'detect', 'import', or 'import-all'.` },
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
