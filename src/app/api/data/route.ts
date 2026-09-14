// ============================================================
//  /api/data — Data management API
//  GET    : list all SourceFiles with row counts (for management UI)
//  DELETE : delete data by month, by fileId, or all (cascade)
//
//  Cascade order (respects FK constraints):
//    DQIssue → InventoryRecord → Week → SourceFile
//
//  After delete: clear statusCache + invalidateAnalysisCache + clearMonthResolverCache
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { validateQuery, dataDeleteQuerySchema, dataGetQuerySchema } from '@/lib/validation';
import { CACHE_METADATA, CACHE_INTERACTIVE } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
// PERF-DELETE-1: was 30s — deleting a month (~54-100K records) or ALL
// (~306K records, 16 indexes on InventoryRecord) can exceed 30s on the
// Supabase pooler. Vercel then killed the function mid-transaction → client
// timeout → user retried → 429 "tunggu beberapa menit" ("hapus juga lama").
// 300s matches /api/ingest-process, the other heavy mutation route.
export const maxDuration = 300;

// ------------------------------------------------------------
//  GET /api/data — list all SourceFiles grouped by month
//  ?fileId=N — include DQ issues detail for that file
// ------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    // FIX (AUDIT8-ROLLBACK-1, Item 9): Zod input validation for GET /api/data.
    // Previously only DELETE was validated — GET just did `parseInt(fileIdParam)`
    // + `isNaN` check, which accepts non-numeric strings as NaN (returning 400
    // but only after parsing) and silently allows negative / over-large fileIds.
    // Now we coerce to a positive int upfront; the isNaN guard below becomes a
    // belt-and-suspenders check (the Zod schema already enforces positive int).
    const validation = validateQuery(dataGetQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const fileId = validation.data.fileId;

    // If fileId specified, return DQ issues for that file
    if (fileId) {
      const dqIssues = await db.dQIssue.findMany({
        where: { sourceFileId: fileId },
        select: { severity: true, code: true, message: true, rowNumber: true, rawValue: true },
        orderBy: [{ severity: 'asc' }, { rowNumber: 'asc' }],
        take: 200,
      });
      // Group by code for summary
      const byCode: Record<string, { severity: string; code: string; message: string; count: number }> = {};
      for (const d of dqIssues) {
        if (!byCode[d.code]) {
          byCode[d.code] = { severity: d.severity, code: d.code, message: d.message, count: 0 };
        }
        byCode[d.code].count++;
      }
      return NextResponse.json({
        success: true,
        issues: dqIssues,
        summary: Object.values(byCode).sort((a, b) => b.count - a.count),
      }, { headers: CACHE_INTERACTIVE });
    }

    const files = await db.sourceFile.findMany({
      orderBy: [{ monthKey: 'desc' }, { importedAt: 'desc' }],
      select: {
        id: true,
        fileName: true,
        monthLabel: true,
        monthKey: true,
        rowCount: true,
        dqStatus: true,
        dqErrorCount: true,
        dqWarningCount: true,
        importedAt: true,
      },
    });

    // Group by monthKey (FIX DEEP-AUDIT-API-4): grouping by monthLabel is case-sensitive,
    // so a mixed-case DB (e.g., "Juli 2026" + "JULI 2026" for the same month) would produce
    // duplicate month entries in the UI dropdown. monthKey is always "YYYY-MM" so it is
    // naturally case-stable.
    const byMonth: Record<string, { monthLabel: string; monthKey: string; fileCount: number; totalRows: number }> = {};
    for (const f of files) {
      if (!byMonth[f.monthKey]) {
        byMonth[f.monthKey] = { monthLabel: f.monthLabel, monthKey: f.monthKey, fileCount: 0, totalRows: 0 };
      }
      byMonth[f.monthKey].fileCount += 1;
      byMonth[f.monthKey].totalRows += f.rowCount;
    }

    return NextResponse.json({
      success: true,
      files,
      months: Object.values(byMonth).sort((a, b) => b.monthKey.localeCompare(a.monthKey)),
    }, { headers: CACHE_METADATA });
  } catch (e: unknown) {
    return errorResponse(e, "data");
  }
}

