// ============================================================
//  Analysis Hooks Barrel Export
//  --------------------------------------------------------
//  React/TanStack Query hooks for the inventory intelligence
//  dashboard:
//    - useAnalysis     — /api/analysis (executive summary, top
//                        items/outlets, growth drivers, deviation
//                        breakdown, BOM correlation findings)
//    - useStatus       — /api/status (file list, months/weeks,
//                        outlets, areas, pics, kelompok options)
//    - useDrilldown    — /api/drilldown (per-record detail rows)
//    - useItemTrend    — /api/item-trend (per-item multi-period
//                        QTY timeline with Z-Score + historical
//                        baseline)
//
//  This file is the public entry point. All existing imports like
//    import { useAnalysis, useStatus, useDrilldown, useItemTrend,
//             type AnalysisData, type StatusData } from '@/hooks/useAnalysis'
//  keep working unchanged — TypeScript resolves `@/hooks/useAnalysis`
//  to `@/hooks/useAnalysis/index.ts` automatically.
//
//  Source split (was src/hooks/useAnalysis.ts, 839 LOC):
//    ./types          — all shared interfaces (AnalysisData,
//                       AnalysisParams, TopItemByNominal,
//                       BomCorrelationFinding, etc.) — ~330 LOC
//    ./fetchAnalysis  — fetchAnalysis(params) HTTP helper used by
//                       useAnalysis + prefetchAnalysis — ~55 LOC
//    ./prefetchHeatmap — prefetchHeatmap(queryClient, params)
//                       background warm-up for heatmap card — ~35 LOC
//    ./useAnalysis    — useAnalysis hook + buildAnalysisQueryKey +
//                       ANALYSIS_STALE_TIME/GC_TIME constants +
//                       prefetchAnalysis + usePrefetchAnalysis — ~135 LOC
//    ./useStatus      — useStatus hook + SourceFileInfo + StatusData — ~70 LOC
//    ./useDrilldown   — useDrilldown hook + DrilldownRecord +
//                       DrilldownData — ~110 LOC
//    ./useItemTrend   — useItemTrend hook + ItemTrendPeriod +
//                       ItemTrendData + ItemTrendMetric +
//                       ItemTrendParams — ~130 LOC
// ============================================================
export * from './types';
export * from './fetchAnalysis';
export * from './prefetchHeatmap';
export * from './useAnalysis';
export * from './useStatus';
export * from './useDrilldown';
export * from './useItemTrend';
