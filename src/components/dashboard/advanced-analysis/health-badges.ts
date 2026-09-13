// ============================================================
//  health-badges — pure color/label helpers shared by the
//  advanced-analysis cards. Moved verbatim from
//  AdvancedAnalysis.tsx (REFACTOR-1-c pure split — zero behavior
//  change).
// ============================================================

// ============================================================
//  Helpers
// ============================================================
export function healthScoreColor(score: number): string {
  if (score < 30) return 'text-red-600 dark:text-red-400';
  if (score < 50) return 'text-amber-600 dark:text-amber-400';
  if (score < 70) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

export function healthScoreBg(score: number): string {
  if (score < 30) return 'bg-red-500';
  if (score < 50) return 'bg-amber-500';
  if (score < 70) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

export function lossToSalesColor(r: number | null | undefined): string {
  if (r == null) return 'text-muted-foreground';
  if (r > 0.10) return 'text-red-600 dark:text-red-400';
  if (r > 0.05) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

// ============================================================
//  1.3 ItemConsistencyAnalysis
//  Analisis pola item (MASSAL / REGIONAL / LOKAL)
//  Display mapping: SYSTEMIC→Massal, WIDESPREAD→Regional, ISOLATED→Lokal
// ============================================================
export function consistencyLabel(type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED'): string {
  switch (type) {
    case 'SYSTEMIC': return 'Massal';
    case 'WIDESPREAD': return 'Regional';
    case 'ISOLATED': return 'Lokal';
    default: return 'Lokal';
  }
}

export function consistencyBadge(type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED'): string {
  switch (type) {
    case 'SYSTEMIC': return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'WIDESPREAD': return 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400';
    case 'ISOLATED': return 'text-muted-foreground bg-muted/50 border-border';
    default: return 'text-muted-foreground bg-muted/50 border-border';
  }
}
