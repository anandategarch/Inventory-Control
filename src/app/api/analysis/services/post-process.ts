// ============================================================
//  post-process — Stage 4 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:549-905).
//
//  This module is split into focused sub-functions so each is a
//  testable unit (< 150 lines). The main `postProcess()` is a thin
//  orchestrator that calls them in order:
//
//    1. evaluateAndMergeFlags   — JS hist rules + merge with SQL flags
//    2. buildGrowthMetrics      — growth metrics + DQ counts + trend
//    3. buildOutletHealthRanking — Metric Engine health score per outlet
//    4. buildHistoricalAnalysis — zScore-ranked critical items (top 50)
//    5. buildTrendProjection    — linear projection of next period
//    6. buildPatterns           — systemic/area/network classification
//    7. mapTopOutlets           — top outlets (deviasi) + bySales
//
//  Awaits 2 promises:
//    - sqlFlagsPromise (fired in stage 3, usually resolved by now)
//    - queryHistoricalCriticalItems (fresh SQL for HISTORICAL_* items)
// ============================================================
import {
  computeNominalDeviationGrowth,
  projectTrend,
  calcZScoreFromStats,
  computeHealthScore,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeLossToSales,
  type AggregateInput,
  type HealthScoreWeights,
  type HealthScoreThresholds,
} from '@/lib/metrics';
import { detectPatterns } from '@/engine/analysis/analysis';
import type { AnalysisOutlet, AnalysisArea } from '@/engine/analysis';
import { queryHistoricalCriticalItems } from '@/lib/queries';
import { evaluateHistoricalRulesJs, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import { buildTrend, buildMultiPeriodComparison, buildNetCostTrend } from './trend-builder';
import { computeDeviationDrivers } from './deviation-drivers';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { ResolvedParams } from './validate-and-resolve';

// Stage-4 output — everything needed by assemble-response.
export interface ProcessedData {
  normal: number;
  warning: number;
  abnormal: number;
  ruleBreakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
  topFlagByKey: Map<string, SqlRuleFlag>;
  growthMetrics: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison: Array<Record<string, unknown>>;
  };
  growthComparisonWithHist: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison: Array<Record<string, unknown>>;
    historicalAnalysis: { criticalItems: Array<Record<string, unknown>> };
  };
  trend: ReturnType<typeof buildTrend>;
  netCostTrend: ReturnType<typeof buildNetCostTrend>;
  trendProjection: ReturnType<typeof projectTrend>;
  patterns: ReturnType<typeof detectPatterns>;
  dqSeverityCounts: Map<string, number>;
  areaAnalysis: Array<Record<string, unknown>>;
  topOut: Array<Record<string, unknown>>;
  topOutletsSales: Array<Record<string, unknown>>;
  outletHealthRanking: Array<AnalysisOutlet & { nominalDeviasi: number; residualPct: number; lossToSales: number | null }>;
  costImpact: Record<string, unknown>;
  itemConsistencyAnalysis: Record<string, unknown>;
  deviationDrivers: ReturnType<typeof computeDeviationDrivers>;
}

// Internal: severity-count maps derived from topFlagByKey + healthRankingRows.
interface SeverityMaps {
  warningByOutlet: Map<number, number>;
  abnormalByOutlet: Map<number, number>;
  recordsWithFlagsByOutlet: Map<number, number>;
}

/**
 * Sub-step 1 — evaluate JS historical rules + merge with SQL flags.
 * Returns topFlagByKey + per-outlet severity counts + global normal/warning/abnormal.
 */
