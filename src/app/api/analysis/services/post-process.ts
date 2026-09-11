// ============================================================
//  post-process — Stage 4 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:549-905).
//
//  This module is a thin orchestrator that delegates to 7 sub-functions
//  (each < 150 lines) extracted into sibling files (Task 3-b split).
//  All sub-functions + types are re-exported here so existing callers
//  (`@/app/api/analysis/services/post-process`) keep resolving.
//
//    1. evaluateAndMergeFlags   — SQL hist rules + merge with SQL flags    → post-process-flags.ts
//    2. buildGrowthMetrics      — growth metrics + DQ counts + trend      → post-process-growth.ts
//    3. buildOutletHealthRanking — Metric Engine health score per outlet  → post-process-health-ranking.ts
//    4. buildHistoricalAnalysis — zScore-ranked critical items (top 200)  → post-process-historical.ts
//    5. buildTrendProjection    — linear projection of next period        → post-process-trend-projection.ts
//    6. buildPatterns           — systemic/area/network classification    → post-process-patterns.ts
//    7. (REMOVED H-11 #4a) mapTopOutlets — deleted with the Dashboard's
//       TopOutlets card (duplicate of the Pareto tab's byOutlet card);
//       post-process-top-outlets.ts was deleted with it.
//
//  Plus Sub-step 1b/1c (BOM correlation) — post-process-bom-correlation.ts
//
//  Awaits 2 promises:
//    - sqlFlagsPromise (fired in stage 3, usually resolved by now)
//    - queryHistoricalCriticalItems (fresh SQL for HISTORICAL_* items)
// ============================================================
// Barrel re-exports — preserve public API surface so callers importing
// from `@/app/api/analysis/services/post-process` keep resolving unchanged.
// (assemble-response.ts imports type ProcessedData; route.ts imports postProcess;
// all other sub-functions are re-exported for any future direct callers.)
export * from './post-process-types';
export * from './post-process-bom-correlation';
export * from './post-process-flags';
export * from './post-process-growth';
export * from './post-process-health-ranking';
export * from './post-process-historical';
export * from './post-process-trend-projection';
export * from './post-process-patterns';
// H-11 (#4a): './post-process-top-outlets' was deleted with the Dashboard's
// TopOutlets card (duplicate of the Pareto tab's byOutlet quadrant card).

import { computeDeviationDrivers } from './deviation-drivers';
import type { ResolvedParams } from './validate-and-resolve';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { ProcessedData } from './post-process-types';
import { evaluateAndMergeFlags } from './post-process-flags';
import { buildBomCorrelationFindings } from './post-process-bom-correlation';
import { buildGrowthMetrics } from './post-process-growth';
import { buildOutletHealthRanking } from './post-process-health-ranking';
import { buildHistoricalAnalysis } from './post-process-historical';
import { buildTrendProjection } from './post-process-trend-projection';
import { buildPatterns } from './post-process-patterns';

/**
 * Stage 4 — post-process raw query results into response-ready shapes.
 *
 * Thin orchestrator — delegates to 7 sub-functions (each < 150 lines).
 */
