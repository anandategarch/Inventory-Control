// ============================================================
//  auto-compare — pure period-comparison resolution helpers
//  --------------------------------------------------------
//  FIX (PERF-1 / AUDIT-BUG-2, shared logic): the same-weekLabel
//  backwards search used to live duplicated (and divergent) in
//  useDashboardEffects.ts (auto-compare effect) and was needed
//  again by FilterBar's atomic period handlers. Extracted here
//  as a PURE module (no React imports) so both call sites use
//  EXACTLY the same resolution:
//    • useDashboardEffects — combined auto-select effect
//    • FilterBar — month/week Select onValueChange handlers
//
//  Semantics (kept from the original effect-4, verified correct):
//    1. Flatten months × weeksByMonth into a chronologically
//       sorted list (sortKey = `${monthKey}|${paddedWeek#}`).
//    2. Find the index of (month, week) in that list.
//    3. Search BACKWARDS for the SAME weekLabel in a DIFFERENT
//       month (e.g. W4 Juli → W4 Juni). Weeks are cumulative,
//       so same-weekLabel across months is the only meaningful
//       apples-to-apples comparison.
//    4. NO chronological fallback. If no same-weekLabel prior
//       month exists → return null (compare disabled; the
//       backend already handles a null compare gracefully).
// ============================================================

/** A single (month, week) period with its chronological sort key. */
export interface AutoComparePeriod {
  monthLabel: string;
  weekLabel: string;
  /** `${monthKey}|${padded week number}` — ascending chronological order. */
  sortKey: string;
}

/**
 * Flatten months × weeksByMonth into a chronologically sorted period list.
 * The sortKey logic is lifted verbatim from the original auto-compare effect
 * (monthKey is "YYYY-MM"-shaped, week numbers are zero-padded so W10 sorts
 * after W9, and non-numeric week labels fall back to 0).
 */
export function buildAllPeriods(
  months: ReadonlyArray<{ label: string; key: string }>,
  weeksByMonth: Record<string, string[]>,
): AutoComparePeriod[] {
  const allPeriods: AutoComparePeriod[] = [];
  for (const m of months) {
    const ws = weeksByMonth[m.key] || [];
    for (const w of ws) {
      allPeriods.push({
        monthLabel: m.label,
        weekLabel: w,
        sortKey: `${m.key}|${String(parseInt(w.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
      });
    }
  }
  allPeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return allPeriods;
}

/**
 * Find the default compare period for (month, week): the SAME weekLabel in
 * the most recent PRIOR month. Returns null when the period is unknown or
 * no same-weekLabel prior month exists.
 *
 * FIX (AUDIT-BUG-2): no chronological fallback — cumulative weeks make
 * cross-week comparisons meaningless (W2 vs W1 of the same month produces
 * a false ~-50% growth).
 */
export function findAutoCompare(
  allPeriods: ReadonlyArray<AutoComparePeriod>,
  month: string,
  week: string,
): AutoComparePeriod | null {
  const currentIdx = allPeriods.findIndex((p) => p.monthLabel === month && p.weekLabel === week);
  if (currentIdx < 0) return null;
  // Search backwards for same weekLabel in a DIFFERENT month (W4 Juli → W4 Juni)
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (allPeriods[i].weekLabel === week && allPeriods[i].monthLabel !== month) {
      return allPeriods[i];
    }
  }
  return null;
}

/**
 * Convenience wrapper: build the period list from a status-shaped object
 * (structurally compatible with StatusData — months + weeksByMonth) and
 * resolve the auto-compare for (month, week) in one call.
 */
export function findAutoCompareForStatus(
  status: { months?: ReadonlyArray<{ label: string; key: string }>; weeksByMonth?: Record<string, string[]> } | undefined,
  month: string,
  week: string,
): AutoComparePeriod | null {
  if (!status?.months?.length || !status?.weeksByMonth) return null;
  return findAutoCompare(buildAllPeriods(status.months, status.weeksByMonth), month, week);
}
