// ============================================================
//  data-fetcher — Stage 1 of /api/export-report GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  Responsibilities (route.ts:349-667 of the original computeFn body):
//    1. Load runtime thresholds (getRuntimeThresholds)
//    2. Resolve PIC outlet codes (case-insensitive raw SQL + sentinel)
//    3. Resolve kelompok outlet codes (shared helper)
//    4. Build Prisma where-clause factory (buildInventoryWhere)
//    5. Fetch weeks + sourceFiles metadata → allPeriods list
//    6. Resolve month label case (case-insensitive via getMonthResolver)
//    7. Resolve prevWeek + prevMonth (via resolveComparePeriod)
//    8. Compute historicalPeriods (same weekLabel, prior months)
//    9. Parallel fetch: currSlim ∥ historicalByOutletItem ∥ sqlFlags
//       ∥ varianceAnalysis
//   10. 404 short-circuit (throw EarlyHttpResponse if currSlim empty)
//   11. evaluateHistoricalRulesJs on currSlim → histFlags → topFlagByKey
//   12. Exec summary (curr ∥ prev via queryExecSummary)
//   13. 17-query Promise.all: topNominal / topDevBom / topWaste / topSusut
//       / topTrial / topLossSurplus / areaAnalysis / breakdown / trendAgg
//       / prevWaste / prevSusut / prevTrial / prevLossSurplus / histWaste
//       / histSusut / histTrial / histLossSurplus
//       (+ queryHistoricalCriticalItems fired EARLY right after the flag
//       merge — see the H-8 QUICK WIN 1b comment below)
//   14. Build prev + hist lookup maps + enrich topWaste/Susut/Trial/LossSurplus
//   15. Build breakdownEnriched + growthMetrics + multiPeriodComparison + trend
//   16. Build histCriticalItems + historicalAnalysis + growthComparisonWithHist
//   17. Assemble ReportData + DocxContext, return both
//
//  PERF (H-8 QUICK WIN 1): removed two DEAD queries — queryTopItemsByDeviasiRank
//  (500-row national rank) and queryOutletHealthRanking — whose DOCX sections
//  ("Section 13 RANKING ITEM NASIONAL" + restoPriority) were previously removed
//  from docx-builder, leaving the data pipeline fetching 1.5-3s of data nobody
//  renders (~500 ranked rows were also stored in the 5-min cache payload).
//
//  All comments preserved VERBATIM from the original route.ts (PERF-CACHE-06,
//  PERF-FASE3-BE04, FIX FILTER-3/4, FIX BUG-PERF-4, FIX RESTORE-BACKEND-2,
//  FIX BUG-NORECORDS-4/5, FIX-DEEP-1, FIX AUDIT-EXPORT-AI-1/2, FIX
//  AUDIT8-ROLLBACK-1 Items 8 + 15, ZS-03 FIX, Rev 2 markers, etc.).
// ============================================================
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { calcGrowth, computeNominalDeviationGrowth, calcZScoreFromStats } from '@/lib/metrics';
import {
  queryTrendAgg,
  queryExecSummary,
  queryDashboardKpis,
  kpisToBreakdown,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByAllCategories,
  queryHistoricalCategoryAvg,
  queryAreaAnalysis,
} from '@/lib/queries';
import { queryVarianceAnalysis, queryHistoricalCriticalItems } from '@/lib/queries/health-ranking';
import { evaluateRulesSql, evaluateHistoricalRulesSql } from '@/lib/queries/rule-evaluation';
import { cachedSharedQuery, cachedSharedQueryMap, histPeriodsKeyParts, histCriticalKeysHash } from '@/lib/queries/query-cache';
import { queryHistoricalStatsMultiMetric } from '@/lib/queries/historical';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { buildInventoryWhere } from '@/lib/build-where';
import { resolveComparePeriod } from '@/lib/period-resolver';
import { withStatementTimeout } from '@/lib/queries/shared';
import { logger } from '@/lib/logger';
import type { ExecSummaryRow } from '@/lib/queries/dashboard';
import type { SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { MultiMetricHistoricalStats } from '@/lib/queries/historical';
import { EarlyHttpResponse } from './types';
import type {
  ExecSummaryWithPrev,
  ReportParams,
  ReportData,
  DocxContext,
  FetchedReport,
} from './types';

// ============================================================
//  buildExecSummaryFromSql (same as analysis route)
//  --------------------------------------------------------
//  Relocated VERBATIM from route.ts:72-109. Builds an ExecutiveSummary
//  object (extended with _prevMetrics) from a (curr, prev) pair of
//  queryExecSummary rows. Used only by this service file.
// ============================================================
function buildExecSummaryFromSql(
  curr: ExecSummaryRow | null,
  prev: ExecSummaryRow | null,
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null,
): ExecSummaryWithPrev {
  const c = curr ?? { sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0, qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0, residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0 };
  const salesPrev = prev?.sales ?? null;
  return {
    period: { monthLabel, weekLabel, comparisonWeek: prevWeekLabel },
    sales: { current: c.sales, previous: salesPrev, growth: calcGrowth(c.sales, salesPrev) },
    nominalDeviasi: { current: c.nominalDeviasi, previous: prev?.nominalDeviasi ?? null, growth: computeNominalDeviationGrowth(c.nominalDeviasi, prev?.nominalDeviasi ?? null) },
    qtyBom: { current: c.qtyBom, previous: prev?.qtyBom ?? null, growth: calcGrowth(c.qtyBom, prev?.qtyBom ?? null) },
    qtyDeviasi: { current: c.qtyDeviasi, previous: prev?.qtyDeviasi ?? null, growth: calcGrowth(c.qtyDeviasi, prev?.qtyDeviasi ?? null) },
    qtyWaste: { current: c.qtyWaste, previous: prev?.qtyWaste ?? null, growth: calcGrowth(c.qtyWaste, prev?.qtyWaste ?? null) },
    qtySusut: { current: c.qtySusut, previous: prev?.qtySusut ?? null, growth: calcGrowth(c.qtySusut, prev?.qtySusut ?? null) },
    qtyTrial: { current: c.qtyTrial, previous: prev?.qtyTrial ?? null, growth: calcGrowth(c.qtyTrial, prev?.qtyTrial ?? null) },
    qtyLossSurplus: { current: c.qtyLossSurplus, previous: prev?.qtyLossSurplus ?? null, growth: calcGrowth(c.qtyLossSurplus, prev?.qtyLossSurplus ?? null) },
    totalLoss: c.totalLoss, totalSurplus: c.totalSurplus,
    lossToSales: c.sales > 0 ? c.totalLoss / c.sales : null,
    surplusToSales: c.sales > 0 ? c.totalSurplus / c.sales : null,
    deviationToBom: c.qtyBom !== 0 ? c.qtyDeviasi / Math.abs(c.qtyBom) : null,
    residualLossQty: c.residualLossQty,
    residualLossPct: c.qtyDeviasiLoss > 0 ? c.residualLossQty / c.qtyDeviasiLoss : null,
    // FIX: store prev values for the 6 metrics that previously showed '—' in the prev column.
    // These are computed from the same `prev` SQL row that already has sales, qtyBom, etc.
    _prevMetrics: prev ? {
      totalLoss: prev.totalLoss ?? null,
      totalSurplus: prev.totalSurplus ?? null,
      lossToSales: prev.sales > 0 ? (prev.totalLoss ?? 0) / prev.sales : null,
      surplusToSales: prev.sales > 0 ? (prev.totalSurplus ?? 0) / prev.sales : null,
      deviationToBom: prev.qtyBom !== 0 ? (prev.qtyDeviasi ?? 0) / Math.abs(prev.qtyBom) : null,
      residualLossQty: prev.residualLossQty ?? null,
      residualLossPct: prev.qtyDeviasiLoss > 0 ? (prev.residualLossQty ?? 0) / prev.qtyDeviasiLoss : null,
    } : null,
  };
}

// ============================================================
//  fetchReportData — main data-fetching pipeline
//  --------------------------------------------------------
//  Body relocated VERBATIM from route.ts:349-667 (the computeFn body of
//  the original withCacheAndDedup wrapper). Comments preserved exactly;
//  only the surrounding closure wrapper + 4-space indentation were
//  adjusted to fit a top-level async function with standard 2-space
//  indentation.
//
//  Throws EarlyHttpResponse on 404 (no records found for the filter).
//  The caller (route.ts) catches this in its outer try/catch.
// ============================================================
export async function fetchReportData(params: ReportParams): Promise<FetchedReport> {
  const {
    monthParam, week, area, outletCode, itemName, pic, kelompok,
    userCompareWeek, userCompareMonth, sections, startedAt,
  } = params;

  // PERF-CACHE-06: monthParam + week are `const` (narrowed to `string` by the
  // outer guard) — TS carries the narrowing into this closure. The resolved
  // `month` (after monthResolver) is declared as a separate const below.
  // Load thresholds
  const thresholds = await getRuntimeThresholds();

  // Resolve PIC outlets — FIX FILTER-3: case-insensitive via raw SQL LOWER()
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  let picOutletCodes: string[] | null = null;
  if (pic) {
    try {
      const pics = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string }>>`SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})`);
      picOutletCodes = pics.map(p => p.outletCode);
    } catch (e) {
      logger.error("[export-report] OutletPIC query failed:", { error: e instanceof Error ? e.message : String(e) });
      picOutletCodes = [];
    }
    // FIX FILTER-4: sentinel for empty list (was: skipped filter → showed ALL outlets)
    if (picOutletCodes.length === 0) {
      picOutletCodes = ['__NO_MATCH__'];
    }
  }

  // FIX (BUG-PERF-4 / BUG-BE-2): Replaced inline "fetch ALL outlets + JS filter"
  // with the shared resolveKelompokOutletCodes helper. Same DB-level SQL filter
  // as buildSqlFilters, ~5x faster, and deduplicates the logic.
  const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);

  // FIX (RESTORE-BACKEND-2): buildWhere now delegates to the shared
  // `buildInventoryWhere` helper from @/lib/build-where.ts. The helper
  // handles area/itemName/kelompok/PIC/outletCode + all intersections,
  // including sentinel for empty PIC list (idempotent — export-report
  // pre-sentineled at line 300; helper passes it through unchanged).
  const buildWhere = (wk: string, mLabel: string): Prisma.InventoryRecordWhereInput =>
    buildInventoryWhere({
      week: wk,
      month: mLabel,
      area,
      itemName,
      kelompok,
      kelompokOutletCodes,
      picOutletCodes,
      outletCode,
    });

  const filterOpts = {
    area: area === 'all' ? null : area,
    kelompok: kelompok === 'all' ? null : kelompok,
    outletCode: outletCode === 'all' ? null : outletCode,
    itemName,
    picOutletCodes, // already has sentinel applied
  };

  // Fetch current + prev records
  const [weeksRaw, fileMonthKeys] = await Promise.all([
    db.week.findMany({ select: { weekLabel: true, monthKey: true }, distinct: ['monthKey', 'weekLabel'] }),
    db.sourceFile.findMany({ select: { monthLabel: true, monthKey: true } }),
  ]);
  const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));
  // BUG FIX (AUDIT-EXPORT-AI-1): monthKeyByLabel — reverse lookup for trend sort.
  // Previously trendAggRows used monthLabelByKey.get(r.monthLabel) which always returned
  // undefined (map is keyed by monthKey, not monthLabel) → sortKey collapsed → sort broken.
  const monthKeyByLabel = new Map(fileMonthKeys.map(f => [f.monthLabel, f.monthKey]));
  // BUG FIX (BUG-NORECORDS-4/5 / FIX-DEEP-1): Case-insensitive monthLabel resolution
  // via shared util `@/lib/month-resolver`. DB may have "AGUSTUS 2026" (upload-data.ts)
  // or "Agustus 2026" (dashboard import). Resolve user-sent month to actual DB case
  // to avoid "No records found".
  const monthResolver = await getMonthResolver();
  // Resolve current + compare month labels to actual DB case.
  // PERF-CACHE-06: declare as `const month` (shadowing monthInput) so the rest
  // of the computeFn uses the resolved case. monthInput is the raw URL param.
  const month = resolveMonthLabel(monthParam, monthResolver) || monthParam;
  const resolvedCompareMonth = userCompareMonth ? resolveMonthLabel(userCompareMonth, monthResolver) : null;
  const allPeriods = weeksRaw.map(w => ({
    monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
    weekLabel: w.weekLabel,
    sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
  })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // BUG FIX (AUDIT-EXPORT-AI-2): use user's compareWeek/compareMonth if provided.
  // Fall back to auto-compute (same weekLabel in previous month) only when user didn't specify.
  //
  // FIX (RESTORE-BACKEND-2): the inline ~15-line period-resolution block has been
  // extracted to `@/lib/period-resolver.ts` as `resolveComparePeriod`. This also
  // fixes a subtle bug in the old logic: when the user set compareWeek WITHOUT
  // compareMonth, the old code searched for the CURRENT week (not compareWeek) in
  // the previous month — so setting compareWeek alone had no effect. The new
  // helper correctly searches for `compareWeek` in the previous month.
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    month,
    userCompareWeek,
    resolvedCompareMonth,
  );

  // Historical periods (same weekLabel only)
  const historicalPeriods = allPeriods.filter(p => p.weekLabel === week && p.monthLabel !== month)
    .filter(p => { const cur = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week); return !cur || p.sortKey < cur.sortKey; });

  // PERF (TAHAP-2 / P2-7 + P2-9): the old block fetched currSlim — 5 columns
  // × ~35K rows — solely to feed evaluateHistoricalRulesJs's JS loop. The
  // 3 zScore rules now run as ONE SQL query (evaluateHistoricalRulesSql)
  // INSIDE this parallel wave, so the current period only needs a COUNT for
  // the 404 short-circuit. The queries marked "shared" below use
  // cachedSharedQuery with the SAME queryIds as the /api/analysis pipeline —
  // when the dashboard was just viewed, those rows are already cached and
  // this export skips recomputing them (~4-6s of the old cold path).
  const [currRecordCount, historicalByOutletItem, sqlFlags, varianceAnalysis, histFlags] = await Promise.all([
    db.inventoryRecord.count({ where: buildWhere(week, month) }),
    historicalPeriods.length > 0
      ? cachedSharedQueryMap(
          'q-hist-stats',
          { ...histPeriodsKeyParts(historicalPeriods), filters: filterOpts },
          () => queryHistoricalStatsMultiMetric(historicalPeriods, filterOpts),
        )
      : Promise.resolve(new Map<string, MultiMetricHistoricalStats>()),
    cachedSharedQuery(
      'q-rules',
      { month, week, compareWeek: prevWeek, compareMonth: prevMonth, filters: filterOpts },
      () => evaluateRulesSql(week, month, prevWeek, prevMonth, filterOpts, thresholds),
    ),
    cachedSharedQuery(
      'q-variance',
      { month, week, compareWeek: prevWeek, compareMonth: prevMonth, filters: filterOpts },
      () => queryVarianceAnalysis(week, month, prevWeek, prevMonth, filterOpts),
    ),
    cachedSharedQuery(
      'q-hist-rules',
      { month, week, filters: filterOpts },
      () => evaluateHistoricalRulesSql(week, month, historicalPeriods, filterOpts, thresholds),
    ),
  ]);

  if (currRecordCount === 0) {
    // BUG FIX (BUG-NORECORDS-11): include filter context in error message for debugging
    const filterSummary = [
      `month="${month}"`, `week="${week}"`,
      area && area !== 'all' ? `area="${area}"` : null,
      outletCode && outletCode !== 'all' ? `outlet="${outletCode}"` : null,
      itemName ? `item="${itemName}"` : null,
      pic ? `pic="${pic}"` : null,
    ].filter(Boolean).join(', ');
    // PERF-CACHE-06: throw EarlyHttpResponse so the outer try/catch returns
    // the 404 response. Throwing (vs returning) propagates through
    // withCacheAndDedup's rejectComputation so concurrent in-flight awaiters
    // also see the 404. The cache is NOT populated (we don't cache 404s).
    throw new EarlyHttpResponse(NextResponse.json({ success: false, error: `No records found for ${filterSummary}. Coba cek filter atau import data ulang.` }, { status: 404 }));
  }

  // PERF (TAHAP-2 / P2-7): the zScore hist flags arrived from SQL in the
  // parallel wave above (evaluateHistoricalRulesSql — replaced the 35K-row
  // currSlim fetch + evaluateHistoricalRulesJs loop).
  // Build topFlagByKey — one entry per (outletId, itemId, akunPenyesuaian)
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

  // PERF (H-8 QUICK WIN 1b): fire queryHistoricalCriticalItems HERE — its only
  // input (histCriticalKeys, derived from the flag merge above) is ready — so
  // it overlaps the KPI + big Promise.all phases below instead of running
  // sequentially after them (~100-300ms off the cold path).
  const histCriticalKeys = [...topFlagByKey.values()]
    .filter((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_ABNORMAL_SURPLUS' || f.ruleCode === 'HISTORICAL_WARNING')
    .map(f => ({ outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian }));
  // PERF (H-11 / #3): q-hist-critical — SAME queryId + keys fingerprint as
  // the analysis pipeline's identical call (both derive the keys from the
  // shared q-rules / q-hist-rules rows), so a dashboard view before the
  // export skips this scan entirely.
  const histCriticalRowsPromise = cachedSharedQuery(
    'q-hist-critical',
    { month, week, filters: filterOpts, extra: { keys: histCriticalKeysHash(histCriticalKeys) } },
    () => queryHistoricalCriticalItems(week, month, filterOpts, histCriticalKeys),
  );
  // SQL queries
  // PERF (PAKET B / F2 — scan merge): current-period exec summary + deviation
  // breakdown come from ONE merged scan (queryDashboardKpis); only the
  // previous-period exec summary still runs standalone.
  // PERF (TAHAP-2 / P2-9): kpis + trendAgg + category tops use the shared
  // per-query cache (same queryIds as the analysis pipeline).
  const [kpis, prevSummary] = await Promise.all([
    cachedSharedQuery(
      'q-kpis',
      { month, week, filters: filterOpts },
      () => queryDashboardKpis(week, month, filterOpts),
    ),
    // PERF (H-11 / #3): q-exec-summary — SAME queryId + period key as the
    // analysis pipeline's prev-period call, so whichever pipeline runs
    // first warms the row for the other.
    prevMonth && prevWeek ? cachedSharedQuery(
      'q-exec-summary',
      { month: prevMonth, week: prevWeek, filters: filterOpts },
      () => queryExecSummary(prevWeek, prevMonth, filterOpts),
    ) : Promise.resolve(null),
  ]);
  const execSummary = buildExecSummaryFromSql(kpis, prevSummary, month, week, prevWeek);
  const breakdown = kpisToBreakdown(kpis);

  const topNItems = thresholds.TOP_N_ITEMS || 10;

  // Rev 2: Fetch previous period + historical category data for comparison
  const historicalPeriodsList = historicalPeriods.map(p => ({ monthLabel: p.monthLabel, weekLabel: p.weekLabel }));
  // PERF (PAKET B / F2 — scan merge): the 4 current + 4 previous category
  // queries each scanned their period separately; now 1 merged scan per
  // period (queryTopItemsByAllCategories — same result sets).
  const [topNominal, topDevBom, topCategories, prevTopCategories, areaAnalysisRaw, trendAggRows,
    // Historical category averages (Rev 2)
    histWasteMap, histSusutMap, histTrialMap, histLossSurplusMap,
  ] = await Promise.all([
    // PERF (H-11 / #3): q-top-nominal / q-top-devbom / q-area — SAME queryIds
    // + keys as the analysis pipeline's calls (limit in the key), and
    // q-hist-catavg — shared across export runs with different `sections`
    // params (the route-level cache key includes sections; the q-* rows do
    // not, so a sections change no longer re-pays the whole query bill).
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
    cachedSharedQuery(
      'q-topcat',
      { month, week, filters: filterOpts, extra: { limit: topNItems } },
      () => queryTopItemsByAllCategories(week, month, filterOpts, topNItems),
    ),
    prevMonth && prevWeek ? queryTopItemsByAllCategories(prevWeek, prevMonth, filterOpts, 100) : Promise.resolve({ waste: [], susut: [], trial: [], lossSurplus: [] }),
    cachedSharedQuery(
      'q-area',
      { month, week, filters: filterOpts },
      () => queryAreaAnalysis(week, month, filterOpts),
    ),
    cachedSharedQuery(
      'q-trend',
      { month, week, filters: filterOpts, extra: { weekLabel: week || 'ALL' } },
      () => queryTrendAgg({ ...filterOpts, weekLabel: week }),
    ),
    // Rev 2: Historical category averages (Map-safe wrapper — see
    // cachedSharedQueryMap for why Maps must be cached as entry arrays).
    // Empty-periods guard: skip caching degenerate empty rows (the query
    // itself early-returns an empty Map when there is no baseline).
    historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'waste' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'waste'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'susut' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'susut'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'trial' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'trial'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'lossSurplus' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'lossSurplus'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
  ]);
  const topWasteRows = topCategories.waste;
  const topSusutRows = topCategories.susut;
  const topTrialRows = topCategories.trial;
  const topLossSurplusRows = topCategories.lossSurplus;
  // Previous period category data (Rev 2)
  const prevWasteRows = prevTopCategories.waste;
  const prevSusutRows = prevTopCategories.susut;
  const prevTrialRows = prevTopCategories.trial;
  const prevLossSurplusRows = prevTopCategories.lossSurplus;

  // Build prev + historical lookup maps keyed by "itemName|outletCode"
  const prevCatMap = (rows: Array<{ itemName: string; outletCode: string; qty: number; nominal: number }>, _qtyKey: string, _nomKey: string) => {
    const m = new Map<string, { qty: number; nominal: number }>();
    for (const r of rows) m.set(`${r.itemName}|${r.outletCode}`, { qty: r.qty, nominal: r.nominal });
    return m;
  };
  const prevWasteMap = prevCatMap(prevWasteRows, 'qty', 'nominal');
  const prevSusutMap = prevCatMap(prevSusutRows, 'qty', 'nominal');
  const prevTrialMap = prevCatMap(prevTrialRows, 'qty', 'nominal');
  const prevLossSurplusMap = prevCatMap(prevLossSurplusRows, 'qty', 'nominal');

  const topWaste = topWasteRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevWasteMap.get(key);
    const hist = histWasteMap.get(key);
    // H-2b: pass satuan through for the "Satuan" column in the docx table.
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qtyWaste: r.qty, nominalWaste: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
  });
  const topSusut = topSusutRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevSusutMap.get(key);
    const hist = histSusutMap.get(key);
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qtySusut: r.qty, nominalSusut: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
  });
  const topTrial = topTrialRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevTrialMap.get(key);
    const hist = histTrialMap.get(key);
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qtyTrial: r.qty, nominalTrial: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
  });
  const topLossSurplus = topLossSurplusRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevLossSurplusMap.get(key);
    const hist = histLossSurplusMap.get(key);
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
  });

  const explainedTotal = (breakdown.waste ?? 0) + (breakdown.susut ?? 0) + (breakdown.trial ?? 0);
  const breakdownEnriched = { ...breakdown, explained: explainedTotal, explainedPct: breakdown.total > 0 ? explainedTotal / breakdown.total : null, netPct: breakdown.total > 0 ? (breakdown.residual ?? 0) / breakdown.total : null };

  // Growth metrics
  const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(execSummary.nominalDeviasi.current, execSummary.nominalDeviasi.previous ?? null);
  const growthMetrics = {
    salesGrowth: execSummary.sales.growth, bomGrowth: execSummary.qtyBom.growth,
    qtyDeviasiGrowth: execSummary.qtyDeviasi.growth, nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
    deviationToSalesRatio: execSummary.sales.current > 0 ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
    deviationToBomRatio: execSummary.deviationToBom,
    multiPeriodComparison: [] as Array<Record<string, unknown>>,
  };

  const multiPeriodComparison = trendAggRows.map(r => {
    const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
    return { period: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, sales: r.sales, deviation: r.nominal, devBomRatio: r.devBom, growthPct: null as number | null };
  }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((row, i, arr) => { if (i > 0) row.growthPct = computeNominalDeviationGrowth(row.deviation, arr[i - 1].deviation); const { sortKey, ...rest } = row; return rest; });
  growthMetrics.multiPeriodComparison = multiPeriodComparison;

  const trend = trendAggRows.map(r => {
    const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
    return { weekLabel: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, devBom: r.devBom, sales: r.sales, nominal: r.nominal };
  }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

  // PERF-FASE3-BE04: varianceAnalysis already computed via SQL in the
  // Promise.all block above (queryVarianceAnalysis). Historical analysis
  // now uses queryHistoricalCriticalItems SQL instead of 35K-record JS loop.
  // (H-8 QUICK WIN 1b: the query was FIRED right after the flag merge above
  // — awaited here after overlapping the KPI + category phases.)
  const histCriticalRows = await histCriticalRowsPromise;
  const histCriticalItems = histCriticalRows.map(row => {
    const key = `${row.outletId}|${row.itemId}`;
    const stats = historicalByOutletItem.get(key);
    if (!stats || stats.devBom.stdDev <= 0) return null;
    // ZS-03 FIX: Don't coerce null to 0 — pass raw value to calcZScoreFromStats
    const zScore = calcZScoreFromStats(row.pctQtyDeviasiToBom, stats.devBom.mean, stats.devBom.stdDev);
    return {
      itemName: row.itemName,
      outletCode: row.outletCode,
      area: row.area,
      currentDevBom: row.pctQtyDeviasiToBom ?? 0,
      historicalAvg: stats.devBom.mean,
      zScore: zScore ?? 0,
      absNominal: row.absNominalDeviasi ?? 0,
      currentWaste: Math.abs(row.qtyWaste ?? 0),
      currentSusut: Math.abs(row.qtySusut ?? 0),
      currentTrial: Math.abs(row.qtyTrial ?? 0),
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  histCriticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  const historicalAnalysis = { criticalItems: histCriticalItems.slice(0, 200) };
  const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };

  // (PERF H-8 QUICK WIN 1: the outletHealthRanking fetch was removed — its
  // DOCX section (restoPriority) no longer exists, so the query was pure
  // dead compute. topItemForCrossOutlet + queryGlobalItemSearch were removed
  // along with the GlobalItemSearchModal — the cross-outlet section was
  // already removed from the report per earlier user request.)
  const data: ReportData = {
    period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
    // FIX (BUG-KELOMPOK-GLOBAL): include kelompok in response filters
    // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
    filters: { area, kelompok, outletCode, itemName, pic },
    executiveSummary: execSummary,
    growthComparison: growthComparisonWithHist,
    topItemsByNominal: topNominal, topItemsByDevBom: topDevBom,
    topItemsByWaste: topWaste, topItemsBySusut: topSusut, topItemsByTrial: topTrial, topItemsByLossSurplus: topLossSurplus,
    deviationBreakdown: breakdownEnriched,
    areaAnalysis: areaAnalysisRaw.map(a => ({ area: a.area, outletCount: a.outletCount, totalSales: a.totalSales, totalAbsNominal: a.totalAbsNominal, avgDevBom: a.avgDevBom, lossToSales: a.lossToSales })),
    varianceAnalysis,
    trend,
    durationMs: Date.now() - startedAt,
  };

  // DocxContext — auxiliary state needed by buildDocxReport (sections filter,
  // historicalPeriods for the Hist label, thresholds + sqlFlags + period labels
  // for the 5.1 BOM-correlation per-record table). Kept separate from
  // ReportData so the cache payload (only `{ buffer, fileName }`) stays clean.
  const ctx: DocxContext = {
    sections,
    historicalPeriods,
    thresholds,
    sqlFlags,
    month,
    week,
    prevWeek,
    prevMonth,
  };

  return { data, ctx };
}
