// ============================================================
//  DEPRECATED — use src/lib/queries/ directory instead.
//  This file kept for backward compat with existing imports.
//  All queries have been split by domain:
//  - queries/shared.ts   (buildSqlFilters)
//  - queries/dashboard.ts (trend, execSummary, breakdown, lossVsSurplus, costImpact)
//  - queries/items.ts    (topItems, pareto, consistency)
//  - queries/outlets.ts  (topOutlets, topOutletsBySales)
//  - queries/areas.ts    (areaAnalysis)
//  - queries/historical.ts (historicalStats)
// ============================================================
export * from './queries/index';
