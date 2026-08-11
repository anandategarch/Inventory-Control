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
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const deleteQuerySchema = z
  .object({
    month: z.string().max(50).optional(),
    fileId: z.coerce.number().int().optional(),
    all: z.enum(['true', '1', 'yes']).optional(),
    confirm: z.enum(['true', '1', 'yes']).optional(),
  })
  .strict();

// ------------------------------------------------------------
//  GET /api/data — list all SourceFiles grouped by month
// ------------------------------------------------------------
export async function GET() {
  try {
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

    // Group by monthLabel for the UI
    const byMonth: Record<string, { monthLabel: string; monthKey: string; fileCount: number; totalRows: number }> = {};
    for (const f of files) {
      if (!byMonth[f.monthLabel]) {
        byMonth[f.monthLabel] = { monthLabel: f.monthLabel, monthKey: f.monthKey, fileCount: 0, totalRows: 0 };
      }
      byMonth[f.monthLabel].fileCount += 1;
      byMonth[f.monthLabel].totalRows += f.rowCount;
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

      await db.dQIssue.deleteMany();
      await db.inventoryRecord.deleteMany();
      await db.week.deleteMany();
      await db.sourceFile.deleteMany();

      detail = 'Reset SEMUA data (nuclear)';
    } else if (data.month) {
      // Delete all SourceFiles for this monthLabel — cascade
      const files = await db.sourceFile.findMany({
        where: { monthLabel: data.month },
        select: { id: true },
      });
      const fileIds = files.map((f) => f.id);

      if (fileIds.length === 0) {
        return NextResponse.json({
          success: true,
          deleted: { sourceFiles: 0, records: 0, weeks: 0 },
          message: `Tidak ada file untuk bulan ${data.month}`,
        });
      }

      await db.dQIssue.deleteMany({ where: { sourceFileId: { in: fileIds } } });
      deletedRecords = await db.inventoryRecord.count({ where: { sourceFileId: { in: fileIds } } });
      await db.inventoryRecord.deleteMany({ where: { sourceFileId: { in: fileIds } } });
      deletedWeeks = await db.week.count({ where: { sourceFileId: { in: fileIds } } });
      await db.week.deleteMany({ where: { sourceFileId: { in: fileIds } } });
      await db.sourceFile.deleteMany({ where: { id: { in: fileIds } } });
      deletedFiles = fileIds.length;

      detail = `Hapus bulan ${data.month} (${deletedFiles} file, ${deletedRecords} record, ${deletedWeeks} week)`;
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

      await db.dQIssue.deleteMany({ where: { sourceFileId: file.id } });
      deletedRecords = await db.inventoryRecord.count({ where: { sourceFileId: file.id } });
      await db.inventoryRecord.deleteMany({ where: { sourceFileId: file.id } });
      deletedWeeks = await db.week.count({ where: { sourceFileId: file.id } });
      await db.week.deleteMany({ where: { sourceFileId: file.id } });
      await db.sourceFile.delete({ where: { id: file.id } });
      deletedFiles = 1;

      detail = `Hapus file ID ${file.id} (${file.fileName}, ${file.monthLabel}) — ${deletedRecords} record, ${deletedWeeks} week`;
    } else {
      return NextResponse.json(
        { success: false, error: 'Parameter diperlukan: month, fileId, atau all' },
        { status: 400 }
      );
    }

    // Clear caches so subsequent reads see fresh state
    analysisCache.clear();
    statusCache.clear();

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
