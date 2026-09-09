// Tests for period-resolver — resolveComparePeriod + resolvePreviousPeriod.
// Both functions use db.week.findMany + db.sourceFile.findMany (mocked here).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveComparePeriod, resolvePreviousPeriod } from '@/lib/period-resolver';

const { mockWeekFindMany, mockSourceFileFindMany } = vi.hoisted(() => ({
  mockWeekFindMany: vi.fn(),
  mockSourceFileFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    week: { findMany: mockWeekFindMany },
    sourceFile: { findMany: mockSourceFileFindMany },
  },
}));

// Build a sequence of (month, week) periods. monthKey is YYYY-MM format.
// Returns the input shape for db.week.findMany + db.sourceFile.findMany.
function setupPeriods(periods: Array<{ month: string; week: string; monthKey: string }>) {
  mockWeekFindMany.mockResolvedValueOnce(
    periods.map((p) => ({ weekLabel: p.week, monthKey: p.monthKey })),
  );
  mockSourceFileFindMany.mockResolvedValueOnce(
    periods.map((p) => ({ monthLabel: p.month, monthKey: p.monthKey })),
  );
}

describe('resolveComparePeriod — Case 2: explicit compareWeek + compareMonth', () => {
  beforeEach(() => {
    mockWeekFindMany.mockReset();
    mockSourceFileFindMany.mockReset();
  });

  it('returns the explicit values directly (no DB lookup)', async () => {
    const r = await resolveComparePeriod('WEEK 1', 'Agustus 2026', 'WEEK 2', 'Juli 2026');
    expect(r).toEqual({ prevWeek: 'WEEK 2', prevMonth: 'Juli 2026' });
    expect(mockWeekFindMany).not.toHaveBeenCalled();
    expect(mockSourceFileFindMany).not.toHaveBeenCalled();
  });
});

describe('resolveComparePeriod — Case 1: auto-previous (compareWeek null)', () => {
  beforeEach(() => {
    mockWeekFindMany.mockReset();
    mockSourceFileFindMany.mockReset();
  });

  it('returns same weekLabel in chronologically previous month', async () => {
    // Months: Juni 2026 (2026-06), Juli 2026 (2026-07), Agustus 2026 (2026-08)
    // Each has WEEK 1, WEEK 2.
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 1', monthKey: '2026-06' },
      { month: 'Juni 2026', week: 'WEEK 2', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Juli 2026', week: 'WEEK 2', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
      { month: 'Agustus 2026', week: 'WEEK 2', monthKey: '2026-08' },
    ]);
    const r = await resolveComparePeriod('WEEK 2', 'Agustus 2026', null, null);
    expect(r).toEqual({ prevWeek: 'WEEK 2', prevMonth: 'Juli 2026' });
  });

  it('returns {null, null} when no previous period exists', async () => {
    setupPeriods([
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
    ]);
    const r = await resolveComparePeriod('WEEK 1', 'Agustus 2026', null, null);
    expect(r).toEqual({ prevWeek: null, prevMonth: null });
  });

  it('returns {null, null} when same weekLabel not found backwards (FIX AUDIT-BUG-2: no chronological fallback)', async () => {
    // Agustus WEEK 4 — no WEEK 4 in previous months → NO comparison.
    // FIX (AUDIT-BUG-2): weeks are CUMULATIVE — cross-week comparison (e.g. W2
    // vs W1 same month) produces false ~-50% growth. The old code fell back to
    // the chronological previous period (Juli WEEK 2) — a mismatched-week pair.
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 1', monthKey: '2026-06' },
      { month: 'Juni 2026', week: 'WEEK 2', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Juli 2026', week: 'WEEK 2', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 4', monthKey: '2026-08' },
    ]);
    const r = await resolveComparePeriod('WEEK 4', 'Agustus 2026', null, null);
    // No WEEK 4 in previous months → no comparison (was: Juli WEEK 2)
    expect(r.prevMonth).toBe(null);
    expect(r.prevWeek).toBe(null);
  });

  it('skips over an intervening month without the same weekLabel and finds the older same-week period', async () => {
    // Current = Agustus WEEK 2; Juli has no WEEK 2; Juni has WEEK 2 → Juni WEEK 2 wins
    // (search goes ALL the way back, not just the immediately previous month).
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 2', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 2', monthKey: '2026-08' },
    ]);
    const r = await resolveComparePeriod('WEEK 2', 'Agustus 2026', null, null);
    expect(r).toEqual({ prevWeek: 'WEEK 2', prevMonth: 'Juni 2026' });
  });
});

