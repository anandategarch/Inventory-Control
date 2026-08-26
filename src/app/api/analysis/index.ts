// ============================================================
//  ANALYSIS API — Barrel file re-exporting all modules
//  Import everything from './index' (or specific modules) for clarity:
//    import {
//      buildWhereClause, aggSql, computeExecutiveSummary,
//      computeTopItems, generateNarrative, ...
//    } from './index';
// ============================================================

export * from './types';

export {
  buildWhereClause,
  buildTrendWhereClause,
  buildCompareWhereClause,
  aggSql,
  salesSql,
  healthSql,
  dqSql,
  worklistSql,
  trendSql,
  trendSalesSql,
  cmpSql,
  cmpSalesSql,
  vaCurrentSql,
  vaPrevSql,
  healthRankSql,
  consistencySql,
  areaSql,
  areaSalesSql,
  resolveAutoComparePeriod,
} from './queries';
export type { WhereClause } from './queries';

export { computeExecutiveSummary } from './execSummary';
export type { ComputeExecSummaryArgs } from './execSummary';

export {
  computeTopItems,
  computeTopOutlets,
  computeDeviationBreakdown,
  computeLossVsSurplus,
  computeHealthBreakdown,
  computeDqStatus,
  computeInvestigationWorklist,
} from './topItems';

export {
  computeVarianceAnalysis,
  computeOutletHealthRanking,
  computeItemConsistencyAnalysis,
  computeAreaAnalysis,
  computeHistoricalAnalysis,
} from './advancedAnalysis';
export type { VarianceArgs } from './advancedAnalysis';

export { generateNarrative, generateRecommendations } from './narrative';
export type { NarrativeInput, RecommendationInput } from './narrative';

export { computeTrend, computeGrowthComparison, computeMultiPeriodComparison } from './growth';
export type { GrowthArgs } from './growth';

export {
  computeCostImpactDecomposition,
  computeParetoAnalysis,
  computeOutletEfficiencyMatrix,
  computeCostPerThousand,
  computeNetCostTrend,
} from './costAccounting';
export type {
  CostImpactDecomposition,
  ParetoAnalysis,
  ParetoItem,
  OutletEfficiencyPoint,
  CostPerThousand,
  NetCostTrendPoint,
} from './costAccounting';

// P2-1: Menu/BOM Relationship analysis (inferred from item name prefixes)
export { computeMenuAnalysis } from './menuAnalysis';
export type { MenuGroup } from './menuAnalysis';
