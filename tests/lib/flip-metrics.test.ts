// Tests for src/lib/flip-metrics.ts — the H-11 (#4c) SINGLE flip-formula
// module shared by flipHelpers.ts (client), flip-ranking.ts (server), and
// FlipRanking.tsx's drill panel. Locks the formula contract that the three
// former copies used to maintain "by comment convention" only:
//   isFlip / disparity / category thresholds / risk score / risk level.
import { describe, it, expect } from 'vitest';
import {
  flipSign,
  isFlipPair,
  flipDisparity,
  flipDisparityPct,
  categorizeFlipDisparity,
  flipRiskScore,
  flipRiskLevel,
} from '@/lib/flip-metrics';

describe('flipSign', () => {
  it('returns -1 / 0 / +1 only', () => {
    expect(flipSign(-5)).toBe(-1);
    expect(flipSign(0)).toBe(0);
    expect(flipSign(7)).toBe(1);
    expect(flipSign(-0.0001)).toBe(-1);
  });
});

describe('isFlipPair (signs differ AND both non-zero)', () => {
  it('classic flip: +100 vs -98', () => {
    expect(isFlipPair(100, -98)).toBe(true);
    expect(isFlipPair(-98, 100)).toBe(true);
  });

  it('same sign → NOT a flip', () => {
    expect(isFlipPair(10, 20)).toBe(false);
    expect(isFlipPair(-10, -20)).toBe(false);
  });

  it('either side zero → NOT a flip (sign change requires both non-zero)', () => {
    expect(isFlipPair(0, 5)).toBe(false);
    expect(isFlipPair(-5, 0)).toBe(false);
    expect(isFlipPair(0, 0)).toBe(false);
  });
});

describe('flipDisparity (|P1+P2| / MAX(|P1|,|P2|), clamped [0,1])', () => {
  it('perfect cancellation → 0', () => {
    expect(flipDisparity(100, -100)).toBe(0);
  });

  it('nearly balanced reversal → small disparity (sempurna band)', () => {
    // +100 vs -98 → net 2 / 100 = 0.02
    expect(flipDisparity(100, -98)).toBeCloseTo(0.02, 10);
  });

  it('one side dominates → high disparity', () => {
    // +100 vs -10 → net 90 / 100 = 0.9
    expect(flipDisparity(100, -10)).toBeCloseTo(0.9, 10);
  });

  it('both zero → 0 (max magnitude guard)', () => {
    expect(flipDisparity(0, 0)).toBe(0);
  });

  it('clamped to 1 for same-sign pairs (only matters for non-flip classification)', () => {
    // +3 vs +5 → net 8 / max 5 = 1.6 → clamped to 1 (flipHelpers semantics).
    expect(flipDisparity(3, 5)).toBe(1);
  });

  it('flipDisparityPct = disparity × 100', () => {
    expect(flipDisparityPct(100, -98)).toBeCloseTo(2, 10);
    expect(flipDisparityPct(100, -100)).toBe(0);
  });
});

describe('categorizeFlipDisparity (thresholds 10% / 40%)', () => {
  it('disparity < 0.10 → sempurna', () => {
    expect(categorizeFlipDisparity(0)).toBe('sempurna');
    expect(categorizeFlipDisparity(0.0999)).toBe('sempurna');
  });

  it('0.10 ≤ disparity < 0.40 → dominan', () => {
    expect(categorizeFlipDisparity(0.10)).toBe('dominan');
    expect(categorizeFlipDisparity(0.3999)).toBe('dominan');
  });

  it('disparity ≥ 0.40 → parsial', () => {
    expect(categorizeFlipDisparity(0.40)).toBe('parsial');
    expect(categorizeFlipDisparity(1)).toBe('parsial');
  });
});

describe('flipRiskScore / flipRiskLevel (BUG2-FLIP-05 formulas)', () => {
  it('riskScore = min(100, sempurna×30 + flips×10)', () => {
    expect(flipRiskScore(0, 0)).toBe(0);
    expect(flipRiskScore(0, 3)).toBe(30);
    expect(flipRiskScore(1, 3)).toBe(60);
    expect(flipRiskScore(4, 10)).toBe(100); // 4*30+10*10=220 → capped
  });

  it('riskLevel: sempurna>0 → high; else flips>0 → moderate; else low', () => {
    expect(flipRiskLevel(1, 1)).toBe('high');
    expect(flipRiskLevel(0, 2)).toBe('moderate');
    expect(flipRiskLevel(0, 0)).toBe('low');
  });
});