describe('resolveComparePeriod — Case 3: compareWeek set, compareMonth null', () => {
  beforeEach(() => {
    mockWeekFindMany.mockReset();
    mockSourceFileFindMany.mockReset();
  });

  it('searches BACKWARDS for same weekLabel in a different month', async () => {
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 2', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 2', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
    ]);
    // Current = Agustus WEEK 1, compareWeek = WEEK 2 → search backwards for WEEK 2 in different month
    const r = await resolveComparePeriod('WEEK 1', 'Agustus 2026', 'WEEK 2', null);
    expect(r).toEqual({ prevWeek: 'WEEK 2', prevMonth: 'Juli 2026' });
  });

  it('does NOT search forward — returns null prevMonth when not found backwards (API-03 fix)', async () => {
    // API-03 FIX: Forward search was removed — a future period as "previous"
    // is semantically wrong (growth vs future = nonsense).
    // Current = Juni WEEK 2; compareWeek = WEEK 1 — no WEEK 1 before Juni.
    // Old behavior: searched forward → found Juli WEEK 1 (FUTURE = wrong).
    // New behavior: returns null prevMonth (no comparison data).
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 2', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
    ]);
    const r = await resolveComparePeriod('WEEK 2', 'Juni 2026', 'WEEK 1', null);
    expect(r.prevMonth).toBe(null);
    expect(r.prevWeek).toBe('WEEK 1');
  });

  it('returns null prevMonth when weekLabel not found in any other month', async () => {
    // AUDIT8-ROLLBACK-1, Item 20: do NOT fall back to current month.
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 1', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
    ]);
    const r = await resolveComparePeriod('WEEK 1', 'Agustus 2026', 'WEEK 5', null);
    expect(r.prevMonth).toBe(null);
    expect(r.prevWeek).toBe('WEEK 5');
  });
});

describe('resolvePreviousPeriod', () => {
  beforeEach(() => {
    mockWeekFindMany.mockReset();
    mockSourceFileFindMany.mockReset();
  });

  it('returns same weekLabel in chronologically previous month', async () => {
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 1', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
    ]);
    const r = await resolvePreviousPeriod('WEEK 1', 'Agustus 2026');
    expect(r).toEqual({ prevWeek: 'WEEK 1', prevMonth: 'Juli 2026' });
  });

  it('returns {null, null} when no previous period exists', async () => {
    setupPeriods([
      { month: 'Agustus 2026', week: 'WEEK 1', monthKey: '2026-08' },
    ]);
    const r = await resolvePreviousPeriod('WEEK 1', 'Agustus 2026');
    expect(r).toEqual({ prevWeek: null, prevMonth: null });
  });

  it('returns {null, null} when same weekLabel not found (FIX AUDIT-BUG-2: no chronological fallback)', async () => {
    setupPeriods([
      { month: 'Juni 2026', week: 'WEEK 1', monthKey: '2026-06' },
      { month: 'Juli 2026', week: 'WEEK 1', monthKey: '2026-07' },
      { month: 'Agustus 2026', week: 'WEEK 4', monthKey: '2026-08' },
    ]);
    // Current = Agustus WEEK 4; no WEEK 4 before → NO comparison.
    // Old behavior fell back to the chronological previous period (Juli WEEK 1)
    // — mismatched weeks produce false ~-50% growth (weeks are cumulative).
    const r = await resolvePreviousPeriod('WEEK 4', 'Agustus 2026');
    expect(r.prevMonth).toBe(null);
    expect(r.prevWeek).toBe(null);
  });
});
