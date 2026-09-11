// ============================================================
//  Top Items Queries — Barrel Export
//  --------------------------------------------------------
//  Public entry point. All existing imports like
//    import { queryTopItemsByNominal, queryTopItemsByDeviasiRank,
//             queryParetoByDevBom, ... } from '@/lib/queries/items/top-items'
//  keep working unchanged — TypeScript resolves `./top-items` to
//  `./top-items/index.ts` automatically.
//
//  Source split (was src/lib/queries/items/top-items.ts, 722 LOC):
//    ./types            — TopItemRow, ParetoDevBomOutletRow,
//                         ParetoDevBomRow, ParetoDevBomResult
//    ./shared-cte       — buildDeviasiRankBaseCte (INTERNAL — not
//                         re-exported here; only by-deviasi-rank.ts
//                         imports it)
//    ./by-deviasi-rank  — queryTopItemsByDeviasiRank (national top-N)
//                         + queryTopItemsByDeviasiRankForOutlet
//                         (per-outlet top-N with national rank)
//    ./by-other-metric  — queryTopItemsByNominal, queryTopItemsByDevBom,
//                         queryTopItemsByAllCategories (waste/susut/trial/
//                         lossSurplus in one scan), queryHistoricalCategoryAvg,
//                         queryItemConsistency, queryParetoByDevBom
// ============================================================
export * from './types';
export * from './by-deviasi-rank';
export * from './by-other-metric';
