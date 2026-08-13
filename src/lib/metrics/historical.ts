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

  // Historical benchmark flag from zScore (historical comparison, NOT area/network)
  // FIX (audit issue #10): Renamed from ABOVE_NETWORK_AVG/ABOVE_AREA_AVG to
  // HISTORICAL_HIGH/HISTORICAL_WARNING — these are historical outlier flags,
  // NOT area/network comparison flags.
  let benchmarkFlag: string | null = null;
  if (zScore != null) {
    if (zScore > thresholds.HISTORICAL_ZSCORE_HIGH) benchmarkFlag = 'HISTORICAL_HIGH';
    else if (zScore > thresholds.HISTORICAL_ZSCORE_WARN) benchmarkFlag = 'HISTORICAL_WARNING';
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
 * Compute Z-Score from pre-computed mean + stdDev (simple inline form).
 *
 * Use this when historical stats (mean, stdDev) are already available
 * (e.g., from SQL aggregate query). Use computeZScore() instead when
 * you have raw historical values and need the full result (trend,
 * benchmarkFlag, warningLevel).
 *
 * Formula: (|value| - mean) / stdDev
 * Returns null if value is null or stdDev is 0.
 *
 * Master context #29: Z-Score uses ABS magnitude (not signed value).
 */
export function calcZScoreFromStats(
  value: number | null,
  mean: number,
  stdDev: number,
): number | null {
  if (value == null || stdDev === 0) return null;
  return (Math.abs(value) - mean) / stdDev;
}

/**
 * SQL template for historical stats query (REFERENCE ONLY)
 *
 * NOTE: The actual implementation is in src/lib/queries.ts queryHistoricalStats(),
 * which uses a two-level CTE: weekly_dev (per-week aggregate) → final stats.
 * This template is kept for documentation but NOT used — it shows the
 * correct per-week aggregation pattern.
 *
 * Each week = 1 observation (SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom))).
 * mean/stddev computed across weekly observations, NOT raw rows.
 * Sample variance (N-1, Bessel's correction).
 */
export const HISTORICAL_STATS_SQL = `
  WITH weekly_dev AS (
    SELECT ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
        ELSE NULL END as "weeklyDevBom"
    FROM "InventoryRecord" ir
    WHERE ({periodFilter})
    GROUP BY ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel"
  )
  SELECT "outletId", "itemId",
    AVG("weeklyDevBom") as mean,
    SUM("weeklyDevBom" * "weeklyDevBom") as "sumSq",
    CAST(COUNT(*) AS INTEGER) as n
  FROM weekly_dev
  WHERE "weeklyDevBom" IS NOT NULL
  GROUP BY "outletId", "itemId"
`;
