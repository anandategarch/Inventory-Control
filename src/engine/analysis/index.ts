// ============================================================
//  Analysis Engine — Barrel Export
//  --------------------------------------------------------
//  All functions split into services:
//  - ruleService.ts      (buildRuleContext, recommendAction)
//  - rankingService.ts   (health ranking, variance, historical, priorities, worklist)
//  - patternEngine.ts    (cross-outlet pattern detection)
//  - rootCauseEngine.ts  (ruleCode → root causes + recommended actions)
//  - types.ts            (shared types)
//
//  FIX (BUG2-P0-2): Removed insightEngine.ts (dead code — generateExecutiveInsights
//  was never called by any active route or component. Referenced investigationWorklist
//  field which was removed from AnalysisData type.)
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
export type { RecWithRels } from './types';
