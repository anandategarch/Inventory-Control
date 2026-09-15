// ============================================================
//  ItemTrendTab — Flip Ranking badge + key helpers
//  --------------------------------------------------------
//  REFACTOR-1-b: pure move from FlipRanking.tsx (no behavior
//  change). Pure, side-effect-free helpers shared by the
//  FlipRanking table and the FlipDrillPanel drill-down:
//    - riskBadge        → risk level badge (class + label)
//    - categoryBadge    → flip category badge (emoji + class)
//    - directionBadgeClass → LOSS/SURPLUS badge class
//    - drillKey         → drill-down expand/collapse state key
//    - monthPrefix      → short month extraction from period label
//  Plus the shared `FlipPair` response type (used by both the
//  ranking table rows and the drill panel props).
//
//  No 'use client', no React — fully tree-shakeable + testable.
// ============================================================

// Local types matching /api/flip-ranking response (kept local to avoid
// importing from the API route file — backend types are not exported).
export interface FlipPair {
  period1Label: string;
  period2Label: string;
  weekLabel: string;
  qtyP1: number;
  qtyP2: number;
  net: number;
  /** P2 − P1 (signed change between the two periods). VERIFY-FLIP: master
   *  context requires topFlips pairs to carry P1/P2/Δ/net/disparity/category.
   *  Optional + defensive: 5-min in-memory API cache can serve a pre-fix
   *  payload — consumers fall back to qtyP2 − qtyP1. */
  delta?: number;
  disparityPct: number;
  category: string;
}

export function riskBadge(level: 'low' | 'moderate' | 'high'): { className: string; label: string } {
  switch (level) {
    case 'high':
      return {
        className: 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400',
        label: 'HIGH',
      };
    case 'moderate':
      return {
        className: 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400',
        label: 'MODERATE',
      };
    case 'low':
      return {
        className: 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/60 dark:border-emerald-800 dark:text-emerald-400',
        label: 'LOW',
      };
  }
}

export function categoryBadge(category: string): { emoji: string; className: string } {
  switch (category) {
    case 'sempurna':
      return { emoji: '🟢', className: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' };
    case 'dominan':
      return { emoji: '🟡', className: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30' };
    case 'parsial':
      return { emoji: '🔴', className: 'text-red-600 bg-red-50 dark:bg-red-950/30' };
    default:
      return { emoji: '⚪', className: 'text-muted-foreground bg-muted/40' };
  }
}

/**
 * Build the drill-down cache key — `${itemName}|${weekLabel}|${period1Label}`.
 * Used as the `expandedFlip` state value so toggling the same row closes it
 * and toggling a different row closes the previous + opens the new one.
 */
export function drillKey(itemName: string, weekLabel: string, period1Label: string): string {
  return `${itemName}|${weekLabel}|${period1Label}`;
}

/**
 * Extract the month prefix from a short period label like "Jul W4" → "Jul".
 * The drill-down API accepts either a full label ("Juli 2026") or a short
 * prefix ("Jul") and matches via ILIKE. Sending the short prefix is simplest
 * — it's already what FlipPair.period1Label contains.
 */
export function monthPrefix(periodLabel: string): string {
  // "Jul W4" → "Jul", "Juli 2026 W4" → "Juli" (handle both shapes defensively).
  // Take everything before the FIRST space.
  const idx = periodLabel.indexOf(' ');
  return idx > 0 ? periodLabel.slice(0, idx) : periodLabel;
}

export function directionBadgeClass(direction: string): string {
  switch (direction) {
    case 'LOSS':
      return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'SURPLUS':
      return 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/60 dark:border-emerald-800 dark:text-emerald-400';
    default:
      return 'text-muted-foreground bg-muted/50 border-border';
  }
}
