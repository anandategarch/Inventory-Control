// ============================================================
//  Types & shared utilities for /api/export-report service modules
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  EXPORT-PDF: the output format switched .docx → .pdf (pdf-builder.ts);
//  DocxContext renamed → ReportContext. The report grew 9 → 13 sections
//  (+ pareto / itemTrend / flip / peer).
//
//  Contains:
//    - PrevMetrics + ExecSummaryWithPrev (helper-types for the
//      ExecutiveSummary._prevMetrics extension used only by this route)
//    - ReportParams (input to fetchReportData — parsed URL params)
//    - ReportData (output of fetchReportData — drives pdf-builder)
//    - ReportContext (auxiliary state passed to buildPdfReport that
//      doesn't belong in ReportData — section filter + historicalPeriods
//      for the header "Hist (Jan-Jul 26)" label)
//    - Derived row shapes (TopCatItem*, BreakdownEnriched, TrendRow,
//      GrowthMetrics)
//
//  FIX (BUG-3-a P1) — dead shapes removed together with the dead compute
//  that fed them (verified 0 reads in the builder): AreaAnalysisMappedRow
//  (q-area), HistCriticalItem + GrowthComparisonWithHist.historicalAnalysis
//  (q-hist-critical / q-hist-stats), GrowthMetrics.multiPeriodComparison.
//
//  H-12: the EarlyHttpResponse class moved to the shared module
//  src/lib/early-http-response.ts (was defined verbatim 3×) — import it
//  from there.
//
//  SQL query return types are imported via `Awaited<ReturnType<typeof
//  import(...).queryX>>` — type-only, no runtime coupling. Mirrors
//  outlet-items/services/types.ts:15 (TopDeviasiRankPromise pattern).
// ============================================================
import type { ExecutiveSummary } from '@/types/inventory';
import type { queryVarianceAnalysis } from '@/lib/queries/health-ranking';
import type { queryOutletHealthRanking } from '@/lib/queries/health-ranking';
import type { queryAreaAnalysis } from '@/lib/queries/areas';
import type { FlipRankResult } from '@/lib/queries/items/flip-ranking';
import type { ItemTrendMatrixRow } from '@/lib/queries/items/item-trend-matrix';
import type { ParetoResult } from '@/lib/queries/pareto';
import type { PeerComparisonRow } from '@/lib/queries/outlets/peer-comparison';

// PERF-CACHE-06: helper used to short-circuit the cache wrapper for early-return
// error paths (404 No records found). Throwing this error propagates through
// withCacheAndDedup's rejectComputation (so concurrent in-flight awaiters also
// see the error) and is caught by the outer try/catch which returns the response.
// Without this, the computeFn's return type would be a union (NextResponse |
// { buffer, fileName }) and the cache wrapper couldn't store the result.
//
// H-12: relocated to src/lib/early-http-response.ts — identical pattern to
// analysis + outlet-items + item-history routes, now ONE definition.

/**
 * Shape of the 6 prev-period metrics attached to ExecutiveSummary for the
 * Word export's growth column (FIX: was `as any` cast at every access site).
 *
 * Relocated verbatim from route.ts:111-123.
 */
export interface PrevMetrics {
  totalLoss: number | null;
  totalSurplus: number | null;
  lossToSales: number | null;
  surplusToSales: number | null;
  deviationToBom: number | null;
  residualLossQty: number | null;
  residualLossPct: number | null;
}

/** Executive summary shape used by the export route (extends base type with _prevMetrics). */
export type ExecSummaryWithPrev = ExecutiveSummary & { _prevMetrics: PrevMetrics | null };

// ============================================================
//  ReportParams — parsed URL params passed into fetchReportData
//  --------------------------------------------------------
//  All fields come from `url.searchParams.get(...)` in route.ts.
//  `startedAt` is captured at the top of GET() so durationMs reflects
//  the full request wall-clock time (not just the computeFn body).
//
//  FIX (BUG-3-a C4): `sections` semantics — null (param absent) = ALL
//  sections; [] (empty param, e.g. `?sections=`) = NO section active
//  (header-only document).
// ============================================================
export interface ReportParams {
  monthParam: string;
  week: string;
  area: string | null;
  outletCode: string | null;
  itemName: string | null;
  pic: string | null;
  kelompok: string | null;
  userCompareWeek: string | null;
  userCompareMonth: string | null;
  sections: string[] | null;
  startedAt: number;
}

// ============================================================
//  Derived row shapes (used by ReportData)
// ============================================================

