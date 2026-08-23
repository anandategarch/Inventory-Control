import { describe, it, expect } from 'vitest';
import { fmtIDR, fmtNum, fmtPct, fmtPctAbs, toNum, directionColor, numberColor } from '@/lib/format';

describe('toNum', () => {
  it('returns null for null/undefined', () => {
    expect(toNum(null)).toBe(null);
    expect(toNum(undefined)).toBe(null);
  });

  it('returns null for NaN strings', () => {
    expect(toNum('abc')).toBe(null);
  });

  it('returns null for empty string (FIX H4: was 0, now null)', () => {
    expect(toNum('')).toBe(null);
  });

  it('returns null for Infinity (FIX H5: was Infinity, now null)', () => {
    expect(toNum(Infinity)).toBe(null);
    expect(toNum(-Infinity)).toBe(null);
  });

  it('coerces valid numbers', () => {
    expect(toNum(42)).toBe(42);
    expect(toNum('42')).toBe(42);
    expect(toNum(3.14)).toBe(3.14);
    expect(toNum('3.14')).toBe(3.14);
    expect(toNum(0)).toBe(0);
    expect(toNum(-5)).toBe(-5);
  });

  it('handles BigInt', () => {
    expect(toNum(BigInt(123))).toBe(123);
    expect(toNum(BigInt(0))).toBe(0);
  });
});

describe('fmtIDR', () => {
  it('returns "—" for null/undefined/NaN/Infinity', () => {
    expect(fmtIDR(null)).toBe('—');
    expect(fmtIDR(undefined)).toBe('—');
    expect(fmtIDR(NaN)).toBe('—');
    expect(fmtIDR(Infinity)).toBe('—');
    expect(fmtIDR(-Infinity)).toBe('—');
  });

  it('formats with Indonesian abbreviations (compact)', () => {
    expect(fmtIDR(1_000_000_000)).toBe('Rp 1,00M');
    expect(fmtIDR(1_500_000_000)).toBe('Rp 1,50M');
    expect(fmtIDR(50_000_000)).toBe('Rp 50,00Jt');
    expect(fmtIDR(1_500_000)).toBe('Rp 1,50Jt');
    expect(fmtIDR(50_000)).toBe('Rp 50,0Rb');
    expect(fmtIDR(500)).toBe('Rp 500');
  });

  it('handles negative values with minus sign', () => {
    expect(fmtIDR(-50_000_000)).toBe('-Rp 50,00Jt');
    expect(fmtIDR(-1_000_000_000)).toBe('-Rp 1,00M');
    expect(fmtIDR(-500)).toBe('-Rp 500');
  });

  it('formats zero', () => {
    expect(fmtIDR(0)).toBe('Rp 0');
  });

  it('non-compact mode uses toLocaleString', () => {
    const result = fmtIDR(1_000_000, false);
    expect(result).toContain('Rp');
    expect(result).toContain('1');
    expect(result).toContain('000');
  });
});

describe('fmtNum', () => {
  it('returns "—" for null/undefined/NaN', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(undefined)).toBe('—');
    expect(fmtNum(NaN)).toBe('—');
  });

  it('formats with compact abbreviations', () => {
    expect(fmtNum(1_000_000)).toContain('Jt');
    expect(fmtNum(1_000)).toContain('Rb');
    // FIX MEDIUM (AUDIT-P2): billions now formatted as M (was '1000,00Jt')
    expect(fmtNum(1_000_000_000)).toContain('M');
  });

  it('appends unit when provided', () => {
    expect(fmtNum(42, 'kg')).toContain('kg');
  });
});

describe('fmtPct', () => {
  it('returns "—" for null/undefined/NaN', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(undefined)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
  });

  it('formats decimal as percentage', () => {
    expect(fmtPct(0.5)).toContain('50');
    expect(fmtPct(0.15)).toContain('15');
    expect(fmtPct(1)).toContain('100');
  });
});

describe('fmtPctAbs', () => {
  it('returns "—" for null/undefined', () => {
    expect(fmtPctAbs(null)).toBe('—');
    expect(fmtPctAbs(undefined)).toBe('—');
  });

  it('takes absolute value before formatting', () => {
    expect(fmtPctAbs(-0.5)).toContain('50');
    expect(fmtPctAbs(0.5)).toContain('50');
  });
});

describe('directionColor', () => {
  it('returns red for LOSS', () => {
    expect(directionColor('LOSS')).toBe('text-red-600');
  });

  it('returns emerald for SURPLUS', () => {
    expect(directionColor('SURPLUS')).toBe('text-emerald-600');
  });

  it('returns muted for null/undefined/NEUTRAL', () => {
    expect(directionColor(null)).toBe('text-muted-foreground');
    expect(directionColor(undefined)).toBe('text-muted-foreground');
    expect(directionColor('NEUTRAL')).toBe('text-muted-foreground');
  });
});

describe('numberColor', () => {
  it('returns red for negative', () => {
    expect(numberColor(-5)).toBe('text-red-600');
  });

  it('returns empty string for null/NaN/positive', () => {
    expect(numberColor(null)).toBe('');
    expect(numberColor(NaN)).toBe('');
    expect(numberColor(5)).toBe('');
    expect(numberColor(0)).toBe('');
  });
});
