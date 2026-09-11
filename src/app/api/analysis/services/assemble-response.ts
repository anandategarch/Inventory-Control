// ============================================================
//  assemble-response — Stage 5 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:907-954).
//
//  Responsibility: assemble the final `result` object that gets
//  serialized as the JSON HTTP response.
//
//  Pure data-shaping — no I/O, no awaits. Takes the processed data
//  from stage 4 + raw query results from stage 3 + params from
//  stage 1 and returns the response object literal.
// ============================================================
import type { ResolvedParams } from './validate-and-resolve';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { ProcessedData } from './post-process';

export interface AnalysisResponse {
  success: true;
  // TASK H-5 (period clarity): + comparisonAuto (how the compare period was
  // chosen: true = otomatis same-week previous month, false = user-selected)
  // + weekRange/comparisonWeekRange (day-of-month bounds, cumulative weeks:
  // W2 = tgl 1–14) — powers the explicit "periode ini vs pembanding" legend
  // on growth cards. Always serialized (null when unresolvable).
  period: {
    monthLabel: string;
    weekLabel: string;
    comparisonWeek: string | null;
    comparisonMonth: string | null;
    comparisonAuto: boolean;
    weekRange: { start: number; end: number } | null;
    comparisonWeekRange: { start: number; end: number } | null;
  };
  filters: {
    area: string | null;
    kelompok: string | null;
    outletCode: string | null;
    itemName: string | null;
    pic: string | null;
  };
  executiveSummary: unknown;
  healthStatus: {
    normal: number;
    warning: number;
    abnormal: number;
    breakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
  };
  dqStatus: { errors: number; warnings: number };
  growthComparison: unknown;
  topItemsByNominal: unknown;
  topItemsByDevBom: unknown;
  paretoDevBom: unknown;
  // H-11 (#4a): topOutlets / topOutletsBySales REMOVED — the Dashboard's
  // TopOutlets card (their only renderer) was deleted; the Pareto tab's
  // byOutlet quadrant card (/api/pareto) covers the outlet 80/20 view.
  growthDrivers: unknown;
  // Task H-2c (CHANGE 6): Top Growth — biggest SALES movers per resto &
  // per barang vs the compare period ({ byOutlet, byItem } arrays).
  topGrowth: unknown;
  deviationDrivers: unknown;
  topItemsByWaste: unknown;
  topItemsBySusut: unknown;
  topItemsByTrial: unknown;
  topItemsByLossSurplus: unknown;
  topDeviasiRank: unknown;
  deviationBreakdown: unknown;
  lossVsSurplus: unknown;
  trend: unknown;
  areaAnalysis: unknown;
  varianceAnalysis: unknown;
  outletHealthRanking: unknown;
  costImpact: unknown;
  itemConsistencyAnalysis: unknown;
  netCostTrend: unknown;
  trendProjection: unknown;
  patterns: unknown;
  durationMs: number;
  [key: string]: unknown;
}

/**
 * Stage 5 — assemble the final JSON response object.
 *
 * Pure function — no I/O. Combines params + records + query results +
 * processed data into the response literal that gets serialized.
 */
export function assembleResponse(
  params: ResolvedParams,
  records: FetchedRecords,
  queries: QueryResults,
  processed: ProcessedData,
): AnalysisResponse {
  const { month, week, prevWeek, prevMonth, area, kelompok, outletCode, itemName, pic, startedAt } = params;
  const {
    execSummary,
    topNominal,
    topDevBom,
    topWaste,
    topSusut,
    topTrial,
    topLossSurplus,
    paretoDevBom,
    breakdown,
    lvs,
    topDeviasiRank,
    varianceAnalysis,
    growthDrivers,
    topGrowth,
  } = queries;
  const {
    normal,
    warning,
    abnormal,
    ruleBreakdown,
    growthComparisonWithHist,
    trend,
    netCostTrend,
    trendProjection,
    patterns,
    dqSeverityCounts,
    areaAnalysis,
    outletHealthRanking,
    costImpact,
    itemConsistencyAnalysis,
    deviationDrivers,
    bomCorrelationFindings,
    bomCorrelationCounts,
  } = processed;

  return {
    success: true,
    period: {
      monthLabel: month,
      weekLabel: week,
      comparisonWeek: prevWeek,
      comparisonMonth: prevMonth,
      // TASK H-5: compare provenance — auto when the request carried no
      // explicit compareWeek/compareMonth (resolveComparePeriod Case 1:
      // same weekLabel in the chronologically previous month).
      comparisonAuto: params.compareWeek == null && params.compareMonthExplicit == null,
      // TASK H-5: concrete day-of-month ranges (filled by fetch-records from
      // the Week table; null-safe when the pair can't be resolved).
      weekRange: params.weekRange ?? null,
      comparisonWeekRange: params.compareWeekRange ?? null,
    },
    // FIX (BUG-KELOMPOK-EMPTY): include kelompok in the response filters object
    // so the frontend can display the active filter state consistently.
    // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
    filters: { area, kelompok, outletCode, itemName, pic },
    executiveSummary: execSummary,
    healthStatus: { normal, warning, abnormal, breakdown: ruleBreakdown },
    // OPTIMIZE-ANALYSIS: only `errors` + `warnings` are read by the frontend
    // (ExecutiveSummary.tsx). `ok` and `issues` were dead — dropped.
    dqStatus: {
      errors: dqSeverityCounts.get('ERROR') ?? 0,
      warnings: dqSeverityCounts.get('WARNING') ?? 0,
    },
    growthComparison: growthComparisonWithHist,
    topItemsByNominal: topNominal,
    topItemsByDevBom: topDevBom,
    // FIX (BUG6-POOL): paretoDevBom in response
    paretoDevBom,
    growthDrivers, // FIX: Pareto 80% drivers per metric
    // Task H-2c (CHANGE 6): Top Growth per resto & per barang (SALES movers
    // vs compare period) — rides the same 30-min cache / SWR / background
    // recompute envelope as the rest of this payload.
    topGrowth,
    deviationDrivers, // NEW: 80% Pareto per deviation category (waste/susut/trial/residual)
    topItemsByWaste: topWaste,
    topItemsBySusut: topSusut,
    topItemsByTrial: topTrial,
    topItemsByLossSurplus: topLossSurplus,
    topDeviasiRank,
    deviationBreakdown: breakdown,
    lossVsSurplus: lvs,
    trend,
    // Extended analytics (Task 5)
    areaAnalysis,
    varianceAnalysis,
    outletHealthRanking,
    costImpact,
    itemConsistencyAnalysis,
    netCostTrend,
    // ANALYZE-BACKEND-2: trend projection + cross-outlet pattern detection
    trendProjection,
    patterns,
    // FIX-BOM-UI (CONFIG-02): per-record BOM correlation findings (top 50 by
    // priority) + per-rule counts. Consumed by BomCorrelationCard primary section.
    bomCorrelationFindings,
    bomCorrelationCounts,
    durationMs: Date.now() - startedAt,
  };
}
