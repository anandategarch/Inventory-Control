// ============================================================
//  query-batch — runSectionQueryBatch (the parallel query wave)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:391-592) — the ONE
//  Promise.all carrying every remaining section-gated query, in
//  the original entry order. Writes the 16 results onto the
//  context. Comments preserved; the only comment edits are the
//  three "see the q-variance note above" pointers, which now
//  point at ./record-guard.ts (the note moved there).
// ============================================================
import {
  queryTrendAgg,
  queryExecSummary,
  queryDashboardKpis,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByAllCategories,
  queryHistoricalCategoryAvg,
  // REFINE-1: per-(item, area) category averages — "Rata-rata Area"
  // column in the export's 3.3-3.6 tables.
  queryAreaCategoryAvg,
  // EXPORT-PDF: the item-trend matrix section query (re-exported via the
  // queries barrel).
  queryItemTrendMatrix,
  // VAR12 — section 6.3 "Analisis Pola Item" (renumbered 7.3 by W10; the
  // dashboard's ItemConsistencyAnalysis widget carried into the PDF;
  // re-exported via the queries barrel).
  queryItemConsistency,
  // W10 — section 5 "Analisis Waste": queryWasteNetwork (re-exported via
  // the queries barrel).
  queryWasteNetwork,
} from '@/lib/queries';
// REFINE-1: section 8 flip items (renamed "Item yang Kemungkinan Plus Minus
// antar Periode") — not in the queries barrel; direct module import.
import { queryFlipRanking } from '@/lib/queries/items/flip-ranking';
// REFINE-3: section 6 "Item Anomali vs Riwayat Sendiri" — direct module
// import (flip-ranking precedent; not in the queries barrel).
import { querySelfHistoryAnomaly } from '@/lib/queries/items/self-history-anomaly';
import { queryWeeklyComposition } from '@/lib/queries/weekly-composition';
import type { SelfHistoryAnomalyRow } from '@/lib/queries/items/self-history-anomaly';
import type { WeeklyCompositionRow } from '@/lib/queries/weekly-composition';
import { cachedSharedQuery, cachedSharedQueryMap, histPeriodsKeyParts } from '@/lib/queries/query-cache';
import type { AreaCategoryAvg } from '@/lib/queries/items/top-items';
import type { WasteSectionData } from '../types';
import type { FetcherContext } from './context';

