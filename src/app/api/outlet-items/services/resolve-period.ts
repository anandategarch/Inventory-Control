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
//    4. Determine previous period (prevWeek + prevMonth):
//       - If compareWeek provided: use it (+ compareMonth if provided)
//       - Otherwise: search backwards for same weekLabel in a DIFFERENT
//         month (FIX BUG 3: cumulative weeks — chronological previous
//         caused W4→W2 same-month false positives)
//       - No fallback (FIX AUDIT-BUG-2): if no same-weekLabel period
//         exists in a previous month → { prevWeek: null, prevMonth: null }
//         so the caller short-circuits (fetch-records guards
//         `prevWeek && prevMonth`; empty prevRecs → profile renders its
//         no-comparison / NEW state).
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
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

  // Determine previous period
  // FIX (BUG 3): Same-weekLabel in previous month (cumulative weeks).
  // Was: chronological previous (W4→W2 same month = false positive growth).
  let prevWeek: string | null = compareWeek;
  let prevMonth: string | null = compareMonth || null;
  if (!prevWeek) {
    // PERF-04: Parallelize weeksRaw + fileMonthKeys (independent)
    const [weeksRaw, fileMonthKeys] = await Promise.all([
      db.week.findMany({
        select: { weekLabel: true, monthKey: true },
        distinct: ['monthKey', 'weekLabel'],
      }),
      db.sourceFile.findMany({ select: { monthLabel: true, monthKey: true } }),
    ]);
    const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));
    const allPeriods = weeksRaw
      .map(w => ({
        monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
        weekLabel: w.weekLabel,
        sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
      }))
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    const currentIdx = allPeriods.findIndex(p => p.monthLabel === resolvedMonth && p.weekLabel === week);
    // Search backwards for same weekLabel in a DIFFERENT month
    prevWeek = week;
    let foundMonth: string | null = null;
    const startIdx = currentIdx >= 0 ? currentIdx - 1 : allPeriods.length - 1;
    for (let i = startIdx; i >= 0; i--) {
      if (allPeriods[i].weekLabel === week && allPeriods[i].monthLabel !== resolvedMonth) {
        foundMonth = allPeriods[i].monthLabel;
        break;
      }
    }
    prevMonth = foundMonth;
    // FIX (AUDIT-BUG-2): weeks are CUMULATIVE — cross-week comparison (e.g. W2
    // vs W1 same month) produces false ~-50% growth. No fallback: no same-week
    // prior period → no comparison. Both fields null (matches
    // resolvePreviousPeriod in @/lib/period-resolver) so callers short-circuit.
    if (!prevMonth) {
      prevWeek = null;
    }
  }

  return {
    month: resolvedMonth,
    compareMonth,
    thresholds,
    outlet: outlet as OutletLookup,
    prevWeek,
    prevMonth,
  };
}
