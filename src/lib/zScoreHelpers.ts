// ============================================================
//  Z-Score Helpers — shared coloring + status-label helpers
//  --------------------------------------------------------
//  Coloring + status-label helpers for signed Z-Score values.
//  Used by ItemTrendTable (ItemTrendTab) and HistoricalZScoreCard
//  so the dashboard has ONE visual language for signed Z-Scores.
//
//  FIX (BATCH1): extracted from ItemTrendTab/zScoreHelpers.ts so
//  HistoricalZScoreCard can import the same single source of truth
//  (it previously held an identical local copy).
// ============================================================

// SIGNED Z-Score coloring: positive = worse (red), negative = better (green).
// Matches HistoricalZScoreCard + ItemTrendTable — single visual language.
export function zScoreColor(z: number): string {
  if (z > 3) return 'text-red-600 dark:text-red-400 font-bold';
  if (z > 2) return 'text-amber-600 dark:text-amber-400 font-semibold';
  if (z > 1) return 'text-yellow-600 dark:text-yellow-400';
  if (z < -2) return 'text-emerald-600 dark:text-emerald-400 font-medium';
  if (z < -1) return 'text-emerald-500 dark:text-emerald-500';
  return 'text-muted-foreground';
}

// Status label + Badge variant for signed Z-Score.
// Accepts null (returns '—') for items with no historical baseline.
// FIX (BUG-LIB-12): z in [-2,-1) now returns 'BAIK' (matches zScoreColor
// which returns emerald-500 for that range). Was returning 'NORMAL' —
// asymmetric with positive side (z=+2 → WARNING, z=-2 → NORMAL was misleading).
export function zScoreStatus(z: number | null): { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' } {
  if (z == null) return { label: '—', variant: 'outline' };
  if (z > 3) return { label: 'ABNORMAL', variant: 'destructive' };
  if (z > 2) return { label: 'WARNING', variant: 'default' };
  if (z > 1) return { label: 'ELEVATED', variant: 'secondary' };
  if (z < -2) return { label: 'BAIK', variant: 'outline' };
  if (z < -1) return { label: 'BAIK', variant: 'outline' }; // FIX (BUG-LIB-12)
  return { label: 'NORMAL', variant: 'outline' };
}
