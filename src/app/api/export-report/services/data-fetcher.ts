// ============================================================
//  data-fetcher — Stage 1 of /api/export-report GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  Responsibilities (updated by FIX BUG-3-a P1/P2 — sections-aware, dead
//  compute removed; this list replaces the old 1-16 list):
//    1. Load runtime thresholds (getRuntimeThresholds — now ONLY consumed
//       for TOP_N_ITEMS; the rule-evaluation thresholds left with the
//       dead q-rules / q-hist-rules compute, see P1 below)
//    2. Resolve PIC outlet codes (case-insensitive raw SQL + sentinel)
//    3. Resolve kelompok outlet codes (shared helper)
//    4. Build Prisma where-clause factory (buildInventoryWhere)
//    5. Fetch weeks + sourceFiles metadata → allPeriods list (wrapped in
//       withStatementTimeout — FIX BUG-3-a C3)
//    6. Resolve month label case (case-insensitive via getMonthResolver)
//    7. Resolve prevWeek + prevMonth (via resolveComparePeriod, fed with
//       the preloaded period tables — FIX BUG-3-a P4)
//    8. Compute historicalPeriods (same weekLabel, prior months — only
//       feeds the header "Hist (…)" label + the topItems section's
//       q-hist-catavg periods now)
//    9. 404 short-circuit (throw EarlyHttpResponse if the current period
//       has 0 records) — first data query for EVERY sections combination
//   10. Sections-aware parallel fetch (FIX BUG-3-a P2) — verified against
//       docx-builder.ts, `?sections=` now gates the FETCHING too:
//         exec / growth / breakdown → q-kpis (+ prev q-exec-summary for
//                                     exec/growth growth columns)
//         topItems                  → q-top-nominal + q-top-devbom +
//                                     q-topcat + prev q-topcat (limit 100)
//                                     + 4× q-hist-catavg
//         variance                  → q-variance
//         trend                     → q-trend
//   11. Build prev lookup maps + enrich topWaste/Susut/Trial/LossSurplus
//   12. Build execSummary + breakdownEnriched + growthMetrics + trend
//   13. Assemble ReportData + DocxContext, return both
//
//  FIX (BUG-3-a P1) — DEAD COMPUTE REMOVED: q-rules (evaluateRulesSql),
//  q-hist-rules (evaluateHistoricalRulesSql), q-hist-stats
//  (queryHistoricalStatsMultiMetric), q-hist-critical
//  (queryHistoricalCriticalItems) and q-area (queryAreaAnalysis) were the 5
//  heaviest queries of the pipeline, but their DOCX sections (Historical
//  anomaly, Area analysis, 5.1 BOM-correlation per-record table) had already
//  been removed by earlier user requests — hunt BUG-3-a verified 0 reads of
//  areaAnalysis / growthComparison.historicalAnalysis / ctx.sqlFlags /
//  ctx.thresholds / multiPeriodComparison in docx-builder.ts. They cost
//  ±5-9s (35-60%) of the 15.3s cold path, and even the 404 path paid them
//  (the 404 is thrown after that wave). Their plumbing went with them:
//  historicalByOutletItem, allFlags/topFlagByKey, histCriticalKeys,
//  areaAnalysisRaw + the ReportData/DocxContext fields they fed.
//  TRADEOFF: the export no longer cross-warms those 5 q-* rows for the
//  /api/analysis dashboard — the dashboard computes them in its own
//  warm-up (run-queries.ts fires all 5 regardless), so only the rare
//  "export first, then open dashboard" ordering loses a warm row; the
//  common "dashboard → export" direction still warms every q-* row the
//  export now needs (q-kpis / q-exec-summary / q-top-nominal / q-top-devbom
//  / q-topcat / q-trend / q-variance / q-hist-catavg).
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
import { getRuntimeThresholds } from '@/lib/settings';
import { calcGrowth, computeNominalDeviationGrowth } from '@/lib/metrics';
import {
  queryTrendAgg,
  queryExecSummary,
  queryDashboardKpis,
  kpisToBreakdown,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByAllCategories,
  queryHistoricalCategoryAvg,
} from '@/lib/queries';
import { queryVarianceAnalysis } from '@/lib/queries/health-ranking';
import { cachedSharedQuery, cachedSharedQueryMap, histPeriodsKeyParts } from '@/lib/queries/query-cache';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { buildInventoryWhere } from '@/lib/build-where';
import { resolveComparePeriod } from '@/lib/period-resolver';
import { withStatementTimeout } from '@/lib/queries/shared';
import { logger } from '@/lib/logger';
import type { ExecSummaryRow } from '@/lib/queries/dashboard';
import { EarlyHttpResponse } from '@/lib/early-http-response';
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
//  Body relocated from route.ts:349-667 (the computeFn body of the
//  original withCacheAndDedup wrapper). Comments preserved;
//  restructured by FIX (BUG-3-a P1/P2) — see the file header.
//
//  Throws EarlyHttpResponse on 404 (no records found for the filter).
//  The caller (route.ts) catches this in its outer try/catch.
// ============================================================
export async function fetchReportData(params: ReportParams): Promise<FetchedReport> {
  const {
    monthParam, week, area, outletCode, itemName, pic, kelompok,
    userCompareWeek, userCompareMonth, sections, startedAt,
  } = params;

  // ============================================================
  //  FIX (BUG-3-a P2): sections-aware fetching. `?sections=` used to gate
  //  only the DOCX rendering — every export paid the FULL query bill even
  //  when it rendered one section (an "exec only" export still ran q-trend
  //  + the whole top-items batch). Build the `need` set up front and gate
  //  every fetch below on it. `sections === null` (param absent) = ALL
  //  sections; `[]` (empty param — FIX BUG-3-a C4 in route.ts) = NONE.
  //  Keep this list in sync with EXPORT_SECTION_KEYS (validation.ts),
  //  ExportDialog.tsx and the hasSection() keys in docx-builder.ts.
  // ============================================================
  const ALL_EXPORT_SECTIONS = ['exec', 'growth', 'topItems', 'breakdown', 'variance', 'trend'] as const;
  const need = new Set<string>(sections ?? ALL_EXPORT_SECTIONS);
  // Section → data dependencies (verified against docx-builder.ts, not
  // assumed): exec renders executiveSummary (q-kpis + prev q-exec-summary);
  // growth renders growthComparison (derived from the SAME execSummary —
  // growth values + _prevMetrics need the prev-period row); breakdown
  // renders deviationBreakdown (derived from the same q-kpis row);
  // topItems renders the 6 top tables (q-top-nominal / q-top-devbom /
  // q-topcat + prev q-topcat + 4× q-hist-catavg); variance → q-variance;
  // trend → q-trend. The header/footer need metadata only (no SQL).
  const needExec = need.has('exec');
  const needGrowth = need.has('growth');
  const needTopItems = need.has('topItems');
  const needBreakdown = need.has('breakdown');
  const needVariance = need.has('variance');
  const needTrend = need.has('trend');
  const needKpis = needExec || needGrowth || needBreakdown;
  const needPrevSummary = needExec || needGrowth;

  // PERF-CACHE-06: monthParam + week are `const` (narrowed to `string` by the
  // outer guard) — TS carries the narrowing into this closure. The resolved
  // `month` (after monthResolver) is declared as a separate const below.
  // Load thresholds.
  // FIX (BUG-3-a P1): after the dead-compute removal the ONLY consumer of
  // thresholds here is TOP_N_ITEMS (the rule-evaluation thresholds went away
  // with q-rules / q-hist-rules). Keep the call — getRuntimeThresholds sits
  // on getAllSettings' 30s-TTL in-process cache, so it is ~0ms when warm.
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
  // pre-sentineled above; helper passes it through unchanged).
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
  // FIX (BUG-3-a C3): these metadata reads (and the inventoryRecord COUNT
  // below) were plain db.* calls — the PgBouncer transaction pooler strips
  // the statement_timeout URL param, so a stuck query could hang them
  // unbounded (Vercel maxDuration 60s → 504 → the reported "spinner muter
  // terus"). Wrap in withStatementTimeout so they fail loudly at 30s.
  const [weeksRaw, fileMonthKeys] = await Promise.all([
    withStatementTimeout((tx) => tx.week.findMany({ select: { weekLabel: true, monthKey: true }, distinct: ['monthKey', 'weekLabel'] })),
    withStatementTimeout((tx) => tx.sourceFile.findMany({ select: { monthLabel: true, monthKey: true } })),
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
  //
  // FIX (BUG-3-a P4): pass the ALREADY-fetched weeksRaw + fileMonthKeys into
  // resolveComparePeriod — without this the helper re-fetched both tables
  // (2 extra round-trips right after the same data was loaded above). Same
  // pattern as analysis/services/fetch-records.ts:152-162.
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    month,
    userCompareWeek,
    resolvedCompareMonth,
    { weeksRaw, fileMonthKeys },
  );

  // Historical periods (same weekLabel only).
  // FIX (BUG-3-a P1): after the dead-compute removal no SQL consumes this
  // list unconditionally anymore — it now feeds (a) the DOCX header's
  // "Hist (Jan-Jul 26)" range label (every section combination) and
  // (b) the topItems section's q-hist-catavg periods. Cheap: metadata only.
  const historicalPeriods = allPeriods.filter(p => p.weekLabel === week && p.monthLabel !== month)
    .filter(p => { const cur = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week); return !cur || p.sortKey < cur.sortKey; });

  // ============================================================
  //  404 short-circuit wave — the FIRST data query for every sections
  //  combination.
  //  FIX (BUG-3-a P1): this wave used to also carry the 5 dead queries
  //  (q-rules / q-hist-rules / q-hist-stats), so even a filter with 0
  //  records paid seconds of dead compute before the 404 was thrown.
  //  FIX (BUG-3-a P2): q-variance is gated on the variance section (it
  //  renders nothing else — the top-worsened table is its only consumer).
  // ============================================================
  const [currRecordCount, varianceAnalysis] = await Promise.all([
    // FIX (BUG-3-a C3): bound the COUNT with a statement timeout too.
    withStatementTimeout((tx) => tx.inventoryRecord.count({ where: buildWhere(week, month) })),
    needVariance
      ? cachedSharedQuery(
          'q-variance',
          { month, week, compareWeek: prevWeek, compareMonth: prevMonth, filters: filterOpts },
          () => queryVarianceAnalysis(week, month, prevWeek, prevMonth, filterOpts),
        )
      : Promise.resolve({ topWorsened: [], topImproved: [] }),
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

  const topNItems = thresholds.TOP_N_ITEMS || 10;

  // Rev 2: Fetch previous period + historical category data for comparison
  const historicalPeriodsList = historicalPeriods.map(p => ({ monthLabel: p.monthLabel, weekLabel: p.weekLabel }));
  // PERF (PAKET B / F2 — scan merge): the 4 current + 4 previous category
  // queries each scanned their period separately; now 1 merged scan per
  // period (queryTopItemsByAllCategories — same result sets).
  //
  // PERF (H-8 QUICK WIN 2 pattern — kept by FIX BUG-3-a P2): ONE Promise.all
  // for ALL remaining section-gated queries. The old code ran TWO serial
  // waves (kpis + prev summary first, then the category batch) with no data
  // dependency between them — one extra full-RTT barrier on the cold path.
  const [kpis, prevSummary, topNominal, topDevBom, topCategories, prevTopCategories, trendAggRows,
    // Historical category averages (Rev 2)
    histWasteMap, histSusutMap, histTrialMap, histLossSurplusMap,
  ] = await Promise.all([
    // PERF (TAHAP-2 / P2-9): kpis + trendAgg + category tops use the shared
    // per-query cache (same queryIds as the analysis pipeline).
    needKpis
      ? cachedSharedQuery(
          'q-kpis',
          { month, week, filters: filterOpts },
          () => queryDashboardKpis(week, month, filterOpts),
        )
      // FIX (BUG-3-a P2): not-fetched sections get zero-value placeholders —
      // never rendered (docx-builder's hasSection gates with the SAME list).
      : Promise.resolve(null),
    // PERF (H-11 / #3): q-exec-summary — SAME queryId + period key as the
    // analysis pipeline's prev-period call, so whichever pipeline runs
    // first warms the row for the other.
    needPrevSummary && prevMonth && prevWeek ? cachedSharedQuery(
      'q-exec-summary',
      { month: prevMonth, week: prevWeek, filters: filterOpts },
      () => queryExecSummary(prevWeek, prevMonth, filterOpts),
    ) : Promise.resolve(null),
    // PERF (H-11 / #3): q-top-nominal / q-top-devbom — SAME queryIds + keys
    // as the analysis pipeline's calls (limit in the key), and q-hist-catavg
    // — shared across export runs with different `sections` params (the
    // route-level cache key includes sections; the q-* rows do not, so a
    // sections change no longer re-pays the whole query bill).
    needTopItems
      ? cachedSharedQuery(
          'q-top-nominal',
          { month, week, filters: filterOpts, extra: { limit: topNItems } },
          () => queryTopItemsByNominal(week, month, filterOpts, topNItems),
        )
      : Promise.resolve([]),
    needTopItems
      ? cachedSharedQuery(
          'q-top-devbom',
          { month, week, filters: filterOpts, extra: { limit: topNItems } },
          () => queryTopItemsByDevBom(week, month, filterOpts, topNItems),
        )
      : Promise.resolve([]),
    needTopItems
      ? cachedSharedQuery(
          'q-topcat',
          { month, week, filters: filterOpts, extra: { limit: topNItems } },
          () => queryTopItemsByAllCategories(week, month, filterOpts, topNItems),
        )
      : Promise.resolve({ waste: [], susut: [], trial: [], lossSurplus: [] }),
    // FIX (BUG-3-a P5): the prev-period merged category scan was the ONE
    // remaining uncached heavy query (recomputed on every export with a
    // compare period). Wrapped in cachedSharedQuery under the SAME 'q-topcat'
    // queryId (period = prevMonth/prevWeek + limit 100 in the key):
    //   - Key: a dedicated 'q-topcat-prev' id would NOT be covered by
    //     invalidateAnalysisCache()'s route-prefix list ('q-topcat\x1f'
    //     matches this row too, since the key starts with the same route
    //     prefix) — the invalidation list lives in aggregation-cache/**
    //     (out of scope for this fix), so reusing 'q-topcat' is the choice
    //     that keeps mutations (ingest/delete/settings) from serving a
    //     stale prev-period row for up to 30 min.
    //   - Limit: kept at 100, NOT topNItems. The prev rows build a LOOKUP
    //     map for the CURRENT period's top-N items — an item ranked #10 now
    //     may rank #11-#100 in the prev period, so a topNItems limit would
    //     turn real prev quantities into '—' in the "QTY <prev>" column
    //     (correctness regression); 100 gives the lookup rank headroom.
    //     extra.limit=100 keeps the cache key distinct from the
    //     current-period q-topcat row (extra.limit=topNItems).
    needTopItems && prevMonth && prevWeek ? cachedSharedQuery(
      'q-topcat',
      { month: prevMonth, week: prevWeek, filters: filterOpts, extra: { limit: 100 } },
      () => queryTopItemsByAllCategories(prevWeek, prevMonth, filterOpts, 100),
    ) : Promise.resolve({ waste: [], susut: [], trial: [], lossSurplus: [] }),
    needTrend
      ? cachedSharedQuery(
          'q-trend',
          { month, week, filters: filterOpts, extra: { weekLabel: week || 'ALL' } },
          () => queryTrendAgg({ ...filterOpts, weekLabel: week }),
        )
      : Promise.resolve([]),
    // Rev 2: Historical category averages (Map-safe wrapper — see
    // cachedSharedQueryMap for why Maps must be cached as entry arrays).
    // Empty-periods guard: skip caching degenerate empty rows (the query
    // itself early-returns an empty Map when there is no baseline).
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'waste' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'waste'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'susut' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'susut'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'trial' } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'trial'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
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

  // FIX (BUG-3-a P2): kpis/prevSummary are null when the exec/growth/
  // breakdown sections are all off — kpisToBreakdown + buildExecSummaryFromSql
  // degrade to their zero-value shapes (never rendered; hasSection gates
  // rendering with the SAME sections list that gated the fetch).
  const execSummary = buildExecSummaryFromSql(kpis, prevSummary, month, week, prevWeek);
  const breakdown = kpisToBreakdown(kpis);

  const explainedTotal = (breakdown.waste ?? 0) + (breakdown.susut ?? 0) + (breakdown.trial ?? 0);
  const breakdownEnriched = { ...breakdown, explained: explainedTotal, explainedPct: breakdown.total > 0 ? explainedTotal / breakdown.total : null, netPct: breakdown.total > 0 ? (breakdown.residual ?? 0) / breakdown.total : null };

  // Growth metrics
  const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(execSummary.nominalDeviasi.current, execSummary.nominalDeviasi.previous ?? null);
  // FIX (BUG-3-a P1): multiPeriodComparison REMOVED from growthMetrics —
  // hunt BUG-3-a verified 0 reads in docx-builder.ts (the Section 2 table
  // renders only the 7 scalar growth fields; the analysis payload keeps its
  // own copy for the frontend). It was rebuilt from trendAggRows on every
  // export for nothing.
  const growthMetrics = {
    salesGrowth: execSummary.sales.growth, bomGrowth: execSummary.qtyBom.growth,
    qtyDeviasiGrowth: execSummary.qtyDeviasi.growth, nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
    // USER-POLISH: waste/susut/trial growth surfaced for the export's Section 2
    // (same calcGrowth-based MoM values the Section 1 rows already render).
    qtyWasteGrowth: execSummary.qtyWaste.growth,
    qtySusutGrowth: execSummary.qtySusut.growth,
    qtyTrialGrowth: execSummary.qtyTrial.growth,
    deviationToSalesRatio: execSummary.sales.current > 0 ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
    deviationToBomRatio: execSummary.deviationToBom,
  };

  const trend = trendAggRows.map(r => {
    const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
    return { weekLabel: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, devBom: r.devBom, sales: r.sales, nominal: r.nominal };
  }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

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
    growthComparison: growthMetrics,
    topItemsByNominal: topNominal, topItemsByDevBom: topDevBom,
    topItemsByWaste: topWaste, topItemsBySusut: topSusut, topItemsByTrial: topTrial, topItemsByLossSurplus: topLossSurplus,
    deviationBreakdown: breakdownEnriched,
    varianceAnalysis,
    trend,
    durationMs: Date.now() - startedAt,
  };

  // DocxContext — auxiliary state needed by buildDocxReport. Kept separate
  // from ReportData so the cache payload (only `{ buffer, fileName }`) stays
  // clean. FIX (BUG-3-a P1): thresholds + sqlFlags + the period labels were
  // removed — their only DOCX consumer was the deleted "5.1 BOM-correlation"
  // per-record table; docx-builder reads period labels from data.period and
  // the historical range from historicalPeriods.
  const ctx: DocxContext = {
    sections,
    historicalPeriods,
  };

  return { data, ctx };
}
