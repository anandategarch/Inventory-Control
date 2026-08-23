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
    zScoreAbnormalCount: number;
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
