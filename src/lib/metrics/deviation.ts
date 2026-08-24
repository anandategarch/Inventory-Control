// ============================================================
//  DEVIATION METRICS — Single Implementation
//  --------------------------------------------------------
//  Semua perhitungan Gross/Explained/Net/DevBOM/Residual
//  harus melalui file ini. Jangan hitung di tempat lain.
//
//  Sesuai definitions.ts dan Master Context.
//
//  FIX (audit issue #4, #18): No DB/Prisma imports — pure functions only.
//  DB access stays in queries.ts/repository layer.
//  FIX: toNum imported from @/lib/format (deduplicated).
// ============================================================

import { toNum } from '@/lib/format';

const safeDiv = (num: number, den: number): number => den > 0 ? num / den : 0;

// ============================================================
//  Direction — Single Implementation (audit issue #14)
//  Master context #9: from NET Deviation (qtyLossSurplus), fallback to GROSS
// ============================================================
import type { Direction } from './definitions';

/**
 * Compute direction from NET deviation (qtyLossSurplus).
 * Fallback to GROSS deviation (qtyDeviasi) if NET is null.
 *
 * Excel sign convention (verified from production data):
 *   LOSS (over-consumption):  qtyLossSurplus < 0, qtyDeviasi < 0, nominalDeviasi < 0
 *   SURPLUS (under-consumption): qtyLossSurplus > 0, qtyDeviasi > 0, nominalDeviasi > 0
 *
 * Net < 0 → LOSS (over-consumption)
 * Net > 0 → SURPLUS (under-consumption)
 * Net = 0 → NEUTRAL
 */
export function computeDirection(
  qtyLossSurplus: number | null,
  qtyDeviasi: number | null = null,
): Direction {
  const net = qtyLossSurplus ?? qtyDeviasi;
  if (net == null) return 'NEUTRAL';
  if (net < 0) return 'LOSS';
  if (net > 0) return 'SURPLUS';
  return 'NEUTRAL';
}

// ============================================================
//  Per-Row Metrics
// ============================================================

/**
 * Dev/BOM per-row: ABS(QTY DEVIASI) / ABS(QTY BOM)
 * Master context #32: Deviation/BOM
 */
export function computeDevBomPerRow(qtyDeviasi: number | null, qtyBom: number | null): number | null {
  if (qtyDeviasi == null || qtyBom == null || qtyBom === 0) return null;
  return Math.abs(qtyDeviasi) / Math.abs(qtyBom);
}

/**
 * Residual: Math.max(0, ABS(qtyDeviasi) - ABS(waste + susut + trial))
 * Master context #11: Residual = sisa setelah W+S+T
 */
export function computeResidual(
  qtyDeviasi: number | null,
  qtyWaste: number | null,
  qtySusut: number | null,
  qtyTrial: number | null,
): { residualQty: number | null; explained: number; isOverExplained: boolean } {
  if (qtyDeviasi == null) return { residualQty: null, explained: 0, isOverExplained: false };
  const w = qtyWaste ?? 0;
  const s = qtySusut ?? 0;
  const t = qtyTrial ?? 0;
  const explained = Math.abs(w) + Math.abs(s) + Math.abs(t);
  const absDev = Math.abs(qtyDeviasi);
  const residualQty = Math.max(0, absDev - explained);
  const isOverExplained = absDev > 0 && explained > absDev;
  return { residualQty, explained, isOverExplained };
}

/**
 * Residual Ratio: ABS(residual) / ABS(qtyDeviasi)
 */
export function computeResidualRatio(residualQty: number | null, qtyDeviasi: number | null): number | null {
  if (residualQty == null || qtyDeviasi == null || Math.abs(qtyDeviasi) === 0) return null;
  return residualQty / Math.abs(qtyDeviasi);
}

/**
 * Explained %: (Waste + Susut + Trial) / Gross Deviation
 * Master context #10: Waste/Susut/Trial menjelaskan deviation
 */
export function computeExplainedPct(
  qtyDeviasi: number | null,
  qtyWaste: number | null,
  qtySusut: number | null,
  qtyTrial: number | null,
): number | null {
  if (qtyDeviasi == null || Math.abs(qtyDeviasi) === 0) return null;
  const explained = Math.abs(qtyWaste ?? 0) + Math.abs(qtySusut ?? 0) + Math.abs(qtyTrial ?? 0);
  return explained / Math.abs(qtyDeviasi);
}

// ============================================================
//  Aggregate Metrics (per outlet/area/network)
// ============================================================

