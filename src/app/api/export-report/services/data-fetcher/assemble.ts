// ============================================================
//  assemble — assembleReport (final ReportData + ReportContext)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:773-818). Builds the
//  ReportData payload + the auxiliary ReportContext and returns
//  the FetchedReport pair. The only mechanical change: the local
//  `ctx` (ReportContext) is renamed `reportCtx` to avoid shadowing
//  the FetcherContext parameter.
// ============================================================
import type {
  ReportData,
  ReportContext,
  FetchedReport,
  PeerComparisonData,
} from '../types';
import type { FetcherContext } from './context';
import type { DerivedReportFields } from './derive';

export function assembleReport(
  ctx: FetcherContext,
  derived: DerivedReportFields,
  peerComparison: PeerComparisonData | null,
): FetchedReport {
  const {
    month, prevWeek, prevMonth, historicalPeriods, varianceAnalysis,
    topNominal, topDevBom, itemTrendMatrixRes, selfAnomalyRes, flipRankingRes,
  } = ctx;
  const { week, area, kelompok, outletCode, itemName, pic, sections, startedAt } = ctx.params;
  const { topWaste, topSusut, topTrial, topLossSurplus, execSummary, trend, weeklyComposition } = derived;

  // (EXPORT-TRIM: the outletRanking fetch + the EXPAND-1 comment blocks that
  // explained it were removed with the 'outlets' section; the peer section's
  // auto-target fallback went with the 'peer' section.)
  const data: ReportData = {
    period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
    // FIX (BUG-KELOMPOK-GLOBAL): include kelompok in response filters
    // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
    filters: { area, kelompok, outletCode, itemName, pic },
    executiveSummary: execSummary,
    topItemsByNominal: topNominal, topItemsByDevBom: topDevBom,
    topItemsByWaste: topWaste, topItemsBySusut: topSusut, topItemsByTrial: topTrial, topItemsByLossSurplus: topLossSurplus,
    varianceAnalysis,
    trend,
    // EXPORT-PDF — section 'itemTrend' ([] placeholder when off; never
    // rendered — the builder gates on the SAME sections list that gated
    // the fetch).
    itemTrendMatrix: itemTrendMatrixRes?.rows ?? [],
    // REFINE-3 — section 'anomali' ([] when off / no historical periods).
    // REFINE-4: + flipRows (direction reversal vs own history) — sv bumped
    // 1 → 2 for the changed row shape (histSignedAvgQty/flip fields +
    // absolute histAvgQty + magnitude deltaQty semantics).
    selfHistoryAnomaly: selfAnomalyRes?.rows ?? [],
    selfHistoryFlips: selfAnomalyRes?.flipRows ?? [],
    // REFINE-3 — weekly composition rows for the trend section's
    // composition + accumulation charts ([] when the trend section is off).
    weeklyComposition,
    // REFINE-1 — section 'peer' (null when off / target unresolvable).
    peerComparison,
    // REFINE-1 — section 'flip' (null when off).
    flipRanking: flipRankingRes,
    durationMs: Date.now() - startedAt,
  };

  // ReportContext — auxiliary state needed by buildPdfReport (EXPORT-PDF:
  // renamed from DocxContext when the output switched .docx → .pdf). Kept
  // separate from ReportData so the cache payload (only `{ buffer,
  // fileName }`) stays clean. FIX (BUG-3-a P1): thresholds + sqlFlags + the
  // period labels were removed — their only consumer was the deleted
  // "5.1 BOM-correlation" per-record table; the builder reads period labels
  // from data.period and the historical range from historicalPeriods.
  const reportCtx: ReportContext = {
    sections,
    historicalPeriods,
  };

  return { data, ctx: reportCtx };
}
