// ============================================================
//  PrioritySummaryCard — shared helpers
//  (split from PrioritySummaryCard.tsx — Phase 3)
// ============================================================

// ------------------------------------------------------------
//  Priority badge by score (visual indicator on each signal row)
// ------------------------------------------------------------

export function priorityBadge(score: number): { label: string; cls: string; dot: string } {
  if (score >= 80) return {
    label: 'CRITICAL',
    cls: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800',
    dot: 'bg-red-500',
  };
  if (score >= 50) return {
    label: 'HIGH',
    cls: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800',
    dot: 'bg-amber-500',
  };
  if (score > 0) return {
    label: 'LOW',
    cls: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800',
    dot: 'bg-emerald-500',
  };
  return {
    label: 'NONE',
    cls: 'bg-muted text-muted-foreground border-border',
    dot: 'bg-muted-foreground/40',
  };
}

// ------------------------------------------------------------
//  Deterministic pseudo-random — for stable chart data synthesis
//  (avoids re-randomization on each render)
// ------------------------------------------------------------

export const seededRand = (seed: number): number => {
  const x = Math.sin(seed * 9999 + 1234) * 10000;
  return x - Math.floor(x); // 0..1
};
