// ============================================================
//  ItemTrendTable — Pattern classification helper
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTable.tsx — no behavior
//  change). Classifies the blast radius of a period by outlet
//  count. Used by the "Pola" column.
//  Thresholds: Massal ≥10 / Regional ≥5 / Lokal ≥2 / Tunggal =1.
//  No 'use client', no React — fully tree-shakeable + testable.
// ============================================================

export function patternBadge(outletCount: number): { emoji: string; label: string; className: string } {
  if (outletCount >= 10) {
    return {
      emoji: '🔴',
      label: 'Massal',
      className: 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30',
    };
  }
  if (outletCount >= 5) {
    return {
      emoji: '🟡',
      label: 'Regional',
      className: 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30',
    };
  }
  if (outletCount >= 2) {
    return {
      emoji: '⚪',
      label: 'Lokal',
      className: 'text-muted-foreground border-border bg-muted/40',
    };
  }
  // FIX (BUG-1-02): outletCount=0 is semantically "no data", not "Tunggal" (single).
  // FIX (BUG-1-03): use distinct emoji for Tunggal (was same ⚪ as Lokal).
  if (outletCount === 1) {
    return {
      emoji: '📍',
      label: 'Tunggal',
      className: 'text-muted-foreground border-border bg-muted/40',
    };
  }
  // outletCount === 0 (shouldn't happen — item has records but no outlets?)
  return {
    emoji: '—',
    label: 'N/A',
    className: 'text-muted-foreground/50 border-border bg-muted/20',
  };
}
