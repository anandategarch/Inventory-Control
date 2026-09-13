// ============================================================
//  advanced-analysis — barrel (REFACTOR-1-c pure split).
//  Re-exports EXACTLY the 3 public components the old god file
//  AdvancedAnalysis.tsx exposed — the module's public API is
//  unchanged. Internal pieces (health-badges helpers,
//  AnomaliOutletExpansion) are NOT re-exported here, matching the
//  old file where they were module-private.
// ============================================================

export { OutletHealthRanking } from './OutletHealthRanking';
export { ItemConsistencyAnalysis } from './ItemConsistencyAnalysis';
export { AreaComparison } from './AreaComparison';
