// ============================================================
//  /api/data — Data management API
//  GET    : list all SourceFiles with row counts (for management UI)
//  DELETE : delete data by month, by fileId, or all (cascade)
//
//  Cascade order (respects FK constraints):
//    DQIssue → InventoryRecord → Week → SourceFile
//
//  After delete: clear analysisCache + statusCache + audit log entry
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { analysisCache, statusCache } from '@/lib/cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const deleteQuerySchema = z
  .object({
    month: z.string().max(50).optional(),       // legacy: monthLabel (resolved to monthKey server-side)
    monthKey: z.string().max(10).optional(),     // preferred: "YYYY-MM" (case-insensitive)
    fileId: z.coerce.number().int().optional(),
    all: z.enum(['true', '1', 'yes']).optional(),
    confirm: z.enum(['true', '1', 'yes']).optional(),
  })
  .strict();

// ------------------------------------------------------------
//  GET /api/data — list all SourceFiles grouped by month
//  ?fileId=N — include DQ issues detail for that file
// ------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const fileIdParam = url.searchParams.get('fileId');

    // If fileId specified, return DQ issues for that file
    if (fileIdParam) {
      const fileId = parseInt(fileIdParam);
      if (isNaN(fileId)) {
        return NextResponse.json({ success: false, error: 'fileId tidak valid' }, { status: 400 });
      }
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
      });
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
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
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
    const params = Object.fromEntries(url.searchParams.entries());
    const parsed = deleteQuerySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.message },
        { status: 400 }
      );
    }
    const data = parsed.data;

    let deletedRecords = 0;
    let deletedFiles = 0;
    let deletedWeeks = 0;
    let detail = '';

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

      // FIX (BUG 1): Wrap cascade in transaction for atomicity
      await db.$transaction([
        db.dQIssue.deleteMany(),
        db.inventoryRecord.deleteMany(),
        db.week.deleteMany(),
        db.sourceFile.deleteMany(),
      ]);

      detail = 'Reset SEMUA data (nuclear)';
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
      await db.$transaction([
        db.dQIssue.deleteMany({ where: { sourceFileId: { in: fileIds } } }),
        db.inventoryRecord.deleteMany({ where: { sourceFileId: { in: fileIds } } }),
        db.week.deleteMany({ where: { sourceFileId: { in: fileIds } } }),
        db.sourceFile.deleteMany({ where: { id: { in: fileIds } } }),
      ]);
      deletedFiles = fileIds.length;

      // Use the first file's monthLabel (canonical) for the audit detail; if multiple case variants
      // existed, they are now all deleted — pick any one for display.
      const displayLabel = files[0]?.monthLabel ?? monthKeyToDelete;
      detail = `Hapus bulan ${displayLabel} [${monthKeyToDelete}] (${deletedFiles} file, ${deletedRecords} record, ${deletedWeeks} week)`;
    } else if (data.fileId) {
      // Delete a single SourceFile by ID — cascade
      const file = await db.sourceFile.findUnique({
        where: { id: data.fileId },
        select: { id: true, fileName: true, monthLabel: true },
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
      await db.$transaction([
        db.dQIssue.deleteMany({ where: { sourceFileId: file.id } }),
        db.inventoryRecord.deleteMany({ where: { sourceFileId: file.id } }),
        db.week.deleteMany({ where: { sourceFileId: file.id } }),
        db.sourceFile.delete({ where: { id: file.id } }),
      ]);
      deletedFiles = 1;

      detail = `Hapus file ID ${file.id} (${file.fileName}, ${file.monthLabel}) — ${deletedRecords} record, ${deletedWeeks} week`;
    } else {
      return NextResponse.json(
        { success: false, error: 'Parameter diperlukan: monthKey, month, fileId, atau all' },
        { status: 400 }
      );
    }

    // Clear caches so subsequent reads see fresh state
    analysisCache.clear();
    statusCache.clear();
    // FIX-DEEP-1C: clear monthResolver cache so subsequent requests see the
    // updated SourceFile set. Without this, getMonthResolver() would keep
    // returning a resolver that includes the now-deleted monthLabel, and
    // resolveMonthLabel might map a future re-import of the same month to
    // the old (now-deleted) DB-case label.
    clearMonthResolverCache();

    await db.auditLog.create({
      data: {
        action: 'DATA_DELETE',
        detail,
      },
    });

    return NextResponse.json({
      success: true,
      deleted: { sourceFiles: deletedFiles, records: deletedRecords, weeks: deletedWeeks },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
