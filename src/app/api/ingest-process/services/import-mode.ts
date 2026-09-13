// ============================================================
//  import-mode — MODE 2 of POST /api/ingest-process
//  --------------------------------------------------------
//  Extracted from the original 963-line route.ts (REFACTOR-1-a
//  pure-move split). Reassemble (or reuse) the uploaded file,
//  parse it, and import ONE specific week (partial commit) under
//  a transaction-scoped advisory lock. The shared request preamble
//  (rate limit, Zod, manual rename, fileHash/ext sanitization)
//  lives in route.ts; everything after `if (mode === 'import')`
//  lives here.
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { parseMonthFromFilename, parseExcelFile } from '@/lib/excel';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { summarizeDQ } from '@/engine/validator';
import { processRowsForImport } from '@/lib/ingestion';
import { acquireDbAdvisoryLock } from '@/lib/ingestion/ingestion-lock';
import fs from 'fs/promises';
import { reassembleFile, reuseTempFile } from './file-reassembly';
import { extractMonthFromRows, type IngestProcessContext } from './shared';

export async function handleImport(ctx: IngestProcessContext): Promise<NextResponse> {
  const weekLabel = ctx.body.weekLabel as string;
  if (!weekLabel) {
    return NextResponse.json(
      { success: false, error: 'weekLabel required for import mode' },
      { status: 400 }
    );
  }

  logger.info(`[ingest-process] import ${weekLabel} for ${ctx.fileName} (hash: ${ctx.safeFileHash})`);

  // Reassemble from DB chunks — uses ctx.safeFileHash (validated in route.ts) to prevent path traversal.
  let filePath: string;
  try {
    // PERF-UPLOAD-5: detect (same or previous invocation) already left the
    // reassembled file at the content-addressed /tmp path — reuse it and
    // skip re-downloading every chunk from Postgres (up to 50MB).
    const reused = await reuseTempFile(ctx.safeFileHash, ctx.fileExt, parseInt(String(ctx.fileSize || 0), 10));
    filePath = reused ?? (await reassembleFile(ctx.safeFileHash, ctx.fileExt));
    logger.info(`[ingest-process] ${reused ? 'reused temp file' : 'reassembled'}: ${filePath}`);
  } catch (e: unknown) {
    logger.error("[ingest-process] reassemble failed", { error: e });
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? `Gagal reassemble file: ${e instanceof Error ? e.message : String(e)}` : "Gagal reassemble file" },
      { status: 500 }
    );
  }

  // Parse Excel
  let parsed;
  try {
    parsed = await parseExcelFile(filePath);
    logger.info(`[ingest-process] parsed ${parsed.sheets.length} sheets`);
  } catch (e: unknown) {
    logger.error("[ingest-process] parse failed", { error: e });
    await fs.unlink(filePath).catch(() => {});
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? `Gagal parse Excel: ${e instanceof Error ? e.message : String(e)}` : "Gagal parse Excel" },
      { status: 500 }
    );
  }

  // FIX: If filename is placeholder, extract month from row data.
  // SKIP auto-extract in manual mode (user explicitly chose the name).
  if (!ctx.manualMode && (ctx.fileNameIsPlaceholder || !ctx.monthInfo)) {
    const allRows: Array<Record<string, unknown>> = [];
    for (const sheet of parsed.sheets) {
      allRows.push(...sheet.rows);
    }
    const extractedMonth = extractMonthFromRows(allRows);
    if (extractedMonth) {
      ctx.fileName = `${extractedMonth}.xlsx`;
      ctx.monthInfo = parseMonthFromFilename(ctx.fileName);
      logger.info(`[ingest-process] import mode: placeholder filename "${ctx.rawFileName}" → extracted month from data → "${ctx.fileName}"`);
    }
  }

  if (!ctx.monthInfo) {
    await fs.unlink(filePath).catch(() => {});
    return NextResponse.json(
      { success: false, error: `Nama file tidak sesuai format: "${ctx.fileName}". Tidak bisa extract month dari data juga. Tip: gunakan opsi "Rename Manual" saat upload.` },
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
      durationMs: Date.now() - ctx.startedAt,
    });
  }

  // Create SourceFile record — upsert to handle re-uploads (fileName is @unique)
  const sourceFile = await db.sourceFile.upsert({
    where: { fileName: `${ctx.fileName} [${weekLabel}]` },
    update: {
      filePath: '',
      monthLabel: ctx.monthInfo.monthLabel,
      monthKey: ctx.monthInfo.monthKey,
      fileHash: `${ctx.safeFileHash}-${weekLabel}`,
      rowCount: 0,
      dqStatus: 'OK',
    },
    create: {
      fileName: `${ctx.fileName} [${weekLabel}]`,
      filePath: '',
      monthLabel: ctx.monthInfo.monthLabel,
      monthKey: ctx.monthInfo.monthKey,
      fileHash: `${ctx.safeFileHash}-${weekLabel}`,
      rowCount: 0,
      dqStatus: 'OK',
    },
  });

  // FIX (AUDIT-BUG-1): resolve existing Week by (monthKey, weekLabel) — a previous
  // import under a different fileName must NOT create a second Week for the same
  // period (doubles every aggregate). Replace the old week's data instead.
  // FIX (AUDIT-BUG-5): the findFirst itself moved INSIDE the transaction (after
  // the advisory lock) — see the comment there.

  // Cumulative periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
  // FIX (AUDIT-BUG-1): the Week upsert itself moved INSIDE the transaction below —
  // it must run AFTER the cross-file purge, otherwise the new
  // @@unique([monthKey, weekLabel]) constraint rejects the create with P2002
  // while the old cross-file week still exists.
  const p = CFG_RECON_SETTINGS.WEEK_PERIODS[weekLabel] || { start: 1, end: Math.min(parseInt(weekLabel.replace(/\D/g,'')) * 7, 31) };

  // FIX (BUG2-INGEST-3): Wrap deleteMany + processRowsForImport in a single
  // transaction so that if createMany fails (DB error, timeout, OOM), the
  // deleteMany is rolled back. Previously, if createMany failed after
  // deleteMany succeeded, the week had 0 records → data loss. The
  // `.catch(() => {})` on deleteMany was also silently swallowing delete
  // errors (which could then cause unique-constraint violations on insert).
  // Now the transaction handles atomicity — if deleteMany fails, the
  // transaction aborts and processRowsForImport is not called.
  //
  // 240s timeout matches the maxDuration (300s) with headroom for parse
  // and post-import steps. Large weeks (~35K rows) can take 1-2 min.
  const seenKeys = new Set<string>();
  const outletDbMap = new Map<string, number>();
  const itemDbMap = new Map<string, { id: number; satuan: string | null }>();
  // Capture monthLabel before the transaction — `monthInfo` is a `let` (reassigned
  // during placeholder-filename resolution above), so TypeScript narrowing from
  // the `if (!monthInfo) return` guard doesn't carry into the closure below.
  const monthLabelForTx = ctx.monthInfo.monthLabel;
  // FIX (AUDIT-BUG-1): capture monthKey too — the Week upsert now runs inside
  // the transaction closure (see above).
  const monthKeyForTx = ctx.monthInfo.monthKey;

  const result = await db.$transaction(
    async (tx) => {
      // FIX (AUDIT-BUG-5): FIRST statement — transaction-scoped PostgreSQL advisory
      // lock keyed on monthKey (SAME key space as processIngestion, so full-file
      // /api/ingest imports and per-week /api/ingest-process imports of the same
      // month serialize against each other, ACROSS serverless instances — the
      // old in-process Set lock never covered this route). xact-scoped → released
      // automatically at COMMIT/ROLLBACK, even on crash.
      await acquireDbAdvisoryLock(tx, monthKeyForTx);

      // FIX (AUDIT-BUG-1 + AUDIT-BUG-5): resolve the existing Week INSIDE the
      // transaction, AFTER the advisory lock. Resolving it before the lock used
      // a stale snapshot when a concurrent import of the same month committed
      // while we waited for the lock → tx.week.delete below would target an
      // already-deleted week (P2025 abort) or leave the old week in place.
      const existingWeek = await tx.week.findFirst({
        where: { monthKey: monthKeyForTx, weekLabel },
        select: { id: true, sourceFileId: true },
      });

      if (existingWeek && existingWeek.sourceFileId !== sourceFile.id) {
        // FIX (AUDIT-BUG-1): a DIFFERENT file owns the old Week for this
        // (monthKey, weekLabel) — purge it so the new file becomes the
        // single source of truth for this (month, week). The old code only
        // deleted the NEW file's week records, leaving BOTH weeks in place
        // (Week.weekKey "unique" existed only in a comment) → every
        // period-filtered aggregate double-counted.
        await tx.inventoryRecord.deleteMany({ where: { weekId: existingWeek.id } });
        // Old file's precomputed sales MODE for this weekLabel (a SourceFile
        // belongs to ONE month, so (sourceFileId, weekLabel) pins exactly this
        // period). Outlets covered by the new import are re-inserted by
        // computeOutletPeriodSales inside processRowsForImport (ON CONFLICT
        // latest-wins); deleting here prevents stale rows for outlets the new
        // import no longer contains.
        await tx.outletPeriodSales.deleteMany({
          where: { sourceFileId: existingWeek.sourceFileId, weekLabel },
        });
        await tx.week.delete({ where: { id: existingWeek.id } });
        // Delete the old SourceFile if it has no weeks left (fully superseded
        // file) — its DQIssues cascade-delete with it.
        const remainingWeeks = await tx.week.count({ where: { sourceFileId: existingWeek.sourceFileId } });
        if (remainingWeeks === 0) {
          await tx.dQIssue.deleteMany({ where: { sourceFileId: existingWeek.sourceFileId } });
          await tx.sourceFile.delete({ where: { id: existingWeek.sourceFileId } });
        }
      }

      // Create Week record — upsert to handle re-uploads (same-file re-import:
      // the purge above was skipped because existingWeek.sourceFileId ===
      // sourceFile.id, so this upsert finds no conflicting week).
      // FIX (AUDIT-BUG-1): runs AFTER the cross-file purge (see comment above
      // the transaction) and rolls back with the import on failure.
      // FIX: CUMULATIVE periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
      const weekRec = await tx.week.upsert({
        where: { sourceFileId_weekLabel: { sourceFileId: sourceFile.id, weekLabel } },
        update: {
          weekKey: `${monthKeyForTx}-${weekLabel.replace(/\s+/g, '')}`,
          monthKey: monthKeyForTx, periodStart: p.start, periodEnd: p.end,
        },
        create: {
          sourceFileId: sourceFile.id, weekLabel,
          weekKey: `${monthKeyForTx}-${weekLabel.replace(/\s+/g, '')}`,
          monthKey: monthKeyForTx, periodStart: p.start, periodEnd: p.end,
        },
      });

      await tx.inventoryRecord.deleteMany({
        where: { sourceFileId: sourceFile.id, weekId: weekRec.id },
      });
      return processRowsForImport(
        weekRows,
        sourceFile.id,
        weekRec.id,
        ctx.fileName,
        monthLabelForTx,
        0,
        outletDbMap,
        itemDbMap,
        seenKeys,
        true, // fastMode: skip DQ validation — pure import for speed
        ctx.locale, // numberLocale: 'auto' | 'id' | 'us' for CSV separator parsing
        tx, // pass transaction client so createMany uses the same transaction
      );
    },
    { timeout: 240_000, maxWait: 10_000 },
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

  // FIX (DEEP-AUDIT-API-1, DEEP-AUDIT-FLOW-1): clear BOTH caches after import.
  // analysisCache was already cleared; statusCache must also be cleared because
  // /api/status returns month/file/row counts in its dropdown payload — without
  // this, the dashboard month dropdown stays stale for up to 5 min after upload.
  statusCache.clear();
  // FIX H1 (AUDIT-5/8): invalidate DB-level AggregationCache after week import.
  // Without this, /api/analysis serves stale data for up to 5 min (TTL).
  // PERF-CACHE-05: await invalidation (was fire-and-forget) — guarantees the
  // client's next read after the mutation returns sees fresh data.
  await invalidateAnalysisCache();
  // FIX-DEEP-1C: clear monthResolver cache so subsequent requests see the new
  // monthLabel added by this import. Without this, getMonthResolver() would
  // keep returning the pre-import resolver and the new month's case might
  // not be in the resolver's `exact` set → resolveMonthLabel would fall back
  // to the (possibly different-case) input label → potential mismatch.
  clearMonthResolverCache();

  // FIX (BUG2-INGEST-2): Clean up FileChunk rows for this fileHash after
  // successful import. Previously, only `import-all` mode cleaned up chunks
  // (see import-all-mode.ts). The `import` mode reassembles the file from DB
  // chunks, parses it, imports the week, and deletes the temp file — but
  // NEVER deleted the FileChunk rows. Each chunk is up to 5MB, so a 50MB
  // file left 50MB of orphaned Bytes data in the DB. Over time, this
  // bloats the database. The frontend (FileUploadDialog) always uses
  // `import-all`, so this is a latent bug for programmatic API callers.
  // Now both modes clean up chunks after successful import.
  await db.fileChunk.deleteMany({ where: { fileHash: ctx.safeFileHash } }).catch(() => {});

  return NextResponse.json({
    success: true,
    mode: 'import',
    weekLabel,
    status: 'IMPORTED',
    rowCount: inserted,
    dqErrors: dq.severityCounts.ERROR,
    dqWarnings: dq.severityCounts.WARNING,
    durationMs: Date.now() - ctx.startedAt,
  });
}
