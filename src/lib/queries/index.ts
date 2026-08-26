// ============================================================
//  Barrel export — re-export everything from the domain modules.
//  Allows `import { queryTrendAgg, buildSqlFilters, ... } from '@/lib/queries'`
//  to keep working after the split.
// ============================================================
export * from './shared';
export * from './dashboard';
export * from './items/top-items';
export * from './items/network-risk';
export * from './items/global-search';
export * from './outlets/top-outlets';
export * from './outlets/peer-comparison';
export * from './outlets/resto-recommendations';
export * from './areas';
export * from './historical';
// SQL-OPTIMIZE: pushed computeOutletHealthRanking + computeVarianceAnalysis +
// computeGrowthDrivers + computeHistoricalAnalysis to SQL — eliminates 35K
// record load to RAM. See health-ranking.ts + growth-drivers.ts.
// (growth-drivers.ts not re-exported here to avoid GrowthDriverMetric name
// collision with src/app/api/analysis/services/growth-drivers.ts — callers
// import directly from '@/lib/queries/growth-drivers' instead.)
export * from './health-ranking';
