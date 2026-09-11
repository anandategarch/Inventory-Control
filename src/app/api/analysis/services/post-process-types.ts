// ============================================================
//  post-process-types — shared types for the post-process pipeline
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Exports:
//    - ProcessedData           (Stage-4 output interface — consumed by assemble-response)
//    - BomCorrelationFinding   (per-record BOM rule fire detail — top 50 by priority)
//    - BomCorrelationCounts    (per-rule counts for all 6 BOM rules)
//    - SeverityMaps            (per-outlet severity-count maps — shared by flags + health-ranking)
//
//  Note: BomDetailRow stays private to post-process-bom-correlation.ts (only
//  used inside that file's helpers — not part of the public surface).
// ============================================================
import type { SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { AnalysisOutlet } from '@/engine/analysis';
import type { buildTrend, buildNetCostTrend } from './trend-builder';
import type { computeDeviationDrivers } from './deviation-drivers';
import type { projectTrend } from '@/lib/metrics';
import type { detectPatterns } from '@/engine/analysis';
import type { HistoricalAnalysisResult } from './post-process-historical';

// ============================================================
//  BOM Correlation Findings — per-record rule fire details
//  --------------------------------------------------------
//  FIX-BOM-UI (CONFIG-02): BomCorrelationCard previously read ONLY
//  aggregate growth from `executiveSummary` and computed alignment
//  inline with hardcoded thresholds. It never saw the per-record
//  rule engine results (sqlFlags where category === 'BOM').
//
//  We now extract ALL BOM rule fires from `sqlFlags` (NOT the
//  topFlagByKey — that's de-duped to highest-priority flag per
//  record and would hide secondary BOM warnings), and join each
//  flag to its underlying record's growth values via a fresh SQL
//  fetch (curr + prev period LATERAL JOIN, same shape as the
//  rule-evaluation CTE but only for the flagged tuples — bounded
//  to ~50 rows by the slice).
//
//  `deviationBomRatio` = qtyDeviasiGrowth / bomGrowth (when bomGrowth > 0).
//  Used by BOM_DEVIATION_DISPROPORTIONATE to show how many times
//  faster deviation grew vs BOM.
// ============================================================

export interface BomCorrelationFinding {
  outletId: number;
  outletName: string;
  itemId: number;
  itemName: string;
  akunPenyesuaian: string | null;
  ruleCode: string;
  rulePriority: number;
  severity: string;
  bomGrowth: number | null;
  /** Growth of the metric relevant to the rule (waste/susut/trial/qtyDeviasi). */
  metricGrowth: number | null;
  /** qtyDeviasiGrowth / bomGrowth (only meaningful when bomGrowth > 0). */
  deviationBomRatio: number | null;
}

export interface BomCorrelationCounts {
  WASTE_BOM_MISMATCH: number;
  SUSUT_BOM_MISMATCH: number;
  TRIAL_BOM_MISMATCH: number;
  BOM_DEVIATION_DISPROPORTIONATE: number;
  BOM_DEVIATION_MISMATCH: number;
  BOM_DOWN_DEV_UP: number;
}

// Stage-4 output — everything needed by assemble-response.
export interface ProcessedData {
  normal: number;
  warning: number;
  abnormal: number;
  ruleBreakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
  topFlagByKey: Map<string, SqlRuleFlag>;
  growthMetrics: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison: Array<Record<string, unknown>>;
  };
  growthComparisonWithHist: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison: Array<Record<string, unknown>>;
    historicalAnalysis: HistoricalAnalysisResult;
  };
  trend: ReturnType<typeof buildTrend>;
  netCostTrend: ReturnType<typeof buildNetCostTrend>;
  trendProjection: ReturnType<typeof projectTrend>;
  patterns: ReturnType<typeof detectPatterns>;
  dqSeverityCounts: Map<string, number>;
  areaAnalysis: Array<Record<string, unknown>>;
  // H-11 (#4a): topOut / topOutletsSales REMOVED with the Dashboard's
  // TopOutlets card (duplicate of the Pareto tab's byOutlet quadrant card;
  // topOutletsBySales had no renderer at all).
  outletHealthRanking: Array<AnalysisOutlet & { nominalDeviasi: number; residualPct: number; lossToSales: number | null }>;
  costImpact: Record<string, unknown>;
  itemConsistencyAnalysis: Record<string, unknown>;
  deviationDrivers: ReturnType<typeof computeDeviationDrivers>;
  // FIX-BOM-UI (CONFIG-02): per-record BOM rule findings (top 50 by priority)
  // + per-rule counts. Consumed by BomCorrelationCard's primary section.
  bomCorrelationFindings: BomCorrelationFinding[];
  bomCorrelationCounts: BomCorrelationCounts;
}

// Internal: severity-count maps derived from topFlagByKey + healthRankingRows.
// Shared between evaluateAndMergeFlags (producer) and buildOutletHealthRanking (consumer).
export interface SeverityMaps {
  warningByOutlet: Map<number, number>;
  abnormalByOutlet: Map<number, number>;
  recordsWithFlagsByOutlet: Map<number, number>;
}
