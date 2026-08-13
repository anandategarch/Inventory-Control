// ============================================================
//  DEVIATION METRICS — Single Implementation
//  --------------------------------------------------------
//  Semua perhitungan Gross/Explained/Net/DevBOM/Residual
//  harus melalui file ini. Jangan hitung di tempat lain.
//
//  Sesuai definitions.ts dan Master Context.
// ============================================================
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

const safeDiv = (num: number, den: number): number => den > 0 ? num / den : 0;

// ============================================================
//  Per-Row Metrics
// ============================================================

/**
 * Dev/BOM per-row: ABS(QTY DEVIASI) / ABS(QTY BOM)
 * Master context #19
 */
export function computeDevBomPerRow(qtyDeviasi: number | null, qtyBom: number | null): number | null {
  if (qtyDeviasi == null || qtyBom == null || qtyBom === 0) return null;
  return Math.abs(qtyDeviasi) / Math.abs(qtyBom);
}

/**
 * Residual: Math.max(0, ABS(qtyDeviasi) - ABS(waste + susut + trial))
 * Master context #11.3
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
  const explained = Math.abs(w + s + t);
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
 * Master context #12
 */
export function computeExplainedPct(
  qtyDeviasi: number | null,
  qtyWaste: number | null,
  qtySusut: number | null,
  qtyTrial: number | null,
): number | null {
  if (qtyDeviasi == null || Math.abs(qtyDeviasi) === 0) return null;
  const explained = Math.abs((qtyWaste ?? 0) + (qtySusut ?? 0) + (qtyTrial ?? 0));
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
  totalLossNominal: number;  // SUM(nominalLossSurplus WHERE > 0)
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
// ============================================================

import { HEALTH_SCORE_THRESHOLDS, HEALTH_SCORE_WEIGHTS } from './definitions';

export function computeHealthScore(input: AggregateInput): number {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));

  // DevBOM: <5% → 100, >50% → 0 (linear)
  const devBom = computeDevBomAggregate(input);
  const devBomScore = clamp(
    100 - ((devBom - HEALTH_SCORE_THRESHOLDS.devBom.good) /
      (HEALTH_SCORE_THRESHOLDS.devBom.bad - HEALTH_SCORE_THRESHOLDS.devBom.good)) * 100
  );

  // Residual: <20% → 100, >80% → 0 (linear)
  const residualPct = computeResidualPctAggregate(input);
  const residualScore = clamp(
    100 - ((residualPct - HEALTH_SCORE_THRESHOLDS.residual.good) /
      (HEALTH_SCORE_THRESHOLDS.residual.bad - HEALTH_SCORE_THRESHOLDS.residual.good)) * 100
  );

  // Loss/Sales: <2% → 100, >15% → 0 (linear)
  const lossToSales = computeLossToSales(input);
  const lossToSalesScore = lossToSales != null
    ? clamp(100 - ((lossToSales - HEALTH_SCORE_THRESHOLDS.lossToSales.good) /
        (HEALTH_SCORE_THRESHOLDS.lossToSales.bad - HEALTH_SCORE_THRESHOLDS.lossToSales.good)) * 100)
    : 50;

  // Abnormal: abnormal / (warning + abnormal), 0% → 100, >50% → 0 (linear)
  const activeItems = input.warningCount + input.abnormalCount;
  const abnormalRate = activeItems > 0 ? input.abnormalCount / activeItems : 0;
  const abnormalScore = clamp(
    100 - ((abnormalRate - HEALTH_SCORE_THRESHOLDS.abnormal.good) /
      (HEALTH_SCORE_THRESHOLDS.abnormal.bad - HEALTH_SCORE_THRESHOLDS.abnormal.good)) * 100
  );

  return Math.round(
    devBomScore * HEALTH_SCORE_WEIGHTS.devBom +
    residualScore * HEALTH_SCORE_WEIGHTS.residual +
    lossToSalesScore * HEALTH_SCORE_WEIGHTS.lossToSales +
    abnormalScore * HEALTH_SCORE_WEIGHTS.abnormal
  );
}

// ============================================================
//  Priority — Single Implementation
//  Uses Settings thresholds, not hardcoded
// ============================================================

export interface PriorityInput {
  absNominalLossSurplus: number;
  devBom: number | null;
  residualRatio: number | null;
  zScore: number | null;
  isOverExplained: boolean;
  thresholds: {
    HIGH_LOSS_NOMINAL_THRESHOLD: number;
    STD_DEVIASI_BOM_PCT: number;
    RESIDUAL_LOSS_HIGH_PCT: number;
    HISTORICAL_ZSCORE_HIGH: number;
  };
}

export function computePriority(input: PriorityInput): 'P1' | 'P2' | 'P3' {
  const t = input.thresholds;
  const isHighNominal = input.absNominalLossSurplus > t.HIGH_LOSS_NOMINAL_THRESHOLD;
  const isHighDevBom = input.devBom != null && Math.abs(input.devBom) > t.STD_DEVIASI_BOM_PCT;
  const isHighResidual = input.residualRatio != null && input.residualRatio > t.RESIDUAL_LOSS_HIGH_PCT;
  const isHighZScore = input.zScore != null && input.zScore > t.HISTORICAL_ZSCORE_HIGH;

  if (isHighNominal && (isHighDevBom || isHighResidual || input.isOverExplained || isHighZScore)) return 'P1';
  if (isHighDevBom || isHighResidual || input.isOverExplained || isHighZScore) return 'P2';
  return 'P3';
}
