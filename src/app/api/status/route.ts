// ============================================================
//  /api/status — list available months, weeks, outlets, areas, pics
//  Resilient to missing tables (returns empty state, not 500)
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const EMPTY_STATE = {
  success: true,
  files: [],
  months: [],
  weeksByMonth: {},
  outlets: [],
  areas: [],
  pics: [],
  stats: { totalFiles: 0, totalOutlets: 0, totalItems: 0, totalRecords: 0 },
  warning: 'Database tables not created yet. Visit /api/setup to initialize.',
};

export async function GET() {
  try {
    const files = await db.sourceFile.findMany({
      orderBy: { monthKey: 'asc' },
      select: { fileName: true, monthLabel: true, monthKey: true, rowCount: true, dqStatus: true, importedAt: true },
    });

    const weeks = await db.week.findMany({
      orderBy: { weekLabel: 'asc' },
      select: { weekLabel: true, monthKey: true, periodStart: true, periodEnd: true },
    });

    // LEFT JOIN OutletPIC so each outlet includes its PIC (if any)
    const outlets = await db.outlet.findMany({
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        area: true,
      },
    });

    // Fetch PIC assignments (OutletPIC table)
    let outletPics: Array<{ outletCode: string; pic: string }> = [];
    try {
      const picRows = await db.outletPIC.findMany({ select: { outletCode: true, pic: true } });
      outletPics = picRows.map((r) => ({ outletCode: r.outletCode, pic: r.pic }));
    } catch {
      // OutletPIC table may not exist — treat as no PICs
    }
    const picMap = new Map(outletPics.map((p) => [p.outletCode, p.pic]));

    // Merge outlets with PIC
    const outletsWithPic = outlets.map((o) => ({ ...o, pic: picMap.get(o.code) || null }));

    const areas = [...new Set(outlets.map((o) => o.area))].sort();
    const pics = [...new Set(outletPics.map((p) => p.pic).filter(Boolean))].sort();

    const itemsCount = await db.item.count();
    const recordsCount = await db.inventoryRecord.count();

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
      outlets: outletsWithPic,
      areas,
      pics,
      stats: {
        totalFiles: files.length,
        totalOutlets: outlets.length,
        totalItems: itemsCount,
        totalRecords: recordsCount,
      },
    });
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    // If tables don't exist, return empty state (not error 500)
    if (errMsg.includes('does not exist') || errMsg.includes('relation') || errMsg.includes('table') || errMsg.includes('no such table')) {
      return NextResponse.json(EMPTY_STATE);
    }
    console.error('[/api/status] Error:', errMsg);
    return NextResponse.json({ success: false, error: errMsg, hint: 'Try visiting /api/setup to create database tables.' }, { status: 500 });
  }
}
