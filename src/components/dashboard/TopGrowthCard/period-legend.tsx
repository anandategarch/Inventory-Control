'use client';

// ============================================================
//  TopGrowthCard — PeriodLegend (TASK H-5)
//  (split from TopGrowthCard.tsx — SPLIT-G; pure code motion)
//
//  The two compared periods, spelled out. Small definition-list
//  rows: label (Kini/Pembanding) → value with the concrete week +
//  month + day range and, for the compare row, HOW it was chosen
//  (otomatis vs dipilih). Answers "growth dari periode apa aja?"
//  at a glance.
// ============================================================

import { Badge } from '@/components/ui/badge';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { formatPeriodLabel } from './format';

export function PeriodLegend({ data }: { data: AnalysisData }) {
  const { monthLabel, weekLabel, comparisonWeek, comparisonMonth, comparisonAuto, weekRange, comparisonWeekRange } =
    data.period;

  const currText = formatPeriodLabel(weekLabel, monthLabel, weekRange);
  const hasCompare = !!comparisonWeek;
  const compareText = hasCompare
    ? formatPeriodLabel(
        comparisonWeek,
        comparisonMonth && comparisonMonth !== monthLabel ? comparisonMonth : monthLabel,
        comparisonWeekRange,
      )
    : null;

  return (
    <div className="ml-9 mt-1 grid grid-cols-[auto_1fr] items-baseline gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums">
      <span className="font-medium text-muted-foreground/80">Periode ini</span>
      <span className="font-medium text-foreground/85 truncate" title={currText}>{currText}</span>

      <span className="font-medium text-muted-foreground/80">Pembanding</span>
      {compareText ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-amber-700 dark:text-amber-400 font-medium truncate" title={compareText}>
            {compareText}
          </span>
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[9px] font-medium leading-none border-border/60 text-muted-foreground"
            title={
              comparisonAuto
                ? 'Periode pembanding otomatis: minggu yang sama di bulan sebelumnya'
                : 'Periode pembanding dipilih pada filter'
            }
          >
            {comparisonAuto ? 'otomatis' : 'dipilih'}
          </Badge>
        </span>
      ) : (
        <span className="text-muted-foreground/60 italic">belum ada — upload minggu di bulan sebelumnya</span>
      )}
    </div>
  );
}