// queryTopItemsByNominal return shape (explicit Promise<...> signature in
// src/lib/queries/items/top-items/by-other-metric.ts:27).
// H-2b: `satuan` (MAX(ir."satuan") — nullable, GROUP BY-safe) flows through
// for the "Satuan" column in the docx top-item tables.
export interface TopItemByNominalRow {
  itemName: string;
  outletCode: string;
  satuan?: string | null;
  absNominal: number;
  nominalDeviasi: number;
  direction: string;
}

// queryTopItemsByDevBom return shape (by-other-metric.ts:57). H-2b: satuan.
export interface TopItemByDevBomRow {
  itemName: string;
  outletCode: string;
  satuan?: string | null;
  devBom: number;
  devBomAbs: number;
  tolerance: number | null;
}

// Derived from queryTopItemsByAllCategories('waste') output via the
// .map() at route.ts:556-561 — adds prevQty + histAvgQty from lookup maps.
// H-2b: satuan (unit of measure) for the "Satuan" column in the docx table.
export interface TopCatItemWaste {
  itemName: string;
  outletCode: string;
  satuan?: string | null;
  qtyWaste: number;
  nominalWaste: number;
  prevQty: number | null;
  histAvgQty: number | null;
}

export interface TopCatItemSusut {
  itemName: string;
  outletCode: string;
  satuan?: string | null;
  qtySusut: number;
  nominalSusut: number;
  prevQty: number | null;
  histAvgQty: number | null;
}

export interface TopCatItemTrial {
  itemName: string;
  outletCode: string;
  satuan?: string | null;
  qtyTrial: number;
  nominalTrial: number;
  prevQty: number | null;
  histAvgQty: number | null;
}

export interface TopCatItemLossSurplus {
  itemName: string;
  outletCode: string;
  satuan?: string | null;
  qtyLossSurplus: number;
  nominalLossSurplus: number;
  direction: string;
  prevQty: number | null;
  histAvgQty: number | null;
}

// breakdownEnriched — derived at route.ts:581-582 from queryDeviationBreakdown
// output. Adds explained (sum) + explainedPct + netPct.
export interface BreakdownEnriched {
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  total: number;
  explained: number;
  explainedPct: number | null;
  netPct: number | null;
}

// trend row — derived at route.ts:600-603 from trendAggRows (queryTrendAgg).
// `sortKey` is stripped by the destructure `({ sortKey, ...rest }) => rest`.
// EXPAND-1: + lossNominal / surplusNominal (TrendAggRow already carries them —
// they were dropped by the old mapping) for the Trend section's Loss/Surplus
// columns. qtyBom kept optional for future use.
export interface TrendRow {
  weekLabel: string;
  devBom: number;
  sales: number;
  nominal: number;
  lossNominal: number;
  surplusNominal: number;
}

// Growth metrics object (route.ts:586-592) — the Section 2 "Perubahan
// (Growth)" table payload. FIX (BUG-3-a P1): `multiPeriodComparison` removed
// (verified 0 reads in docx-builder.ts — the analysis payload keeps its own
// copy for the frontend; the export computed it on every run for nothing).
export interface GrowthMetrics {
  salesGrowth: number | null;
  bomGrowth: number | null;
  qtyDeviasiGrowth: number | null;
  nominalDeviasiGrowth: number | null;
  // USER-POLISH: Section 2 "Perubahan (Growth)" additions — single MoM step,
  // same calcGrowth values the Section 1 rows render.
  qtyWasteGrowth: number | null;
  qtySusutGrowth: number | null;
  qtyTrialGrowth: number | null;
  deviationToSalesRatio: number | null;
  deviationToBomRatio: number | null;
}

// EXPAND-1 — nominal (cost) composition + record counts, derived from the
// same q-kpis row that feeds deviationBreakdown (DashboardKpisRow already
// carries wasteCost/susutCost/trialCost/residualCost/totalCost/lossCount/
// surplusCount). Zero-value when the kpis sections are all off.
export interface DeviationCost {
  wasteCost: number;
  susutCost: number;
  trialCost: number;
  residualCost: number;
  totalCost: number;
  lossCount: number;
  surplusCount: number;
}

