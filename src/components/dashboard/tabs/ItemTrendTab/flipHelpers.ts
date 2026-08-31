// ============================================================
//  ItemTrendTab — Flip Detection Helpers (Phase A+B / FLIP-FE)
//  --------------------------------------------------------
//  Pure helper module for "flip pattern" detection.
//
//  A "flip" is a balanced reversal between same-week periods
//  (e.g. W4 Jul vs W4 Agu) — i.e. the SIGNED qtyDeviasiSigned
//  changes sign between consecutive same-week periods. The
//  "disparity" score (|net| / max(|P1|,|P2|)) quantifies how
//  perfectly balanced the reversal is:
//    - 0%  → P1 + P2 == 0 (perfect cancellation — suspicious,
//                          likely an adjustment/cutoff pattern)
//    - 100% → one side dominates the other
//
//  Categories:
//    sempurna       — flip AND disparity < 10%   (suspicious)
//    dominan        — flip AND disparity 10-40%  (one side dominant)
//    parsial        — flip AND disparity >= 40%  (partial flip)
//    konsisten-naik — NOT flip AND P2 > P1       (same dir, increasing)
//    konsisten-turun— NOT flip AND P2 < P1       (same dir, decreasing)
//    stagnan        — NOT flip AND P2 == P1      (no change)
//    first          — no predecessor (first same-week period)
//
//  Risk levels:
//    high     — sempurna flip
//    moderate — dominan or parsial flip
//    low      — konsisten / first
//
//  No 'use client', no React — fully tree-shakeable + unit-testable.
// ============================================================

import type { ItemTrendPeriod } from '@/hooks/useAnalysis';
import { periodShortLabel } from './periodHelpers';

// ----------------------------------------------------------------
//  Types
// ----------------------------------------------------------------

export interface FlipAnalysis {
  /** `${monthLabel}|${weekLabel}` of P1 (earlier period). */
  period1Key: string;
  /** `${monthLabel}|${weekLabel}` of P2 (later period). */
  period2Key: string;
  /** Short label of P1, e.g. "Jul W4". */
  period1Label: string;
  /** Short label of P2, e.g. "Agu W4". */
  period2Label: string;
  /** The shared weekLabel (e.g. "WEEK 4"). */
  weekLabel: string;
  /** Signed qtyDeviasiSigned of P1 (negative = LOSS, positive = SURPLUS). */
  qtyP1: number;
  /** Signed qtyDeviasiSigned of P2. */
  qtyP2: number;
  /** True iff signs of P1 + P2 differ AND both non-zero. */
  isFlip: boolean;
  /** P1 + P2 (signed net of the pair). */
  net: number;
  /** |net| / max(|P1|, |P2|), in range [0, 1]. */
  disparity: number;
  /** disparity × 100, in range [0, 100]. */
  disparityPct: number;
  category: 'sempurna' | 'dominan' | 'parsial' | 'konsisten-naik' | 'konsisten-turun' | 'stagnan' | 'first';
  riskLevel: 'high' | 'moderate' | 'low';
}

export interface ItemFlipScore {
  /** Total same-week consecutive pairs analyzed. */
  totalPairs: number;
  /** Number of pairs that are flips (sign change, both non-zero). */
  flipCount: number;
  /** flipCount / totalPairs (0 when totalPairs === 0). */
  flipRate: number;
  /** Mean disparity of FLIP pairs only (0 when no flips). */
  avgDisparity: number;
  sempurnaCount: number;
  dominanCount: number;
  parsialCount: number;
  /** konsisten-naik + konsisten-turun + stagnan (NOT flip, NOT first). */
  konsistenCount: number;
  /** 0-100 — weighted risk score for the item (sempurna=100, dominan=60, parsial=30, others=0). */
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'high';
}

// ----------------------------------------------------------------
//  Internal helpers
// ----------------------------------------------------------------

/** Build the stable period key `${monthLabel}|${weekLabel}`. */
export function periodKey(p: ItemTrendPeriod): string {
  return `${p.monthLabel}|${p.weekLabel}`;
}

/** Safe sign helper — returns -1, 0, or +1. */
function sign(n: number): -1 | 0 | 1 {
  if (n < 0) return -1;
  if (n > 0) return 1;
  return 0;
}

// ----------------------------------------------------------------
//  Public API
// ----------------------------------------------------------------

