// ============================================================
//  ItemTrendTab — Z-Score Helpers
//  --------------------------------------------------------
//  Coloring + status-label helpers for signed Z-Score values.
//  Used by ItemTrendTable to color Z-Score cells + status badges.
//
//  TODO: deduplicate with HistoricalZScoreCard — extract to
//  lib/zScoreHelpers.ts. The HistoricalZScoreCard.tsx file has
//  identical helpers but is intentionally NOT modified in this
//  task (potential parallel-work conflict). A future refactor
//  should consolidate both copies into a single lib/zScoreHelpers.
// ============================================================

// SIGNED Z-Score coloring — matches HistoricalZScoreCard exactly so the
// dashboard has ONE visual language for signed Z-Scores.
export function zScoreColor(z: number): string {
  if (z > 3) return 'text-red-600 dark:text-red-400 font-bold';
  if (z > 2) return 'text-amber-600 dark:text-amber-400 font-semibold';
  if (z > 1) return 'text-yellow-600 dark:text-yellow-400';
  if (z < -2) return 'text-emerald-600 dark:text-emerald-400 font-medium';
  if (z < -1) return 'text-emerald-500 dark:text-emerald-500';
  return 'text-muted-foreground';
}

export function zScoreStatus(z: number | null): { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' } {
  if (z == null) return { label: '—', variant: 'outline' };
  if (z > 3) return { label: 'ABNORMAL', variant: 'destructive' };
  if (z > 2) return { label: 'WARNING', variant: 'default' };
  if (z > 1) return { label: 'ELEVATED', variant: 'secondary' };
  if (z < -2) return { label: 'BAIK', variant: 'outline' };
  return { label: 'NORMAL', variant: 'outline' };
}
