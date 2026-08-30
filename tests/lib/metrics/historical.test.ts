// ============================================================
//  Tests for src/lib/metrics/historical.ts
//  --------------------------------------------------------
//  Covers:
//    - computeZScore(): full statistical result (zScore, trend,
//      benchmarkFlag, warningLevel, sampleSize, mean, stdDev)
//    - calcZScoreFromStats(): inline zScore from pre-computed stats
//
//  Reference formula (from source):
//    zScore = (|currentValue| - mean(|historicalValues|)) / STDDEV_SAMP(|historicalValues|)
//    Sample variance (N-1, Bessel's correction)
//    Trend: ratio = |current|/mean  → DETERIORATING(>1.1) | IMPROVING(<0.9) | STABLE
// ============================================================

import { describe, it, expect } from 'vitest';
import { computeZScore, calcZScoreFromStats } from '@/lib/metrics/historical';

// ---- Shared thresholds (defaults from src/lib/settings.ts) ----
const thresholds = {
  HISTORICAL_MIN_WEEKS: 4,
  HISTORICAL_ZSCORE_WARN: 1.5,
  HISTORICAL_ZSCORE_HIGH: 2.0,
};

// Helper to compute sample mean/stdDev so tests are self-verifying
function sampleStats(values: number[]): { mean: number; stdDev: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, stdDev: Math.sqrt(variance) };
}