export interface AggregateInput {
  totalQtyDeviasi: number;   // SUM(ABS(qtyDeviasi))
  totalQtyBom: number;       // SUM(ABS(qtyBom))
  totalQtyWaste: number;     // SUM(ABS(qtyWaste))
  totalQtySusut: number;     // SUM(ABS(qtySusut))
  totalQtyTrial: number;     // SUM(ABS(qtyTrial))
  totalResidualQty: number;  // SUM(ABS(residualQty))
  // FIX (CALC-1): totalLossNominal = SUM(ABS(nominalLossSurplus) WHERE nominalLossSurplus < 0)
  // = NET LOSS only (negative NET deviation items = over-consumption / LOSS).
  // Excel convention: LOSS items have NEGATIVE nominalLossSurplus.
  // Used by computeLossToSales() = totalLossNominal / totalSales.
  totalLossNominal: number;  // SUM(ABS(nominalLossSurplus) WHERE < 0) — NET LOSS only
  totalSales: number;        // MODE(sales)
  normalCount: number;
  warningCount: number;
  abnormalCount: number;
}

/**
 * Dev/BOM aggregate: SUM(ABS(QTY DEV)) / SUM(ABS(QTY BOM))
 * BUKAN AVG(ABS(pctQtyDeviasiToBom)) — lihat definitions.ts
 */
export function computeDevBomAggregate(input: AggregateInput): number {
  return safeDiv(input.totalQtyDeviasi, input.totalQtyBom);
}

/**
 * Residual % aggregate: SUM(ABS(residual)) / SUM(ABS(qtyDeviasi))
 */
export function computeResidualPctAggregate(input: AggregateInput): number {
  return safeDiv(input.totalResidualQty, input.totalQtyDeviasi);
}

/**
 * Explained % aggregate: SUM(W+S+T) / SUM(ABS(qtyDeviasi))
 */
export function computeExplainedPctAggregate(input: AggregateInput): number {
  const explained = input.totalQtyWaste + input.totalQtySusut + input.totalQtyTrial;
  return safeDiv(explained, input.totalQtyDeviasi);
}

/**
 * Loss/Sales ratio: SUM(NET loss) / Sales
 * Master context: Loss/Sales = NET loss / Sales
 */
export function computeLossToSales(input: AggregateInput): number | null {
  if (input.totalSales <= 0) return null;
  return input.totalLossNominal / input.totalSales;
}

// ============================================================
//  Health Score — Single Implementation
//  Master context #33: 30% DevBOM + 25% Residual + 25% Loss/Sales + 20% Abnormal
//
//  FIX (audit issue #6): Accepts optional runtime weights from Settings.
//  FIX (audit P2 #10): Accepts optional runtime thresholds from Settings.
//  If not provided, falls back to HEALTH_SCORE_WEIGHTS / HEALTH_SCORE_THRESHOLDS
//  from definitions.ts.
// ============================================================

import { HEALTH_SCORE_THRESHOLDS, HEALTH_SCORE_WEIGHTS } from './definitions';

export interface HealthScoreWeights {
  devBom: number;       // weight (0-1, will be normalized)
  residual: number;
  lossToSales: number;
  abnormal: number;
}

export interface HealthScoreThresholds {
  devBom: { good: number; bad: number };
  residual: { good: number; bad: number };
  lossToSales: { good: number; bad: number };
  abnormal: { good: number; bad: number };
}

