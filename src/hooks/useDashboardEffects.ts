'use client';

// ============================================================
//  useDashboardEffects — extracted from page.tsx lines 113-206.
//  --------------------------------------------------------
//  Side-effect-only hook (no return value). Was 5 chained
//  useEffects (auto month → auto week → cache warming →
//  auto-compare → week validation); now TWO effects:
//
//    1. Combined auto-select effect (replaces old effects 1, 2,
//       4 and 5) — runs when monthLabel/currentWeek are missing
//       or currentWeek doesn't belong to monthLabel's weeks.
//       Resolves month + week + default compare period in ONE
//       atomic setPeriod() call:
//         • target month  = existing monthLabel (if still in
//           status) or the latest month from status.
//         • target week   = currentWeek if it belongs to the
//           target month's weeks, else the last available week.
//         • compare       = same weekLabel searched BACKWARDS in
//           a different month (BUG-1 fix, kept from old effect 4).
//
//    2. PERF-OPT cache warming — prefetch the latest period as
//       soon as status loads, WITH the resolved compare period
//       so the prefetch queryKey matches the final live query
//       key exactly (was compareWeek: null — a wasted fetch that
//       never deduped against the live query).
//
//  FIX (PERF-1 / AUDIT-FE — CRITICAL double-fetch): the old
//  5-effect chain updated the store in SEPARATE commits
//  (setMonth → setWeek → setCompareWeek). useAnalysis fired on
//  every intermediate state: first with compareWeek: null, then
//  again when the auto-compare effect changed the queryKey →
//  /api/analysis (heaviest payload, 6-8s cold) was fetched TWICE
//  on mount and on EVERY period change. With ONE atomic
//  setPeriod() the queryKey changes exactly once.
//
//  FIX (AUDIT-BUG-2, frontend half): the old auto-compare effect
//  had a chronological fallback (`allPeriods[currentIdx - 1]`)
//  that compared mismatched weeks (W2 vs W1 of the same month —
//  cumulative weeks → false ~-50% growth). Removed: when no
//  same-weekLabel prior month exists, compare = null (backend
//  handles a null compare gracefully).
//
//  Edge case preserved: when the user EXPLICITLY clears the
//  compare select ("Tidak dibandingkan" → setCompareWeek(null,
//  null)) and month+week are valid, this hook does NOT re-set a
//  compare — the old effect 4 immediately re-set one (annoying).
//  Compare is auto-resolved ONLY during the combined auto-select
//  (month/week missing or invalid) and in FilterBar's handlers.
//
//  All inputs are passed in by the parent (DashboardPage) so this
//  hook is pure with respect to the store — no direct useDashboard
//  calls here. Keeps the hook testable in isolation.
// ============================================================

import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { prefetchAnalysis, prefetchHeatmap, type AnalysisParams, type StatusData } from '@/hooks/useAnalysis';
import { findAutoCompareForStatus } from '@/lib/auto-compare';

export interface UseDashboardEffectsParams {
  status: StatusData | undefined;
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  // FIX (H-12 / prefetchHeatmap filter mismatch): the warming effect needs the
  // CURRENT dashboard filters so the heatmap prefetch key matches the card's
  // live key (same reasoning as the resolved-compare PERF-1 fix below — the
  // key must be built from the same state the live query will use).
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
  // FIX (PERF-1 / AUDIT-FE): the hook now needs ONLY the atomic period setter.
  // Replaces the old setMonth/setWeek/setCompareWeek props whose three separate
  // store commits caused the double /api/analysis fetch.
  setPeriod: (month: string | null, week: string | null, compareWeek: string | null, compareMonth: string | null) => void;
  queryClient: QueryClient;
}