// ============================================================
//  computeZScore()
// ============================================================
describe('computeZScore', () => {
  // ---- 1. Normal case ----
  it('1. computes correct zScore for normal case (5 historical values, valid current)', () => {
    const historicalValues = [0.12, 0.18, 0.14, 0.16, 0.20];
    const currentValue = 0.45;
    const result = computeZScore({ currentValue, historicalValues, thresholds });

    const absH = historicalValues.map(Math.abs);
    const { mean, stdDev } = sampleStats(absH);
    const expectedZ = (Math.abs(currentValue) - mean) / stdDev;

    expect(result.zScore).not.toBeNull();
    expect(result.zScore).toBeCloseTo(expectedZ, 6);
    expect(result.sampleSize).toBe(5);
    expect(result.mean).toBeCloseTo(mean, 6);
    expect(result.stdDev).toBeCloseTo(stdDev, 6);
  });

  // ---- 2. Insufficient data: n < MIN_WEEKS ----
  it('2. returns null zScore + INSUFFICIENT_DATA trend when n < MIN_WEEKS (3 values, min=4)', () => {
    const result = computeZScore({
      currentValue: 0.45,
      historicalValues: [0.12, 0.18, 0.14], // n=3 < 4
      thresholds,
    });

    expect(result.zScore).toBeNull();
    expect(result.trend).toBe('INSUFFICIENT_DATA');
    expect(result.sampleSize).toBe(3);
    expect(result.benchmarkFlag).toBeNull();
    expect(result.warningLevel).toBe('NONE');
    expect(result.mean).toBe(0);
    expect(result.stdDev).toBe(0);
  });

  // ---- 3. Exactly MIN_WEEKS ----
  it('3. computes zScore when exactly MIN_WEEKS (4 values) provided', () => {
    const historicalValues = [0.12, 0.18, 0.14, 0.16];
    const result = computeZScore({
      currentValue: 0.45,
      historicalValues,
      thresholds,
    });

    const { mean, stdDev } = sampleStats(historicalValues.map(Math.abs));
    const expectedZ = (0.45 - mean) / stdDev;

    expect(result.zScore).not.toBeNull();
    expect(result.zScore).toBeCloseTo(expectedZ, 6);
    expect(result.sampleSize).toBe(4);
  });

  // ---- 4. stdDev = 0 (all historical values identical) ----
  it('4. returns null zScore when stdDev === 0 (all historical values identical)', () => {
    const result = computeZScore({
      currentValue: 0.45,
      historicalValues: [0.15, 0.15, 0.15, 0.15], // stdDev = 0
      thresholds,
    });

    expect(result.zScore).toBeNull();
    expect(result.stdDev).toBe(0);
    expect(result.mean).toBeCloseTo(0.15, 6);
    expect(result.sampleSize).toBe(4);
    // zScore null → benchmarkFlag null, warningLevel NONE
    expect(result.benchmarkFlag).toBeNull();
    expect(result.warningLevel).toBe('NONE');
  });

  // ---- 5. currentValue = null ----
  it('5. returns null zScore when currentValue is null', () => {
    const result = computeZScore({
      currentValue: null,
      historicalValues: [0.12, 0.18, 0.14, 0.16],
      thresholds,
    });

    expect(result.zScore).toBeNull();
    expect(result.sampleSize).toBe(4);
    // Trend stays STABLE when currentValue is null
    expect(result.trend).toBe('STABLE');
    expect(result.benchmarkFlag).toBeNull();
    expect(result.warningLevel).toBe('NONE');
  });

  // ---- 6. All historical values null ----
  it('6. returns null zScore with sampleSize=0 when all historical values are null', () => {
    const result = computeZScore({
      currentValue: 0.45,
      historicalValues: [null, null, null, null, null],
      thresholds,
    });

    expect(result.zScore).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.trend).toBe('INSUFFICIENT_DATA');
    expect(result.warningLevel).toBe('NONE');
    expect(result.benchmarkFlag).toBeNull();
  });

  // ---- 7. Mixed nulls in historical → nulls filtered ----
  it('7. filters nulls and uses non-null count as sampleSize', () => {
    const result = computeZScore({
      currentValue: 0.45,
      historicalValues: [0.12, null, 0.18, null, 0.14, 0.16, null], // 4 non-null
      thresholds,
    });

    expect(result.sampleSize).toBe(4);
    expect(result.zScore).not.toBeNull();

    // Verify zScore computed from the 4 non-null values
    const { mean, stdDev } = sampleStats([0.12, 0.18, 0.14, 0.16]);
    const expectedZ = (0.45 - mean) / stdDev;
    expect(result.zScore).toBeCloseTo(expectedZ, 6);
  });

  // ---- 8. Negative values → ABS used for magnitude ----
  it('8. uses ABS(value) for both historical and current (negative magnitude)', () => {
    const result = computeZScore({
      currentValue: -0.45,
      historicalValues: [-0.12, -0.18, -0.14, -0.16], // all negative
      thresholds,
    });

    // Should match the positive equivalent case
    const positiveResult = computeZScore({
      currentValue: 0.45,
      historicalValues: [0.12, 0.18, 0.14, 0.16],
      thresholds,
    });

    expect(result.zScore).not.toBeNull();
    expect(result.zScore).toBeCloseTo(positiveResult.zScore!, 6);
    expect(result.mean).toBeCloseTo(positiveResult.mean, 6);
    expect(result.stdDev).toBeCloseTo(positiveResult.stdDev, 6);
  });

  // ---- 9. Trend DETERIORATING: current > 1.1 × mean ----
  it('9. sets trend=DETERIORATING when current magnitude > 1.1 × mean', () => {
    // historical: [0.10, 0.12, 0.10, 0.12] → mean=0.11, stdDev≈0.01155
    // current=0.20 → ratio = 0.20/0.11 ≈ 1.82 > 1.1 → DETERIORATING
    const result = computeZScore({
      currentValue: 0.20,
      historicalValues: [0.10, 0.12, 0.10, 0.12],
      thresholds,
    });

    expect(result.mean).toBeCloseTo(0.11, 6);
    expect(result.trend).toBe('DETERIORATING');
    expect(result.zScore).not.toBeNull();
  });

  // ---- 10. Trend IMPROVING: current < 0.9 × mean ----
  it('10. sets trend=IMPROVING when current magnitude < 0.9 × mean', () => {
    // mean=0.11, current=0.05 → ratio = 0.05/0.11 ≈ 0.45 < 0.9 → IMPROVING
    const result = computeZScore({
      currentValue: 0.05,
      historicalValues: [0.10, 0.12, 0.10, 0.12],
      thresholds,
    });

    expect(result.trend).toBe('IMPROVING');
    expect(result.zScore).not.toBeNull();
  });

  // ---- 11. Trend STABLE: current within 0.9-1.1 × mean ----
  it('11. sets trend=STABLE when current magnitude is within 0.9-1.1 × mean', () => {
    // mean=0.11, current=0.11 → ratio = 1.0 → STABLE
    const result = computeZScore({
      currentValue: 0.11,
      historicalValues: [0.10, 0.12, 0.10, 0.12],
      thresholds,
    });

    expect(result.mean).toBeCloseTo(0.11, 6);
    expect(result.trend).toBe('STABLE');
  });

  // ---- 12. benchmarkFlag HISTORICAL_HIGH: zScore > HIGH threshold ----
  it('12. sets benchmarkFlag=HISTORICAL_HIGH when zScore > HIGH threshold (2.0)', () => {
    // historical=[0.12, 0.18, 0.14, 0.16], current=0.45 → zScore≈11.62 > 2.0
    const result = computeZScore({
      currentValue: 0.45,
      historicalValues: [0.12, 0.18, 0.14, 0.16],
      thresholds,
    });

    expect(result.zScore).not.toBeNull();
    expect(result.zScore!).toBeGreaterThan(thresholds.HISTORICAL_ZSCORE_HIGH);
    expect(result.benchmarkFlag).toBe('HISTORICAL_HIGH');
  });

  // ---- 13. benchmarkFlag HISTORICAL_WARNING: WARN < zScore ≤ HIGH ----
  it('13. sets benchmarkFlag=HISTORICAL_WARNING when WARN < zScore ≤ HIGH', () => {
    // historical=[1,2,3,4] → mean=2.5, stdDev≈1.291
    // current=5.0 → zScore=(5.0-2.5)/1.291 ≈ 1.936 → 1.5 < z ≤ 2.0 → HISTORICAL_WARNING
    const result = computeZScore({
      currentValue: 5.0,
      historicalValues: [1, 2, 3, 4],
      thresholds,
    });

    expect(result.zScore).not.toBeNull();
    expect(result.zScore!).toBeGreaterThan(thresholds.HISTORICAL_ZSCORE_WARN);
    expect(result.zScore!).toBeLessThanOrEqual(thresholds.HISTORICAL_ZSCORE_HIGH);
    expect(result.benchmarkFlag).toBe('HISTORICAL_WARNING');
    expect(result.warningLevel).toBe('WARNING');
  });

  // ---- 14. warningLevel: ABNORMAL / WARNING / NORMAL ----
  describe('14. warningLevel classification', () => {
    it('14a. sets warningLevel=ABNORMAL when zScore > HIGH threshold', () => {
      // zScore ≈ 11.62 → ABNORMAL
      const result = computeZScore({
        currentValue: 0.45,
        historicalValues: [0.12, 0.18, 0.14, 0.16],
        thresholds,
      });
      expect(result.zScore!).toBeGreaterThan(thresholds.HISTORICAL_ZSCORE_HIGH);
      expect(result.warningLevel).toBe('ABNORMAL');
    });

    it('14b. sets warningLevel=WARNING when WARN < zScore ≤ HIGH', () => {
      // zScore ≈ 1.936 → WARNING
      const result = computeZScore({
        currentValue: 5.0,
        historicalValues: [1, 2, 3, 4],
        thresholds,
      });
      expect(result.warningLevel).toBe('WARNING');
    });

    it('14c. sets warningLevel=NORMAL when zScore ≤ WARN threshold', () => {
      // historical=[1,2,3,4] mean=2.5, current=3.0 → zScore=(3.0-2.5)/1.291≈0.387 → NORMAL
      const result = computeZScore({
        currentValue: 3.0,
        historicalValues: [1, 2, 3, 4],
        thresholds,
      });
      expect(result.zScore!).toBeLessThanOrEqual(thresholds.HISTORICAL_ZSCORE_WARN);
      expect(result.warningLevel).toBe('NORMAL');
      // benchmarkFlag must be null for NORMAL
      expect(result.benchmarkFlag).toBeNull();
    });

    it('14d. sets warningLevel=NONE when zScore is null (insufficient data)', () => {
      const result = computeZScore({
        currentValue: 0.45,
        historicalValues: [0.12, 0.18, 0.14], // n=3 < 4
        thresholds,
      });
      expect(result.zScore).toBeNull();
      expect(result.warningLevel).toBe('NONE');
    });
  });

  // ---- 15. Edge: mean=0, current>0 → DETERIORATING (deviation onset from zero base) ----
  it('15. sets trend=DETERIORATING when mean=0 and current > 0 (zero-base deviation onset)', () => {
    // All historical = 0 → mean=0, stdDev=0 → zScore=null, but trend=DETERIORATING
    const result = computeZScore({
      currentValue: 0.05,
      historicalValues: [0, 0, 0, 0],
      thresholds,
    });

    expect(result.mean).toBe(0);
    expect(result.stdDev).toBe(0);
    expect(result.zScore).toBeNull(); // stdDev=0 → zScore null
    expect(result.trend).toBe('DETERIORATING');
    expect(result.warningLevel).toBe('NONE');
    expect(result.benchmarkFlag).toBeNull();
  });
});