export async function runSectionQueryBatch(ctx: FetcherContext): Promise<void> {
  const { thresholds, month, prevWeek, prevMonth, filterOpts, historicalPeriods, gates } = ctx;
  const { week } = ctx.params;
  const { needKpis, needPrevSummary, needTopItems, needTrend, needItemTrend, needAnomali, needFlip, needWaste } = gates;

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
    // EXPORT-PDF: item-trend matrix. FIX (found in runtime verify):
    // queryItemTrendMatrix returns { rows: ItemTrendMatrixRow[] } (the whole
    // result object), NOT the bare array — the old `as ItemTrendMatrixRow[]`
    // cast silenced tsc while the object landed in ReportData.itemTrendMatrix,
    // whose `.length` was undefined → the section silently never rendered
    // even with 743 cached rows. Unwrap .rows here; `[]` stays the
    // off-section placeholder.
    itemTrendMatrixRes,
    // REFINE-3 — section 6 "Item Anomali vs Riwayat Sendiri": top items
    // departing from their own same-week historical average (empty result
    // when off / no historical periods).
    selfAnomalyRes,
    // REFINE-3 — per-week category composition of the exported month (for
    // the trend section's composition + accumulation charts; empty when
    // the trend section is off).
    weeklyCompRes,
    // REFINE-1 — "Item yang Kemungkinan Plus Minus antar Periode" (section 10 after the W10 renumber):
    // flip ranking scoped to the exported week + month (null when off).
    flipRankingRes,
    // REFINE-1 — per-(item, area) category averages for the "Rata-rata
    // Area" column in 3.3-3.6 (empty Map when topItems is off).
    areaCatAvgMap,
    // VAR12 — section 6.3 "Analisis Pola Item" (renumbered 7.3 by W10):
    // per-item outlet-count pattern rows. Called DIRECTLY (uncached) — the
    // exact precedent of the analysis pipeline (run-queries.ts runs
    // queryItemConsistency uncached too: one light GROUP BY). No new q-*
    // namespace → no invalidation-array coupling; the route-level rv-keyed
    // PDF cache already dedupes repeat exports.
    consistencyRows,
    // W10 — section 5 "Analisis Waste": the q-waste-network projection
    // (null when the waste section is off).
    wasteRes,
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
          // REFINE-1: sv forks a fresh cache namespace — the query's row shape
          // gained `devBom` (3.1's new column) and cached pre-deploy rows lack
          // it, which would render '—' in the new column for up to a TTL
          // cycle after deploy.
          { month, week, filters: filterOpts, extra: { limit: topNItems, sv: 2 } },
          () => queryTopItemsByNominal(week, month, filterOpts, topNItems),
        )
      : Promise.resolve([]),
    needTopItems
      ? cachedSharedQuery(
          'q-top-devbom',
          // REFINE-1: sv — row shape gained `nominalDeviasi` (3.2's new
          // column); see the q-top-nominal note above.
          { month, week, filters: filterOpts, extra: { limit: topNItems, sv: 2 } },
          () => queryTopItemsByDevBom(week, month, filterOpts, topNItems),
        )
      : Promise.resolve([]),
    needTopItems || needWaste
      ? cachedSharedQuery(
          'q-topcat',
          // REFINE-1: sv — row shape gained `area` (drives the "Rata-rata
          // Area" lookup); see the q-top-nominal note above.
          // W10: fetch gate widened to needTopItems || needWaste — the
          // "Analisis Waste" section's 5.3 top-waste snapshot reuses this
          // SAME row (identical key = one shared cache row when both
          // sections are on; a waste-only export fetches it once itself).
          { month, week, filters: filterOpts, extra: { limit: topNItems, sv: 2 } },
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
    // FIX (BUGHUNT-Q1): sv 2 — the query's grain changed (per-row AVG →
    // per-period SUM then AVG), so pre-fix cached rows under the same key
    // would keep serving the understated benchmark for up to the 30-min
    // TTL after a deploy. sv forks a fresh namespace (same convention as
    // q-topcat sv 2 / q-item-trend-matrix sv 2); the 'q-hist-catavg' route
    // prefix is unchanged so mutation invalidation still covers it.
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'waste', sv: 2 } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'waste'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'susut', sv: 2 } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'susut'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'trial', sv: 2 } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'trial'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    needTopItems && historicalPeriodsList.length > 0 ? cachedSharedQueryMap(
      'q-hist-catavg',
      { ...histPeriodsKeyParts(historicalPeriodsList), filters: filterOpts, extra: { metric: 'lossSurplus', sv: 2 } },
      () => queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'lossSurplus'),
    ) : Promise.resolve(new Map<string, { avgQty: number; avgNominal: number }>()),
    // EXPORT-PDF (section 'itemTrend'): per-(month × item) ABS-nominal matrix
    // for the same weekLabel across ALL months. The query's only inputs are
    // weekLabel + filters — month is NOT one of them, so the cache key uses
    // the literal 'ALL' month (converges across exports of different
    // months: identical input → one cache row, same convention as the
    // dashboard's item-trend route key which also keys on week only).
    needItemTrend ? cachedSharedQuery(
      'q-item-trend-matrix',
      // REFINE-2: sv — row shape gained `satuan` (section 5's "Satuan"
      // column); see the q-variance note in ./record-guard.ts.
      { month: 'ALL', week, filters: { ...filterOpts, itemName: null }, extra: { weekLabel: week, sv: 2 } },
      () => queryItemTrendMatrix(week, { ...filterOpts, itemName: null }),
    ) : Promise.resolve(null),
    // REFINE-3 — section 'anomali': own-history departure ranking. Unlike
    // q-hist-catavg (whose result depends ONLY on the hist-period list, so
    // the fingerprint REPLACES month/week), this query also reads the
    // CURRENT period — month/week stay the primary period key and the hist
    // fingerprint rides in `extra`; sv forks a fresh namespace for the new
    // row shape.
    needAnomali && historicalPeriodsList.length > 0 ? cachedSharedQuery(
      'q-self-anom',
      // REFINE-4: sv 2 — ABS average + signed average + flip fields +
      // the separate flipRows list (see the mapping below).
      { month, week, filters: filterOpts, extra: { ...histPeriodsKeyParts(historicalPeriodsList), limit: topNItems, sv: 2 } },
      () => querySelfHistoryAnomaly({ week, month, historicalPeriods: historicalPeriodsList, filters: filterOpts, limit: topNItems }),
    ) : Promise.resolve({ rows: [] as SelfHistoryAnomalyRow[], flipRows: [] as SelfHistoryAnomalyRow[] }),
    // REFINE-3 — weekly category composition of the exported month. The
    // query itself is week-agnostic (it returns the month's FULL week set)
    // so the cache key uses the literal 'ALL' week (same convention as
    // q-item-trend-matrix); the caller slices to the exported week below.
    needTrend ? cachedSharedQuery(
      'q-week-comp',
      { month, week: 'ALL', filters: filterOpts, extra: {} },
      () => queryWeeklyComposition({ month, filters: filterOpts }),
    ) : Promise.resolve({ rows: [] as WeeklyCompositionRow[] }),
    // REFINE-1 — section 'flip': top-N items whose QTY deviasi sign flips
    // between consecutive same-week periods ("plus minus antar periode").
    // Scoped to the exported week + month (flips involving the selected
    // month). Filters follow the dashboard scope (area/kelompok/outlet/pic);
    // itemName is ignored by the query itself (it scans all items).
    // VAR11: limit 10 → 200 — the PDF section no longer displays the
    // query's riskScore order (volume-of-flips surfaced badly-balanced
    // pairs with huge Nets); it re-ranks by pair BALANCE (disparityPct
    // ASC, see pdf/sections/flip.ts), which needs the FULL candidate
    // pool (~all items — a top-10 risk slice could exclude an item with
    // ONE nearly-perfect reversal because 10 noisier items outscored it).
    // `limit` is part of the cache key (extra) → this forks a fresh
    // q-flip-rank entry; sv stays 2 (row shape unchanged).
    needFlip ? cachedSharedQuery(
      'q-flip-rank',
      // REFINE-2: sv — row shape gained `satuan` (the flip section's "Satuan"
      // column); see the q-variance note in ./record-guard.ts.
      { month, week, filters: filterOpts, extra: { limit: 200, weekLabel: week, sv: 2 } },
      () => queryFlipRanking(filterOpts, week, month, 200),
    ) : Promise.resolve(null),
    // REFINE-1 — per-(item, area) category averages (current period).
    // Scoped by area ONLY: the benchmark is the whole area population
    // ("rata-rata area di mana resto itu berada"), independent of the
    // outlet/pic/kelompok filters the report itself runs under.
    needTopItems ? cachedSharedQueryMap(
      'q-area-catavg',
      { month, week, filters: { area: filterOpts.area }, extra: {} },
      () => queryAreaCategoryAvg(week, month, filterOpts.area),
    ) : Promise.resolve(new Map<string, AreaCategoryAvg>()),
    // VAR12 — section 6.3 "Analisis Pola Item" (renumbered 7.3 by W10):
    // the full pattern ranking
    // (ALL items with a deviation in the period — the query has no limit
    // param; the PDF section slices its own top rows). Gated on the
    // anomali section because 7.3 renders inside section 7.
    needAnomali ? queryItemConsistency(week, month, filterOpts) : Promise.resolve([]),
    // W10 — section 5 "Analisis Waste": the queryWasteNetwork projection
    // under its own q-* row (30-min TTL, mutation-invalidated via the
    // 'q-waste-network' prefix in invalidateAnalysisCache — see
    // aggregation-cache/invalidate.ts). Key notes:
    //   - month = the EXPORTED month: it bounds the 12-month same-week
    //     window INCLUSIVELY (queryWasteNetwork's currentMonthKey — same
    //     semantics as /api/waste-series).
    //   - itemName is stripped (the waste network is outlet-grain — same
    //     convention as q-item-trend-matrix's filters).
    //   - sv 1 forks a fresh namespace for the projected row shape.
    //   - The computeFn caches ONLY the W10 projection (months + kpis +
    //     attribution): the full result's monthly/outlets arrays (~MBs of
    //     JSON) stay in the /api/waste-series route's own 5-min cache —
    //     the q-row keeps repeat exports cheap without duplicating them.
    needWaste ? cachedSharedQuery<WasteSectionData>(
      'q-waste-network',
      { month, week, filters: { ...filterOpts, itemName: null }, extra: { weekLabel: week, sv: 1 } },
      async () => {
        // currentMonthKey from the setup phase's monthLabel→monthKey map
        // (the same lookup /api/waste-series does via sourceFile.findFirst;
        // the month label case was already resolved). Null = no upper bound
        // — unreachable in practice: the 404 guard proved the month exists.
        const currentMonthKey = ctx.monthKeyByLabel.get(month) ?? null;
        const r = await queryWasteNetwork(
          week,
          currentMonthKey,
          { ...filterOpts, itemName: null },
          thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
        );
        return { months: r.months, kpis: r.kpis, attribution: r.attribution };
      },
    ) : Promise.resolve(null),
  ]);

  ctx.kpis = kpis;
  ctx.prevSummary = prevSummary;
  ctx.topNominal = topNominal;
  ctx.topDevBom = topDevBom;
  ctx.topCategories = topCategories;
  ctx.prevTopCategories = prevTopCategories;
  ctx.trendAggRows = trendAggRows;
  ctx.histWasteMap = histWasteMap;
  ctx.histSusutMap = histSusutMap;
  ctx.histTrialMap = histTrialMap;
  ctx.histLossSurplusMap = histLossSurplusMap;
  ctx.itemTrendMatrixRes = itemTrendMatrixRes;
  ctx.selfAnomalyRes = selfAnomalyRes;
  ctx.weeklyCompRes = weeklyCompRes;
  ctx.flipRankingRes = flipRankingRes;
  ctx.areaCatAvgMap = areaCatAvgMap;
  ctx.consistencyRows = consistencyRows;
  ctx.wasteRes = wasteRes;
}
