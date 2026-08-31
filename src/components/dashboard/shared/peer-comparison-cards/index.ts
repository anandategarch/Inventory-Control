// ============================================================
//  Peer Comparison Cards — barrel
//  --------------------------------------------------------
//  Re-exports the 5 shared presentational cards + types so
//  callers can `import { EfficiencyScoreCard, ... } from
//  '@/components/dashboard/shared/peer-comparison-cards'`.
// ============================================================

export { EfficiencyScoreCard } from './efficiency-score-card';
export type { EfficiencyScoreCardProps } from './efficiency-score-card';

export { GapAnalysisCard } from './gap-analysis-card';
export type { GapAnalysisCardProps } from './gap-analysis-card';

export { ScatterPlotCard } from './scatter-plot-card';
export type { ScatterPlotCardProps } from './scatter-plot-card';

export { RankingSummaryCard } from './ranking-summary-card';
export type { RankingSummaryCardProps } from './ranking-summary-card';

export { AnomalyFlags, computeAnomalyFlags } from './anomaly-flags';
export type { AnomalyFlagsProps, ComputeAnomalyFlagsOpts } from './anomaly-flags';

export type {
  BasePeerRow,
  BasePeerAverages,
  AnomalyFlag,
  GapRow,
  ScatterPoint,
  RankItem,
} from './types';