export function useDashboardEffects({
  status,
  monthLabel,
  currentWeek,
  comparisonWeek,
  comparisonMonth,
  area,
  kelompok,
  outletCode,
  pic,
  setPeriod,
  queryClient,
}: UseDashboardEffectsParams): void {
  // PERF-OPT: track whether cache warming has already fired for this status
  // payload. Prevents re-prefetching on every status re-render (status has
  // 5-min staleTime, but its reference may update on invalidation).
  const warmedStatusKey = useRef<string | null>(null);

  // ============================================================
  //  Effect 1 — combined auto-select (old effects 1, 2, 4, 5).
  //  Runs when monthLabel or currentWeek is missing, or when
  //  currentWeek doesn't belong to monthLabel's weeks (BUG-8
  //  validation). Resolves the FULL (month, week, compare) state
  //  and commits it with ONE atomic setPeriod() so useAnalysis's
  //  queryKey changes exactly once (PERF-1).
  // ============================================================
  useEffect(() => {
    if (!status?.months?.length || !status?.weeksByMonth) return;

    // Target month: the current monthLabel if still valid in status,
    // else the latest available month (old effect 1 / stale-month case).
    const monthEntry = monthLabel
      ? status.months.find((m) => m.label === monthLabel)
      : undefined;
    const targetMonth = monthEntry ?? status.months[status.months.length - 1];
    if (!targetMonth) return;

    // Target week: currentWeek if it belongs to targetMonth's weeks
    // (BUG-8 validation), else the last available week (old effect 2).
    const weeks = status.weeksByMonth[targetMonth.key] || [];
    const weekValid = Boolean(currentWeek && weeks.includes(currentWeek));
    const targetWeek = weekValid
      ? currentWeek
      : (weeks[weeks.length - 1] ?? null);

    // Auto-select mode: month/week missing or invalid. ONLY in this mode do
    // we auto-resolve the compare period — so the first useAnalysis queryKey
    // is FULLY resolved (PERF-1). When month+week are valid, comparisonWeek
    // === null means the user explicitly picked "Tidak dibandingkan" in
    // FilterBar — leave it null (old effect 4 annoyingly re-set it).
    // `!monthEntry` covers the stale-month case (monthLabel no longer in
    // status, e.g. its data was deleted): targetMonth falls back to the
    // latest month, so the compare is re-resolved for the NEW month instead
    // of preserving one that may reference a deleted period.
    const needsAutoSelect = !monthLabel || !monthEntry || !currentWeek || !weekValid;

    let targetCompareWeek = comparisonWeek;
    let targetCompareMonth = comparisonMonth;
    if (needsAutoSelect) {
      // Default compare = SAME weekLabel in the most recent PRIOR month
      // (BUG-1 fix, kept from old effect 4: W4 Juli → W4 Juni).
      // FIX (AUDIT-BUG-2): no chronological fallback — cumulative weeks make
      // cross-week comparisons meaningless. No prior same-weekLabel month →
      // compare stays null.
      const compare = targetWeek
        ? findAutoCompareForStatus(status, targetMonth.label, targetWeek)
        : null;
      targetCompareWeek = compare?.weekLabel ?? null;
      targetCompareMonth = compare?.monthLabel ?? null;
    }

    // Guard against render loops: only commit when a value actually differs
    // from the current store state (e.g. first month of data → compare is
    // null and stays null → this effect settles after ONE setPeriod).
    if (
      targetMonth.label !== monthLabel ||
      targetWeek !== currentWeek ||
      targetCompareWeek !== comparisonWeek ||
      targetCompareMonth !== comparisonMonth
    ) {
      setPeriod(targetMonth.label, targetWeek, targetCompareWeek, targetCompareMonth);
    }
  }, [status, monthLabel, currentWeek, comparisonWeek, comparisonMonth, setPeriod]);

  // ============================================================
  //  Effect 2 — PERF-OPT cache warming (old effect 3).
  //  Fires a prefetch for the latest month/week as soon as status
  //  loads (don't wait for the auto-select effect to settle).
  //
  //  FIX (PERF-1 / AUDIT-FE): the prefetch now includes the RESOLVED
  //  compare period (same findAutoCompareForStatus search the combined
  //  effect uses), so the prefetch queryKey matches the final live
  //  useAnalysis queryKey EXACTLY — TanStack dedupes them into a single
  //  /api/analysis fetch. Previously it prefetched with compareWeek:
  //  null, which was a guaranteed wasted fetch. kelompok: null is also
  //  included so the key shape matches page.tsx's useAnalysis params
  //  field-for-field (same class of mismatch FilterBar's BUG-FE-1 fixed
  //  for the hover-prefetch).
  // ============================================================
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
    // Resolve the compare the combined auto-select effect WILL resolve,
    // so the prefetch key and the live key are identical.
    const compare = findAutoCompareForStatus(status, latestMonth.label, latestWeek);
    const params: AnalysisParams = {
      month: latestMonth.label,
      week: latestWeek,
      compareWeek: compare?.weekLabel ?? null, // resolved up front — not null (PERF-1)
      compareMonth: compare?.monthLabel ?? null,
      area: null,
      kelompok: null,
      outlet: null,
      item: null,
      pic: null,
    };
    prefetchAnalysis(queryClient, params);
    // PERF-HEATMAP: also prefetch heatmap (independent API, not part of
    // analysis). FIX (H-12 / prefetchHeatmap filter mismatch): carries the
    // store's CURRENT filters (normalized inside prefetchHeatmap exactly
    // like the heatmap card) so the warmed key matches the card's live key
    // by construction — previously it omitted them, so the prefetch was a
    // wasted fetch whenever a filter was active.
    prefetchHeatmap(queryClient, { month: params.month, week: params.week, area, kelompok, outletCode, pic });
    // Filters participate in the effect deps so a filter change re-syncs
    // the warming state (belt-and-braces for the key-parity invariant).
  }, [status, queryClient, monthLabel, currentWeek, area, kelompok, outletCode, pic]);
}
