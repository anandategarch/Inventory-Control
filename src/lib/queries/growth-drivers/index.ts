// ============================================================
//  growth-drivers — public barrel
//  --------------------------------------------------------
//  Keeps the public import path '@/lib/queries/growth-drivers'
//  STABLE after the REFACTOR-1-a split of the former monolith into
//  ./types.ts + ./drivers.ts + ./top-growth.ts. Consumers (analysis
//  services/run-queries.ts, TopGrowthCard.tsx, useAnalysis/types.ts,
//  tests/queries/growth-drivers.test.ts, tests/queries/top-growth.test.ts)
//  keep importing from here — no consumer edits.
//
//  NOTE: src/lib/queries/index.ts deliberately does NOT re-export
//  this module (GrowthDriverMetric name collision with
//  src/app/api/analysis/services/growth-drivers.ts — see its header);
//  callers import directly from '@/lib/queries/growth-drivers'.
//
//  Internal imports must be file-to-file (e.g. './types'), NOT via
//  this barrel — avoids import cycles.
// ============================================================
export * from './types';
export * from './drivers';
export * from './top-growth';
