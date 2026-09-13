// ============================================================
//  import-all-mode — MODE 3 of POST /api/ingest-process
//  --------------------------------------------------------
//  Extracted from the original 963-line route.ts (REFACTOR-1-a
//  pure-move split). Reassemble + parse ONCE, import ALL weeks in
//  one request (each under a transaction-scoped advisory lock).
//  FIX: previously each week was imported via separate 'import'
//  call, causing reassemble + parse for EACH week (3x for 3 weeks
//  = 3x slow). This mode does it all in one request → 3x faster,
//  no 504 timeout. The shared request preamble lives in route.ts;
//  everything after `if (mode === 'import-all')` lives here.
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

export async function handleImportAll(ctx: IngestProcessContext): Promise<NextResponse> {
  const weeksToImport: string[] = (ctx.body.weeksToImport as string[]) || [];
  if (weeksToImport.length === 0) {
    return NextResponse.json(
      { success: false, error: 'weeksToImport array required for import-all mode' },
      { status: 400 }
    );
  }

  logger.info(`[ingest-process] import-all ${weeksToImport.length} weeks for ${ctx.fileName}`);

  // Reassemble ONCE
  let filePath: string;
  try {
    // PERF-UPLOAD-5: detect (same or previous invocation) already left the
    // reassembled file at the content-addressed /tmp path — reuse it and
    // skip re-downloading every chunk from Postgres (up to 50MB).
    const reused = await reuseTempFile(ctx.safeFileHash, ctx.fileExt, parseInt(String(ctx.fileSize || 0), 10));
    filePath = reused ?? (await reassembleFile(ctx.safeFileHash, ctx.fileExt));
    logger.info(`[ingest-process] ${reused ? 'reused temp file' : 'reassembled'}: ${filePath}`);
  } catch (e: unknown) {
    const err = e as Error;
    logger.error("[ingest-process] reassemble failed", { error: err });
    return NextResponse.json(
      { success: false, error: `Gagal reassemble file: ${err?.message}` },
      { status: 500 }
    );
  }

  // Parse ONCE
  let parsed;
  try {
    parsed = await parseExcelFile(filePath);
    logger.info(`[ingest-process] parsed ${parsed.sheets.length} sheets`);
  } catch (e: unknown) {
    const err = e as Error;
    logger.error("[ingest-process] parse failed", { error: err });
    await fs.unlink(filePath).catch(() => {});
    return NextResponse.json(
      { success: false, error: `Gagal parse Excel: ${err?.message}` },
      { status: 500 }
    );
  }

  // Extract month if needed
  if (!ctx.manualMode && (ctx.fileNameIsPlaceholder || !ctx.monthInfo)) {
    const allRows: Array<Record<string, unknown>> = [];
    for (const sheet of parsed.sheets) {
      allRows.push(...sheet.rows);
    }
    const extractedMonth = extractMonthFromRows(allRows);
    if (extractedMonth) {
      ctx.fileName = `${extractedMonth}.xlsx`;
      ctx.monthInfo = parseMonthFromFilename(ctx.fileName);
    }
  }

  if (!ctx.monthInfo) {
    await fs.unlink(filePath).catch(() => {});
    return NextResponse.json(
      { success: false, error: `Nama file tidak sesuai format: "${ctx.fileName}"` },
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

    // Create SourceFile per week — upsert to handle re-uploads (fileName is @unique)
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

    // FIX (AUDIT-BUG-1): resolve existing Week by (monthKey, weekLabel) — a
    // previous import under a different fileName must NOT create a second
    // Week for the same period (doubles every aggregate). Replace the old
    // week's data instead.
    // FIX (AUDIT-BUG-5): the findFirst itself moved INSIDE the transaction
    // (after the advisory lock) — see the comment there.

    // Cumulative periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
    // FIX (AUDIT-BUG-1): the Week upsert itself moved INSIDE the transaction
    // below — it must run AFTER the cross-file purge, otherwise the new
    // @@unique([monthKey, weekLabel]) constraint rejects the create with
    // P2002 while the old cross-file week still exists.
    const p = CFG_RECON_SETTINGS.WEEK_PERIODS[weekLabel] || { start: 1, end: Math.min(parseInt(weekLabel.replace(/\D/g, '')) * 7, 31) };

    // FIX (BUG2-INGEST-3): Wrap deleteMany + processRowsForImport in a single
    // transaction so that if createMany fails, the deleteMany is rolled back.
    // Same rationale as `import` mode above. Without this, a
    // createMany failure mid-week would leave the week with 0 records.
    // Capture monthLabel before the transaction — `monthInfo` is a `let`, so TS
    // narrowing from the `if (!monthInfo) return` guard doesn't carry into closures.
    const monthLabelForTx = ctx.monthInfo.monthLabel;
    // FIX (AUDIT-BUG-1): capture monthKey too — the Week upsert now runs
    // inside the transaction closure (see above).
    const monthKeyForTx = ctx.monthInfo.monthKey;
    const result = await db.$transaction(
      async (tx) => {
        // FIX (AUDIT-BUG-5): FIRST statement — transaction-scoped PostgreSQL
        // advisory lock keyed on monthKey (same key space as `import` mode and
        // processIngestion — all writers of a month serialize, cross-instance).
        // xact-scoped → released automatically at COMMIT/ROLLBACK, even on crash.
        await acquireDbAdvisoryLock(tx, monthKeyForTx);

        // FIX (AUDIT-BUG-1 + AUDIT-BUG-5): resolve the existing Week INSIDE the
        // transaction, AFTER the advisory lock (stale-snapshot fix — same
        // rationale as `import` mode above).
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
          // Old file's precomputed sales MODE for this weekLabel (a
          // SourceFile belongs to ONE month, so (sourceFileId, weekLabel)
          // pins exactly this period). Outlets covered by the new import
          // are re-inserted by computeOutletPeriodSales inside
          // processRowsForImport (ON CONFLICT latest-wins).
          await tx.outletPeriodSales.deleteMany({
            where: { sourceFileId: existingWeek.sourceFileId, weekLabel },
          });
          await tx.week.delete({ where: { id: existingWeek.id } });
          // Delete the old SourceFile if it has no weeks left (fully
          // superseded file) — its DQIssues cascade-delete with it.
          const remainingWeeks = await tx.week.count({ where: { sourceFileId: existingWeek.sourceFileId } });
          if (remainingWeeks === 0) {
            await tx.dQIssue.deleteMany({ where: { sourceFileId: existingWeek.sourceFileId } });
            await tx.sourceFile.delete({ where: { id: existingWeek.sourceFileId } });
          }
        }

        // Create Week record — upsert to handle re-uploads (same-file
        // re-import: the purge above was skipped because
        // existingWeek.sourceFileId === sourceFile.id).
        // FIX (AUDIT-BUG-1): runs AFTER the cross-file purge (see comment
        // above the transaction) and rolls back with the import on failure.
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
          weekRows, sourceFile.id, weekRec.id, ctx.fileName,
          monthLabelForTx, 0, outletDbMap, itemDbMap, seenKeys,
          true, ctx.locale, tx,
        );
      },
      { timeout: 240_000, maxWait: 10_000 },
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

    logger.info(`[ingest-process] ${weekLabel}: ${result.inserted} rows (${((Date.now() - weekStart) / 1000).toFixed(1)}s)`);
  }

  // Clear caches
  statusCache.clear();
  // FIX H1 (AUDIT-5/8): invalidate DB-level AggregationCache after import-all.
  // PERF-CACHE-05: await invalidation (was fire-and-forget) — guarantees the
  // client's next read after the mutation returns sees fresh data.
  await invalidateAnalysisCache();
  clearMonthResolverCache();

  // Cleanup chunks
  await db.fileChunk.deleteMany({ where: { fileHash: ctx.safeFileHash } }).catch(() => {});

  return NextResponse.json({
    success: true,
    mode: 'import-all',
    totalInserted,
    importedWeeks,
    durationMs: Date.now() - ctx.startedAt,
  });
}
