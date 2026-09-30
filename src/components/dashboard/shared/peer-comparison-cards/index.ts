// ============================================================
//  Peer Comparison Cards — barrel
//  --------------------------------------------------------
//  Re-exports the 5 shared presentational cards + types so
//  callers can `import { EfficiencyScoreCard, ... } from
//  '@/components/dashboard/shared/peer-comparison-cards'`.
// ============================================================

export { EfficiencyScoreCard } from './efficiency-score-card';

export { GapAnalysisCard } from './gap-analysis-card';

export { ScatterPlotCard } from './scatter-plot-card';

export { RankingSummaryCard } from './ranking-summary-card';

export { AnomalyFlags, computeAnomalyFlags } from './anomaly-flags';

// FILTERDROP-1 dead-code audit: the *Props type re-exports above and the
// BasePeerRow/BasePeerAverages names were REMOVED — zero barrel-path
// consumers (cards are imported by value; GapRow/RankItem/ScatterPoint/
// AnomalyFlag types ARE imported via this barrel by card-compute.ts +
// peer-computation.ts).
export type {
  AnomalyFlag,
  GapRow,
  ScatterPoint,
  RankItem,
} from './types';
