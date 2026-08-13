// ============================================================
//  DEPRECATED — use src/engine/analysis/ directory instead.
//  This file kept for backward compat with existing imports.
//  All functions split into services:
//  - analysis/ruleService.ts    (buildRuleContext, recommendAction)
//  - analysis/rankingService.ts (health ranking, variance, historical, priorities, worklist)
//  - analysis/types.ts          (shared types)
//  - analysis/index.ts          (barrel export)
// ============================================================
export * from './index';
