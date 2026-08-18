// ============================================================
//  Analysis Engine — Barrel Export
//  --------------------------------------------------------
//  All functions split into services:
//  - ruleService.ts   (buildRuleContext, recommendAction)
//  - rankingService.ts (health ranking, variance, historical, priorities, worklist)
//  - types.ts         (shared types)
// ============================================================
export { buildRuleContext, recommendAction } from './ruleService';
export {
  computeOutletHealthRanking,
  computeVarianceAnalysis,
  computeHistoricalAnalysis,
  buildWorklistFromFlags,
} from './rankingService';
export type { RecWithRels } from './types';
