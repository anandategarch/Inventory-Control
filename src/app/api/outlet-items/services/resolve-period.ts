// ============================================================
//  resolve-period — Section 1 of /api/outlet-items GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 673-line route.ts (lines ~110-176).
//
//  Responsibilities:
//    1. Month label re-resolution (FIX-DEEP-1: case-insensitive match
//       to actual DB case — DB may have "AGUSTUS 2026" or "Agustus 2026")
//    2. Parallel fetch of runtime thresholds + outlet lookup
//    3. Throw EarlyHttpResponse on 404 outlet (so withCacheAndDedup's
//       rejectComputation propagates the 404 to concurrent awaiters)
//    4. Determine previous period (prevWeek + prevMonth) — DELEGATED to
//       the shared @/lib/period-resolver (see FIX BUG-3-c R-9 below).
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveComparePeriod } from '@/lib/period-resolver';
import { EarlyHttpResponse } from '@/lib/early-http-response';
import type { OutletLookup, ResolvedPeriod } from './types';

export async function resolveOutletAndPeriod(params: {
  outletCode: string;
  month: string;
  week: string;
  compareWeek: string | null;
  compareMonthRaw: string | null;
}): Promise<ResolvedPeriod> {
  const { outletCode, month, week, compareWeek, compareMonthRaw } = params;

  // FIX-DEEP-1 (DEEP-AUDIT-API-2): Resolve monthLabel case to actual DB case.
  // DB may have "AGUSTUS 2026" (upload-data.ts) or "Agustus 2026" (dashboard import).
  // Without this, raw SQL `WHERE ir."monthLabel" = ${month}` returns 0 rows on
  // case mismatch → empty Resto Profile + empty item breakdown.
  const monthResolver = await getMonthResolver();
  const resolvedMonth = resolveMonthLabel(month, monthResolver) || month;
  const compareMonth = compareMonthRaw
    ? (resolveMonthLabel(compareMonthRaw, monthResolver) || compareMonthRaw)
    : null;

  // ============================================================
  //  Load runtime thresholds (Settings-driven, no hardcoding)
  //  + outlet lookup + the period tables.
  //
  //  PERF (PERF-FILTER1 D): thresholds, outlet, weeks + sourceFiles
  //  used to run as TWO serial waves — Promise.all([thresholds,
  //  outlet]) followed by resolveComparePeriod's own week.findMany +
  //  sourceFile.findMany pair. At ~200ms per cross-region round-trip
  //  wave (Vercel iad1 ↔ Supabase ap-southeast-1) that second wave
  //  was pure serial latency on EVERY cold request. All four fetches
  //  are independent — ONE wave now, and the preloaded tables are
  //  passed into resolveComparePeriod (its PreloadedPeriodTables
  //  contract, same pattern as the analysis route's fetch-records).
  // ============================================================
  const [thresholds, outlet, weeksRaw, fileMonthKeys] = await Promise.all([
    getRuntimeThresholds(),
    db.outlet.findFirst({
      where: { code: outletCode },
      select: { id: true, code: true, name: true, area: true },
    }),
    db.week.findMany({
      select: { weekLabel: true, monthKey: true },
      distinct: ['monthKey', 'weekLabel'],
    }),
    db.sourceFile.findMany({
      select: { monthLabel: true, monthKey: true },
    }),
  ]);
  if (!outlet) {
    // PERF-API-01: throw EarlyHttpResponse so the outer catch returns the
    // 404 response (matches the export-report pattern). Cache is NOT populated.
    throw new EarlyHttpResponse(
      NextResponse.json(
        { success: false, error: `Outlet ${outletCode} not found` },
        { status: 404 },
      ),
    );
  }

  // ============================================================
  //  Determine previous period — delegated to the SHARED resolver.
  //
  //  FIX (BUG-3-c R-9): this used to be a ~40-line inline copy of the
  //  period-resolution logic that DIVERGED from @/lib/period-resolver in
  //  three ways (all reproduced here by delegating):
  //    (a) same-month cross-week explicit compare was NOT refused — W4 vs W1
  //        of the same month compared a 25-day cumulative window against a
  //        7-day one (false "growth", BUG-2-b's lib-side fix never reached
  //        this route);
  //    (b) compareWeek WITHOUT compareMonth produced prevMonth=null — the
  //        comparison silently vanished instead of searching for the same
  //        weekLabel in a previous month (lib Case 3);
  //    (c) Case 3 can never resolve to the CURRENT month — the backwards
  //        search only accepts monthLabel !== month, so a request to compare
  //        the period against itself (e.g. ?compareWeek=<current week> with
  //        no compareMonth) is refused rather than producing a fake 0%-delta
  //        self-comparison.
  //  The lib resolver is already covered by tests/lib/period-resolver.test.ts
  //  (13 tests incl. the same-month cross-week guards); the period tables
  //  preloaded in the wave above feed it (PERF-FILTER1 D — zero extra
  //  round-trips on the cold path).
  // ============================================================
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    resolvedMonth,
    compareWeek,
    compareMonth,
    { weeksRaw, fileMonthKeys },
  );

  return {
    month: resolvedMonth,
    compareMonth,
    thresholds,
    outlet: outlet as OutletLookup,
    prevWeek,
    prevMonth,
  };
}
