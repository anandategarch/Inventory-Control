// ============================================================
//  post-process-growth — Sub-step 2: buildGrowthMetrics
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    1. Compute growth metrics (salesGrowth, bomGrowth, qtyDeviasiGrowth,
//       nominalDeviasiGrowth, deviationToSalesRatio, deviationToBomRatio).
//    2. Aggregate DQ issue severity counts (ERROR/WARNING/INFO).
//    3. Delegate trend / multiPeriodComparison / netCostTrend to
//       services/trend-builder.ts (Phase 3 extraction).
// ============================================================
import { computeNominalDeviationGrowth } from '@/lib/metrics';
import { buildTrend, buildMultiPeriodComparison, buildNetCostTrend } from './trend-builder';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { ProcessedData } from './post-process-types';

/**
 * Sub-step 2 — build growth metrics + DQ severity counts + trend artifacts.
 */
export function buildGrowthMetrics(
  execSummary: QueryResults['execSummary'],
  trendAggRows: QueryResults['trendAggRows'],
  monthKeyByLabel: FetchedRecords['monthKeyByLabel'],
  dqIssuesRaw: QueryResults['dqIssuesRaw'],
): {
  growthMetrics: ProcessedData['growthMetrics'];
  multiPeriodComparison: ReturnType<typeof buildMultiPeriodComparison>;
  trend: ReturnType<typeof buildTrend>;
  netCostTrend: ReturnType<typeof buildNetCostTrend>;
  dqSeverityCounts: Map<string, number>;
} {
  // FIX (audit issue #11): Use computeNominalDeviationGrowth (magnitude) for
  // nominalDeviasi — signed calcGrowth is misleading when sign flips.
  // For -10M → -20M: signed gives -100% (decreasing), magnitude gives +100% (worsening).
  const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(
    execSummary.nominalDeviasi.current,
    execSummary.nominalDeviasi.previous ?? null,
  );

  const growthMetrics = {
    salesGrowth: execSummary.sales.growth,
    bomGrowth: execSummary.qtyBom.growth,
    qtyDeviasiGrowth: execSummary.qtyDeviasi.growth,
    nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
    deviationToSalesRatio: execSummary.sales.current > 0
      ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
    deviationToBomRatio: execSummary.deviationToBom,
    multiPeriodComparison: [] as Array<Record<string, unknown>>,
  };

  // OPTIMIZE-ANALYSIS: DQ groupBy changed from `by: ['code','severity','message']`
  // (one row per unique issue text → potentially many rows) to `by: ['severity']`
  // (≤3 rows: ERROR/WARNING/INFO). Frontend only reads `dqStatus.errors` and
  // `dqStatus.warnings` (ExecutiveSummary.tsx:308,312) — the per-issue `code`/
  // `message` breakdown and the `ok`/`issues` response fields were unused.
  const dqSeverityCounts = new Map<string, number>();
  for (const d of dqIssuesRaw) {
    dqSeverityCounts.set(d.severity, (dqSeverityCounts.get(d.severity) ?? 0) + d._count._all);
  }

  // ============================================================
  //  Trend — from parallel queryTrendAgg result above
  //  Phase 3: extracted to services/trend-builder.ts
  // ============================================================
  const trend = buildTrend(trendAggRows, monthKeyByLabel);
  const multiPeriodComparison = buildMultiPeriodComparison(trendAggRows, monthKeyByLabel);
  growthMetrics.multiPeriodComparison = multiPeriodComparison as unknown as Array<Record<string, unknown>>;
  const netCostTrend = buildNetCostTrend(trendAggRows, monthKeyByLabel);

  return { growthMetrics, multiPeriodComparison, trend, netCostTrend, dqSeverityCounts };
}
