// ============================================================
//  Types & shared utilities for /api/export-report service modules
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  Contains:
//    - PrevMetrics + ExecSummaryWithPrev (helper-types for the
//      ExecutiveSummary._prevMetrics extension used only by this route)
//    - ReportParams (input to fetchReportData — parsed URL params)
//    - ReportData (output of fetchReportData — drives docx-builder)
//    - DocxContext (auxiliary state passed to buildDocxReport that
//      doesn't belong in ReportData — section filter, historicalPeriods
//      for label rendering, thresholds + sqlFlags + period labels for
//      the BOM-correlation per-record table)
//    - Derived row shapes (TopCatItem*, BreakdownEnriched,
//      AreaAnalysisMappedRow, TrendRow, HistCriticalItem,
//      GrowthMetrics, GrowthComparisonWithHist)
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
import type { RuntimeThresholds } from '@/lib/settings';
import type { SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { queryVarianceAnalysis } from '@/lib/queries/health-ranking';

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

// areaAnalysis mapped row — derived at route.ts:662 from queryAreaAnalysis
// output. Same fields, just narrowed to the 6 the export cares about.
export interface AreaAnalysisMappedRow {
  area: string;
  outletCount: number;
  totalSales: number;
  totalAbsNominal: number;
  avgDevBom: number;
  lossToSales: number | null;
}

// trend row — derived at route.ts:600-603 from trendAggRows (queryTrendAgg).
// `sortKey` is stripped by the destructure `({ sortKey, ...rest }) => rest`.
export interface TrendRow {
  weekLabel: string;
  devBom: number;
  sales: number;
  nominal: number;
}

// Per-row shape inside growthComparison.historicalAnalysis.criticalItems
// (built at route.ts:612-630 — maps queryHistoricalCriticalItems output
// + computes zScore via calcZScoreFromStats).
export interface HistCriticalItem {
  itemName: string;
  outletCode: string;
  area: string;
  currentDevBom: number;
  historicalAvg: number;
  zScore: number;
  absNominal: number;
  currentWaste: number;
  currentSusut: number;
  currentTrial: number;
}

// Growth metrics object (route.ts:586-592). `multiPeriodComparison` is
// typed as `Array<Record<string, unknown>>` in the original (route.ts:591)
// — preserved here for byte-identical type behavior.
export interface GrowthMetrics {
  salesGrowth: number | null;
  bomGrowth: number | null;
  qtyDeviasiGrowth: number | null;
  nominalDeviasiGrowth: number | null;
  deviationToSalesRatio: number | null;
  deviationToBomRatio: number | null;
  multiPeriodComparison: Array<Record<string, unknown>>;
}

export interface GrowthComparisonWithHist extends GrowthMetrics {
  historicalAnalysis: { criticalItems: HistCriticalItem[] };
}

// ============================================================
//  ReportData — the full data object built by fetchReportData
//  --------------------------------------------------------
//  Shape mirrors the `data` literal built at route.ts:651-667 verbatim.
//  SQL-return fields use `Awaited<ReturnType<typeof ...>>` so a signature
//  drift in the underlying query surfaces here as a tsc error.
// ============================================================
export interface ReportData {
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  // FIX (BUG-KELOMPOK-GLOBAL): include kelompok in response filters
  // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
  filters: { area: string | null; kelompok: string | null; outletCode: string | null; itemName: string | null; pic: string | null };
  executiveSummary: ExecSummaryWithPrev;
  growthComparison: GrowthComparisonWithHist;
  topItemsByNominal: TopItemByNominalRow[];
  topItemsByDevBom: TopItemByDevBomRow[];
  topItemsByWaste: TopCatItemWaste[];
  topItemsBySusut: TopCatItemSusut[];
  topItemsByTrial: TopCatItemTrial[];
  topItemsByLossSurplus: TopCatItemLossSurplus[];
  deviationBreakdown: BreakdownEnriched;
  areaAnalysis: AreaAnalysisMappedRow[];
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  trend: TrendRow[];
  durationMs: number;
}

// ============================================================
//  DocxContext — auxiliary state passed to buildDocxReport
//  --------------------------------------------------------
//  Contains everything the docx-builder needs that is NOT part of the
//  ReportData object itself:
//    - sections:           URL `?sections=` filter (null = all sections)
//    - historicalPeriods:  for the "Hist (Jan-Jul 26)" range label
//    - thresholds:         for BOM_DISPROPORTIONATE_FACTOR + BOM_DEVIATION_FACTOR
//    - sqlFlags:           for the 5.1 BOM-correlation per-record table
//    - month/week/prevWeek/prevMonth: for the bomKeys InventoryRecord lookup
//      (current + prev period records matched by outletId+itemId+akun)
// ============================================================
export interface DocxContext {
  sections: string[] | null;
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }>;
  thresholds: RuntimeThresholds;
  sqlFlags: SqlRuleFlag[];
  month: string;
  week: string;
  prevWeek: string | null;
  prevMonth: string | null;
}

// Shape returned by fetchReportData — the data object + auxiliary docx context.
export interface FetchedReport {
  data: ReportData;
  ctx: DocxContext;
}
