// ============================================================
//  Period Resolver — shared logic for auto-computing previous period.
//  Used by 4 API routes: analysis, outlet-items, recommendations,
//  export-report.
//
//  Logic: same weekLabel in chronologically previous month.
//  Weeks are CUMULATIVE (W1=1-7, W2=1-14, W4=1-25). Comparing
//  W4 vs W2 same month is NOT apples-to-apples. Must compare
//  same weekLabel: W4 Juli vs W4 Juni, W2 Juli vs W2 Juni, etc.
//
//  FIX (AUDIT-BUG-2): NO chronological-previous fallback anywhere in this
//  module — when no same-weekLabel period exists in a previous month, we
//  return { prevWeek: null, prevMonth: null } so callers short-circuit into
//  their no-comparison path (callers verified: analysis fetch-records,
//  export-report data-fetcher, outlet-items fetch-records, recommendations
//  queryRestoRecommendations — all null-safe).
//
//  Before this module, each route had ~30 lines of inline period
//  resolution logic.
// ============================================================
import { db } from '@/lib/db';

export interface ResolvedPeriod {
  prevWeek: string | null;
  prevMonth: string | null;
}

/**
 * PERF (PAKET B / F4): optional pre-fetched Week + SourceFile metadata.
 * Callers that already loaded these tables in their parallel metadata batch
 * (e.g. /api/analysis fetch-records Stage 2) pass them here so this resolver
 * no longer re-fetches both tables sequentially on every request.
 */
export interface PreloadedPeriodTables {
  weeksRaw: Array<{ weekLabel: string; monthKey: string }>;
  fileMonthKeys: Array<{ monthLabel: string; monthKey: string }>;
}

/**
 * PERF (PAKET B / F4): the two metadata fetches used to run SEQUENTIALLY
 * (await week.findMany; await sourceFile.findMany). Promise.all them —
 * removes one serial round-trip barrier on every call that doesn't preload.
 */
async function loadPeriodTables(preloaded?: PreloadedPeriodTables): Promise<PreloadedPeriodTables> {
  if (preloaded) return preloaded;
  const [weeksRaw, fileMonthKeys] = await Promise.all([
    db.week.findMany({
      select: { weekLabel: true, monthKey: true },
      distinct: ['monthKey', 'weekLabel'],
    }),
    db.sourceFile.findMany({
      select: { monthLabel: true, monthKey: true },
    }),
  ]);
  return { weeksRaw, fileMonthKeys };
}

interface PeriodRow {
  monthLabel: string;
  weekLabel: string;
  monthKey: string;
  sortKey: string;
}

function buildAllPeriods(tables: PreloadedPeriodTables): PeriodRow[] {
  const monthLabelByKey = new Map(tables.fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));
  return tables.weeksRaw
    .map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      monthKey: w.monthKey,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/**
 * Auto-compute previous period (same weekLabel in chronologically previous month).
 * No fallback: if no same-weekLabel period exists in a previous month, returns
 * { prevWeek: null, prevMonth: null } so the caller short-circuits (no comparison).
 *
 * @param week Current weekLabel (e.g. "WEEK 2")
 * @param month Current monthLabel (e.g. "Agustus 2026")
 * @returns { prevWeek, prevMonth } or { null, null } if no same-week previous period exists
 */
export async function resolvePreviousPeriod(
  week: string,
  month: string,
  preloaded?: PreloadedPeriodTables,
): Promise<ResolvedPeriod> {
  const allPeriods = buildAllPeriods(await loadPeriodTables(preloaded));

  const currentIdx = allPeriods.findIndex(p => p.monthLabel === month && p.weekLabel === week);

  // Search backwards for same weekLabel in a DIFFERENT month
  let prevWeek = week;
  let foundMonth: string | null = null;
  const startIdx = currentIdx >= 0 ? currentIdx - 1 : allPeriods.length - 1;
  for (let i = startIdx; i >= 0; i--) {
    if (allPeriods[i].weekLabel === week && allPeriods[i].monthLabel !== month) {
      foundMonth = allPeriods[i].monthLabel;
      break;
    }
  }
  prevWeek = week;
  let prevMonth = foundMonth;

  // FIX (AUDIT-BUG-2): weeks are CUMULATIVE — cross-week comparison (e.g. W2
  // vs W1 same month) produces false ~-50% growth. No fallback: no same-week
  // prior period → no comparison.
  if (!prevMonth) {
    return { prevWeek: null, prevMonth: null };
  }

  return { prevWeek, prevMonth };
}

