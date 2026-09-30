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
// FILTERDROP-1 dead-code audit: trimmed to the names actually imported via
// the barrel path (post-process-*.ts): detectPatterns, AnalysisOutlet,
// AnalysisArea. AnalysisData/AnalysisItem/PatternDetection re-exports and the
// RecWithRels re-export had zero barrel-path consumers (PatternDetection is
// imported directly from ./patternEngine by useAnalysis/types.ts).
export {
  detectPatterns,
  type AnalysisArea,
  type AnalysisOutlet,
} from './patternEngine';