// EXPAND-1 — Lampiran: Cakupan Data & Filter. outletCount/itemCount come from
// ONE raw COUNT(DISTINCT) scan (null when the coverage section is off);
// recordCount reuses the 404-check COUNT; periodCount/historicalPeriodCount
// come from the already-loaded weeks metadata; generatedAt is captured at
// fetch time (the route-level 5-min cache pins it to the cache-write moment).
export interface CoverageInfo {
  recordCount: number;
  outletCount: number | null;
  itemCount: number | null;
  periodCount: number;
  historicalPeriodCount: number;
  generatedAt: string;
}

// ============================================================
// ReportData — the full data object built by fetchReportData
//  --------------------------------------------------------
//  Shape mirrors the `data` literal built at route.ts:651-667 verbatim,
//  minus the dead fields removed by FIX (BUG-3-a P1) — see the file header.
//  SQL-return fields use `Awaited<ReturnType<typeof ...>>` so a signature
//  drift in the underlying query surfaces here as a tsc error.
//
//  FIX (BUG-3-a P2): fields for sections that were NOT selected hold
//  zero-value placeholders (null kpis / empty arrays) — the builder's
//  hasSection() gates rendering with the SAME `sections` list that gated
//  the fetch, so a placeholder is never rendered.
//
//  EXPAND-1: + areaAnalysis (q-area — SAME shared cache id as the analysis
//  pipeline's Area tab), outletRanking (queryOutletHealthRanking, which rides
//  the shared q-outlet-agg cached scan), deviationCost (from the same q-kpis
//  row as deviationBreakdown), coverage (Lampiran metadata).
//
//  EXPORT-PDF: + paretoItem/paretoOutlet (q-pareto-item / q-pareto-outlet),
//  itemTrendMatrix (q-item-trend-matrix), flipRanking (q-flip-rank),
//  peerComparison (q-peer-cmp + resolved target outlet — the outletCode
//  param, or auto top-1 resto prioritas when no outlet filter is active).
// ============================================================
export interface ReportData {
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  // FIX (BUG-KELOMPOK-GLOBAL): include kelompok in response filters
  // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
  filters: { area: string | null; kelompok: string | null; outletCode: string | null; itemName: string | null; pic: string | null };
  executiveSummary: ExecSummaryWithPrev;
  growthComparison: GrowthMetrics;
  topItemsByNominal: TopItemByNominalRow[];
  topItemsByDevBom: TopItemByDevBomRow[];
  topItemsByWaste: TopCatItemWaste[];
  topItemsBySusut: TopCatItemSusut[];
  topItemsByTrial: TopCatItemTrial[];
  topItemsByLossSurplus: TopCatItemLossSurplus[];
  deviationBreakdown: BreakdownEnriched;
  deviationCost: DeviationCost;
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  trend: TrendRow[];
  areaAnalysis: Awaited<ReturnType<typeof queryAreaAnalysis>>;
  outletRanking: Awaited<ReturnType<typeof queryOutletHealthRanking>>;
  coverage: CoverageInfo | null;
  // EXPORT-PDF — section 'pareto': item-level + outlet-level Pareto
  // (zero-value placeholders when the section is off).
  paretoItem: ParetoResult;
  paretoOutlet: ParetoResult;
  // EXPORT-PDF — section 'itemTrend': per-(month × item) rows ([] when off).
  itemTrendMatrix: ItemTrendMatrixRow[];
  // EXPORT-PDF — section 'flip': top flip-risk items ({ items: [],
  // totalItemsScanned: 0 } when off).
  flipRanking: FlipRankResult;
  // EXPORT-PDF — section 'peer': target outlet vs similar-sales peers.
  // null when the section is off OR no peer data could be computed.
  peerComparison: {
    targetOutlet: { code: string; name: string; area: string };
    /** true when the target was auto-picked (top-1 Resto Prioritas) because no outlet filter was active. */
    autoTarget: boolean;
    targetSales: number;
    peers: PeerComparisonRow[];
  } | null;
  durationMs: number;
}

// ============================================================
//  ReportContext — auxiliary state passed to buildPdfReport
//  --------------------------------------------------------
//  EXPORT-PDF: renamed from DocxContext (output switched .docx → .pdf).
//  Contains everything the pdf-builder needs that is NOT part of the
//  ReportData object itself:
//    - sections:           URL `?sections=` filter (null = all sections;
//                          [] = no section — cover-only document)
//    - historicalPeriods:  for the "Hist (Jan-Jul 26)" range label
// ============================================================
export interface ReportContext {
  sections: string[] | null;
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }>;
}

// Shape returned by fetchReportData — the data object + auxiliary report context.
export interface FetchedReport {
  data: ReportData;
  ctx: ReportContext;
}
