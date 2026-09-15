'use client';

// ============================================================
//  use-filter-bar-state — FilterBar's non-UI half: the zustand
//  store subscription (single useShallow selector, same fields as
//  pre-split), the /api/status query, the stale-filter cleanup
//  effect (BUG-FE-9), the derived dropdown options, the VH-3
//  "Filter (n)" badge count, and the atomic period-change
//  handlers (PERF-1 / AUDIT-FE). Moved verbatim from FilterBar.tsx
//  (SPLIT-C pure code motion — zero behavior change).
//  The return type is inferred and exported as FilterBarState so
//  the subcomponents (PeriodSelects / OrgSelects) can type their
//  props with Pick<FilterBarState, ...> — no re-declared
//  signatures that could drift from the store.
// ============================================================

import { useEffect, useMemo } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useStatus } from '@/hooks/useAnalysis';
import { findAutoCompareForStatus } from '@/lib/auto-compare';

/** Compare-period option for the "Perbandingan" Select (was the local
 * `type Period` inside the pre-split FilterBar component). */
export interface ComparePeriodOption {
  label: string;
  monthLabel: string;
  weekLabel: string;
  sortKey: string;
}

export function useFilterBarState() {
  // FIX (PERF-1 / AUDIT-FE): setPeriod replaces setMonth/setWeek in the month/week
  // Select handlers — period changes are now ATOMIC (one store update, one
  // queryKey change, one /api/analysis fetch). setCompareWeek stays for the
  // compare Select (single-field change is already atomic).
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, itemName, pic, setPeriod, setCompareWeek, setArea, setKelompok, setOutlet, setPic, reset } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonWeek: s.comparisonWeek,
    comparisonMonth: s.comparisonMonth,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    itemName: s.itemName,
    pic: s.pic,
    setPeriod: s.setPeriod,
    setCompareWeek: s.setCompareWeek,
    setArea: s.setArea,
    setKelompok: s.setKelompok,
    setOutlet: s.setOutlet,
    setPic: s.setPic,
    reset: s.reset,
  })));
  const { data: status, isLoading } = useStatus();

  // FIX (BUG-FE-9): After data upload/import, the status query invalidates and
  // refetches. If the new dataset doesn't have the currently-selected kelompok
  // (e.g., user uploaded a different region's data), the dropdown would still
  // show the old kelompok as selected but the option would be gone — user can't
  // deselect via dropdown, only via Reset. This effect clears kelompok (and
  // other filter state) if they're no longer valid in the new status data.
  useEffect(() => {
    if (!status) return;
    const kelompokOpts = status.kelompokOptions || [];
    if (kelompok && kelompok !== 'all' && kelompokOpts.length > 0 && !kelompokOpts.some(k => k.kelompok === kelompok)) {
      setKelompok(null);
    }
    if (area && status.areas.length > 0 && !status.areas.includes(area)) {
      setArea(null);
    }
    if (pic && status.pics.length > 0 && !status.pics.includes(pic)) {
      setPic(null);
    }
    if (outletCode && status.outlets.length > 0 && !status.outlets.some((o) => o.code === outletCode)) {
      setOutlet(null);
    }
  }, [status, kelompok, area, pic, outletCode, setKelompok, setArea, setPic, setOutlet]);

  const months = status?.months || [];
  const weeks = (monthLabel && status?.weeksByMonth) ? Object.entries(status.weeksByMonth).find(([k]) => {
    const m = status.months.find((mm) => mm.label === monthLabel);
    return m && k === m.key;
  })?.[1] || [] : [];
  const pics = status?.pics || [];
  const kelompokOptions = status?.kelompokOptions || [];
  // Filter outlets by area AND pic AND kelompok
  // FIX (BUG-FE-2): previously only filtered by area + pic — user could select
  // an outlet outside the selected kelompok → backend returns 0 rows → misleading
  // "no data" error. Now filters by kelompok too, so the dropdown only shows
  // outlets consistent with the active kelompok filter.
  // PERF-05: useMemo outlets filter — was recomputed on every render (e.g., when
  // ingestMsg state changes). Now only recomputes when status/area/pic/kelompok change.
  const outlets = useMemo(() => (status?.outlets || []).filter((o) => {
    if (area && o.area !== area) return false;
    if (pic && o.pic !== pic) return false;
    if (kelompok) {
      // Same extraction as backend: last dot-segment, first 3 chars, uppercase
      const segs = o.code.split('.');
      const oKelompok = (segs[segs.length - 1] || '').substring(0, 3).toUpperCase();
      if (oKelompok !== kelompok.toUpperCase()) return false;
    }
    return true;
  }), [status?.outlets, area, pic, kelompok]);
  const areas = status?.areas || [];

  const allComparePeriods: ComparePeriodOption[] = [];
  if (status?.weeksByMonth && status?.months) {
    for (const m of status.months) {
      const ws = status.weeksByMonth[m.key] || [];
      for (const w of ws) {
        // FIX (BUG-2-b / BUG-1-c #5): exclude ALL periods of the CURRENT month,
        // not just the exact current period. Weeks are CUMULATIVE snapshots
        // (W1=1-7, W2=1-14, W3=1-21, W4=1-25) — offering "WEEK 1 — Agustus"
        // as a compare option while the current period is "WEEK 4 — Agustus"
        // invites a 25-day-vs-7-day comparison that shows up as a false
        // ~-72% "growth" (the exact class the auto path already rejects —
        // see period-resolver FIX AUDIT-BUG-2). Other months' weeks stay
        // selectable (explicit user choice; the day-range labels make the
        // windows visible).
        if (m.label === monthLabel) continue;
        allComparePeriods.push({
          label: `${w} — ${m.label}`,
          monthLabel: m.label,
          weekLabel: w,
          sortKey: `${m.key}|${String(parseInt(w.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
        });
      }
    }
    allComparePeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  const compareValue = comparisonWeek
    ? `${comparisonWeek}|||${comparisonMonth || monthLabel}`
    : 'auto';
  // VH-3 (spec §4 L1 / D7): "Filter (n)" badge — counts the 5 dashboard
  // filters (area, kelompok, outlet, PIC, item) that are non-null. The
  // FilterBar has no collapse mechanism on desktop, so the badge rides the
  // existing filter-controls row (no new collapse system); hidden when n=0.
  const activeFilterCount = [area, kelompok, outletCode, pic, itemName].filter(Boolean).length;
  // Item counts as an active filter too — keeps the Reset button consistent
  // with the badge (the insight actions set `item` as a transient filter).
  const hasActiveFilter = activeFilterCount > 0;

  // ============================================================
  //  FIX (PERF-1 / AUDIT-FE): atomic period-change handlers.
  //  --------------------------------------------------------
  //  Previously `onValueChange={setMonth}` / `onValueChange={setWeek}`
  //  reset week+compare (store setters null them out), then the
  //  useDashboardEffects chain re-set them across several renders →
  //  useAnalysis's queryKey changed TWICE per interaction → the heavy
  //  /api/analysis payload was double-fetched on every month/week
  //  change. These handlers resolve the full (month, week, compare)
  //  triple up front and commit it with ONE setPeriod() call.
  //
  //  Compare resolution = same-weekLabel search BACKWARDS in a
  //  different month (shared with useDashboardEffects via
  //  src/lib/auto-compare.ts).
  //  FIX (AUDIT-BUG-2): no chronological fallback — cumulative weeks
  //  make cross-week comparisons meaningless. No same-weekLabel prior
  //  month → compare = null (backend handles null compare gracefully).
  // ============================================================
  function handleMonthChange(newMonth: string) {
    // New month's last available week (the same week the auto-select
    // effect / hover-prefetch assume for a month switch).
    const m = status?.months.find((mm) => mm.label === newMonth);
    const weeksForMonth = m && status?.weeksByMonth ? (status.weeksByMonth[m.key] || []) : [];
    const lastWeek = weeksForMonth[weeksForMonth.length - 1] ?? null;
    if (!lastWeek) {
      // Week data not available for the new month — clear week+compare;
      // the combined auto-select effect in useDashboardEffects fills them
      // (still ONE setPeriod from the user's click, one more from the effect).
      setPeriod(newMonth, null, null, null);
      return;
    }
    const compare = findAutoCompareForStatus(status, newMonth, lastWeek);
    setPeriod(newMonth, lastWeek, compare?.weekLabel ?? null, compare?.monthLabel ?? null);
  }

  function handleWeekChange(newWeek: string) {
    if (!monthLabel) return; // Select is disabled without a month — defensive
    const compare = findAutoCompareForStatus(status, monthLabel, newWeek);
    setPeriod(monthLabel, newWeek, compare?.weekLabel ?? null, compare?.monthLabel ?? null);
  }

  return {
    // Store values + actions (same single useShallow subscription as pre-split)
    monthLabel,
    currentWeek,
    comparisonWeek,
    comparisonMonth,
    area,
    kelompok,
    outletCode,
    itemName,
    pic,
    setPeriod,
    setCompareWeek,
    setArea,
    setKelompok,
    setOutlet,
    setPic,
    reset,
    // Status query
    status,
    isLoading,
    // Derived dropdown options
    months,
    weeks,
    pics,
    outlets,
    areas,
    kelompokOptions,
    allComparePeriods,
    compareValue,
    // VH-3 badge
    activeFilterCount,
    hasActiveFilter,
    // Atomic period-change handlers
    handleMonthChange,
    handleWeekChange,
  };
}

/** Everything useFilterBarState returns (inferred — see header comment). */
export type FilterBarState = ReturnType<typeof useFilterBarState>;
