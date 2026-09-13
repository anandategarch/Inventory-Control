'use client';

// ============================================================
//  AdvancedAnalysis — legacy module path (REFACTOR-1-c).
//  --------------------------------------------------------
//  The former 604-line god file was split into ./advanced-analysis/*
//  (pure move — zero behavior change):
//    health-badges.ts            5 pure color/label helpers
//    OutletHealthRanking.tsx      "Ranking Kondisi Outlet" card
//    AnomaliOutletExpansion.tsx   internal row-expansion panel
//    ItemConsistencyAnalysis.tsx  "Analisis Pola Item" card
//    AreaComparison.tsx           "Perbandingan Area" card
//    index.ts                     barrel (3 public exports)
//
//  This file remains ONLY as a re-export barrel so the public import
//  path `@/components/dashboard/AdvancedAnalysis` stays alive for its
//  consumers (tabs/AreaTab.tsx, tabs/ItemTab.tsx) — per the refactor
//  contract, consumers and tests are NOT edited. The directory name
//  (kebab-case, per the split spec) does not case-fold to this module
//  specifier, so the path must stay materialized here.
// ============================================================

export {
  OutletHealthRanking,
  ItemConsistencyAnalysis,
  AreaComparison,
} from './advanced-analysis';
