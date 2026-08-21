// ============================================================
//  Analysis Engine — Barrel Export
//  --------------------------------------------------------
//  All functions split into services:
//  - ruleService.ts      (buildRuleContext, recommendAction)
//  - rankingService.ts   (health ranking, variance, historical, priorities, worklist)
//  - patternEngine.ts    (cross-outlet pattern detection)
//  - rootCauseEngine.ts  (ruleCode → root causes + recommended actions)
//  - insightEngine.ts    (auto-generated executive insights from analysis data)
//  - types.ts            (shared types)
// ============================================================
export { buildRuleContext, recommendAction } from './ruleService';
export {
  computeOutletHealthRanking,
  computeVarianceAnalysis,
  computeHistoricalAnalysis,
  buildWorklistFromFlags,
} from './rankingService';
export {
  detectPatterns,
  type AnalysisData,
  type AnalysisArea,
  type AnalysisItem,
  type AnalysisOutlet,
  type PatternDetection,
} from './patternEngine';
export {
  getRootCauses,
  getRootCause,
  listKnownRuleCodes,
  ROOT_CAUSE_MAPPINGS,
} from './rootCauseEngine';
export type {
  RootCauseMapping,
  RootCauseSeverity,
  RootCauseCategory,
} from './rootCauseEngine';
export { generateExecutiveInsights } from './insightEngine';
export type {
  ExecutiveInsight,
  InsightCategory,
  InsightSeverity,
  InsightInput,
  NetworkItemRiskSummary,
} from './insightEngine';
export type { RecWithRels } from './types';
