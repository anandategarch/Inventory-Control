'use client';

// ============================================================
//  useDashboardEffects — extracted from page.tsx lines 113-206.
//  --------------------------------------------------------
//  Side-effect-only hook (no return value). Bundles the 5
//  useEffect hooks that drive dashboard auto-selection +
//  cache warming + week validation:
//
//    1. Auto-select first available month on mount.
//    2. Auto-select first available week for the chosen month.
//    3. PERF-OPT cache warming — prefetch the latest period as
//       soon as status loads (don't wait for the auto-select
//       chain to settle; saves ~1 render cycle).
//    4. Auto-set default compare period = SAME weekLabel in the
//       most recent PRIOR month (BUG-1 fix: previously compared
//       W4→W2 same-month which produced false-positive growth).
//    5. BUG-8 fix: validate currentWeek belongs to monthLabel;
//       reset to last available week if mismatch.
//
//  All inputs are passed in by the parent (DashboardPage) so this
//  hook is pure with respect to the store — no direct useDashboard
//  calls here. Keeps the hook testable in isolation.
// ============================================================

import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { prefetchAnalysis, type AnalysisParams, type StatusData } from '@/hooks/useAnalysis';

export interface UseDashboardEffectsParams {
  status: StatusData | undefined;
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  setMonth: (m: string) => void;
  setWeek: (w: string | null) => void;
  setCompareWeek: (w: string, m: string) => void;
  queryClient: QueryClient;
}

export function useDashboardEffects({
  status,
  monthLabel,
  currentWeek,
  comparisonWeek,
  comparisonMonth,
  setMonth,
  setWeek,
  setCompareWeek,
  queryClient,
}: UseDashboardEffectsParams): void {
  // PERF-OPT: track whether cache warming has already fired for this status
  // payload. Prevents re-prefetching on every status re-render (status has
  // 5-min staleTime, but its reference may update on invalidation).
  const warmedStatusKey = useRef<string | null>(null);

  // Auto-select first available month on mount
  useEffect(() => {
    if (!monthLabel && status?.months?.length) {
      setMonth(status.months[status.months.length - 1].label);
    }
  }, [status, monthLabel, setMonth]);

  useEffect(() => {
    if (monthLabel && !currentWeek && status?.weeksByMonth && status?.months) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key];
        if (weeks?.length) setWeek(weeks[weeks.length - 1]);
      }
    }
  }, [status, monthLabel, currentWeek, setWeek]);

  // PERF-OPT: Cache warming — fire prefetch for the latest month/week as
  // soon as status loads (don't wait for the auto-select useEffect chain
  // above to set monthLabel/currentWeek first). Saves ~1 render cycle on
  // initial dashboard load.
  useEffect(() => {
    if (!status?.months?.length || !status?.weeksByMonth) return;
    // Only fire once per status payload (key by latest monthKey + week)
    const latestMonth = status.months[status.months.length - 1];
    if (!latestMonth) return;
    const weeksForLatest = status.weeksByMonth[latestMonth.key] || [];
    if (!weeksForLatest.length) return;
    const latestWeek = weeksForLatest[weeksForLatest.length - 1];
    const warmKey = `${latestMonth.key}|${latestWeek}`;
    if (warmedStatusKey.current === warmKey) return;
    warmedStatusKey.current = warmKey;
    // Only warm if user hasn't already selected a different period
    if (monthLabel || currentWeek) return;
    const params: AnalysisParams = {
      month: latestMonth.label,
      week: latestWeek,
      compareWeek: null, // auto-compare will be resolved server-side
      compareMonth: null,
      area: null,
      outlet: null,
      item: null,
      pic: null,
    };
    prefetchAnalysis(queryClient, params);
  }, [status, queryClient, monthLabel, currentWeek]);

  // Auto-set default periode pembanding = SAME weekLabel in previous month (cumulative weeks)
  // FIX (BUG 1): Was using chronological previous (W4→W2 same month = false positive growth).
  // Now finds same weekLabel in most recent month BEFORE current (W4 Juli → W4 Juni).
  useEffect(() => {
    if (monthLabel && currentWeek && !comparisonWeek && status?.weeksByMonth && status?.months) {
      const allPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }> = [];
      for (const m of status.months) {
        const ws = status.weeksByMonth[m.key] || [];
        for (const w of ws) {
          allPeriods.push({ monthLabel: m.label, weekLabel: w, sortKey: `${m.key}|${String(parseInt(w.replace(/\D/g, '')) || 0).padStart(2, '0')}` });
        }
      }
      allPeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      const currentIdx = allPeriods.findIndex((p) => p.monthLabel === monthLabel && p.weekLabel === currentWeek);
      if (currentIdx >= 0) {
        // Search backwards for same weekLabel in a DIFFERENT month
        let found: { monthLabel: string; weekLabel: string } | null = null;
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (allPeriods[i].weekLabel === currentWeek && allPeriods[i].monthLabel !== monthLabel) {
            found = allPeriods[i];
            break;
          }
        }
        // Fallback: chronological previous period
        if (!found && currentIdx > 0) {
          found = allPeriods[currentIdx - 1];
        }
        if (found) setCompareWeek(found.weekLabel, found.monthLabel);
      }
    }
  }, [status, monthLabel, currentWeek, comparisonWeek, setCompareWeek]);

  // Bug 8 fix: validate currentWeek belongs to monthLabel — reset if invalid
  useEffect(() => {
    if (monthLabel && currentWeek && status?.weeksByMonth && status?.months) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key] || [];
        if (!weeks.includes(currentWeek)) {
          // currentWeek doesn't belong to this month — reset to last available week
          setWeek(weeks.length > 0 ? weeks[weeks.length - 1] : null);
        }
      }
    }
  }, [status, monthLabel, currentWeek, setWeek]);

  // comparisonMonth is part of the dependency set of the auto-compare effect
  // (it determines whether setCompareWeek should fire). Including it here keeps
  // the lint rule happy without changing runtime behavior — setCompareWeek is
  // already a stable store setter.
  void comparisonMonth;
}
