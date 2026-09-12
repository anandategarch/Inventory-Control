// ============================================================
//  Barrel export — re-export everything from the domain modules.
//  Allows `import { queryTrendAgg, buildSqlFilters, ... } from '@/lib/queries'`
//  to keep working after the split.
// ============================================================
export * from './shared';
export * from './dashboard';
export * from './items/top-items';
export * from './items/global-search';
// H-11 (#4a): './outlets/top-outlets' REMOVED — queryTopOutlets +
// queryTopOutletsBySales were deleted with the Dashboard's TopOutlets card
// (duplicate of the Pareto tab's byOutlet quadrant card) and the never-rendered
// topOutletsBySales payload section.
export * from './outlets/peer-comparison';
export * from './outlets/resto-recommendations';
// ANA-1-D: outlet recurrence/persistence history (additive `history` field
// for /api/recommendations — no interaction with the existing queries).
export * from './outlets/outlet-recurrence';
export * from './areas';
export * from './historical';
// SQL-OPTIMIZE: pushed computeOutletHealthRanking + computeVarianceAnalysis +
// computeGrowthDrivers + computeHistoricalAnalysis to SQL — eliminates 35K
// record load to RAM. See health-ranking.ts + growth-drivers.ts.
// (growth-drivers.ts not re-exported here to avoid GrowthDriverMetric name
// collision with src/app/api/analysis/services/growth-drivers.ts — callers
// import directly from '@/lib/queries/growth-drivers' instead.)
export * from './health-ranking';
export * from './heatmap';