export async function postProcess(params: ResolvedParams, records: FetchedRecords, queries: QueryResults): Promise<ProcessedData> {
  const { week, month, prevWeek, prevMonth } = params;
  const { currRecordCount, historicalByOutletItem, historicalPeriodsCount, thresholds, monthKeyByLabel, filterOpts } = records;
  const {
    earlyPromises,
    execSummary,
    areaAnalysisRaw,
    costImpactSql,
    lvs,
    consistencyItems,
    trendAggRows,
    healthRankingRows,
    deviationDriverRows,
    dqIssuesRaw,
  } = queries;
  // NOTE: varianceAnalysis is NOT destructured here — post-process doesn't
  // transform it. assemble-response reads it directly from `queries.varianceAnalysis`.

  // Sub-step 1: rule flag evaluation + merge (awaits the SQL rules + SQL
  // hist-rules promises fired in stage 3 — PERF TAHAP-2/P2-7).
  const { topFlagByKey, severityMaps, normal, warning, abnormal, ruleBreakdown } = await evaluateAndMergeFlags(
    earlyPromises.histFlagsSqlPromise, earlyPromises.sqlFlagsPromise, healthRankingRows,
  );

  // PERF-API-04 (Task PERF-API): run Sub-step 1b (BOM correlation findings) and
  // Sub-step 4 (historical critical-items) IN PARALLEL via Promise.all. Both are
  // independent SQL queries (fetchBomCorrelationDetails + queryHistoricalCriticalItems)
  // that depend only on the now-resolved topFlagByKey + sqlFlags. Previously they
  // ran sequentially: ~50ms (BOM) + ~100ms (historical) = ~150ms total.
  // Parallel: max(50, 100) = ~100ms total. Saves ~50ms on cold cache path.
  // Sync sub-steps (2, 3, 5, 6, 7) are computed WHILE the SQL queries run — no
  // additional latency since they don't await.
  const sqlFlags = await earlyPromises.sqlFlagsPromise;
  const [bomCorrelationResult, historicalAnalysis] = await Promise.all([
    buildBomCorrelationFindings(week, month, prevWeek, prevMonth, filterOpts, sqlFlags),
    buildHistoricalAnalysis(
      topFlagByKey,
      week,
      month,
      filterOpts,
      historicalByOutletItem,
      // FX-HIST-EMPTY: pass currRecordCount + historicalPeriodsCount +
      // thresholds so buildHistoricalAnalysis can compute a meta block for the
      // frontend empty state. Without these the card always shows the misleading
      // "minimal 4 bulan data" tip regardless of the real reason.
      currRecordCount,
      historicalPeriodsCount,
      thresholds,
    ),
  ]);
  const { findings: bomCorrelationFindings, counts: bomCorrelationCounts } = bomCorrelationResult;

  // Sub-step 2: growth metrics + trend
  const { growthMetrics, trend, netCostTrend, dqSeverityCounts } = buildGrowthMetrics(
    execSummary, trendAggRows, monthKeyByLabel, dqIssuesRaw,
  );

  // Sub-step 3: outlet health ranking
  const outletHealthRanking = buildOutletHealthRanking(healthRankingRows, severityMaps, thresholds);

  const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };

  // Sub-step 5: trend projection
  const trendProjection = buildTrendProjection(trendAggRows, monthKeyByLabel);

  // Extended analytics: area mapping
  const areaAnalysis = areaAnalysisRaw.map(a => ({
    area: a.area,
    outletCount: a.outletCount,
    totalSales: a.totalSales,
    totalAbsNominal: a.totalAbsNominal,
    avgDevBom: a.avgDevBom,
    lossToSales: a.lossToSales,
  }));

  // Cost Impact — only the 4 fields consumed by InsightsPanel + CostImpact type.
  // (wasteCost/susutCost/trialCost/residualCost and their *ToSales ratios were
  // only read by the now-removed CostAccounting tab — dropped to slim the
  // response payload. totalCost comes from the merged queryDashboardKpis scan
  // via kpisToCostImpact.)
  const costImpact = {
    totalCost: costImpactSql.totalCost,
    pctOfSales: execSummary.sales.current > 0 ? costImpactSql.totalCost / execSummary.sales.current : null,
    lossNominal: lvs.lossNominal,
    surplusNominal: lvs.surplusNominal,
  };

  // Item Consistency — from parallel query result above
  const systemic = consistencyItems
    .filter(i => i.consistency === 'SYSTEMIC')
    .map(i => ({
      itemName: i.itemName, outletCode: '', area: '',
      occurrences: i.outletCount, avgDevBom: i.avgDevBom, absNominal: i.totalAbsNominal,
    }));
  const episodic = consistencyItems
    .filter(i => i.consistency !== 'SYSTEMIC')
    .map(i => ({
      itemName: i.itemName, outletCode: '', area: '',
      absNominal: i.totalAbsNominal, devBom: i.avgDevBom,
    }));
  const itemConsistencyAnalysis = {
    systemic,
    episodic,
    items: consistencyItems.map(i => ({
      itemName: i.itemName,
      satuan: '', // not used by frontend table; would need separate fetch
      outletCount: i.outletCount,
      lossOutlets: i.lossOutlets,
      surplusOutlets: i.surplusOutlets,
      totalAbsNominal: i.totalAbsNominal,
      avgDevBom: i.avgDevBom,
      consistency: i.consistency,
    })),
  };

  // Sub-step 6: pattern detection
  const patterns = buildPatterns(outletHealthRanking, itemConsistencyAnalysis, areaAnalysis);

  // Sub-step 7: top outlets mapping — REMOVED (H-11 / #4a). The Dashboard's
  // TopOutlets card was deleted (duplicate of the Pareto tab's byOutlet
  // quadrant card) and topOutletsBySales had no renderer at all, so
  // mapTopOutlets + its two per-outlet scans are dead compute.

  // Deviation Drivers — Phase 3 service
  const deviationDrivers = computeDeviationDrivers(deviationDriverRows);

  return {
    normal, warning, abnormal, ruleBreakdown, topFlagByKey,
    growthMetrics, growthComparisonWithHist,
    trend, netCostTrend, trendProjection, patterns,
    dqSeverityCounts, areaAnalysis,
    outletHealthRanking, costImpact, itemConsistencyAnalysis, deviationDrivers,
    bomCorrelationFindings, bomCorrelationCounts,
  };
}