// ============================================================
//  calcZScoreFromStats()
// ============================================================
describe('calcZScoreFromStats', () => {
  // ---- 1. Normal case ----
  it('1. computes zScore = (|value| - mean) / stdDev for normal inputs', () => {
    // value=45, mean=15, stdDev=8 → (45-15)/8 = 3.75
    const result = calcZScoreFromStats(45, 15, 8);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(3.75, 6);
  });

  // ---- 2. value = null → null ----
  it('2. returns null when value is null', () => {
    const result = calcZScoreFromStats(null, 15, 8);
    expect(result).toBeNull();
  });

  // ---- 3. stdDev = 0 → null ----
  it('3. returns null when stdDev is 0', () => {
    const result = calcZScoreFromStats(45, 15, 0);
    expect(result).toBeNull();
  });

  // ---- 4. Negative value → ABS used ----
  it('4. uses Math.abs(value) so negative value produces same zScore as positive', () => {
    // value=-45 → (45-15)/8 = 3.75 (same as positive 45)
    const result = calcZScoreFromStats(-45, 15, 8);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(3.75, 6);
  });

  // ---- Additional edge: value=0 below mean → negative zScore (better than historical) ----
  it('5. handles value=0 correctly (returns negative zScore — current below mean = better)', () => {
    // value=0, mean=15, stdDev=8 → (|0| - 15) / 8 = -1.875 (signed: below mean = better)
    const result = calcZScoreFromStats(0, 15, 8);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(-1.875, 6);
  });
});
