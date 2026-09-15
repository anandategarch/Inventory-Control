// ============================================================
//  Change Analysis — "Rata-rata Perubahan" (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  User-approved feature: rank outlets whose CURRENT period-over-
//  period deviation move strays from their OWN average move, then
//  attribute the move to items ("item apa yang buat dia
//  menyimpang?").
//
//  SEMANTICS (mirrors the A2 z-score baseline conventions):
//   - SAME-WEEK chain only. Weeks are cumulative MTD snapshots
//     (W1=1-7 … W4=1-25), so the only valid Δ is the SAME
//     weekLabel ACROSS months (W4 Jul → W4 Agu) — never W1 → W2
//     in-month (that is fake growth; historical-baseline.ts
//     header). The query pins ir."weekLabel" = week.
//   - Window = every DB month with sf."monthKey" <= currentMonthKey
//     (INCLUDES the running month — it is the value under
//     evaluation — and excludes future months in one comparison,
//     the BUG2-PARETO-1 correct form).
//   - The CURRENT pair (previous snapshot → current snapshot) is
//     the evaluated value; the BASELINE = the pairs BEFORE it
//     (mirrors metrics/historical.ts "exclude current" — the
//     evaluated change must not dilute its own baseline).
//   - MOVEMENT ("gerak") = swing = |V_now − V_prev| on the SIGNED
//     sums (captures full LOSS↔SURPLUS swings), averaged as |Δ|.
//   - DISPLAY delta = magnitude change |V_now| − |V_prev|
//     (audit #11 / computeNominalDeviationGrowth — positive =
//     deviation GREW (memburuk), negative = shrank (membaik);
//     sign flips carry isFlip so a LOSS→SURPLUS swing is never
//     read as "improvement" without its ↺ marker).
//   - nominalDeviasi + qtyDeviasi are genuine per-row data → sums
//     are additive at every grouping level (TASK H-7 lesson), so
//     the outlet series in the items query is derived by summing
//     the item series (no second query).
//   - Item participation: an item joins the breakdown iff it has
//     rows in the current month OR in the outlet's previous DB
//     month (vanished items close their story; long-dormant items
//     do not resurrect old news).
//
//  Thresholds are RUNTIME (Settings, CHANGE_* keys — settings.ts);
//  a Settings mutation invalidates the route cache entry via
//  invalidateAnalysisCache ('change-analysis*' prefixes), so no
//  threshold fingerprint is needed in the cache key.
// ============================================================
// ============================================================
//  SPLIT-E module map (pure code motion — this file is now a
//  thin barrel; the implementation lives in sibling modules
//  grouped by concern; SQL, comments and behavior preserved
//  verbatim):
//    ./change-analysis-stats.ts             — computeChangeStats,
//                                              classifyChange
//                                              (+ ChangeSeriesPoint,
//                                              ChangeStats,
//                                              ChangeThresholds,
//                                              ChangeStatus)
//    ./change-analysis-outlet-ranking.ts    — queryOutletChangeAnalysis
//                                              (+ OutletChangeRow,
//                                              ChangeAnalysisResult)
//    ./change-analysis-item-attribution.ts  — queryOutletChangeItems
//                                              (+ ItemChangeRow,
//                                              ChangeAnalysisItemsResult)
//    ./change-analysis-context.ts           — resolveChangeAnalysisContext
//  Every public symbol keeps its exact old export name — imports
//  from '@/lib/queries/outlets/change-analysis' are unchanged.
// ============================================================
export { computeChangeStats, classifyChange } from './change-analysis-stats';
export type { ChangeSeriesPoint, ChangeStats, ChangeThresholds, ChangeStatus } from './change-analysis-stats';
export { queryOutletChangeAnalysis } from './change-analysis-outlet-ranking';
export type { OutletChangeRow, ChangeAnalysisResult } from './change-analysis-outlet-ranking';
export { queryOutletChangeItems } from './change-analysis-item-attribution';
export type { ItemChangeRow, ChangeAnalysisItemsResult } from './change-analysis-item-attribution';
export { resolveChangeAnalysisContext } from './change-analysis-context';
