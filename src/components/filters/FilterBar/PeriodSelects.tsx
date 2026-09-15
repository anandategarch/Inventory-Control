'use client';

// ============================================================
//  PeriodSelects — the 3 period dropdowns (Bulan / Minggu /
//  Perbandingan) with hover-prefetch. Moved verbatim from
//  FilterBar.tsx's `periodSelects()` render helper (SPLIT-C pure
//  code motion — zero behavior change): the JSX, the hover
//  prefetch params, and every comment are unchanged. Props are
//  typed with Pick<FilterBarState, ...> so the handler/store
//  signatures cannot drift from useDashboard's store.
//  SPEC-1 (§16.1): shared filter fields — the 3 period Selects
//  bind to the SAME zustand state + handlers as the pre-split
//  helper (desktop-only app — single inline wrap-row layout).
// ============================================================

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePrefetchAnalysis } from '@/hooks/useAnalysis';
import { findAutoCompareForStatus } from '@/lib/auto-compare';
import type { FilterBarState } from './use-filter-bar-state';

export type PeriodSelectsProps = Pick<
  FilterBarState,
  | 'isLoading'
  | 'status'
  | 'months'
  | 'weeks'
  | 'monthLabel'
  | 'currentWeek'
  | 'compareValue'
  | 'allComparePeriods'
  | 'area'
  | 'kelompok'
  | 'outletCode'
  | 'itemName'
  | 'pic'
  | 'handleMonthChange'
  | 'handleWeekChange'
  | 'setCompareWeek'
>;

export function PeriodSelects(props: PeriodSelectsProps) {
  const {
    isLoading,
    status,
    months,
    weeks,
    monthLabel,
    currentWeek,
    compareValue,
    allComparePeriods,
    area,
    kelompok,
    outletCode,
    itemName,
    pic,
    handleMonthChange,
    handleWeekChange,
    setCompareWeek,
  } = props;
  const prefetchAnalysis = usePrefetchAnalysis();

  return (
    <>
      <Select value={monthLabel || ''} onValueChange={handleMonthChange} disabled={isLoading}>
        <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[120px]"><SelectValue placeholder="Bulan" /></SelectTrigger>
        <SelectContent>
          {months.map((m) => (
            <SelectItem
              key={m.key}
              value={m.label}
              className="text-xs"
              // PERF-OPT: prefetch analysis for this month on hover.
              // Uses the LAST week of the hovered month (handleMonthChange
              // picks the same week on click) + the resolved compare so
              // the prefetch key matches the live key.
              // TanStack Query dedupes — safe to fire multiple times.
              onMouseEnter={() => {
                const weeksForMonth = status?.weeksByMonth?.[m.key] || [];
                const lastWeek = weeksForMonth[weeksForMonth.length - 1];
                if (!lastWeek) return;
                // FIX (BUG-FE-1): include kelompok in prefetch params
                // so the prefetch queryKey matches the live useAnalysis
                // queryKey. Without this, prefetch cache entries were
                // never reused when kelompok was active.
                // FIX (PERF-1 / AUDIT-FE): also include the RESOLVED
                // compare period — handleMonthChange now sets it on
                // click, so compareWeek: null here would make the
                // hover-prefetch key never match the live key.
                const compare = findAutoCompareForStatus(status, m.label, lastWeek);
                prefetchAnalysis({
                  month: m.label,
                  week: lastWeek,
                  compareWeek: compare?.weekLabel ?? null,
                  compareMonth: compare?.monthLabel ?? null,
                  area,
                  kelompok,
                  outlet: outletCode,
                  item: itemName,
                  pic,
                });
              }}
            >
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentWeek || ''} onValueChange={handleWeekChange} disabled={!monthLabel}>
        <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[90px]"><SelectValue placeholder="Minggu" /></SelectTrigger>
        <SelectContent>
          {weeks.map((w) => (
            <SelectItem
              key={w}
              value={w}
              className="text-xs"
              // PERF-OPT: prefetch analysis for this week on hover.
              // Includes the resolved compare period so the prefetch
              // key matches what useAnalysis will send when the user
              // actually clicks (handleWeekChange).
              onMouseEnter={() => {
                if (!monthLabel) return;
                // FIX (BUG-FE-1): include kelompok in prefetch params
                // FIX (PERF-1 / AUDIT-FE): also include the RESOLVED
                // compare period — handleWeekChange now sets it on
                // click (was compareWeek: null, which relied on a
                // server-side auto-resolve the live query no longer
                // triggers after the atomic-handler change).
                const compare = findAutoCompareForStatus(status, monthLabel, w);
                prefetchAnalysis({
                  month: monthLabel,
                  week: w,
                  compareWeek: compare?.weekLabel ?? null,
                  compareMonth: compare?.monthLabel ?? null,
                  area,
                  kelompok,
                  outlet: outletCode,
                  item: itemName,
                  pic,
                });
              }}
            >
              {w}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={compareValue}
        onValueChange={(v) => {
          if (v === 'auto') {
            setCompareWeek(null, null);
          } else {
            const [wk, ml] = v.split('|||');
            setCompareWeek(wk, ml);
          }
        }}
        disabled={!currentWeek}
      >
        <SelectTrigger className="h-8 text-xs bg-background hover:bg-muted/40 transition-colors min-w-[150px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="auto" className="text-xs">Otomatis (periode sebelumnya)</SelectItem>
          {allComparePeriods.map((p) => (
            <SelectItem
              key={`${p.weekLabel}|${p.monthLabel}`}
              value={`${p.weekLabel}|||${p.monthLabel}`}
              className="text-xs"
            >
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
