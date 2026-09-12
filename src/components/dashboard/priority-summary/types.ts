// ============================================================
//  PrioritySummaryCard — shared types
//  (split from PrioritySummaryCard.tsx — Phase 3)
// ============================================================

/** Single signal entry in a Recommendation's signalScores array. */
export interface SignalScore {
  name: string;
  score: number;
  weight: number;
  value: string;
}

/**
 * Per-outlet recurrence/persistence history (ANA-1-D) — mirrors the server's
 * OutletRecurrenceHistory from src/lib/queries/outlets/outlet-recurrence.ts.
 * "Bermasalah" bulan = Dev/BOM di atas toleransi fallback ATAU loss nominal
 * di atas threshold P1 (threshold existing dari Settings, bukan angka baru).
 */
export interface RecommendationHistory {
  /** Historical months actually available (same-weekLabel, max 12, BEFORE the running period). */
  periodCount: number;
  /** Months flagged abnormal (devBom > tolerance fallback OR lossNominal > P1 nominal). */
  abnormalCount: number;
  /** Consecutive abnormal run ending at the most recent historical month. */
  streak: number;
  classification: 'REKUREN' | 'SEKALI' | 'STABIL';
}

/** Per-outlet recommendation payload from /api/recommendations. */
export interface Recommendation {
  outletCode: string;
  outletName: string;
  priorityScore: number;
  priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  signals: {
    devBomRatio: number;
    deviasiGrowth: number | null;
    abnormalCount: number;
    residualRatio: number;
    lossToSales: number;
    directionFlip: boolean;
    trendDeteriorating: boolean;
    itemConcentration: number;
    toleranceBreachCount: number;
    toleranceBreachHighCount: number;
    /** Items with |Dev/BOM| > 50% — fixed threshold, NOT a z-score (H-13 rename). */
    highDevBomCount: number;
    overExplainedCount: number;
    highLossItemCount: number;
    noToleranceItems: number;
    benchmarkHighCount: number;
  };
  metrics: {
    sales: number;
    nominalDeviasi: number;
    devBom: number;
    totalLoss: number;
    totalSurplus: number;
    residualQty: number;
    itemCount: number;
    direction: string;
    topItem: string | null;
    topItemNominal: number;
  };
  analysis: string[];
  signalScores?: SignalScore[];
  /** ANA-1-D: OPTIONAL recurrence history — absent in payloads cached before
   *  the field existed (and when the outlet has no same-week history), so the
   *  chip render must guard for undefined. Never feeds the priority score. */
  history?: RecommendationHistory;
}

/** Per-item row from /api/outlet-items — used by chart data builders. */
export interface OutletItem {
  itemName: string;
  devBom: number | null;
  nominalLossSurplus: number | null;
  absNominalLossSurplus: number;
  direction: string;
  residualRatio: number | null;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyDeviasi: number | null;
  qtyBom: number;
  priority: string;
}
