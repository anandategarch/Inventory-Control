// ============================================================
//  ItemTrendTab — Period Formatting Helpers
//  --------------------------------------------------------
//  Small pure helpers for sorting + shortening ItemTrendPeriod
//  labels. Used by both the main orchestrator (chronological sort
//  for the chart) and ItemTrendTable (row label + period column
//  sort).
// ============================================================

import type { ItemTrendPeriod } from '@/hooks/useAnalysis';

// Chronological sort key (year-month + week number) — sorts periods
// ascending in time so the chart + table both read left-to-right.
export function periodSortKey(p: ItemTrendPeriod): string {
  const wk = parseInt(p.weekLabel.replace(/\D/g, ''), 10) || 0;
  return `${p.monthKey}|${String(wk).padStart(2, '0')}`;
}

// Short label for X-axis + table: "Jun W4"
export function periodShortLabel(p: ItemTrendPeriod): string {
  const mon = p.monthLabel.slice(0, 3);
  const wk = p.weekLabel.replace('WEEK ', 'W');
  return `${mon} ${wk}`;
}
