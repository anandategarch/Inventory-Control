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
  // ============================================================
  // PERF-04: Parallelize thresholds + outlet lookup (independent)
  const [thresholds, outlet] = await Promise.all([
    getRuntimeThresholds(),
    db.outlet.findFirst({
      where: { code: outletCode },
      select: { id: true, code: true, name: true, area: true },
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
  //  (13 tests incl. the same-month cross-week guards); no preloaded tables
  //  are passed — the two metadata fetches are cheap (small tables, shared
  //  with the analysis + export-report routes' resolver usage).
  // ============================================================
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    resolvedMonth,
    compareWeek,
    compareMonth,
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
