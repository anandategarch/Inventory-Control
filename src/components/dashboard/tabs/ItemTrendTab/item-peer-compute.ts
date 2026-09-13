// ============================================================
//  ItemTrendTab — Item Peer Comparison compute helpers
//  --------------------------------------------------------
//  REFACTOR-1-b: pure move from ItemPeerComparison.tsx (no
//  behavior change). Pure, side-effect-free computations used
//  by the ItemPeerComparison drill-down panel:
//    - computeEfficiencyScore — composite 0-100 target vs peer avg
//    - rankColor              — rank badge color thresholds
//
//  No 'use client', no React — fully tree-shakeable + testable.
// ============================================================

import type { ItemPeerRow, ItemPeerAverages } from './ItemPeerComparison';

// ------------------------------------------------------------
//  Efficiency score — composite 0-100 based on target vs peer avg.
//  Penalty: |devBom| above peer avg (50pts), |nominalDeviasi| above peer
//  avg (50pts). Higher = better.
//  FIX (BUG-2-03): use ABS values for comparison — devBom is SIGNED (neg=LOSS,
//  pos=SURPLUS); comparing signed values would penalize SURPLUS targets (wrong
//  direction — SURPLUS is good, not bad).
// ------------------------------------------------------------

export function computeEfficiencyScore(target: ItemPeerRow, peerAvg: ItemPeerAverages): number {
  const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
  // FIX (BUG-2-03): compare ABSOLUTE magnitudes, not signed values.
  const targetAbsDevBom = target.devBom != null ? Math.abs(target.devBom) : 0;
  const peerAbsDevBom = Math.abs(peerAvg.devBom);
  const devBomPenalty = target.devBom != null
    ? Math.min(50, Math.max(0, safeDiv(targetAbsDevBom - peerAbsDevBom, peerAbsDevBom) * 25))
    : 0;
  const nominalPenalty = Math.min(
    50,
    Math.max(0, safeDiv(target.absNominalDeviasi - peerAvg.absNominalDeviasi, peerAvg.absNominalDeviasi) * 25),
  );
  const raw = 100 - (devBomPenalty + nominalPenalty);
  return Math.max(0, Math.min(100, raw));
}

// ------------------------------------------------------------
//  Rank color helper (matches Peer Tab style + the worst!=1 guard
//  for the Item Tab's small peer sets).
// ------------------------------------------------------------

export function rankColor(r: number, t: number): string {
  if (r === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (r === t && t > 1) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
  if (r <= t / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  return 'bg-muted text-muted-foreground';
}