/**
 * Group periods by weekLabel, then sort each group by monthKey ASC
 * (chronological within the same week). Returns a Map keyed by
 * weekLabel, preserving insertion order of the first-seen week.
 */
export function groupPeriodsByWeek(periods: ItemTrendPeriod[]): Map<string, ItemTrendPeriod[]> {
  const groups = new Map<string, ItemTrendPeriod[]>();
  for (const p of periods) {
    const list = groups.get(p.weekLabel);
    if (list) {
      list.push(p);
    } else {
      groups.set(p.weekLabel, [p]);
    }
  }
  // Sort each group's periods by monthKey ASC (chronological).
  // monthKey may be null in rare cases — fall back to monthLabel so the
  // sort is still stable (uses localeCompare on the string fallback).
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const ka = a.monthKey ?? a.monthLabel;
      const kb = b.monthKey ?? b.monthLabel;
      return ka.localeCompare(kb);
    });
  }
  return groups;
}

/**
 * Compute flip analysis for ALL same-week consecutive pairs.
 *
 * For each week group (sorted chronologically), iterate consecutive
 * (P1, P2) pairs and compute isFlip + disparity + category + risk.
 *
 * Pairs where both P1.qtyDeviasiSigned == 0 AND P2.qtyDeviasiSigned == 0
 * are classified as `stagnan` (no change). Pairs where exactly one side
 * is zero are NOT flips (sign change requires both non-zero) and fall
 * into `konsisten-naik` / `konsisten-turun` based on direction.
 */
export function computeFlipAnalyses(periods: ItemTrendPeriod[]): FlipAnalysis[] {
  const groups = groupPeriodsByWeek(periods);
  const out: FlipAnalysis[] = [];

  for (const [weekLabel, list] of groups) {
    for (let i = 1; i < list.length; i++) {
      const p1 = list[i - 1];
      const p2 = list[i];
      const qtyP1 = p1.qtyDeviasiSigned;
      const qtyP2 = p2.qtyDeviasiSigned;
      const net = qtyP1 + qtyP2;
      const absP1 = Math.abs(qtyP1);
      const absP2 = Math.abs(qtyP2);
      const maxMagnitude = Math.max(absP1, absP2);
      // Disparity: 0 when net cancels perfectly, 1 when one side dominates entirely.
      const disparity = maxMagnitude > 0 ? Math.min(Math.abs(net) / maxMagnitude, 1) : 0;
      const disparityPct = disparity * 100;
      const isFlip = sign(qtyP1) !== sign(qtyP2) && qtyP1 !== 0 && qtyP2 !== 0;

      let category: FlipAnalysis['category'];
      let riskLevel: FlipAnalysis['riskLevel'];

      if (isFlip) {
        if (disparity < 0.10) {
          category = 'sempurna';
          riskLevel = 'high';
        } else if (disparity < 0.40) {
          category = 'dominan';
          riskLevel = 'moderate';
        } else {
          category = 'parsial';
          riskLevel = 'moderate';
        }
      } else {
        // Same direction (or one side zero) — classify by delta.
        if (qtyP2 > qtyP1) {
          category = 'konsisten-naik';
        } else if (qtyP2 < qtyP1) {
          category = 'konsisten-turun';
        } else {
          category = 'stagnan';
        }
        riskLevel = 'low';
      }

      out.push({
        period1Key: periodKey(p1),
        period2Key: periodKey(p2),
        period1Label: periodShortLabel(p1),
        period2Label: periodShortLabel(p2),
        weekLabel,
        qtyP1,
        qtyP2,
        isFlip,
        net,
        disparity,
        disparityPct,
        category,
        riskLevel,
      });
    }
  }

  return out;
}

/**
 * Compute aggregate flip score for an item across all same-week pairs.
 *
 * `riskScore` is a weighted 0-100 score:
 *   sempurna → 100 per pair
 *   dominan  → 60 per pair
 *   parsial  → 30 per pair
 *   others   → 0 per pair
 * Averaged across totalPairs (so an item with 1 sempurna out of 1 pair
 * = 100; out of 4 pairs = 25).
 *
 * `riskLevel` thresholds:
 *   riskScore >= 50 → high
 *   riskScore >= 20 → moderate
 *   else            → low
 */
