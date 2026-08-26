// ============================================================
//  /api/status — list available months, weeks, outlets, areas, pics
//  Phase 1c: server-side cache (5 min TTL) to reduce DB queries
//  Resilient to missing tables (returns empty state, not 500)
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { statusCache } from '@/lib/cache';
import { validateQuery, statusQuerySchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

// Phase 1c: cache status response for 5 minutes (shared instance from lib/cache)
// so that other routes (/api/data, /api/pic) can clear it after mutations.

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

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    // Sprint 1: Zod input validation (no params expected)
    const validation = validateQuery(statusQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // Phase 1c: check cache first
    const cached = statusCache.get('status');
    if (cached) {
      return NextResponse.json({ ...(cached as object), cached: true });
    }

    const files = await db.sourceFile.findMany({
      orderBy: { monthKey: 'asc' },
      select: { fileName: true, monthLabel: true, monthKey: true, rowCount: true, dqStatus: true, importedAt: true },
    });

    // Bug 5 fix: sort by monthKey then periodStart (not weekLabel string)
    // String sort puts "WEEK 10" before "WEEK 2" — wrong chronological order
    const weeks = await db.week.findMany({
      orderBy: [{ monthKey: 'asc' }, { periodStart: 'asc' }],
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
    // Kelompok: 3-char prefix from outlet code (e.g. "MLG" from "1016.MLGJAK")
    const kelompokOptions = [...new Set(
      outlets.map((o) => {
        const parts = o.code.split('.');
        return parts.length >= 2 ? parts[1].substring(0, 3) : '';
      }).filter(Boolean)
    )].sort();

    const itemsCount = await db.item.count();
    const recordsCount = await db.inventoryRecord.count();

    const weeksByMonth: Record<string, string[]> = {};
    for (const w of weeks) {
      if (!weeksByMonth[w.monthKey]) weeksByMonth[w.monthKey] = [];
      if (!weeksByMonth[w.monthKey].includes(w.weekLabel)) weeksByMonth[w.monthKey].push(w.weekLabel);
    }
    // BUG 1.8 fix: sort weeks numerically, not lexicographically.
    // "WEEK 10" > "WEEK 2" lexicographically, breaking week order in dropdown.
    const weekSort = (a: string, b: string): number => {
      const na = parseInt(a.replace(/\D/g, '')) || 0;
      const nb = parseInt(b.replace(/\D/g, '')) || 0;
      return na - nb;
    };
    for (const k of Object.keys(weeksByMonth)) weeksByMonth[k].sort(weekSort);

    const result = {
      success: true,
      files,
      months: (() => {
        // FIX (BUG 7): Dedupe by monthKey — re-upload creates duplicate SourceFile rows
        const seen = new Set<string>();
        return files.filter((f) => {
          if (seen.has(f.monthKey)) return false;
          seen.add(f.monthKey);
          return true;
        }).map((f) => ({ label: f.monthLabel, key: f.monthKey }));
      })(),
      weeksByMonth,
      outlets: outletsWithPic,
      areas,
      pics,
      kelompokOptions,
      stats: {
        totalFiles: files.length,
        totalOutlets: outlets.length,
        totalItems: itemsCount,
        totalRecords: recordsCount,
      },
    };

    // Phase 1c: cache the result for 5 minutes
    statusCache.set('status', result);

    return NextResponse.json(result);
  } catch (e: unknown) {
    const errMsg = (e instanceof Error ? e.message : String(e));
    // If tables don't exist, return empty state (not error 500)
    if (errMsg.includes('does not exist') || errMsg.includes('relation') || errMsg.includes('table') || errMsg.includes('no such table')) {
      return NextResponse.json(EMPTY_STATE);
    }
    logger.error("[/api/status] Error:", { error: errMsg });
    return NextResponse.json({ success: false, error: errMsg, hint: 'Try visiting /api/setup to create database tables.' }, { status: 500 });
  }
}
