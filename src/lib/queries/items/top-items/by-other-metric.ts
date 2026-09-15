// ============================================================
//  Top Items — Other Metric Queries
//  --------------------------------------------------------
//  Five query functions covering all top-item aggregations EXCEPT
//  the deviasi-rank pair (which lives in ./by-deviasi-rank.ts
//  because it shares a CTE structure):
//
//    1. queryTopItemsByNominal     — top by ABS(nominalDeviasi)
//    2. queryTopItemsByDevBom      — top by ABS(qtyDeviasi / qtyBom)
//    3. queryHistoricalCategoryAvg — historical avg per (item,outlet)
//    4. queryItemConsistency       — per-item outlet-count + consistency tier
//    5. queryParetoByDevBom        — Pareto 80/20 for items with |Dev/BOM| > threshold
//    6. queryAreaCategoryAvg       — per-(item, area) avg category QTY across the
//                                   area's outlets (REFINE-1: "Rata-rata Area"
//                                   column in the export's 3.3-3.6 tables)
//
//  REFINE-1 (user request): queryTopItemsByNominal now also returns devBom
//  (SUM(qtyDeviasi) / SUM|qtyBom| per group — feeds the "% Deviasi To BOM"
//  column added to export table 3.1), and queryTopItemsByDevBom returns
//  nominalDeviasi (feeds the "Nominal Deviasi" column added to 3.2). Both are
//  additive — existing consumers ignore the extra fields.
//
//  (H-10: the standalone queryTopItemsByCategory was removed — zero
//  production callers since queryTopItemsByAllCategories landed.)
//
//  Source: split out of src/lib/queries/items/top-items.ts (722 LOC,
//  Task 1-d). All SQL + comments preserved verbatim — pure relocation.
// ============================================================
// ============================================================
//  SPLIT-E module map (pure code motion — this file is now a
//  thin barrel; the queries live in sibling modules grouped by
//  metric family; SQL, comments and behavior preserved verbatim):
//    ./by-other-metric-nominal-devbom.ts     — queryTopItemsByNominal,
//                                              queryTopItemsByDevBom
//    ./by-other-metric-all-categories.ts     — queryTopItemsByAllCategories
//                                              (+ TopItemsCategoryRow,
//                                              TopItemsAllCategories)
//    ./by-other-metric-category-averages.ts  — queryHistoricalCategoryAvg,
//                                              queryAreaCategoryAvg
//                                              (+ AreaCategoryAvg)
//    ./by-other-metric-item-consistency.ts   — queryItemConsistency
//    ./by-other-metric-pareto.ts             — queryParetoByDevBom
//  Every public symbol keeps its exact old export name — imports
//  via './by-other-metric' (and the re-export chain through
//  ./index.ts → '@/lib/queries/items/top-items') are unchanged.
// ============================================================
export { queryTopItemsByNominal, queryTopItemsByDevBom } from './by-other-metric-nominal-devbom';
export { queryTopItemsByAllCategories } from './by-other-metric-all-categories';
export type { TopItemsCategoryRow, TopItemsAllCategories } from './by-other-metric-all-categories';
export { queryHistoricalCategoryAvg, queryAreaCategoryAvg } from './by-other-metric-category-averages';
export type { AreaCategoryAvg } from './by-other-metric-category-averages';
export { queryItemConsistency } from './by-other-metric-item-consistency';
export { queryParetoByDevBom } from './by-other-metric-pareto';
