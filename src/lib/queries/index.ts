// ============================================================
//  Barrel export — re-export everything from the domain modules.
//  Allows `import { queryTrendAgg, buildSqlFilters, ... } from '@/lib/queries'`
//  to keep working after the split.
// ============================================================
export * from './shared';
export * from './dashboard';
export * from './items';
export * from './outlets';
export * from './areas';
export * from './historical';
