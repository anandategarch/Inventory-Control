// ============================================================
//  /api/status — list available months, weeks, outlets, areas
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Ensure database tables exist (auto-migration)
    
    const files = await db.sourceFile.findMany({
      orderBy: { monthKey: 'asc' },
      select: { fileName: true, monthLabel: true, monthKey: true, rowCount: true, dqStatus: true, importedAt: true },
    });

    const weeks = await db.week.findMany({
      orderBy: { weekLabel: 'asc' },
      select: { weekLabel: true, monthKey: true, periodStart: true, periodEnd: true },
    });

    const outlets = await db.outlet.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true, area: true },
    });

    const areas = [...new Set(outlets.map((o) => o.area))].sort();

    const itemsCount = await db.item.count();
    const recordsCount = await db.inventoryRecord.count();

    // Group weeks by month
    const weeksByMonth: Record<string, string[]> = {};
    for (const w of weeks) {
      if (!weeksByMonth[w.monthKey]) weeksByMonth[w.monthKey] = [];
      if (!weeksByMonth[w.monthKey].includes(w.weekLabel)) weeksByMonth[w.monthKey].push(w.weekLabel);
    }
    for (const k of Object.keys(weeksByMonth)) weeksByMonth[k].sort();

    return NextResponse.json({
      success: true,
      files,
      months: files.map((f) => ({ label: f.monthLabel, key: f.monthKey })),
      weeksByMonth,
      outlets,
      areas,
      stats: {
        totalFiles: files.length,
        totalOutlets: outlets.length,
        totalItems: itemsCount,
        totalRecords: recordsCount,
      },
    });
  } catch (e: any) {
    // If tables don't exist, return empty state (not error 500)
    // This handles fresh PostgreSQL where db:push hasn't run yet
    const errMsg = e?.message || String(e);
    if (errMsg.includes('does not exist') || errMsg.includes('relation') || errMsg.includes('table')) {
      return NextResponse.json({
        success: true,
        files: [],
        months: [],
        weeksByMonth: {},
        outlets: [],
        areas: [],
        stats: { totalFiles: 0, totalOutlets: 0, totalItems: 0, totalRecords: 0 },
        warning: 'Database tables not created yet. Run db:push or trigger an import.',
      });
    }
    return NextResponse.json({ success: false, error: errMsg }, { status: 500 });
  }
}
