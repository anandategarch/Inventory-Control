// ============================================================
//  HISTORICAL METRICS — Single Implementation
//  --------------------------------------------------------
//  Z-Score: (ABS(current) - mean(ABS(historical))) / STDDEV_SAMP(ABS(historical))
//
//  Aturan (sesuai definitions.ts):
//   1. Gunakan ABS (magnitude), bukan signed value
//   2. Sample variance (N-1, Bessel's correction)
//   3. Exclude current period dari historical stats
//   4. Require n >= HISTORICAL_MIN_WEEKS (default 4)
//
//  Master context #29: Historical harus membaca Magnitude + Direction + Consistency
// ============================================================

import type { RuntimeThresholds } from '@/lib/settings';

export interface HistoricalStats {
  mean: number;
  stdDev: number;
  n: number;
}

export interface HistoricalInput {
  /** Current period Dev/BOM (pctQtyDeviasiToBom) */
  currentValue: number | null;
  /** Historical Dev/BOM values (EXCLUDING current period) */
  historicalValues: number[];
  /** Runtime thresholds (from Settings) */
  thresholds: Pick<RuntimeThresholds, 'HISTORICAL_MIN_WEEKS' | 'HISTORICAL_ZSCORE_WARN' | 'HISTORICAL_ZSCORE_HIGH'>;
}

export interface HistoricalResult {
  zScore: number | null;
  mean: number;
  stdDev: number;
  sampleSize: number;
  /** Historical trend: compare current magnitude vs historical mean */
  trend: 'DETERIORATING' | 'IMPROVING' | 'STABLE' | 'INSUFFICIENT_DATA';
  /** Benchmark flag from zScore (NOT from area/network comparison) */
  benchmarkFlag: string | null;
  /** Warning level from zScore */
  warningLevel: 'ABNORMAL' | 'WARNING' | 'NORMAL' | 'NONE';
}

/**
 * Compute Z-Score from historical data
 *
 * Formula: (|currentValue| - mean(|historicalValues|)) / STDDEV_SAMP(|historicalValues|)
 *
 * Rules:
 *   - Use ABS values (magnitude)
 *   - Sample variance (N-1)
 *   - Exclude current period (caller must pass historicalValues WITHOUT current)
 *   - Require n >= HISTORICAL_MIN_WEEKS
 *   - If stdDev === 0 or n < min, return null zScore
 */
export function computeZScore(input: HistoricalInput): HistoricalResult {
  const { currentValue, historicalValues, thresholds } = input;
  const minWeeks = thresholds.HISTORICAL_MIN_WEEKS ?? 4;

  // Filter to absolute, non-null values
  const absValues = historicalValues
    .filter((v) => v != null && !isNaN(v))
    .map((v) => Math.abs(v));

  const n = absValues.length;

  // Not enough historical data
  if (n < minWeeks) {
    return {
      zScore: null,
      mean: 0,
      stdDev: 0,
      sampleSize: n,
      trend: 'INSUFFICIENT_DATA',
      benchmarkFlag: null,
      warningLevel: 'NONE',
    };
  }

  // Compute mean (of absolute values)
  const mean = absValues.reduce((a, b) => a + b, 0) / n;

  // Compute sample standard deviation (N-1, Bessel's correction)
  const stdDev = n > 1
    ? Math.sqrt(absValues.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0;

  // Compute zScore
  let zScore: number | null = null;
  if (currentValue != null && stdDev > 0) {
    zScore = (Math.abs(currentValue) - mean) / stdDev;
  }

  // Determine trend (current magnitude vs historical mean)
  let trend: HistoricalResult['trend'] = 'STABLE';
  if (currentValue != null && mean > 0) {
    const ratio = Math.abs(currentValue) / mean;
    if (ratio > 1.1) trend = 'DETERIORATING';
    else if (ratio < 0.9) trend = 'IMPROVING';
  } else if (currentValue != null && mean === 0 && Math.abs(currentValue) > 0) {
    trend = 'DETERIORATING'; // deviation onset from zero base
  }

  // Benchmark flag from zScore (historical comparison, NOT area/network)
  let benchmarkFlag: string | null = null;
  if (zScore != null) {
    if (zScore > thresholds.HISTORICAL_ZSCORE_HIGH) benchmarkFlag = 'ABOVE_NETWORK_AVG';
    else if (zScore > thresholds.HISTORICAL_ZSCORE_WARN) benchmarkFlag = 'ABOVE_AREA_AVG';
  }

  // Warning level from zScore
  let warningLevel: HistoricalResult['warningLevel'] = 'NONE';
  if (zScore != null) {
    if (zScore > thresholds.HISTORICAL_ZSCORE_HIGH) warningLevel = 'ABNORMAL';
    else if (zScore > thresholds.HISTORICAL_ZSCORE_WARN) warningLevel = 'WARNING';
    else warningLevel = 'NORMAL';
  }

  return { zScore, mean, stdDev, sampleSize: n, trend, benchmarkFlag, warningLevel };
}

/**
 * Compute deterioration: current vs earliest historical
 * Returns absolute difference (positive = getting worse)
 */
export function computeDeterioration(
  currentValue: number | null,
  earliestValue: number | null,
): number | null {
  if (currentValue == null || earliestValue == null) return null;
  return Math.abs(currentValue) - Math.abs(earliestValue);
}

/**
 * SQL template for historical stats query
 * Uses ABS + STDDEV_SAMP (sample variance)
 *
 * Caller must provide periodFilter as parameterized OR conditions.
 */
export const HISTORICAL_STATS_SQL = `
  SELECT ir."outletId", ir."itemId",
    AVG(ABS(ir."pctQtyDeviasiToBom")) as mean,
    COALESCE(STDDEV_SAMP(ABS(ir."pctQtyDeviasiToBom")), 0) as "stdDev",
    COUNT(*)::int as n
  FROM "InventoryRecord" ir
  WHERE ({periodFilter})
    AND ir."pctQtyDeviasiToBom" IS NOT NULL
    AND ir."qtyBom" != 0
  GROUP BY ir."outletId", ir."itemId"
`;
