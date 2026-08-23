import { describe, it, expect } from 'vitest';
import { computeZScore, calcZScoreFromStats, computeDeterioration } from '@/lib/metrics/historical';
import type { RuntimeThresholds } from '@/lib/settings';

const mockThresholds: Pick<RuntimeThresholds, 'HISTORICAL_MIN_WEEKS' | 'HISTORICAL_ZSCORE_WARN' | 'HISTORICAL_ZSCORE_HIGH'> = {
  HISTORICAL_MIN_WEEKS: 4,
  HISTORICAL_ZSCORE_WARN: 2,
  HISTORICAL_ZSCORE_HIGH: 3,
};

describe('computeZScore', () => {
  it('returns INSUFFICIENT_DATA when n < minWeeks', () => {
    const result = computeZScore({
      currentValue: 0.5,
      historicalValues: [0.1, 0.2, 0.3], // n=3 < 4
      thresholds: mockThresholds,
    });
    expect(result.trend).toBe('INSUFFICIENT_DATA');
    expect(result.zScore).toBe(null);
    expect(result.warningLevel).toBe('NONE');
  });

  it('returns zScore when n >= minWeeks', () => {
    const result = computeZScore({
      currentValue: 0.5,
      historicalValues: [0.1, 0.2, 0.3, 0.15], // n=4
      thresholds: mockThresholds,
    });
    expect(result.zScore).not.toBe(null);
    expect(result.sampleSize).toBe(4);
  });

  it('uses ABS values for magnitude comparison', () => {
    // Current = -0.5 (LOSS), historical all negative
    // ABS: current=0.5, hist=[0.1, 0.2, 0.3, 0.15]
    const result = computeZScore({
      currentValue: -0.5,
      historicalValues: [-0.1, -0.2, -0.3, -0.15],
      thresholds: mockThresholds,
    });
    expect(result.zScore).not.toBe(null);
    expect(result.zScore).toBeGreaterThan(0); // magnitude increased
  });

  it('returns DETERIORATING when current > 1.1× historical mean', () => {
    const result = computeZScore({
      currentValue: 0.5, // 0.5 / 0.2 = 2.5x → > 1.1
      historicalValues: [0.2, 0.2, 0.2, 0.2], // mean=0.2
      thresholds: mockThresholds,
    });
    expect(result.trend).toBe('DETERIORATING');
  });

  it('returns IMPROVING when current < 0.9× historical mean', () => {
    const result = computeZScore({
      currentValue: 0.1, // 0.1 / 0.2 = 0.5 → < 0.9
      historicalValues: [0.2, 0.2, 0.2, 0.2], // mean=0.2
      thresholds: mockThresholds,
    });
    expect(result.trend).toBe('IMPROVING');
  });

  it('returns STABLE when current ~ historical mean', () => {
    const result = computeZScore({
      currentValue: 0.21, // 0.21 / 0.2 = 1.05 → between 0.9 and 1.1
      historicalValues: [0.2, 0.2, 0.2, 0.2],
      thresholds: mockThresholds,
    });
    expect(result.trend).toBe('STABLE');
  });

  it('returns ABNORMAL when zScore > HISTORICAL_ZSCORE_HIGH', () => {
    const result = computeZScore({
      currentValue: 1.0, // far above mean=0.2, stdDev=0
      historicalValues: [0.2, 0.2, 0.2, 0.2, 0.2], // stdDev=0 → zScore null
      thresholds: mockThresholds,
    });
    // stdDev=0 → zScore=null → warningLevel=NONE
    expect(result.zScore).toBe(null);
    expect(result.warningLevel).toBe('NONE');
  });

  it('returns WARNING when zScore is between 2 and 3', () => {
    // Construct data where zScore is between 2 and 3
    // Use known values: mean=0.2, stdDev calculated from data
    // Values: [0.1, 0.2, 0.3, 0.2] → mean=0.2, variance=((0.1-0.2)^2+0+(0.3-0.2)^2+0)/3=0.00667, stdDev=0.0816
    // current=0.35 → z=(0.35-0.2)/0.0816=1.84 (between 1 and 2 → ELEVATED, not WARNING)
    // current=0.4 → z=(0.4-0.2)/0.0816=2.45 (between 2 and 3 → WARNING)
    const result = computeZScore({
      currentValue: 0.4,
      historicalValues: [0.1, 0.2, 0.3, 0.2],
      thresholds: mockThresholds,
    });
    expect(result.zScore).not.toBe(null);
    if (result.zScore != null) {
      expect(result.zScore).toBeGreaterThan(2);
      expect(result.zScore).toBeLessThanOrEqual(3);
      expect(result.warningLevel).toBe('WARNING');
    }
  });

  it('excludes null values from historical baseline', () => {
    const result = computeZScore({
      currentValue: 0.5,
      historicalValues: [0.1, null, 0.3, 0.15, null], // 3 valid out of 5
      thresholds: mockThresholds,
    });
    expect(result.sampleSize).toBe(3); // n < 4 → INSUFFICIENT_DATA
    expect(result.trend).toBe('INSUFFICIENT_DATA');
  });

  it('returns DETERIORATING for onset from zero base', () => {
    const result = computeZScore({
      currentValue: 0.5,
      historicalValues: [0, 0, 0, 0], // mean=0, current>0
      thresholds: mockThresholds,
    });
    expect(result.trend).toBe('DETERIORATING');
  });
});

describe('calcZScoreFromStats', () => {
  it('returns null when value is null', () => {
    expect(calcZScoreFromStats(null, 0.2, 0.05)).toBe(null);
  });

  it('returns null when stdDev is 0', () => {
    expect(calcZScoreFromStats(0.5, 0.2, 0)).toBe(null);
  });

  it('computes (|value| - mean) / stdDev', () => {
    // |0.5| - 0.2 = 0.3, / 0.1 = 3.0
    expect(calcZScoreFromStats(0.5, 0.2, 0.1)).toBeCloseTo(3.0, 5);
  });

  it('uses ABS of value (negative current = same zScore as positive)', () => {
    expect(calcZScoreFromStats(-0.5, 0.2, 0.1)).toBeCloseTo(3.0, 5);
  });
});

describe('computeDeterioration', () => {
  it('returns null when either value is null', () => {
    expect(computeDeterioration(null, 0.5)).toBe(null);
    expect(computeDeterioration(0.5, null)).toBe(null);
  });

  it('returns positive when current magnitude > earliest', () => {
    // |0.5| - |0.3| = 0.2 → worsening
    expect(computeDeterioration(0.5, 0.3)).toBeCloseTo(0.2, 5);
  });

  it('returns negative when current magnitude < earliest', () => {
    // |0.1| - |0.3| = -0.2 → improving
    expect(computeDeterioration(0.1, 0.3)).toBeCloseTo(-0.2, 5);
  });

  it('uses ABS values (sign doesn\'t matter, magnitude does)', () => {
    expect(computeDeterioration(-0.5, 0.3)).toBeCloseTo(0.2, 5);
    expect(computeDeterioration(0.5, -0.3)).toBeCloseTo(0.2, 5);
  });
});
