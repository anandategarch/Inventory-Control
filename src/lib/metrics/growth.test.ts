import { describe, it, expect } from 'vitest';
import { calcGrowth, calcGrowthAbs, computeGrowthResult, computeNominalDeviationGrowth } from '@/lib/metrics/growth';

describe('calcGrowth', () => {
  it('returns null when curr or prev is null', () => {
    expect(calcGrowth(null, 100)).toBe(null);
    expect(calcGrowth(100, null)).toBe(null);
    expect(calcGrowth(null, null)).toBe(null);
  });

  it('returns null when prev = 0 and curr != 0 (can\'t compute from zero base)', () => {
    expect(calcGrowth(100, 0)).toBe(null);
  });

  it('returns 0 when both curr and prev are 0', () => {
    expect(calcGrowth(0, 0)).toBe(0);
  });

  it('computes (curr - prev) / |prev|', () => {
    expect(calcGrowth(150, 100)).toBe(0.5); // +50%
    expect(calcGrowth(50, 100)).toBe(-0.5); // -50%
    expect(calcGrowth(100, 100)).toBe(0); // 0%
  });

  it('uses ABS of prev (handles negative prev)', () => {
    // (50 - (-100)) = 150, / |-100| = 1.5
    expect(calcGrowth(50, -100)).toBe(1.5);
  });
});

describe('calcGrowthAbs', () => {
  it('returns null when curr or prev is null', () => {
    expect(calcGrowthAbs(null, 100)).toBe(null);
    expect(calcGrowthAbs(100, null)).toBe(null);
  });

  it('returns null when |prev| = 0 and |curr| != 0', () => {
    expect(calcGrowthAbs(100, 0)).toBe(null);
  });

  it('returns 0 when both are 0', () => {
    expect(calcGrowthAbs(0, 0)).toBe(0);
  });

  it('computes (|curr| - |prev|) / |prev| (magnitude)', () => {
    expect(calcGrowthAbs(150, 100)).toBe(0.5); // +50%
    expect(calcGrowthAbs(50, 100)).toBe(-0.5); // -50%
  });

  it('treats negative values same as positive (magnitude only)', () => {
    expect(calcGrowthAbs(-150, 100)).toBe(0.5); // same as (150, 100)
    expect(calcGrowthAbs(150, -100)).toBe(0.5); // same as (150, 100)
    expect(calcGrowthAbs(-150, -100)).toBe(0.5); // same as (150, 100)
  });
});

describe('computeGrowthResult', () => {
  it('returns NEW when prev = 0 and curr != 0', () => {
    const result = computeGrowthResult(100, 0, 0.1);
    expect(result.trend).toBe('NEW');
  });

  it('returns RESOLVED when curr = null and prev != 0', () => {
    const result = computeGrowthResult(null, 100, 0.1);
    expect(result.trend).toBe('RESOLVED');
  });

  it('returns STABLE when growth < threshold', () => {
    const result = computeGrowthResult(105, 100, 0.1); // 5% < 10%
    expect(result.trend).toBe('STABLE');
  });

  it('returns INCREASING when growth > threshold', () => {
    const result = computeGrowthResult(120, 100, 0.1); // 20% > 10%
    expect(result.trend).toBe('INCREASING');
  });

  it('returns DECREASING when growth < -threshold', () => {
    const result = computeGrowthResult(80, 100, 0.1); // -20% < -10%
    expect(result.trend).toBe('DECREASING');
  });

  it('detects direction flip (sign change)', () => {
    const result = computeGrowthResult(100, -100, 0.1);
    expect(result.isDirectionFlip).toBe(true);
  });

  it('no direction flip when same sign', () => {
    const result = computeGrowthResult(120, 100, 0.1);
    expect(result.isDirectionFlip).toBe(false);
  });
});

describe('computeNominalDeviationGrowth', () => {
  it('returns null when curr or prev is null', () => {
    expect(computeNominalDeviationGrowth(null, 100)).toBe(null);
    expect(computeNominalDeviationGrowth(100, null)).toBe(null);
  });

  it('returns null when prev = 0', () => {
    expect(computeNominalDeviationGrowth(100, 0)).toBe(null);
  });

  it('computes magnitude growth: (|curr| - |prev|) / |prev|', () => {
    expect(computeNominalDeviationGrowth(150, 100)).toBe(0.5);
    expect(computeNominalDeviationGrowth(50, 100)).toBe(-0.5);
  });

  it('handles negative values (magnitude)', () => {
    // |−150| - |−100| = 50, / 100 = 0.5
    expect(computeNominalDeviationGrowth(-150, -100)).toBe(0.5);
    // |150| - |−100| = 50, / 100 = 0.5
    expect(computeNominalDeviationGrowth(150, -100)).toBe(0.5);
  });
});
