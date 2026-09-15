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
//       pdf-builder.ts, `?sections=` now gates the FETCHING too
//       (EXPORT-TRIM: 6 sections remain):
//         exec / growth → q-kpis (+ prev q-exec-summary for the growth
//                          columns) — also feeds the cover KPI cards
//         topItems      → q-top-nominal + q-top-devbom + q-topcat +
//                         prev q-topcat (limit 100) + 4× q-hist-catavg
//         variance      → q-variance
//         itemTrend     → q-item-trend-matrix
//         trend         → q-trend
//   11. Build prev lookup maps + enrich topWaste/Susut/Trial/LossSurplus
//   12. Build execSummary + trend
//   13. Assemble ReportData + ReportContext, return both
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
// ============================================================
//  SPLIT-A (god-file split, pure code motion): this file was 819
//  lines — fetchReportData's monolithic body. It is now the slim
//  orchestrator; the body moved verbatim into ./data-fetcher/:
//     ./data-fetcher/section-gates.ts  — ALL_EXPORT_SECTIONS +
//                                       SectionGates (the ?sections=
//                                       need-flags)
//     ./data-fetcher/context.ts        — FetcherContext + SetupFields +
//                                       createFetcherContext (the
//                                       pipeline's shared state)
//     ./data-fetcher/setup.ts          — resolvePipelineSetup
//                                       (responsibilities 1-8)
//     ./data-fetcher/record-guard.ts   — ensureRecordsExist
//                                       (responsibility 9 + q-variance)
//     ./data-fetcher/query-batch.ts    — runSectionQueryBatch
//                                       (responsibility 10 — the single
//                                       parallel wave, entry order kept)
//     ./data-fetcher/derive.ts         — deriveReportFields
//                                       (responsibilities 11-12)
//     ./data-fetcher/peer.ts           — fetchPeerComparison (section 8's
//                                       serial dependent wave)
//     ./data-fetcher/assemble.ts       — assembleReport
//                                       (responsibility 13)
//  Import path unchanged: route.ts still imports fetchReportData from
//  './services/data-fetcher'. Zero behavior change — every await, SQL
//  call, cache key and cache-version constant (sv) sits at the same
//  pipeline position as before the split.
// ============================================================
import type { ReportParams, FetchedReport } from './types';
import { resolvePipelineSetup } from './data-fetcher/setup';
import { ensureRecordsExist } from './data-fetcher/record-guard';
import { runSectionQueryBatch } from './data-fetcher/query-batch';
import { deriveReportFields } from './data-fetcher/derive';
import { fetchPeerComparison } from './data-fetcher/peer';
import { assembleReport } from './data-fetcher/assemble';

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
  // Setup — thresholds, PIC/kelompok outlet resolution, period tables,
  // month-case resolution, compare period + historicalPeriods (pure
  // preamble; mutates nothing downstream).
  const ctx = await resolvePipelineSetup(params);

  // 404 short-circuit wave — the FIRST data query for every sections
  // combination (throws EarlyHttpResponse when the current period has
  // 0 records); the q-variance fetch shares the wave.
  await ensureRecordsExist(ctx);

  // The single parallel wave of section-gated queries (FIX BUG-3-a P2 /
  // H-8 QUICK WIN 2 pattern) — one Promise.all, original entry order.
  await runSectionQueryBatch(ctx);

  // Post-batch shaping — top-items enrichment (3.3-3.6), execSummary
  // (1-2), trend rows + weekly-composition slicing (7). Pure, no awaits.
  const derived = deriveReportFields(ctx);

  // Peer comparison — the one intentionally-serial dependent wave
  // (auto-target scan → q-peer-cmp → q-peer-cmp-items); null when the
  // section is off or the target is unresolvable.
  const peerComparison = await fetchPeerComparison(ctx);

  // Assemble ReportData + ReportContext.
  return assembleReport(ctx, derived, peerComparison);
}