export function computeItemFlipScore(flips: FlipAnalysis[]): ItemFlipScore {
  const totalPairs = flips.length;
  if (totalPairs === 0) {
    return {
      totalPairs: 0,
      flipCount: 0,
      flipRate: 0,
      avgDisparity: 0,
      sempurnaCount: 0,
      dominanCount: 0,
      parsialCount: 0,
      konsistenCount: 0,
      riskScore: 0,
      riskLevel: 'low',
    };
  }

  let flipCount = 0;
  let sempurnaCount = 0;
  let dominanCount = 0;
  let parsialCount = 0;
  let konsistenCount = 0;
  let disparitySum = 0;

  for (const f of flips) {
    if (f.isFlip) {
      flipCount++;
      disparitySum += f.disparity;
      if (f.category === 'sempurna') sempurnaCount++;
      else if (f.category === 'dominan') dominanCount++;
      else if (f.category === 'parsial') parsialCount++;
    } else {
      konsistenCount++;
    }
  }

  // Weighted risk: sempurna=100, dominan=60, parsial=30, others=0.
  const weighted = sempurnaCount * 100 + dominanCount * 60 + parsialCount * 30;
  const riskScore = Math.round(weighted / totalPairs);
  const riskLevel: ItemFlipScore['riskLevel'] =
    riskScore >= 50 ? 'high' : riskScore >= 20 ? 'moderate' : 'low';

  return {
    totalPairs,
    flipCount,
    flipRate: flipCount / totalPairs,
    avgDisparity: flipCount > 0 ? disparitySum / flipCount : 0,
    sempurnaCount,
    dominanCount,
    parsialCount,
    konsistenCount,
    riskScore,
    riskLevel,
  };
}

/**
 * Get flip analysis for a specific period (vs its same-week predecessor).
 *
 * Looks up the flip pair where this period is P2 (the later period).
 * Returns null if this period has no same-week predecessor (i.e. it is
 * the first same-week period — categorized as `first`).
 *
 * Note: a period CAN appear as P1 of the next pair (with its successor),
 * but that pair describes the NEXT period's flip, not this one's. We only
 * return pairs where `period2Key === periodKey`.
 */
export function getFlipForPeriod(flips: FlipAnalysis[], periodKey: string): FlipAnalysis | null {
  for (const f of flips) {
    if (f.period2Key === periodKey) return f;
  }
  return null;
}

/**
 * Get ALL flip analyses a period is involved in (as P1 OR P2).
 *
 * Used by the chart annotation: a dot is "flip-flagged" if it is either
 * side of any flip pair. Returns an empty array when the period is not
 * part of any flip pair.
 */
export function getFlipsForPeriod(flips: FlipAnalysis[], periodKey: string): FlipAnalysis[] {
  const out: FlipAnalysis[] = [];
  for (const f of flips) {
    if (f.period1Key === periodKey || f.period2Key === periodKey) {
      out.push(f);
    }
  }
  return out;
}

/** Format disparity for display: "0%" / "33%" / "100%" (rounded to int). */
export function formatDisparity(flip: FlipAnalysis): string {
  return `${Math.round(flip.disparityPct)}%`;
}

/**
 * Get badge config for a flip category.
 *
 * Returns the emoji + short label + Tailwind className for a badge.
 * `first` returns muted "—" styling (caller usually renders "—" text
 * directly instead of a badge).
 */
export function flipBadge(category: FlipAnalysis['category']): { emoji: string; label: string; className: string } {
  switch (category) {
    case 'sempurna':
      return {
        emoji: '🟢',
        label: 'Sempurna',
        className: 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30',
      };
    case 'dominan':
      return {
        emoji: '🟡',
        label: 'Dominan',
        className: 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30',
      };
    case 'parsial':
      return {
        emoji: '🔴',
        label: 'Parsial',
        className: 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30',
      };
    case 'konsisten-naik':
      return {
        emoji: '⬆',
        label: 'Konsisten',
        className: 'text-muted-foreground border-border bg-muted/40',
      };
    case 'konsisten-turun':
      return {
        emoji: '⬇',
        label: 'Konsisten',
        className: 'text-muted-foreground border-border bg-muted/40',
      };
    case 'stagnan':
      return {
        emoji: '⚪',
        label: 'Stagnan',
        className: 'text-muted-foreground border-border bg-muted/40',
      };
    case 'first':
    default:
      return {
        emoji: '—',
        label: '',
        className: 'text-muted-foreground/50 border-transparent',
      };
  }
}
