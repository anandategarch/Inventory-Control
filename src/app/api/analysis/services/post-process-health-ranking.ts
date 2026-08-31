// ============================================================
//  post-process-health-ranking — Sub-step 3: buildOutletHealthRanking
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    Build outlet health ranking with Metric Engine health score.
//    Combines SQL aggregate (healthRankingRows) + JS severity counts
//    (SeverityMaps produced by Sub-step 1 / post-process-flags.ts).
//
//  Returns a superset of AnalysisOutlet — extra fields (nominalDeviasi,
//  residualPct, lossToSales) are kept because assemble-response spreads
//  the array directly into the JSON response (frontend reads them).
// ============================================================
import {
  computeHealthScore,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeLossToSales,
  type AggregateInput,
  type HealthScoreWeights,
  type HealthScoreThresholds,
} from '@/lib/metrics';
import type { AnalysisOutlet } from '@/engine/analysis';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { SeverityMaps } from './post-process-types';

/**
 * Sub-step 3 — build outlet health ranking with Metric Engine health score.
 * Combines SQL aggregate (healthRankingRows) + JS severity counts (topFlagByKey).
 *
 * Returns a superset of AnalysisOutlet — extra fields (nominalDeviasi,
 * residualPct, lossToSales) are kept because assemble-response spreads the
 * array directly into the JSON response (frontend reads them).
 */
export function buildOutletHealthRanking(
  healthRankingRows: QueryResults['healthRankingRows'],
  severityMaps: SeverityMaps,
  thresholds: FetchedRecords['thresholds'],
): Array<AnalysisOutlet & { nominalDeviasi: number; residualPct: number; lossToSales: number | null }> {
  // FIX (audit issue #6, P2 #10): Pass runtime health score weights + thresholds from Settings
  const healthScoreWeights = {
    devBom: thresholds.HEALTH_WEIGHT_DEV_BOM,
    residual: thresholds.HEALTH_WEIGHT_RESIDUAL,
    lossToSales: thresholds.HEALTH_WEIGHT_LOSS_TO_SALES,
    abnormal: thresholds.HEALTH_WEIGHT_ABNORMAL,
  };
  const healthScoreThresholds = {
    devBom: { good: thresholds.HEALTH_THRESH_DEV_BOM_GOOD, bad: thresholds.HEALTH_THRESH_DEV_BOM_BAD },
    residual: { good: thresholds.HEALTH_THRESH_RESIDUAL_GOOD, bad: thresholds.HEALTH_THRESH_RESIDUAL_BAD },
    lossToSales: { good: thresholds.HEALTH_THRESH_LOSS_TO_SALES_GOOD, bad: thresholds.HEALTH_THRESH_LOSS_TO_SALES_BAD },
    abnormal: { good: thresholds.HEALTH_THRESH_ABNORMAL_GOOD, bad: thresholds.HEALTH_THRESH_ABNORMAL_BAD },
  };

  const { warningByOutlet, abnormalByOutlet, recordsWithFlagsByOutlet } = severityMaps;
  return healthRankingRows.map(row => {
    const recWithFlags = recordsWithFlagsByOutlet.get(row.outletId) ?? 0;
    const w = warningByOutlet.get(row.outletId) ?? 0;
    const ab = abnormalByOutlet.get(row.outletId) ?? 0;
    const n = Math.max(0, row.nonZeroDevCount - recWithFlags) + row.zeroDevCount;
    const aggregateInput: AggregateInput = {
      totalQtyDeviasi: row.totalQtyDeviasi,
      totalQtyBom: row.totalQtyBom,
      totalQtyWaste: row.totalQtyWaste,
      totalQtySusut: row.totalQtySusut,
      totalQtyTrial: row.totalQtyTrial,
      totalResidualQty: row.totalResidualQty,
      totalLossNominal: row.lossNominal,
      totalSales: row.sales,
      normalCount: n,
      warningCount: w,
      abnormalCount: ab,
    };
    const devBom = computeDevBomAggregate(aggregateInput);
    const residualPct = computeResidualPctAggregate(aggregateInput);
    const lossToSales = computeLossToSales(aggregateInput);
    const healthScore = computeHealthScore(aggregateInput, healthScoreWeights as HealthScoreWeights, healthScoreThresholds as HealthScoreThresholds);
    return {
      outletCode: row.outletCode,
      outletName: row.outletName,
      area: row.area,
      healthScore,
      normal: n,
      warning: w,
      abnormal: ab,
      absNominal: row.absNominal,
      nominalDeviasi: row.nominalDeviasi,
      residualPct,
      lossToSales,
      devBom,
      sales: row.sales,
    };
  }).sort((a, b) => a.healthScore - b.healthScore || b.abnormal - a.abnormal);
}
