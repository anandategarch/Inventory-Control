// ============================================================
//  run-queries — Stage 3 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:417-547).
//
//  Responsibilities:
//    1. Fire 4 early-start promises (sqlFlags, healthRanking, variance,
//       growthDrivers) — they run in background during Batches 1-4
//    2. Run Batch 0 (exec summary curr + prev)
//    3. Run Batch 1 (top items: nominal, devBom, waste, susut, trial)
//    4. Run Batch 2 (lossSurplus + area + topOutlets + breakdown + Pareto)
//    5. Run Batch 3 (lvs + trend + cost + consistency + DQ groupBy)
//    6. Run Batch 4 (deviasi + drivers + health + variance + growth)
//    7. Map raw SQL rows into response-ready shapes
//
//  PERF note (DEEP-AUDIT-SERIAL): batches are SERIAL (each awaited before
//  the next starts) because Supabase free plan PgBouncer caps concurrent
//  connections at ~10. Firing all 20 queries at once caused pool exhaustion.
//  See original comment block (lines 459-468) for the full rationale.
// ============================================================
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  queryTrendAgg,
  queryExecSummary,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByCategory,
  queryTopItemsByDeviasiRank,
  queryTopOutlets,
  queryTopOutletsBySales,
  queryDeviationBreakdown,
  queryDeviationBreakdownDrivers,
  queryLossVsSurplus,
  queryAreaAnalysis,
  queryCostImpact,
  queryItemConsistency,
  queryOutletHealthRanking,
  queryVarianceAnalysis,
  queryParetoByDevBom,
} from '@/lib/queries';
import { queryGrowthDrivers } from '@/lib/queries/growth-drivers';
import { evaluateRulesSql, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import { buildExecSummaryFromSql } from './exec-summary';
import type { FetchedRecords, FilterOpts } from './fetch-records';
import type { ResolvedParams } from './validate-and-resolve';

// Early-fired promise bundle — kept as a property on the result so post-process
// can `await` them just before consuming (PERF-FASE2-BE03 optimization).
export interface EarlyPromises {
  sqlFlagsPromise: Promise<SqlRuleFlag[]>;
  healthRankingSqlPromise: ReturnType<typeof queryOutletHealthRanking>;
  varianceAnalysisPromise: ReturnType<typeof queryVarianceAnalysis>;
  growthDriversPromise: ReturnType<typeof queryGrowthDrivers>;
}

// Stage-3 output — everything needed by post-process + assemble-response.
export interface QueryResults {
  earlyPromises: EarlyPromises;
  execSummary: ReturnType<typeof buildExecSummaryFromSql>;
  topNominal: Awaited<ReturnType<typeof queryTopItemsByNominal>>;
  topDevBom: Awaited<ReturnType<typeof queryTopItemsByDevBom>>;
  topWaste: Array<{ itemName: string; outletCode: string; qtyWaste: unknown; nominalWaste: unknown }>;
  topSusut: Array<{ itemName: string; outletCode: string; qtySusut: unknown; nominalSusut: unknown }>;
  topTrial: Array<{ itemName: string; outletCode: string; qtyTrial: unknown; nominalTrial: unknown }>;
  topLossSurplus: Array<{ itemName: string; outletCode: string; qtyLossSurplus: unknown; nominalLossSurplus: unknown; direction: unknown }>;
  areaAnalysisRaw: Awaited<ReturnType<typeof queryAreaAnalysis>>;
  topOutletsRaw: Awaited<ReturnType<typeof queryTopOutlets>>;
  topOutletsSalesRaw: Awaited<ReturnType<typeof queryTopOutletsBySales>>;
  breakdown: Awaited<ReturnType<typeof queryDeviationBreakdown>>;
  paretoDevBom: Awaited<ReturnType<typeof queryParetoByDevBom>>;
  lvs: Awaited<ReturnType<typeof queryLossVsSurplus>>;
  trendAggRows: Awaited<ReturnType<typeof queryTrendAgg>>;
  costImpactSql: Awaited<ReturnType<typeof queryCostImpact>>;
  consistencyItems: Awaited<ReturnType<typeof queryItemConsistency>>;
  // dqIssuesRaw: result of db.dQIssue.groupBy with { by: ['severity'], _count: { _all: true } }
  // — narrowed type so post-process can safely access d._count._all.
  dqIssuesRaw: Array<{ severity: string; _count: { _all: number } }>;
  topDeviasiRank: Awaited<ReturnType<typeof queryTopItemsByDeviasiRank>>;
  deviationDriverRows: Awaited<ReturnType<typeof queryDeviationBreakdownDrivers>>;
  healthRankingRows: Awaited<ReturnType<typeof queryOutletHealthRanking>>;
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  growthDrivers: Awaited<ReturnType<typeof queryGrowthDrivers>>;
}

/**
 * Stage 3 — run all SQL aggregate queries in serial batches + map raw rows.
 *
 * Batches are SERIAL to stay within PgBouncer's ~10 connection cap (see
 * DEEP-AUDIT-SERIAL comment above). Early-fired promises (sqlFlags,
 * healthRanking, variance, growthDrivers) run in the background during
 * Batches 1-4 and are awaited in post-process (stage 4).
 */
export async function runQueries(params: ResolvedParams, records: FetchedRecords): Promise<QueryResults> {
  const { week, month, prevWeek, prevMonth } = params;
  const { filterOpts, thresholds } = records;

  // ============================================================
  //  RULE EVALUATION + SQL AGGREGATES — ALL PARALLEL (Sprint 3 + SQL-OPTIMIZE)
  //  --------------------------------------------------------
  //  Old: 35K-record JS loop calling evaluateRules() per record
  //  New: SQL flags (12 rules) + JS hist flags (5 zScore rules)
  //       + queryOutletHealthRanking + queryVarianceAnalysis +
  //       queryGrowthDrivers — all running in parallel with the
  //       existing 15 SQL aggregate queries.
  // ============================================================

  // Fire these 4 promises early — they'll be awaited in the Promise.all below.
  const sqlFlagsPromise = evaluateRulesSql(week, month, prevWeek, prevMonth, filterOpts, thresholds);
  const healthRankingSqlPromise = queryOutletHealthRanking(week, month, filterOpts);
  const varianceAnalysisPromise = queryVarianceAnalysis(week, month, prevWeek, prevMonth, filterOpts);
  const growthDriversPromise = queryGrowthDrivers(week, month, prevWeek, prevMonth, filterOpts);

  // ============================================================
  //  SQL AGGREGATE QUERIES (Phase 1b/2/4 + SQL-OPTIMIZE) — PARALLEL (P0 fix)
  //  All independent queries run via Promise.all for ~50% speedup.
  //  Sprint 3: sqlFlagsPromise runs in parallel with these queries.
  //  SQL-OPTIMIZE: healthRankingSqlPromise + varianceAnalysisPromise +
  //    growthDriversPromise also run in parallel here.
  // ============================================================

  // Group 1: Exec summary (curr + prev) — independent, parallel
  // PERF-FASE2-BE03: Drop sqlFlagsPromise from this await — it was blocking
  // Batches 1-4 from starting until evaluateRulesSql (~3s) completed.
  // sqlFlagsPromise continues firing in background during Batches 1-4,
  // and is awaited just before post-processing (line ~562). Same pattern
  // already used by healthRankingSql/varianceAnalysis/growthDrivers (lines 429-431).
  // Expected: ~1-2s off cold cache path.
  const [currSummary, prevSummary] = await Promise.all([
    queryExecSummary(week, month, filterOpts),
    // prevWeek && prevMonth narrowing — if no compare period, return null
    // so buildExecSummaryFromSql skips the prev summary entirely.
    prevWeek && prevMonth ? queryExecSummary(prevWeek, prevMonth, filterOpts) : Promise.resolve(null),
  ]);
  const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month, week, prevWeek);

  // Group 2: All top items + breakdown + area + outlets + trend + cost + consistency + health + variance + growth
  // P2 fix: use thresholds.TOP_N_ITEMS / TOP_N_OUTLETS instead of hardcoded 10
  // SQL-OPTIMIZE: healthRankingSqlPromise + varianceAnalysisPromise + growthDriversPromise
  //   were fired above; they're awaited here in serial batches.
  //
  // FIX (DEEP-AUDIT-SERIAL): Split the single 20-query Promise.all into 4 serial
  // batches of ~5 queries each. Supabase free plan PgBouncer caps concurrent
  // connections at ~10 (practical). Firing 20 queries in parallel causes pool
  // exhaustion → 30-60s queue + "Unable to start a transaction" errors.
  // Serial batches keep each batch within the pool cap → faster overall
  // (no queue wait) and no timeout errors.
  //   Batch 1 (5 queries): top items by nominal + devBom + 3 category (waste/susut/trial)
  //   Batch 2 (5 queries): lossSurplus category + area + 2 top outlets + deviation breakdown
  //   Batch 3 (5 queries): loss vs surplus + trend agg + cost impact + item consistency + DQ issues
  //   Batch 4 (5 queries): deviasi rank + deviation drivers + health ranking + variance + growth
  const topNItems = thresholds.TOP_N_ITEMS || 10;
  const topNOutlets = thresholds.TOP_N_OUTLETS || 10;

  // Batch 1: top items (nominal, devBom, waste, susut, trial)
  const [topNominal, topDevBom, topWasteRows, topSusutRows, topTrialRows] = await Promise.all([
    queryTopItemsByNominal(week, month, filterOpts, topNItems),
    queryTopItemsByDevBom(week, month, filterOpts, topNItems),
    queryTopItemsByCategory(week, month, filterOpts, 'waste', topNItems),
    queryTopItemsByCategory(week, month, filterOpts, 'susut', topNItems),
    queryTopItemsByCategory(week, month, filterOpts, 'trial', topNItems),
  ]);

  // Batch 2: lossSurplus category + area analysis + top outlets + breakdown + Pareto DevBom
  // FIX (BUG6-1+BUG6-POOL): paretoDevBom back in Promise.all with .catch() wrapper.
  const safeParetoDevBom = queryParetoByDevBom(week, month, filterOpts, 20, 0.50).catch((e: unknown) => {
    logger.error('[analysis] queryParetoByDevBom failed (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: 0, thresholdPct: 0.50 };
  });
  const [topLossSurplusRows, areaAnalysisRaw, topOutletsRaw, topOutletsSalesRaw, breakdown, paretoDevBom] = await Promise.all([
    queryTopItemsByCategory(week, month, filterOpts, 'lossSurplus', topNItems),
    queryAreaAnalysis(week, month, filterOpts),
    queryTopOutlets(week, month, filterOpts, topNOutlets),
    queryTopOutletsBySales(week, month, filterOpts, topNOutlets),
    queryDeviationBreakdown(week, month, filterOpts),
    safeParetoDevBom,
  ]);

  // Batch 3: loss vs surplus + trend + cost + consistency + DQ issues
  const [lvs, trendAggRows, costImpactSql, consistencyItems, dqIssuesRaw] = await Promise.all([
    queryLossVsSurplus(week, month, filterOpts),
    queryTrendAgg({ ...filterOpts, weekLabel: week }),
    queryCostImpact(week, month, execSummary.sales.current, filterOpts),
    queryItemConsistency(week, month, filterOpts),
    db.dQIssue.groupBy({
      by: ['severity'],
      where: { sourceFile: { monthLabel: month } },
      _count: { _all: true },
    }),
  ]);

  // Batch 4: deviasi rank + deviation drivers + health ranking + variance + growth
  const [topDeviasiRank, deviationDriverRows, healthRankingRows, varianceAnalysis, growthDrivers] = await Promise.all([
    queryTopItemsByDeviasiRank(week, month, filterOpts, 50),
    queryDeviationBreakdownDrivers(week, month, filterOpts),
    // SQL-OPTIMIZE: pushed from JS (was: computeOutletHealthRanking loop over 35K records)
    healthRankingSqlPromise,
    // SQL-OPTIMIZE: pushed from JS (was: computeVarianceAnalysis loop over 35K records)
    varianceAnalysisPromise,
    // SQL-OPTIMIZE: pushed from JS (was: computeGrowthDrivers loop over 35K×2 records)
    growthDriversPromise,
  ]);

  // Map results (same as before, just from parallel results)
  const topWaste = topWasteRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyWaste: r.qty, nominalWaste: r.nominal }));
  const topSusut = topSusutRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtySusut: r.qty, nominalSusut: r.nominal }));
  const topTrial = topTrialRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyTrial: r.qty, nominalTrial: r.nominal }));
  const topLossSurplus = topLossSurplusRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction }));

  // OPTIMIZE-ANALYSIS: deviationBreakdown response is just the SQL aggregate
  // row (waste/susut/trial/residual/total). The `explained`/`explainedPct`/
  // `netPct` enrichment used to live here but no frontend component reads those
  // fields (Charts.tsx DeviationBreakdownChart + InsightsPanel.tsx #3 only use
  // waste/susut/trial/residual/total). export-report computes its own
  // enrichment inline if needed.

  return {
    earlyPromises: { sqlFlagsPromise, healthRankingSqlPromise, varianceAnalysisPromise, growthDriversPromise },
    execSummary,
    topNominal,
    topDevBom,
    topWaste,
    topSusut,
    topTrial,
    topLossSurplus,
    areaAnalysisRaw,
    topOutletsRaw,
    topOutletsSalesRaw,
    breakdown,
    paretoDevBom,
    lvs,
    trendAggRows,
    costImpactSql,
    consistencyItems,
    dqIssuesRaw,
    topDeviasiRank,
    deviationDriverRows,
    healthRankingRows,
    varianceAnalysis,
    growthDrivers,
  };
}

// Re-export FilterOpts so route.ts can still import it from this barrel if needed.
export type { FilterOpts };