export async function evaluateAndMergeFlags(
  currSlim: FetchedRecords['currSlim'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
  thresholds: FetchedRecords['thresholds'],
  sqlFlagsPromise: Promise<SqlRuleFlag[]>,
  healthRankingRows: QueryResults['healthRankingRows'],
): Promise<{
  topFlagByKey: Map<string, SqlRuleFlag>;
  severityMaps: SeverityMaps;
  normal: number;
  warning: number;
  abnormal: number;
  ruleBreakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
}> {
  // ============================================================
  //  POST-PROCESS RULE FLAGS (Sprint 3 + SQL-OPTIMIZE)
  //  --------------------------------------------------------
  //  1. Evaluate 5 zScore-based rules in JS (uses currSlim — 5 cols × 35K rows)
  //  2. Merge SQL + JS flags → topFlagByKey (key → highest-priority flag)
  //  3. Compute per-outlet + global severity counts from topFlagByKey +
  //     healthRankingRows (zeroDev / nonZeroDev counts per outlet)
  // ============================================================
  const histFlags = evaluateHistoricalRulesJs(currSlim, historicalByOutletItem, thresholds);

  // PERF-FASE2-BE03: Await sqlFlagsPromise here (not in Group 1) — by now
  // Batches 1-4 have finished, and evaluateRulesSql has been running in
  // parallel the whole time. If it's already resolved, this await is ~0ms.
  const sqlFlags = await sqlFlagsPromise;

  // topFlagByKey — one entry per (outletId, itemId, akunPenyesuaian) record
  // that fired at least one rule. Keeps the highest-priority flag.
  const allFlags = [...sqlFlags, ...histFlags];
  const topFlagByKey = new Map<string, SqlRuleFlag>();
  for (const flag of allFlags) {
    const key = `${flag.outletId}|${flag.itemId}|${flag.akunPenyesuaian ?? ''}`;
    const existing = topFlagByKey.get(key);
    if (!existing || flag.priority > existing.priority) {
      topFlagByKey.set(key, flag);
    }
  }

  // Per-outlet severity counts derived from topFlagByKey (small map —
  // ~5K-10K entries, one per flagged record). Much smaller than iterating
  // 35K currentRecs as the old JS code did.
  const warningByOutlet = new Map<number, number>();
  const abnormalByOutlet = new Map<number, number>();
  const recordsWithFlagsByOutlet = new Map<number, number>();
  const ruleCategoryCounts = new Map<string, number>();
  const ruleCodeCounts = new Map<string, number>();
  for (const [, flag] of topFlagByKey) {
    recordsWithFlagsByOutlet.set(flag.outletId, (recordsWithFlagsByOutlet.get(flag.outletId) ?? 0) + 1);
    if (flag.severity === 'ABNORMAL') {
      abnormalByOutlet.set(flag.outletId, (abnormalByOutlet.get(flag.outletId) ?? 0) + 1);
    } else if (flag.severity === 'WARNING') {
      warningByOutlet.set(flag.outletId, (warningByOutlet.get(flag.outletId) ?? 0) + 1);
    }
    ruleCategoryCounts.set(flag.category, (ruleCategoryCounts.get(flag.category) || 0) + 1);
    ruleCodeCounts.set(flag.ruleCode, (ruleCodeCounts.get(flag.ruleCode) || 0) + 1);
  }

  // Global normal/warning/abnormal counts (matches the old JS loop exactly):
  //   normal   = (nonZeroDevCount - recordsWithFlags) + zeroDevCount
  //   warning  = records with top-flag WARNING
  //   abnormal = records with top-flag ABNORMAL
  let normal = 0, warning = 0, abnormal = 0;
  for (const row of healthRankingRows) {
    const recWithFlags = recordsWithFlagsByOutlet.get(row.outletId) ?? 0;
    const w = warningByOutlet.get(row.outletId) ?? 0;
    const ab = abnormalByOutlet.get(row.outletId) ?? 0;
    const n = Math.max(0, row.nonZeroDevCount - recWithFlags) + row.zeroDevCount;
    normal += n;
    warning += w;
    abnormal += ab;
  }

  const ruleBreakdown = {
    byCategory: Object.fromEntries(ruleCategoryCounts) as Record<string, number>,
    byRule: Object.fromEntries(ruleCodeCounts) as Record<string, number>,
  };

  return {
    topFlagByKey,
    severityMaps: { warningByOutlet, abnormalByOutlet, recordsWithFlagsByOutlet },
    normal, warning, abnormal,
    ruleBreakdown,
  };
}

/**
 * Sub-step 2 — build growth metrics + DQ severity counts + trend artifacts.
 */
export function buildGrowthMetrics(
  execSummary: QueryResults['execSummary'],
  trendAggRows: QueryResults['trendAggRows'],
  monthKeyByLabel: FetchedRecords['monthKeyByLabel'],
  dqIssuesRaw: QueryResults['dqIssuesRaw'],
): {
  growthMetrics: ProcessedData['growthMetrics'];
  multiPeriodComparison: ReturnType<typeof buildMultiPeriodComparison>;
  trend: ReturnType<typeof buildTrend>;
  netCostTrend: ReturnType<typeof buildNetCostTrend>;
  dqSeverityCounts: Map<string, number>;
} {
  // FIX (audit issue #11): Use computeNominalDeviationGrowth (magnitude) for
  // nominalDeviasi — signed calcGrowth is misleading when sign flips.
  // For -10M → -20M: signed gives -100% (decreasing), magnitude gives +100% (worsening).
  const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(
    execSummary.nominalDeviasi.current,
    execSummary.nominalDeviasi.previous ?? null,
  );

  const growthMetrics = {
    salesGrowth: execSummary.sales.growth,
    bomGrowth: execSummary.qtyBom.growth,
    qtyDeviasiGrowth: execSummary.qtyDeviasi.growth,
    nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
    deviationToSalesRatio: execSummary.sales.current > 0
      ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
    deviationToBomRatio: execSummary.deviationToBom,
    multiPeriodComparison: [] as Array<Record<string, unknown>>,
  };

  // OPTIMIZE-ANALYSIS: DQ groupBy changed from `by: ['code','severity','message']`
  // (one row per unique issue text → potentially many rows) to `by: ['severity']`
  // (≤3 rows: ERROR/WARNING/INFO). Frontend only reads `dqStatus.errors` and
  // `dqStatus.warnings` (ExecutiveSummary.tsx:308,312) — the per-issue `code`/
  // `message` breakdown and the `ok`/`issues` response fields were unused.
  const dqSeverityCounts = new Map<string, number>();
  for (const d of dqIssuesRaw) {
    dqSeverityCounts.set(d.severity, (dqSeverityCounts.get(d.severity) ?? 0) + d._count._all);
  }

  // ============================================================
  //  Trend — from parallel queryTrendAgg result above
  //  Phase 3: extracted to services/trend-builder.ts
  // ============================================================
  const trend = buildTrend(trendAggRows, monthKeyByLabel);
  const multiPeriodComparison = buildMultiPeriodComparison(trendAggRows, monthKeyByLabel);
  growthMetrics.multiPeriodComparison = multiPeriodComparison as unknown as Array<Record<string, unknown>>;
  const netCostTrend = buildNetCostTrend(trendAggRows, monthKeyByLabel);

  return { growthMetrics, multiPeriodComparison, trend, netCostTrend, dqSeverityCounts };
}

/**
 * Sub-step 3 — build outlet health ranking with Metric Engine health score.
 * Combines SQL aggregate (healthRankingRows) + JS severity counts (topFlagByKey).
 *
 * Returns a superset of AnalysisOutlet — extra fields (nominalDeviasi,
 * residualPct, lossToSales) are kept because assemble-response spreads the
 * array directly into the JSON response (frontend reads them).
 */
export function buildOutletHealthRanking(
  healthRankingRows: QueryResults['healthRankingRows'],
  severityMaps: SeverityMaps,
  thresholds: FetchedRecords['thresholds'],
): Array<AnalysisOutlet & { nominalDeviasi: number; residualPct: number; lossToSales: number | null }> {
  // FIX (audit issue #6, P2 #10): Pass runtime health score weights + thresholds from Settings
  const healthScoreWeights = {
    devBom: thresholds.HEALTH_WEIGHT_DEV_BOM,
    residual: thresholds.HEALTH_WEIGHT_RESIDUAL,
    lossToSales: thresholds.HEALTH_WEIGHT_LOSS_TO_SALES,
    abnormal: thresholds.HEALTH_WEIGHT_ABNORMAL,
  };
  const healthScoreThresholds = {
    devBom: { good: thresholds.HEALTH_THRESH_DEV_BOM_GOOD, bad: thresholds.HEALTH_THRESH_DEV_BOM_BAD },
    residual: { good: thresholds.HEALTH_THRESH_RESIDUAL_GOOD, bad: thresholds.HEALTH_THRESH_RESIDUAL_BAD },
    lossToSales: { good: thresholds.HEALTH_THRESH_LOSS_TO_SALES_GOOD, bad: thresholds.HEALTH_THRESH_LOSS_TO_SALES_BAD },
    abnormal: { good: thresholds.HEALTH_THRESH_ABNORMAL_GOOD, bad: thresholds.HEALTH_THRESH_ABNORMAL_BAD },
  };

  const { warningByOutlet, abnormalByOutlet, recordsWithFlagsByOutlet } = severityMaps;
  return healthRankingRows.map(row => {
    const recWithFlags = recordsWithFlagsByOutlet.get(row.outletId) ?? 0;
    const w = warningByOutlet.get(row.outletId) ?? 0;
    const ab = abnormalByOutlet.get(row.outletId) ?? 0;
    const n = Math.max(0, row.nonZeroDevCount - recWithFlags) + row.zeroDevCount;
    const aggregateInput: AggregateInput = {
      totalQtyDeviasi: row.totalQtyDeviasi,
      totalQtyBom: row.totalQtyBom,
      totalQtyWaste: row.totalQtyWaste,
      totalQtySusut: row.totalQtySusut,
      totalQtyTrial: row.totalQtyTrial,
      totalResidualQty: row.totalResidualQty,
      totalLossNominal: row.lossNominal,
      totalSales: row.sales,
      normalCount: n,
      warningCount: w,
      abnormalCount: ab,
    };
    const devBom = computeDevBomAggregate(aggregateInput);
    const residualPct = computeResidualPctAggregate(aggregateInput);
    const lossToSales = computeLossToSales(aggregateInput);
    const healthScore = computeHealthScore(aggregateInput, healthScoreWeights as HealthScoreWeights, healthScoreThresholds as HealthScoreThresholds);
    return {
      outletCode: row.outletCode,
      outletName: row.outletName,
      area: row.area,
      healthScore,
      normal: n,
      warning: w,
      abnormal: ab,
      absNominal: row.absNominal,
      nominalDeviasi: row.nominalDeviasi,
      residualPct,
      lossToSales,
      devBom,
      sales: row.sales,
    };
  }).sort((a, b) => a.healthScore - b.healthScore || b.abnormal - a.abnormal);
}

/**
 * Sub-step 4 — build historical critical-items analysis.
 * Filters topFlagByKey for HISTORICAL_* flags, fetches per-record fields via SQL,
 * computes zScore + sorts + slices top 50.
 */
export async function buildHistoricalAnalysis(
  topFlagByKey: Map<string, SqlRuleFlag>,
  week: string,
  month: string,
  filterOpts: FetchedRecords['filterOpts'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
): Promise<{ criticalItems: Array<Record<string, unknown>> }> {
  // ============================================================
  //  Historical Analysis (SQL-OPTIMIZE)
  //  --------------------------------------------------------
  //  Old: computeHistoricalAnalysis iterated over recsWithFlags (35K)
  //       + filtered for HISTORICAL_* flags + looked up stats map.
  //  New: filter topFlagByKey for HISTORICAL_* flags (small — ~50-200
  //       entries), run queryHistoricalCriticalItems SQL to fetch the
  //       per-record fields (itemName, outletCode, area, pctQtyDeviasiToBom,
  //       absNominalDeviasi) for those flagged records only, then compute
  //       zScore + sort + slice top 50 in JS.
  // ============================================================
  const histCriticalKeys = [...topFlagByKey.values()]
    .filter((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_WARNING')
    .map(f => ({ outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian }));
  const histCriticalRows = await queryHistoricalCriticalItems(week, month, filterOpts, histCriticalKeys);
  const histCriticalItems = histCriticalRows.map(row => {
    const key = `${row.outletId}|${row.itemId}`;
    const stats = historicalByOutletItem.get(key);
    if (!stats || stats.stdDev <= 0) return null;
    const zScore = calcZScoreFromStats(row.pctQtyDeviasiToBom ?? 0, stats.mean, stats.stdDev);
    return {
      itemName: row.itemName,
      outletCode: row.outletCode,
      area: row.area,
      currentDevBom: row.pctQtyDeviasiToBom ?? 0,
      historicalAvg: stats.mean,
      zScore: zScore ?? 0,
      absNominal: row.absNominalDeviasi ?? 0,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  histCriticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  // FIX: return top 200 (was 50) — Phase B-4: increased limit for pagination.
  // HistoricalZScoreCard shows 20 initially with "load more" button.
  return { criticalItems: histCriticalItems.slice(0, 200) };
}

/**
 * Sub-step 5 — linear projection of next period's |nominalDeviasi|.
 * Reuses trendAggRows (already fetched) — no extra DB query.
 * Sign convention: input uses signed nominal (LOSS = negative); projectTrend takes ABS internally.
 */
export function buildTrendProjection(
  trendAggRows: QueryResults['trendAggRows'],
  monthKeyByLabel: FetchedRecords['monthKeyByLabel'],
): ReturnType<typeof projectTrend> {
  // FIX FORECAST-1: sort trendAggRows chronologically before projecting
  // (DB returns rows in arbitrary order; projectTrend needs chronological W1→W4)
  return projectTrend(
    trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, "")) || 0).padStart(2, "0")}`,
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          nominalDeviasi: r.nominal,
          devBom: r.devBom,
          sales: r.sales,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey)),
  );
}

/**
 * Sub-step 6 — pattern detection (systemic/area-level/network-wide).
 * No extra DB query — runs entirely on already-computed in-memory data.
 */
export function buildPatterns(
  outletHealthRanking: AnalysisOutlet[],
  itemConsistencyAnalysis: { items: Array<Record<string, unknown>> },
  areaAnalysis: AnalysisArea[],
): ReturnType<typeof detectPatterns> {
  // ============================================================
  //  Pattern Detection (ANALYZE-BACKEND-2 — Feature 5)
  //  --------------------------------------------------------
  //  totalOutlets = outletHealthRanking.length (universe of outlets
  //  with at least one evaluated item this period). Slight under-count
  //  for outlets where ALL items are zero-dev, but those are rare and
  //  irrelevant for systemic-pattern detection.
  // ============================================================
  const items = itemConsistencyAnalysis.items ?? [];
  return detectPatterns({
    outletHealthRanking,
    itemConsistency: items.map((i) => ({
      itemName: i.itemName as string,
      outletCount: i.outletCount as number,
      totalAbsNominal: i.totalAbsNominal as number,
      avgDevBom: i.avgDevBom as number,
      consistency: i.consistency as 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED' | undefined,
    })),
    areaAnalysis,
    totalOutlets: outletHealthRanking.length,
  });
}

/**
 * Sub-step 7 — map top outlet SQL rows to response shape, including areaAvg.
 */
export function mapTopOutlets(
  topOutletsRaw: QueryResults['topOutletsRaw'],
  topOutletsSalesRaw: QueryResults['topOutletsSalesRaw'],
  areaAnalysisRaw: QueryResults['areaAnalysisRaw'],
): { topOut: Array<Record<string, unknown>>; topOutletsSales: Array<Record<string, unknown>> } {
  const areaAvgMap = new Map<string, number>(areaAnalysisRaw.map(a => [a.area, a.avgDevBom ?? 0]));
  const topOut = topOutletsRaw.map(o => ({
    outletCode: o.outletCode, outletName: o.outletName, area: o.area,
    absNominal: o.absNominal, nominalDeviasi: o.nominalDeviasi ?? 0,
    devBom: o.devBom, areaAvg: areaAvgMap.get(o.area) ?? 0,
    sales: o.sales, lossAmount: o.lossAmount, surplusAmount: o.surplusAmount, direction: o.direction,
  }));
  const topOutletsSales = topOutletsSalesRaw.map(o => ({
    outletCode: o.outletCode, outletName: o.outletName, area: o.area,
    sales: o.sales, absNominal: o.absNominal, nominalDeviasi: o.nominalDeviasi ?? 0,
    devToSalesRatio: o.sales > 0 ? o.absNominal / o.sales : null,
  }));
  return { topOut, topOutletsSales };
}

/**
 * Stage 4 — post-process raw query results into response-ready shapes.
 *
 * Thin orchestrator — delegates to 7 sub-functions (each < 150 lines).
 */
export async function postProcess(params: ResolvedParams, records: FetchedRecords, queries: QueryResults): Promise<ProcessedData> {
  const { week, month } = params;
  const { currSlim, historicalByOutletItem, thresholds, monthKeyByLabel, filterOpts } = records;
  const {
    earlyPromises,
    execSummary,
    areaAnalysisRaw,
    topOutletsRaw,
    topOutletsSalesRaw,
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

  // Sub-step 1: rule flag evaluation + merge
  const { topFlagByKey, severityMaps, normal, warning, abnormal, ruleBreakdown } = await evaluateAndMergeFlags(
    currSlim, historicalByOutletItem, thresholds, earlyPromises.sqlFlagsPromise, healthRankingRows,
  );

  // Sub-step 2: growth metrics + trend
  const { growthMetrics, trend, netCostTrend, dqSeverityCounts } = buildGrowthMetrics(
    execSummary, trendAggRows, monthKeyByLabel, dqIssuesRaw,
  );

  // Sub-step 3: outlet health ranking
  const outletHealthRanking = buildOutletHealthRanking(healthRankingRows, severityMaps, thresholds);

  // Sub-step 4: historical critical-items analysis
  const historicalAnalysis = await buildHistoricalAnalysis(topFlagByKey, week, month, filterOpts, historicalByOutletItem);
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
  // response payload. queryCostImpact still runs because totalCost is needed.)
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

  // Sub-step 7: top outlets mapping
  const { topOut, topOutletsSales } = mapTopOutlets(topOutletsRaw, topOutletsSalesRaw, areaAnalysisRaw);

  // Deviation Drivers — Phase 3 service
  const deviationDrivers = computeDeviationDrivers(deviationDriverRows);

  return {
    normal, warning, abnormal, ruleBreakdown, topFlagByKey,
    growthMetrics, growthComparisonWithHist,
    trend, netCostTrend, trendProjection, patterns,
    dqSeverityCounts, areaAnalysis, topOut, topOutletsSales,
    outletHealthRanking, costImpact, itemConsistencyAnalysis, deviationDrivers,
  };
}
