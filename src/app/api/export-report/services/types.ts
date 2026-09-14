// ============================================================
//  Types & shared utilities for /api/export-report service modules
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  EXPORT-PDF: the output format switched .docx → .pdf (pdf-builder.ts);
//  DocxContext renamed → ReportContext.
//
//  EXPORT-TRIM (user request): report trimmed 13 → 6 sections —
//  GrowthMetrics / BreakdownEnriched / DeviationCost / CoverageInfo and the
//  ReportData fields they fed (growthComparison / deviationBreakdown /
//  deviationCost / areaAnalysis / outletRanking / coverage / paretoItem /
//  paretoOutlet / flipRanking / peerComparison) were removed together with
//  their sections (verified 0 reads in pdf-builder.ts).
//
//  Contains:
//    - PrevMetrics + ExecSummaryWithPrev (helper-types for the
//      ExecutiveSummary._prevMetrics extension used only by this route)
//    - ReportParams (input to fetchReportData — parsed URL params)
//    - ReportData (output of fetchReportData — drives pdf-builder)
//    - ReportContext (auxiliary state passed to buildPdfReport that
//      doesn't belong in ReportData — section filter + historicalPeriods
//      for the header "Hist (Jan-Jul 26)" label)
//    - Derived row shapes (TopCatItem*, TrendRow)
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
import type { ItemTrendMatrixRow } from '@/lib/queries/items/item-trend-matrix';

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

// ============================================================
// ReportData — the full data object built by fetchReportData
//  --------------------------------------------------------
//  SQL-return fields use `Awaited<ReturnType<typeof ...>>` so a signature
//  drift in the underlying query surfaces here as a tsc error.
//
//  FIX (BUG-3-a P2): fields for sections that were NOT selected hold
//  zero-value placeholders (null kpis / empty arrays) — the builder's
//  hasSection() gates rendering with the SAME `sections` list that gated
//  the fetch, so a placeholder is never rendered.
//
//  EXPORT-TRIM (user request): trimmed 13 → 6 sections. Removed fields:
//  growthComparison (dead in pdf-builder — the growth section reads
//  executiveSummary directly), deviationBreakdown + deviationCost
//  ('breakdown'), areaAnalysis ('area'), outletRanking ('outlets'),
//  paretoItem/paretoOutlet ('pareto'), flipRanking ('flip'),
//  peerComparison ('peer'), coverage ('coverage').
// ============================================================
export interface ReportData {
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  // FIX (BUG-KELOMPOK-GLOBAL): include kelompok in response filters
  // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
  filters: { area: string | null; kelompok: string | null; outletCode: string | null; itemName: string | null; pic: string | null };
  executiveSummary: ExecSummaryWithPrev;
  topItemsByNominal: TopItemByNominalRow[];
  topItemsByDevBom: TopItemByDevBomRow[];
  topItemsByWaste: TopCatItemWaste[];
  topItemsBySusut: TopCatItemSusut[];
  topItemsByTrial: TopCatItemTrial[];
  topItemsByLossSurplus: TopCatItemLossSurplus[];
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  trend: TrendRow[];
  // EXPORT-PDF — section 'itemTrend': per-(month × item) rows ([] when off).
  itemTrendMatrix: ItemTrendMatrixRow[];
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