// ------------------------------------------------------------
//  DELETE /api/data — cascade delete by month / fileId / all
// ------------------------------------------------------------
export async function DELETE(req: NextRequest) {
  try {
    // FIX (DEEP-AUDIT-API-5): Rate limit destructive delete endpoint
    const ip = getClientIP(req);
    const rl = rateLimit(`data:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Penghapusan adalah operasi berat, tunggu beberapa menit.' },
        { status: 429 }
      );
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation (replaces inline schema — kept behavior identical)
    const validation = validateQuery(dataDeleteQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const data = validation.data;

    let deletedRecords = 0;
    let deletedFiles = 0;
    let deletedWeeks = 0;

    if (data.all) {
      // Nuclear option — require confirm param
      if (!data.confirm) {
        return NextResponse.json(
          {
            success: false,
            error: 'Konfirmasi diperlukan. Tambahkan ?all=true&confirm=true untuk reset semua data.',
          },
          { status: 400 }
        );
      }

      // Capture counts BEFORE delete (so we can return them)
      deletedFiles = await db.sourceFile.count();
      deletedRecords = await db.inventoryRecord.count();
      deletedWeeks = await db.week.count();

      // PERF-DELETE-2: single atomic TRUNCATE instead of four deleteMany.
      // DELETE walks every row and removes its entry from EVERY index —
      // InventoryRecord alone has ~16 indexes (12 @@index + unique + NULL-safe
      // + INCLUDE covering), so "reset semua" (~306K rows) performed millions
      // of index-tuple deletions in one transaction: tens of seconds + heavy
      // WAL. TRUNCATE is metadata-level (O(1) regardless of row count), still
      // fully atomic, and resets nothing else — sequence values are preserved
      // (ids continue like the old DELETE path).
      // All five tables are truncated together so FK references (Week →
      // SourceFile, InventoryRecord → Week/SourceFile, DQIssue → SourceFile,
      // OutletPeriodSales → SourceFile) are satisfied without CASCADE.
      // Outlet/Item are intentionally NOT truncated (Restrict FKs from
      // InventoryRecord — truncating InventoryRecord is allowed without
      // touching them, and they are master data, not imported data).
      // Table names are static identifiers — no injection surface.
      //
      // FIX (BUG-3-c R-6a): "FileChunk" added to the TRUNCATE list. FileChunk
      // holds raw upload chunks (up to 50MB per hash) with NO FK to the other
      // tables — a full reset used to leave every chunk row behind, so the
      // only cleanup was DB-SIZE-1's 24h orphan TTL. After a "reset semua"
      // the table should genuinely be empty (matches the month/fileId DELETE
      // branches, whose delete-mode counterparts clean their chunks).
      //
      // FIX (BUG-3-c R-6b): same pg_advisory_xact_lock pattern as the month /
      // fileId branches — serialize a full reset against concurrent imports
      // (chunk upserts + week imports) so a racing import can't resurrect
      // rows into freshly truncated tables. The lock key is a fixed literal
      // ("data-delete-all") — separate key space from per-month locks, and
      // xact-scoped so it auto-releases at COMMIT/ROLLBACK.
      await db.$transaction([
        db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('data-delete-all'))`,
        db.$executeRawUnsafe(
          'TRUNCATE TABLE "DQIssue", "InventoryRecord", "Week", "SourceFile", "OutletPeriodSales", "FileChunk"',
        ),
      ]);
    } else if (data.monthKey || data.month) {
      // Delete all SourceFiles for this month — cascade.
      // FIX (DEEP-AUDIT-API-3, DEEP-AUDIT-FLOW-7): query by monthKey, NOT monthLabel.
      // monthLabel is case-sensitive ("Juli 2026" vs "JULI 2026"); a mixed-case DB would
      // only delete one case variant, leaving the other behind. monthKey is always
      // "YYYY-MM" so case is irrelevant.
      //
      // Preferred path: caller passes `monthKey` directly (e.g., "2026-07").
      // Legacy path: caller passes `month` (a monthLabel). We resolve it to monthKey
      // via a case-insensitive lookup on SourceFile, then delete by monthKey.
      let monthKeyToDelete = data.monthKey;
      if (!monthKeyToDelete && data.month) {
        const sample = await db.sourceFile.findFirst({
          where: { monthLabel: { equals: data.month, mode: 'insensitive' } },
          select: { monthKey: true },
        });
        if (!sample) {
          return NextResponse.json({
            success: true,
            deleted: { sourceFiles: 0, records: 0, weeks: 0 },
            message: `Tidak ada file untuk bulan ${data.month}`,
          });
        }
        monthKeyToDelete = sample.monthKey;
      }

      const files = await db.sourceFile.findMany({
        where: { monthKey: monthKeyToDelete },
        select: { id: true, monthLabel: true },
      });
      const fileIds = files.map((f) => f.id);

      if (fileIds.length === 0) {
        return NextResponse.json({
          success: true,
          deleted: { sourceFiles: 0, records: 0, weeks: 0 },
          message: `Tidak ada file untuk monthKey ${monthKeyToDelete}`,
        });
      }

      // FIX (BUG 1): Capture counts BEFORE, then wrap deletes in transaction
      deletedRecords = await db.inventoryRecord.count({ where: { sourceFileId: { in: fileIds } } });
      deletedWeeks = await db.week.count({ where: { sourceFileId: { in: fileIds } } });
      // PERF-DELETE-3: advisory lock on the same key space as imports
      // (pg_advisory_xact_lock(hashtext(monthKey)) — see
      // src/lib/ingestion/ingestion-lock.ts). Without it, a DELETE of a
      // month racing a concurrent import of the SAME month interleaves:
      // import deletes+inserts inside its transaction while the delete's
      // deleteMany runs → the final state depends on commit order (the
      // "deleted" month can partially resurrect). xact-scoped → auto-released
      // at COMMIT/ROLLBACK even if the function dies mid-transaction.
      await db.$transaction([
        db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${monthKeyToDelete}))`,
        db.dQIssue.deleteMany({ where: { sourceFileId: { in: fileIds } } }),
        db.inventoryRecord.deleteMany({ where: { sourceFileId: { in: fileIds } } }),
        db.week.deleteMany({ where: { sourceFileId: { in: fileIds } } }),
        db.sourceFile.deleteMany({ where: { id: { in: fileIds } } }),
      ]);
      deletedFiles = fileIds.length;
    } else if (data.fileId) {
      // Delete a single SourceFile by ID — cascade
      const file = await db.sourceFile.findUnique({
        where: { id: data.fileId },
        select: { id: true, fileName: true, monthLabel: true, monthKey: true },
      });
      if (!file) {
        return NextResponse.json(
          { success: false, error: 'File tidak ditemukan' },
          { status: 404 }
        );
      }

      // FIX (BUG 1): Capture counts BEFORE, then wrap deletes in transaction
      deletedRecords = await db.inventoryRecord.count({ where: { sourceFileId: file.id } });
      deletedWeeks = await db.week.count({ where: { sourceFileId: file.id } });
      // PERF-DELETE-3: advisory lock on the file's monthKey — same key space
      // as imports (see month-branch comment + ingestion-lock.ts) so a delete
      // can't interleave with a concurrent import of the same month.
      await db.$transaction([
        db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${file.monthKey}))`,
        db.dQIssue.deleteMany({ where: { sourceFileId: file.id } }),
        db.inventoryRecord.deleteMany({ where: { sourceFileId: file.id } }),
        db.week.deleteMany({ where: { sourceFileId: file.id } }),
        db.sourceFile.delete({ where: { id: file.id } }),
      ]);
      deletedFiles = 1;
    } else {
      return NextResponse.json(
        { success: false, error: 'Parameter diperlukan: monthKey, month, fileId, atau all' },
        { status: 400 }
      );
    }

    // Clear caches so subsequent reads see fresh state
    statusCache.clear();
    // FIX Medium #1: invalidate DB-level AggregationCache too.
    // PERF-CACHE-05: await invalidation (was fire-and-forget) — guarantees the
    // client's next read after the mutation returns sees fresh data.
    await invalidateAnalysisCache();
    // FIX-DEEP-1C: clear monthResolver cache so subsequent requests see the
    // updated SourceFile set. Without this, getMonthResolver() would keep
    // returning a resolver that includes the now-deleted monthLabel, and
    // resolveMonthLabel might map a future re-import of the same month to
    // the old (now-deleted) DB-case label.
    clearMonthResolverCache();

    return NextResponse.json({
      success: true,
      deleted: { sourceFiles: deletedFiles, records: deletedRecords, weeks: deletedWeeks },
    });
  } catch (e: unknown) {
    return errorResponse(e, "data");
  }
}
