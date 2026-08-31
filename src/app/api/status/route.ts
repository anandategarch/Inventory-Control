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
import { NO_STORE } from '@/lib/cache-headers';
// FIX (BUG-PERF-5): use shared kelompok extractor instead of inline duplication
import { extractKelompokFromCode } from '@/lib/kelompok-resolver';
// PERF-CACHE-07: opportunistic cleanup of expired AggregationCache rows.
// Status is called frequently (every dashboard load) — calling cleanup here
// (rate-limited internally to once per 10 min) prevents unbounded table growth.
import { cleanupExpiredCache } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

// Phase 1c: cache status response for 5 minutes (shared instance from lib/cache)
// so that other routes (/api/data, /api/pic) can clear it after mutations.

const EMPTY_STATE = {
  // FIX (AUDIT8-ROLLBACK-1, Item 12): EMPTY_STATE must NOT report success:true.
  // Frontend uses success:false + setupRequired:true to distinguish "DB tables
  // not created yet" (redirect to /api/setup) from "DB exists, no uploads yet"
  // (show empty dashboard). Returning success:true here caused the dashboard to
  // render with no setup redirect.
  success: false,
  setupRequired: true,
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
    // PERF-CACHE-07: opportunistic cleanup of expired AggregationCache rows.
    // The helper is internally rate-limited (once per 10 min) + non-throwing,
    // so this is a safe fire-and-forget on every status request. The first
    // status call after server start (or after 10 min idle) triggers cleanup;
    // subsequent calls within 10 min are no-ops.
    void cleanupExpiredCache();

    const url = new URL(req.url);

    // Sprint 1: Zod input validation (no params expected)
    const validation = validateQuery(statusQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // Phase 1c: check cache first
    const cached = statusCache.get('status');
    if (cached) {
      // FIX (BUG-PIC-STALE): cached response also gets NO_STORE headers. The CDN
    // (s-maxage=60) would serve stale status data for up to 60s after a PIC
    // mutation — statusCache.clear() in /api/pic POST only clears server memory,
    // not the CDN edge. The server-side statusCache (5-min TTL) is sufficient
    // for performance; CDN caching is redundant and causes stale-data bugs.
    return NextResponse.json(
      { ...(cached as object), cached: true },
      { headers: NO_STORE },
    );
    }

    // DP-07 FIX: Parallelize all 6 independent DB queries via Promise.all
    // (was sequential — ~600ms → ~200ms on cold cache)
    const [files, weeks, outlets, picRows, itemsCount, recordsCount] = await Promise.all([
      db.sourceFile.findMany({
        orderBy: { monthKey: 'asc' },
        select: { fileName: true, monthLabel: true, monthKey: true, rowCount: true, dqStatus: true, importedAt: true },
      }),
      // Bug 5 fix: sort by monthKey then periodStart (not weekLabel string)
      db.week.findMany({
        orderBy: [{ monthKey: 'asc' }, { periodStart: 'asc' }],
        select: { weekLabel: true, monthKey: true, periodStart: true, periodEnd: true },
      }),
      db.outlet.findMany({
        orderBy: { code: 'asc' },
        select: { code: true, name: true, area: true },
      }),
      // Fetch PIC assignments (OutletPIC table) — wrapped in try/catch for missing table
      db.outletPIC.findMany({ select: { outletCode: true, pic: true } }).catch(() => []),
      db.item.count(),
      db.inventoryRecord.count(),
    ]);

    const outletPics = picRows.map((r) => ({ outletCode: r.outletCode, pic: r.pic }));
    const picMap = new Map(outletPics.map((p) => [p.outletCode, p.pic]));

    // Merge outlets with PIC
    const outletsWithPic = outlets.map((o) => ({ ...o, pic: picMap.get(o.code) || null }));

    const areas = [...new Set(outlets.map((o) => o.area))].sort();
    const pics = [...new Set(outletPics.map((p) => p.pic).filter(Boolean))].sort();
    // Kelompok: 3-char prefix from outlet NAME segment (after the LAST dot).
    // FIX (BUG-PERF-5): use shared extractKelompokFromCode helper.
    // FIX (USER-REQ): only show kelompok with >1 outlet, and include area info
    // so the frontend dropdown can display "BDG · JAWA BARAT 1 (5 outlet)".
    // FIX (BUG6-LOST): restore object format that was lost during force push.
    const kelompokMap = new Map<string, { outletCount: number; areas: Set<string> }>();
    for (const o of outlets) {
      const k = extractKelompokFromCode(o.code);
      if (!k) continue;
      if (!kelompokMap.has(k)) kelompokMap.set(k, { outletCount: 0, areas: new Set() });
      const entry = kelompokMap.get(k)!;
      entry.outletCount++;
      if (o.area) entry.areas.add(o.area);
    }
    const kelompokOptions = Array.from(kelompokMap.entries())
      .filter(([, v]) => v.outletCount > 1)
      .map(([kelompok, v]) => ({
        kelompok,
        outletCount: v.outletCount,
        area: Array.from(v.areas).sort().join(', '),
      }))
      .sort((a, b) => a.kelompok.localeCompare(b.kelompok));

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

    // FIX (BUG-PIC-STALE): use NO_STORE instead of CACHE_METADATA. The CDN
    // (s-maxage=60) caused stale status data after mutations (PIC update,
    // file upload, data delete) — the edge cache wasn't cleared by
    // statusCache.clear() or invalidateAnalysisCache(). The server-side
    // statusCache (5-min TTL, properly invalidated by mutations) is sufficient.
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e: unknown) {
    const errMsg = (e instanceof Error ? e.message : String(e));
    // If tables don't exist, return empty state (not error 500)
    if (errMsg.includes('does not exist') || errMsg.includes('relation') || errMsg.includes('table') || errMsg.includes('no such table')) {
      return NextResponse.json(EMPTY_STATE);
    }
    logger.error("[/api/status] Error:", { error: errMsg });
    // SEC-03: Don't leak DB internals in production
    const isDev = process.env.NODE_ENV === 'development';
    return NextResponse.json({ success: false, error: isDev ? errMsg : 'Internal server error', hint: isDev ? 'Try visiting /api/setup to create database tables.' : undefined }, { status: 500 });
  }
}
