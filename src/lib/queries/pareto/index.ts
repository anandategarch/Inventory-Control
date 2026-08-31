// ============================================================
//  Pareto Analysis Queries — Barrel Export
//  --------------------------------------------------------
//  80/20 rule analysis: top contributors that account for 80% of
//  total deviation. Dimensions: Item, Outlet, Area, PIC, Kelompok,
//  and nested Item→Outlet (plus a generalized parent×child variant).
//
//  This file is the public entry point. All existing imports like
//    import { queryParetoByItem, ... } from '@/lib/queries/pareto'
//  keep working unchanged — TypeScript resolves `./pareto` to
//  `./pareto/index.ts` automatically.
//
//  Source split (was src/lib/queries/pareto.ts, 794 LOC):
//    ./types         — ParetoRow, ParetoResult, ParetoDimension,
//                       DimensionExpr, NestedParetoItem,
//                       NestedParetoResultItem
//    ./compute       — computePareto (80/20 cumulative-share),
//                       mergeHistoricalIntoPareto (z-score attach)
//    ./by-dimension  — queryParetoByItem / Outlet / Area /
//                       Kelompok / PIC
//    ./nested        — queryParetoNestedItemOutlet,
//                       queryParetoNested (generalized parent×child)
//    ./historical    — queryParetoHistorical (mean + stddev across
//                       same week in prior months)
// ============================================================
export * from './types';
export * from './compute';
export * from './by-dimension';
export * from './nested';
export * from './historical';
