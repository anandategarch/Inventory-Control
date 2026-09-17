// Supplementary format tests — covers severityColor, priorityColor,
// and edge cases NOT already covered by src/lib/format.test.ts.
// P23: trendColor tests removed together with the dead helper (zero src callers).
import { describe, it, expect } from 'vitest';
import {
  fmtIDR,
  fmtNum,
  fmtPct,
  fmtPctAbs,
  severityColor,
  priorityColor,
  toNum,
} from '@/lib/format';
describe('severityColor', () => {
  it('returns red styles for ABNORMAL', () => {
    expect(severityColor('ABNORMAL')).toContain('text-red-600');
    expect(severityColor('ABNORMAL')).toContain('bg-red-50');
  });

  it('returns amber styles for WARNING', () => {
    expect(severityColor('WARNING')).toContain('text-amber-600');
    expect(severityColor('WARNING')).toContain('bg-amber-50');
  });

  it('returns emerald styles for NORMAL', () => {
    expect(severityColor('NORMAL')).toContain('text-emerald-600');
    expect(severityColor('NORMAL')).toContain('bg-emerald-50');
  });

  it('returns dark ERROR style', () => {
    expect(severityColor('ERROR')).toContain('text-red-700');
  });

  it('returns muted for unknown severity', () => {
    expect(severityColor('UNKNOWN')).toContain('text-muted-foreground');
    expect(severityColor('')).toContain('text-muted-foreground');
  });
});

describe('priorityColor', () => {
  it('returns red style for P1', () => {
    expect(priorityColor('P1')).toContain('text-red-700');
    expect(priorityColor('P1')).toContain('bg-red-100');
  });

  it('returns amber style for P2', () => {
    expect(priorityColor('P2')).toContain('text-amber-700');
  });

  it('returns sky style for P3', () => {
    expect(priorityColor('P3')).toContain('text-sky-700');
  });

  it('returns muted for unknown priority', () => {
    expect(priorityColor('')).toContain('text-muted-foreground');
    expect(priorityColor('UNKNOWN')).toContain('text-muted-foreground');
  });
});

describe('fmtIDR — non-compact mode', () => {
  it('uses Indonesian locale formatting (id-ID) when compact=false', () => {
    const result = fmtIDR(1_234_567, false);
    expect(result).toContain('Rp');
    expect(result).toContain('1');
  });

  it('non-compact mode still returns "—" for null/NaN', () => {
    expect(fmtIDR(null, false)).toBe('—');
    expect(fmtIDR(NaN, false)).toBe('—');
    expect(fmtIDR(Infinity, false)).toBe('—');
  });
});

describe('fmtNum — non-compact + unit', () => {
  it('non-compact mode uses locale string', () => {
    const result = fmtNum(1_500_000, '', false);
    expect(result).toContain('1');
  });

  it('appends unit in compact mode', () => {
    expect(fmtNum(1_500, 'kg', true)).toContain('kg');
  });

  it('returns "—" for invalid in non-compact', () => {
    expect(fmtNum(null, '', false)).toBe('—');
    expect(fmtNum(NaN, '', false)).toBe('—');
  });
});

describe('fmtPct — sign + digits', () => {
  it('adds + sign by default for positive', () => {
    const result = fmtPct(0.10);
    expect(result).toContain('+');
    expect(result).toContain('10');
  });

  it('disables + sign when withSign=false', () => {
    const result = fmtPct(0.10, false);
    expect(result).not.toContain('+');
    expect(result).toContain('10');
  });

  it('respects digits param', () => {
    const r1 = fmtPct(0.1234, true, 1);
    const r2 = fmtPct(0.1234, true, 2);
    // 0.1234 * 100 = 12.34% → with 1 digit = 12,3%, with 2 digits = 12,34%
    expect(r1).toContain('12,3');
    expect(r2).toContain('12,34');
  });

  it('never adds + sign for negative', () => {
    const result = fmtPct(-0.10);
    expect(result).not.toContain('+');
    expect(result).toContain('-');
  });
});

describe('fmtPctAbs — digits + abs', () => {
  it('respects custom digits', () => {
    const result = fmtPctAbs(-0.1234, 2);
    expect(result).toContain('12,34');
  });

  it('always returns positive magnitude (abs)', () => {
    expect(fmtPctAbs(-0.5)).not.toContain('-');
    expect(fmtPctAbs(0.5)).not.toContain('+');
  });
});

describe('toNum — additional edge cases', () => {
  it('handles numeric strings with whitespace implicitly (Number coerces)', () => {
    // Number(' 42 ') === 42 (trim happens during coercion)
    expect(toNum(' 42 ')).toBe(42);
  });

  it('handles boolean false → 0', () => {
    // Number(false) === 0
    expect(toNum(false)).toBe(0);
  });

  it('handles boolean true → 1', () => {
    expect(toNum(true)).toBe(1);
  });

  it('returns null for object', () => {
    expect(toNum({})).toBe(null);
    expect(toNum({ n: 1 })).toBe(null);
  });

  it('returns null for array', () => {
    expect(toNum([1, 2])).toBe(null);
  });
});
