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
//      doesn't belong in ReportData — section filter +
//      historicalPeriods for the header "Hist (Jan-Jul 26)" label)
//    - Derived row shapes (TopCatItem*, BreakdownEnriched, TrendRow,
//      GrowthMetrics)
//
//  FIX (BUG-3-a P1) — dead shapes removed together with the dead compute
//  that fed them (verified 0 reads in docx-builder.ts): AreaAnalysisMappedRow
//  (q-area), HistCriticalItem + GrowthComparisonWithHist.historicalAnalysis
//  (q-hist-critical / q-hist-stats), GrowthMetrics.multiPeriodComparison,
//  and DocxContext's thresholds/sqlFlags/month/week/prevWeek/prevMonth (the
//  "5.1 BOM-korelasi" per-record table that consumed them was removed by an
//  earlier user request; growthComparison is now the plain GrowthMetrics
//  object the Section 2 table actually renders).
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
export interface TrendRow {
  weekLabel: string;
  devBom: number;
  sales: number;
  nominal: number;
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

// ============================================================
//  ReportData — the full data object built by fetchReportData
//  --------------------------------------------------------
//  Shape mirrors the `data` literal built at route.ts:651-667 verbatim,
//  minus the dead fields removed by FIX (BUG-3-a P1) — see the file header.
//  SQL-return fields use `Awaited<ReturnType<typeof ...>>` so a signature
//  drift in the underlying query surfaces here as a tsc error.
//
//  FIX (BUG-3-a P2): fields for sections that were NOT selected hold
//  zero-value placeholders (null kpis / empty arrays) — docx-builder's
//  hasSection() gates rendering with the SAME `sections` list that gated
//  the fetch, so a placeholder is never rendered.
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
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  trend: TrendRow[];
  durationMs: number;
}

// ============================================================
//  DocxContext — auxiliary state passed to buildDocxReport
//  --------------------------------------------------------
//  Contains everything the docx-builder needs that is NOT part of the
//  ReportData object itself:
//    - sections:           URL `?sections=` filter (null = all sections;
//                          [] = no section — header-only document)
//    - historicalPeriods:  for the "Hist (Jan-Jul 26)" range label
//  FIX (BUG-3-a P1): thresholds / sqlFlags / month / week / prevWeek /
//  prevMonth removed — their only consumer was the deleted "5.1 BOM
//  correlation" per-record table; docx-builder reads the period labels
//  from data.period instead.
// ============================================================
export interface DocxContext {
  sections: string[] | null;
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }>;
}

// Shape returned by fetchReportData — the data object + auxiliary docx context.
export interface FetchedReport {
  data: ReportData;
  ctx: DocxContext;
}