/**
 * Resolve compare (previous) period from user-supplied compareWeek + optional
 * explicit compareMonth. Handles 3 cases:
 *
 *  - Case 1 (compareWeek is null): auto-previous — same weekLabel in the
 *    chronologically previous month. No fallback (FIX AUDIT-BUG-2): if no
 *    same-weekLabel period exists in a previous month, returns nulls so the
 *    caller short-circuits. Delegates to `resolvePreviousPeriod`.
 *
 *  - Case 2 (compareWeek + compareMonthExplicit both set): use them directly.
 *    No DB lookup needed (caller already validated the month label exists).
 *
 *  - Case 3 (compareWeek set, compareMonthExplicit null): find the same
 *    weekLabel in the most recent month BEFORE the current month. If not
 *    found searching backwards, fall back to searching FORWARD (after
 *    current). If neither found, return { prevWeek: compareWeek, prevMonth: null }
 *    so the caller can short-circuit "no comparison data" cleanly.
 *    FIX (AUDIT8-ROLLBACK-1, Item 20): previously fell back to the current
 *    month itself (`prevMonth || month`) which caused downstream code to
 *    compare the period to ITSELF, producing misleading "0% change" results.
 *
 * FIX (RESTORE-BACKEND-2): replaces ~60 lines of inline logic in
 * /api/analysis/route.ts and ~15 lines in /api/export-report/route.ts.
 *
 * @param week Current week label (e.g. "WEEK 2")
 * @param month Current month label (e.g. "Agustus 2026")
 * @param compareWeek User-supplied compare week label, or null for auto-previous
 * @param compareMonthExplicit User-supplied explicit compare month, or null
 * @returns { prevWeek, prevMonth } — both null when no comparison period exists
 */
export async function resolveComparePeriod(
  week: string,
  month: string,
  compareWeek: string | null,
  compareMonthExplicit: string | null,
  preloaded?: PreloadedPeriodTables,
): Promise<ResolvedPeriod> {
  // Case 2: both compareWeek + compareMonthExplicit provided — use them directly.
  // No DB lookup needed; caller already validated the month label exists.
  // FIX (BUG-2-b / BUG-1-c #5): same-month cross-week compare = comparing a
  // cumulative week against ANOTHER cumulative window of the SAME month
  // (W1=1-7, W2=1-14, W3=1-21, W4=1-25) — e.g. W4 vs W1 compares 25 days
  // vs 7 days and yields a false "growth" that is just the window delta.
  // The AUTO path (Case 1 / resolvePreviousPeriod) already refuses this
  // (FIX AUDIT-BUG-2); the explicit path must refuse it too. Return the
  // same nulls convention so callers short-circuit into their no-comparison
  // path (verified null-safe: analysis fetch-records, export-report
  // data-fetcher).
  if (compareWeek && compareMonthExplicit) {
    if (compareMonthExplicit === month && compareWeek !== week) {
      return { prevWeek: null, prevMonth: null };
    }
    return { prevWeek: compareWeek, prevMonth: compareMonthExplicit };
  }

  // Case 1: compareWeek is null → auto-previous (same weekLabel in previous month).
  // Delegates to the existing resolvePreviousPeriod helper.
  if (!compareWeek) {
    return resolvePreviousPeriod(week, month, preloaded);
  }

  // Case 3: compareWeek set, compareMonthExplicit null.
  // Find same weekLabel in most recent month BEFORE current; fall back to
  // searching forward (after current); fall back to current month itself.
  const allPeriods = buildAllPeriods(await loadPeriodTables(preloaded));

  const currentIdx = allPeriods.findIndex(p => p.monthLabel === month && p.weekLabel === week);

  // API-03 FIX: If the current period doesn't exist in DB (typo, or new month
  // not yet ingested), don't search forward — that could pick a FUTURE period
  // as "previous", producing misleading growth metrics (e.g., "Sales grew 500%
  // vs last month" when "last month" is actually next month).
  if (currentIdx === -1) {
    return { prevWeek: compareWeek, prevMonth: null };
  }

  let prevMonth: string | null = null;
  // Search BACKWARDS from current for the same weekLabel in a different month
  const startIdx = currentIdx - 1;
  for (let i = startIdx; i >= 0; i--) {
    if (allPeriods[i].weekLabel === compareWeek && allPeriods[i].monthLabel !== month) {
      prevMonth = allPeriods[i].monthLabel;
      break;
    }
  }
  // FIX (AUDIT8-ROLLBACK-1, Item 20): do NOT fall back to the current month.
  // The previous inline comment claimed "downstream code will see prevMonth
  // === month and can short-circuit" — but downstream code in analysis/route.ts
  // + outlet-items/route.ts treats `prevWeek && prevMonth` as "comparison data
  // exists" and runs the comparison query, producing misleading "0% change"
  // results (period compared to itself). Return null instead so callers
  // short-circuit cleanly (e.g. `prevWeek && prevMonth ? X : Y`).
  // API-03 FIX: Also do NOT search forward — a future period as "previous"
  // is semantically wrong (growth vs future = nonsense).
  return { prevWeek: compareWeek, prevMonth };
}
