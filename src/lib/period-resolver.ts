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
