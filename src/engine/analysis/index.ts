// ============================================================
//  Analysis Engine — Barrel Export
//  --------------------------------------------------------
//  Services:
//  - patternEngine.ts    (cross-outlet pattern detection)
//  - types.ts            (shared types)
//
//  Removed as dead code (see git history):
//  - insightEngine.ts (BUG2-P0-2), rankingService.ts (DC-01)
//  - DC-02 (Task W): ruleService.ts (buildRuleContext + recommendAction —
//    zero callers since the rule loop moved to SQL push-down in
//    src/lib/queries/rule-evaluation.ts), rootCauseEngine.ts +
//    rootCauseMappings.ts (~500 LOC, never imported outside the engine),
//    and the whole src/engine/rules/ JS evaluator subtree.
//    src/config/rules.yaml remains as the declarative rule SPEC only.
// ============================================================
export {
  detectPatterns,
  type AnalysisData,
  type AnalysisArea,
  type AnalysisItem,
  type AnalysisOutlet,
  type PatternDetection,
} from './patternEngine';
export type { RecWithRels } from './types';
