// ============================================================
//  Change Analysis — pure change statistics (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  computeChangeStats + classifyChange and their types — the
//  pure, DB-free half of the change-analysis module (exported
//  for tests). Semantics doc: see ./change-analysis.ts header.
//
//  Split from ./change-analysis.ts (SPLIT-E — pure code motion;
//  computation and comments preserved verbatim). Public symbols
//  stay re-exported from ./change-analysis.ts.
// ============================================================
import { calcGrowthAbs } from '@/lib/metrics/growth';

// ------------------------------------------------------------
//  Pure computation (exported for tests) — one outlet's series
//  of same-week monthly snapshots → change statistics.
// ------------------------------------------------------------
/** One (month, same-week) snapshot of an outlet's deviation sums. */
export interface ChangeSeriesPoint {
  monthKey: string;
  /** SUM(nominalDeviasi) — SIGNED net (negative = LOSS). */
  nominal: number;
  /** SUM(qtyDeviasi) — SIGNED net. */
  qty: number;
}

/** Change statistics for one outlet (or one outlet×item). */
export interface ChangeStats {
  /** Baseline pair count (consecutive same-week snapshots BEFORE the current pair). */
  pairs: number;
  /** False when the outlet has no current-month snapshot (cannot be evaluated). */
  hasCurrent: boolean;
  /** mean |Δ nominal| over the baseline pairs (0 when no pairs). */
  avgSwingNominal: number;
  /** mean |Δ qty| over the baseline pairs (0 when no pairs). */
  avgSwingQty: number;
  /** mean |%Δ nominal| over the baseline pairs (null when no computable %). */
  avgPctNominal: number | null;
  /** |V_now| − |V_prev| (Rp) — + = deviation grew (memburuk), − = shrank. Null = no current pair. */
  deltaNominal: number | null;
  /** |Q_now| − |Q_prev| (qty) — same magnitude-change convention. */
  deltaQty: number | null;
  /** calcGrowthAbs(V_now, V_prev) — null when |V_prev| = 0 (small-base guard). */
  deltaPctNominal: number | null;
  /** |V_now − V_prev| (Rp) — the CURRENT movement size. Null = no current pair. */
  swingNominal: number | null;
  /** |Q_now − Q_prev| — the CURRENT movement size (qty). */
  swingQty: number | null;
  /** swingNominal / avgSwingNominal — null when the baseline is flat (see BARU_BERGERAK) or no pair. */
  ratioNominal: number | null;
  /** swingQty / avgSwingQty. */
  ratioQty: number | null;
  /** LOSS↔SURPLUS flip between the current pair (both sides non-zero). */
  isFlip: boolean;
  /** No snapshot before the current one at all (appeared this period). */
  isNew: boolean;
}

/** Runtime-tunable thresholds (Settings keys CHANGE_*). */
export interface ChangeThresholds {
  /** swing/avgSwing at/above this = ANOMALI (default 2.0). */
  ratioThreshold: number;
  /** Minimum baseline pairs before any ratio is judged (default 4). */
  minPairs: number;
  /** Minimum current swing (Rp) for ANOMALI / BARU_BERGERAK — noise gate (default 100k). */
  minNominal: number;
}

/** Lifecycle status derived from stats + thresholds. */
export type ChangeStatus = 'ANOMALI' | 'BARU_BERGERAK' | 'NORMAL' | 'DATA_KURANG';

/**
 * Compute change statistics for ONE series of same-week monthly snapshots.
 *
 * `points` may be in any order (sorted by monthKey internally). The point
 * whose monthKey equals `currentMonthKey` is the running snapshot — with the
 * window query (`monthKey <= current`) it is the LAST point when present.
 * A missing current snapshot yields hasCurrent=false (everything null).
 */
export function computeChangeStats(points: ChangeSeriesPoint[], currentMonthKey: string): ChangeStats {
  const sorted = [...points].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const n = sorted.length;
  let currentIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (sorted[i].monthKey === currentMonthKey) {
      currentIdx = i;
      break;
    }
  }
  if (currentIdx === -1) {
    return {
      pairs: 0, hasCurrent: false,
      avgSwingNominal: 0, avgSwingQty: 0, avgPctNominal: null,
      deltaNominal: null, deltaQty: null, deltaPctNominal: null,
      swingNominal: null, swingQty: null,
      ratioNominal: null, ratioQty: null,
      isFlip: false, isNew: false,
    };
  }

  // Baseline pairs = consecutive pairs ENDING BEFORE the current pair
  // (pair i = points[i-1] → points[i]; baseline = i in 1..currentIdx-1).
  const pairs = Math.max(0, currentIdx - 1);
  let sumSwingN = 0;
  let sumSwingQ = 0;
  const pctVals: number[] = [];
  for (let i = 1; i <= currentIdx - 1; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    sumSwingN += Math.abs(b.nominal - a.nominal);
    sumSwingQ += Math.abs(b.qty - a.qty);
    const g = calcGrowthAbs(b.nominal, a.nominal);
    if (g != null) pctVals.push(Math.abs(g));
  }
  const avgSwingNominal = pairs > 0 ? sumSwingN / pairs : 0;
  const avgSwingQty = pairs > 0 ? sumSwingQ / pairs : 0;
  const avgPctNominal = pctVals.length > 0 ? pctVals.reduce((x, y) => x + y, 0) / pctVals.length : null;

  const cur = sorted[currentIdx];
  const prev = currentIdx > 0 ? sorted[currentIdx - 1] : null;
  const pNom = prev ? prev.nominal : 0;
  const pQty = prev ? prev.qty : 0;
  const swingNominal = Math.abs(cur.nominal - pNom);
  const swingQty = Math.abs(cur.qty - pQty);
  return {
    pairs,
    hasCurrent: true,
    avgSwingNominal,
    avgSwingQty,
    avgPctNominal,
    deltaNominal: Math.abs(cur.nominal) - Math.abs(pNom),
    deltaQty: Math.abs(cur.qty) - Math.abs(pQty),
    deltaPctNominal: calcGrowthAbs(cur.nominal, pNom),
    swingNominal,
    swingQty,
    ratioNominal: avgSwingNominal > 0 ? swingNominal / avgSwingNominal : null,
    ratioQty: avgSwingQty > 0 ? swingQty / avgSwingQty : null,
    isFlip: prev != null && pNom !== 0 && cur.nominal !== 0 && Math.sign(cur.nominal) !== Math.sign(pNom),
    isNew: prev == null,
  };
}

/** Derive the lifecycle status from stats + thresholds. */
export function classifyChange(s: ChangeStats, t: ChangeThresholds): ChangeStatus {
  if (!s.hasCurrent || s.pairs < t.minPairs) return 'DATA_KURANG';
  const swing = s.swingNominal ?? 0;
  if (s.avgSwingNominal === 0 && swing >= t.minNominal) return 'BARU_BERGERAK';
  if (s.ratioNominal != null && s.ratioNominal >= t.ratioThreshold && swing >= t.minNominal) return 'ANOMALI';
  return 'NORMAL';
}
