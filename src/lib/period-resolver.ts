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
//  Before this module, each route had ~30 lines of inline period
//  resolution logic.
// ============================================================
import { db } from '@/lib/db';

export interface ResolvedPeriod {
  prevWeek: string | null;
  prevMonth: string | null;
}

/**
 * Auto-compute previous period (same weekLabel in chronologically previous month).
 * Falls back to chronological previous if same-weekLabel not found.
 *
 * @param week Current weekLabel (e.g. "WEEK 2")
 * @param month Current monthLabel (e.g. "Agustus 2026")
 * @returns { prevWeek, prevMonth } or { null, null } if no previous period exists
 */
export async function resolvePreviousPeriod(
  week: string,
  month: string,
): Promise<ResolvedPeriod> {
  const weeksRaw = await db.week.findMany({
    select: { weekLabel: true, monthKey: true },
    distinct: ['monthKey', 'weekLabel'],
  });
  const fileMonthKeys = await db.sourceFile.findMany({
    select: { monthLabel: true, monthKey: true },
  });
  const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));

  const allPeriods = weeksRaw
    .map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      monthKey: w.monthKey,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

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

  if (!prevMonth && currentIdx > 0) {
    // Fallback: chronological previous
    prevWeek = allPeriods[currentIdx - 1].weekLabel;
    prevMonth = allPeriods[currentIdx - 1].monthLabel;
  }

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
 *    chronologically previous month. Falls back to the chronological previous
 *    period if same-weekLabel not found. Delegates to `resolvePreviousPeriod`.
 *
 *  - Case 2 (compareWeek + compareMonthExplicit both set): use them directly.
 *    No DB lookup needed (caller already validated the month label exists).
 *
 *  - Case 3 (compareWeek set, compareMonthExplicit null): find the same
 *    weekLabel in the most recent month BEFORE the current month. If not
 *    found searching backwards, fall back to searching FORWARD (after
 *    current). If neither found, fall back to the current month itself
 *    (preserves existing behavior — caller is responsible for handling
 *    "no comparison data" downstream).
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
): Promise<ResolvedPeriod> {
  // Case 2: both compareWeek + compareMonthExplicit provided — use them directly.
  // No DB lookup needed; caller already validated the month label exists.
  if (compareWeek && compareMonthExplicit) {
    return { prevWeek: compareWeek, prevMonth: compareMonthExplicit };
  }

  // Case 1: compareWeek is null → auto-previous (same weekLabel in previous month).
  // Delegates to the existing resolvePreviousPeriod helper.
  if (!compareWeek) {
    return resolvePreviousPeriod(week, month);
  }

  // Case 3: compareWeek set, compareMonthExplicit null.
  // Find same weekLabel in most recent month BEFORE current; fall back to
  // searching forward (after current); fall back to current month itself.
  const weeksRaw = await db.week.findMany({
    select: { weekLabel: true, monthKey: true },
    distinct: ['monthKey', 'weekLabel'],
  });
  const fileMonthKeys = await db.sourceFile.findMany({
    select: { monthLabel: true, monthKey: true },
  });
  const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));

  const allPeriods = weeksRaw
    .map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      monthKey: w.monthKey,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const currentIdx = allPeriods.findIndex(p => p.monthLabel === month && p.weekLabel === week);

  let prevMonth: string | null = null;
  // Search BACKWARDS from current for the same weekLabel in a different month
  const startIdx = currentIdx >= 0 ? currentIdx - 1 : allPeriods.length - 1;
  for (let i = startIdx; i >= 0; i--) {
    if (allPeriods[i].weekLabel === compareWeek && allPeriods[i].monthLabel !== month) {
      prevMonth = allPeriods[i].monthLabel;
      break;
    }
  }
  // Fallback: search FORWARD (after current) for the same weekLabel
  if (!prevMonth) {
    const fwdStart = currentIdx >= 0 ? currentIdx + 1 : 0;
    for (let i = fwdStart; i < allPeriods.length; i++) {
      if (allPeriods[i].weekLabel === compareWeek && allPeriods[i].monthLabel !== month) {
        prevMonth = allPeriods[i].monthLabel;
        break;
      }
    }
  }
  // Preserve existing behavior: fall back to the current month itself when
  // no other month has the same weekLabel. Downstream code will see prevMonth
  // === month and can short-circuit (no comparison data).
  return { prevWeek: compareWeek, prevMonth: prevMonth || month };
}