export function computeHealthScore(
  input: AggregateInput,
  weights?: HealthScoreWeights,
  thresholds?: HealthScoreThresholds,
): number {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  // FIX (BUG-2-2): Neutral score when NaN could appear in the weighted sum.
  const neutralScore = 50;

  // Use provided weights or fall back to defaults
  const w = weights ?? HEALTH_SCORE_WEIGHTS;
  const wSum = w.devBom + w.residual + w.lossToSales + w.abnormal;
  const nw = wSum > 0 ? {
    devBom: w.devBom / wSum,
    residual: w.residual / wSum,
    lossToSales: w.lossToSales / wSum,
    abnormal: w.abnormal / wSum,
  } : HEALTH_SCORE_WEIGHTS;

  // Use provided thresholds or fall back to defaults
  const th = thresholds ?? HEALTH_SCORE_THRESHOLDS;

  // Linear-interpolation component scorer with div-by-zero guard (BUG-2-2).
  // When good===bad, the threshold pair is misconfigured — return neutral.
  const componentScore = (value: number, c: { good: number; bad: number }): number => {
    if (c.bad === c.good) return neutralScore;
    return clamp(100 - ((value - c.good) / (c.bad - c.good)) * 100);
  };

  // DevBOM: <good → 100, >bad → 0 (linear)
  // FIX (DEEP-AUDIT-LOGIC #6): when totalQtyBom=0, safeDiv returns 0 → componentScore
  // interprets 0 as "good" → false positive score 100. Return neutralScore instead.
  const devBom = input.totalQtyBom > 0 ? computeDevBomAggregate(input) : null;
  const devBomScore = devBom != null ? componentScore(devBom, th.devBom) : neutralScore;

  // Residual: <good → 100, >bad → 0 (linear)
  // FIX (DEEP-AUDIT-LOGIC #6): same div-by-zero guard for residual denominator.
  const residualPct = input.totalQtyDeviasi > 0 ? computeResidualPctAggregate(input) : null;
  const residualScore = residualPct != null ? componentScore(residualPct, th.residual) : neutralScore;

  // Loss/Sales: <good → 100, >bad → 0 (linear)
  const lossToSales = computeLossToSales(input);
  const lossToSalesScore = lossToSales != null
    ? componentScore(lossToSales, th.lossToSales)
    : neutralScore;

  // Abnormal rate: abnormal / total items, <good → 100, >bad → 0 (linear)
  // FIX (DEEP-AUDIT-LOGIC #7): was abnormal / (warning + abnormal) which dilutes by
  // warnings — an outlet with 50 warnings + 5 abnormals scored HIGHER than one
  // with 0 warnings + 5 abnormals. Now uses total item count as denominator.
  // FIX (AUDIT-CALC-METRICS EDGE-1): when totalItemCount=0 (empty outlet), abnormalRate=0
  // → abnormalScore=100 (misleading perfect score). Now returns neutralScore.
  const totalItemCount = input.normalCount + input.warningCount + input.abnormalCount;
  const abnormalRate = totalItemCount > 0 ? input.abnormalCount / totalItemCount : null;
  const abnormalScore = abnormalRate != null ? componentScore(abnormalRate, th.abnormal) : neutralScore;

  // FIX (BUG-2-3): clamp the final weighted sum to [0, 100] so negative
  // weights or extreme inputs cannot push the score outside the valid range.
  const finalScore = Math.round(
    devBomScore * nw.devBom +
    residualScore * nw.residual +
    lossToSalesScore * nw.lossToSales +
    abnormalScore * nw.abnormal
  );
  return clamp(finalScore);
}

// ============================================================
//  Priority — Single Implementation
//  FIX (audit issue #5): Master rule uses OR logic, not AND.
//
//  P1: high nominal OR high residual OR high zScore OR over-explained
//  P2: medium nominal OR warn residual OR high devBom
//  P3: lainnya
// ============================================================

export interface PriorityInput {
  absNominalLossSurplus: number;
  devBom: number | null;
  residualRatio: number | null;
  zScore: number | null;
  isOverExplained: boolean;
  thresholds: {
    HIGH_LOSS_NOMINAL_THRESHOLD: number;   // P1 nominal threshold (default 1M)
    P2_NOMINAL_THRESHOLD: number;           // P2 nominal threshold (default 100K) ← NEW
    STD_DEVIASI_BOM_PCT: number;
    RESIDUAL_LOSS_WARN_PCT: number;
    RESIDUAL_LOSS_HIGH_PCT: number;
    HISTORICAL_ZSCORE_HIGH: number;
  };
}

export function computePriority(input: PriorityInput): 'P1' | 'P2' | 'P3' {
  const t = input.thresholds;

  // P1 conditions (OR logic — any single condition triggers P1)
  const isP1HighNominal = input.absNominalLossSurplus > t.HIGH_LOSS_NOMINAL_THRESHOLD;
  const isP1HighResidual = input.residualRatio != null && input.residualRatio > t.RESIDUAL_LOSS_HIGH_PCT;
  const isP1HighZScore = input.zScore != null && input.zScore > t.HISTORICAL_ZSCORE_HIGH;

  if (isP1HighNominal || isP1HighResidual || isP1HighZScore || input.isOverExplained) return 'P1';

  // P2 conditions (OR logic)
  const isP2MediumNominal = input.absNominalLossSurplus > t.P2_NOMINAL_THRESHOLD;
  const isP2WarnResidual = input.residualRatio != null && input.residualRatio > t.RESIDUAL_LOSS_WARN_PCT;
  const isP2HighDevBom = input.devBom != null && Math.abs(input.devBom) > t.STD_DEVIASI_BOM_PCT;

  if (isP2MediumNominal || isP2WarnResidual || isP2HighDevBom) return 'P2';

  return 'P3';
}
