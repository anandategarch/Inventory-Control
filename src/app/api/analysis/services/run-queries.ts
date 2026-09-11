// ============================================================
//  run-queries — Stage 3 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:417-547).
//
//  Responsibilities:
//    1. Fire 4 early-start promises (sqlFlags, healthRanking, variance,
//       growthDrivers) — kept as early fires so post-process (stage 4) can
//       await the SAME promise objects instead of re-running queries
//    2. Run ALL independent aggregate queries in ONE Promise.all
//    3. Map raw SQL rows into response-ready shapes
//
//  PERF note (H-8 QUICK WIN 2 — full parallel): the old 4 SERIAL batches
//  were a workaround for Supabase free plan PgBouncer's ~10 practical
//  connection cap (DEEP-AUDIT-SERIAL). That constraint no longer applies:
//  src/lib/db.ts FORCES connection_limit=30 + pool_timeout=60 on the
//  Supabase transaction pooler (which allows ~200 concurrent), and the
//  limit was already bumped 10→20→30 by earlier fixes. Peak concurrency
//  here is ~19 in-flight queries (18 awaited below + sqlFlagsPromise
//  firing in the background for post-process) — comfortably under the
//  30-connection pool. Wall-clock: cold path bounded by the SLOWEST
//  single query instead of the SUM of 4 batch durations (~30-50% faster).
// ============================================================
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  queryTrendAgg,
  queryExecSummary,
  queryDashboardKpis,
  kpisToBreakdown,
  kpisToLvs,
  kpisToCostImpact,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByAllCategories,
  queryTopItemsByDeviasiRank,
  queryDeviationBreakdownDrivers,
  queryAreaAnalysis,
  queryItemConsistency,
  queryOutletHealthRanking,
  queryVarianceAnalysis,
  queryParetoByDevBom,
} from '@/lib/queries';
import { queryGrowthDrivers, queryTopGrowth } from '@/lib/queries/growth-drivers';
import { evaluateRulesSql, evaluateHistoricalRulesSql, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import { cachedSharedQuery } from '@/lib/queries/query-cache';
import { buildExecSummaryFromSql } from './exec-summary';
import type { FetchedRecords, FilterOpts } from './fetch-records';
import type { ResolvedParams } from './validate-and-resolve';

// Early-fired promise bundle — kept as a property on the result so post-process
// can `await` them just before consuming (PERF-FASE2-BE03 optimization).
export interface EarlyPromises {
  sqlFlagsPromise: Promise<SqlRuleFlag[]>;
  // PERF (TAHAP-2 / P2-7): the 3 zScore rules now run as ONE SQL query with an
  // inline historical-baseline CTE (replaces the 35K-row currSlim fetch + JS
  // loop). Fired early like sqlFlags so post-process awaits the same promise.
  histFlagsSqlPromise: Promise<SqlRuleFlag[]>;
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
  // H-11 (#4a): topOutletsRaw / topOutletsSalesRaw REMOVED — the Dashboard's
  // TopOutlets card was deleted (duplicate of the Pareto tab's byOutlet
  // quadrant card) and topOutletsBySales had no renderer at all, so both
  // per-outlet scans (2× per analysis run) were dead compute.
  // H-10: standalone KPI queries removed — shapes now derive from the
  // kpisTo* mappers (field-for-field identical to the old standalone queries).
  breakdown: ReturnType<typeof kpisToBreakdown>;
  paretoDevBom: Awaited<ReturnType<typeof queryParetoByDevBom>>;
  lvs: ReturnType<typeof kpisToLvs>;
  trendAggRows: Awaited<ReturnType<typeof queryTrendAgg>>;
  costImpactSql: ReturnType<typeof kpisToCostImpact>;
  consistencyItems: Awaited<ReturnType<typeof queryItemConsistency>>;
  // dqIssuesRaw: result of db.dQIssue.groupBy with { by: ['severity'], _count: { _all: true } }
  // — narrowed type so post-process can safely access d._count._all.
  dqIssuesRaw: Array<{ severity: string; _count: { _all: number } }>;
  topDeviasiRank: Awaited<ReturnType<typeof queryTopItemsByDeviasiRank>>;
  deviationDriverRows: Awaited<ReturnType<typeof queryDeviationBreakdownDrivers>>;
  healthRankingRows: Awaited<ReturnType<typeof queryOutletHealthRanking>>;
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  growthDrivers: Awaited<ReturnType<typeof queryGrowthDrivers>>;
  // Task H-2c (CHANGE 6): Top Growth — biggest SALES movers per resto &
  // per barang vs the compare period (same prev-period semantics as
  // growthDrivers above).
  topGrowth: Awaited<ReturnType<typeof queryTopGrowth>>;
}

/**
 * Stage 3 — run all SQL aggregate queries in ONE parallel wave + map raw rows.
 *
 * PERF (H-8 QUICK WIN 2): all independent queries (formerly Groups 1-4 /
 * Batches 1-4) run in a single Promise.all. The old serial-batch structure
 * was a workaround for a PgBouncer ~10-connection cap that no longer exists
 * (db.ts forces connection_limit=30; see the H-8 note in the file header).
 * Early-fired promises (sqlFlags, healthRanking, variance, growthDrivers)
 * still fire at t=0 and are awaited in the same wave + re-exposed via
 * `earlyPromises` for post-process (stage 4).
 */
export async function runQueries(params: ResolvedParams, records: FetchedRecords): Promise<QueryResults> {
  const { week, month, prevWeek, prevMonth } = params;
  const { filterOpts, thresholds, historicalPeriods } = records;

  // ============================================================
  //  RULE EVALUATION + SQL AGGREGATES — ALL PARALLEL (Sprint 3 + SQL-OPTIMIZE)
  //  --------------------------------------------------------
  //  Old: 35K-record JS loop calling evaluateRules() per record
  //  New: SQL flags (16 rules) + SQL hist flags (3 zScore rules)
  //       + queryOutletHealthRanking + queryVarianceAnalysis +
  //       queryGrowthDrivers — all running in parallel with the
  //       existing 15 SQL aggregate queries.
  //
  //  PERF (TAHAP-2 / P2-9): the 6 heaviest queries shared with the
  //  /api/export-report pipeline (rule flags, hist-rule flags, variance,
  //  merged KPIs, category tops, trend) are wrapped in cachedSharedQuery —
  //  a per-query AggregationCache row keyed by period+filters. Export uses
  //  the SAME queryIds, so "view dashboard → export report" skips recomputing
  //  them (~4-6s of the export cold path). TTL 30 min + mutation-triggered
  //  invalidation via invalidateAnalysisCache (see aggregation-cache.ts).
  // ============================================================

  // Fire these 5 promises early at t=0 — awaited in the big Promise.all
  // below AND re-exposed via `earlyPromises` so post-process (stage 4)
  // awaits the same promise objects.
  const sqlFlagsPromise = cachedSharedQuery(
    'q-rules',
    { month, week, compareWeek: prevWeek, compareMonth: prevMonth, filters: filterOpts },
    () => evaluateRulesSql(week, month, prevWeek, prevMonth, filterOpts, thresholds),
  );
  const histFlagsSqlPromise = cachedSharedQuery(
    'q-hist-rules',
    { month, week, filters: filterOpts },
    () => evaluateHistoricalRulesSql(week, month, historicalPeriods, filterOpts, thresholds),
  );
  // H-10 (G1 scan-share): health ranking now goes through the shared
  // q-outlet-agg scan (superset also consumed by /api/recommendations) —
  // one cached period scan feeds both the analysis payload and the Resto
  // tab's recommendations. Threshold passed explicitly so the cache key
  // matches the one the recommendations route builds.
  const healthRankingSqlPromise = queryOutletHealthRanking(week, month, filterOpts, thresholds.HIGH_LOSS_NOMINAL_THRESHOLD);
  const varianceAnalysisPromise = cachedSharedQuery(
    'q-variance',
    { month, week, compareWeek: prevWeek, compareMonth: prevMonth, filters: filterOpts },
    () => queryVarianceAnalysis(week, month, prevWeek, prevMonth, filterOpts),
  );
  const growthDriversPromise = queryGrowthDrivers(week, month, prevWeek, prevMonth, filterOpts);

  // ============================================================
  //  PERF (PAKET B / F2 — scan merge, kept): the current exec summary,
  //  deviation breakdown, loss-vs-surplus and cost-impact queries all
  //  scanned the SAME filtered period separately (4 scans + 4 transactions).
  //  queryDashboardKpis computes all of them in ONE scan; breakdown/lvs/
  //  costImpact are derived from the merged KPI row below. Only the
  //  PREVIOUS-period exec summary still runs standalone (different period).
  //  The four category queries (waste/susut/trial/lossSurplus) likewise
  //  come from ONE merged scan (queryTopItemsByAllCategories).
  // ============================================================
  const topNItems = thresholds.TOP_N_ITEMS || 10;

  // PERF (TAHAP-2 / P2-9): cachedSharedQuery wraps the export-shared queries
  // (see the early-fire block above for the rationale).
  const kpisPromise = cachedSharedQuery(
    'q-kpis',
    { month, week, filters: filterOpts },
    () => queryDashboardKpis(week, month, filterOpts),
  );
  const topCategoriesPromise = cachedSharedQuery(
    'q-topcat',
    { month, week, filters: filterOpts, extra: { limit: topNItems } },
    () => queryTopItemsByAllCategories(week, month, filterOpts, topNItems),
  );
  const trendAggPromise = cachedSharedQuery(
    'q-trend',
    { month, week, filters: filterOpts, extra: { weekLabel: week || 'ALL' } },
    () => queryTrendAgg({ ...filterOpts, weekLabel: week }),
  );

  // FIX (BUG6-1+BUG6-POOL): paretoDevBom wrapped in .catch() so a failure
  // degrades to an empty Pareto instead of failing the whole analysis.
  const safeParetoDevBom = queryParetoByDevBom(week, month, filterOpts, 20, 0.50).catch((e: unknown) => {
    logger.error('[analysis] queryParetoByDevBom failed (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: 0, thresholdPct: 0.50 };
  });

  // ============================================================
  //  PERF (H-8 QUICK WIN 2 — full parallel): ONE Promise.all for ALL
  //  independent queries. Peak concurrency ≈ 19 (18 awaited here +
  //  sqlFlagsPromise running in background for post-process) — under
  //  db.ts's connection_limit=30, and the transaction pooler itself
  //  allows ~200. pool_timeout=60 guards the tail if a burst ever
  //  exceeds the pool.
  // ============================================================
  const [
    kpis, prevSummary,
    topNominal, topDevBom, topCategories,
    areaAnalysisRaw, paretoDevBom,
    trendAggRows, consistencyItems, dqIssuesRaw,
    topDeviasiRank, deviationDriverRows,
    healthRankingRows, varianceAnalysis, growthDrivers,
    topGrowth,
  ] = await Promise.all([
    // Group 1: merged KPI scan (curr) + standalone prev exec summary
    kpisPromise,
    // prevWeek && prevMonth narrowing — if no compare period, return null
    // so buildExecSummaryFromSql skips the prev summary entirely.
    // PERF (H-11 / #3): q-exec-summary — the prev-period scan is wrapped in
    // the shared per-query cache with the SAME queryId + key as the export
    // pipeline's prev summary, so "view dashboard → export report" no longer
    // recomputes it (~0.3-0.8s of the export cold path).
    prevWeek && prevMonth ? cachedSharedQuery(
      'q-exec-summary',
      { month: prevMonth, week: prevWeek, filters: filterOpts },
      () => queryExecSummary(prevWeek, prevMonth, filterOpts),
    ) : Promise.resolve(null),
    // Batch 1: top items by nominal + devBom + merged category scan
    // PERF (H-11 / #3): q-top-nominal / q-top-devbom — same queryIds as the
    // export pipeline (limit in the key so a TOP_N_ITEMS change can't share
    // a stale row).
    cachedSharedQuery(
      'q-top-nominal',
      { month, week, filters: filterOpts, extra: { limit: topNItems } },
      () => queryTopItemsByNominal(week, month, filterOpts, topNItems),
    ),
    cachedSharedQuery(
      'q-top-devbom',
      { month, week, filters: filterOpts, extra: { limit: topNItems } },
      () => queryTopItemsByDevBom(week, month, filterOpts, topNItems),
    ),
    topCategoriesPromise,
    // Batch 2: area analysis + Pareto DevBom
    // PERF (H-11 / #3): q-area — shared with the export pipeline's
    // areaAnalysis fetch (identical period + filters → one scan for both).
    cachedSharedQuery(
      'q-area',
      { month, week, filters: filterOpts },
      () => queryAreaAnalysis(week, month, filterOpts),
    ),
    // H-11 (#4a): queryTopOutlets + queryTopOutletsBySales REMOVED (dead
    // compute — see QueryResults note above).
    safeParetoDevBom,
    // Batch 3: trend + consistency + DQ issues
    trendAggPromise,
    queryItemConsistency(week, month, filterOpts),
    db.dQIssue.groupBy({
      by: ['severity'],
      where: { sourceFile: { monthLabel: month } },
      _count: { _all: true },
    }),
    // Batch 4: deviasi rank + deviation drivers (health ranking / variance /
    // growth drivers come from the early-fired promises above)
    queryTopItemsByDeviasiRank(week, month, filterOpts, 50),
    queryDeviationBreakdownDrivers(week, month, filterOpts),
    healthRankingSqlPromise,
    varianceAnalysisPromise,
    growthDriversPromise,
    // Task H-2c (CHANGE 6): Top Growth (per resto & per barang)
    queryTopGrowth(week, month, prevWeek, prevMonth, filterOpts),
  ]);

  const execSummary = buildExecSummaryFromSql(kpis, prevSummary, month, week, prevWeek);
  // Single-scan derivations (field-for-field identical to the standalone queries):
  const breakdown = kpisToBreakdown(kpis);
  const lvs = kpisToLvs(kpis);
  const costImpactSql = kpisToCostImpact(kpis, execSummary.sales.current);

  const topWasteRows = topCategories.waste;
  const topSusutRows = topCategories.susut;
  const topTrialRows = topCategories.trial;
  const topLossSurplusRows = topCategories.lossSurplus;

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
    earlyPromises: { sqlFlagsPromise, histFlagsSqlPromise, healthRankingSqlPromise, varianceAnalysisPromise, growthDriversPromise },
    execSummary,
    topNominal,
    topDevBom,
    topWaste,
    topSusut,
    topTrial,
    topLossSurplus,
    areaAnalysisRaw,
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
    topGrowth,
  };
}

// Re-export FilterOpts so route.ts can still import it from this barrel if needed.
export type { FilterOpts };
