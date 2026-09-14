// Tests for /api/outlet-items services/resolve-period — the FIX (BUG-3-c R-9)
// port of the previous inline period-resolution copy to the shared
// @/lib/period-resolver. These tests pin the THREE divergences the port
// closed (same-month cross-week guard, compareWeek-without-compareMonth
// search, no-self-compare) at the SERVICE level — the resolver itself is
// covered by tests/lib/period-resolver.test.ts.
//
// resolveOutletAndPeriod touches db.outlet.findFirst (outlet lookup),
// db.sourceFile.findMany (month resolver + period tables), db.week.findMany
// (period tables) and db.setting.findMany (runtime thresholds) — all mocked
// here following the same vi.hoisted pattern as the sibling test files.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveOutletAndPeriod } from '@/app/api/outlet-items/services/resolve-period';
import { EarlyHttpResponse } from '@/lib/early-http-response';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { invalidateSettingsCache } from '@/lib/settings';

const { mockOutletFindFirst, mockWeekFindMany, mockSourceFileFindMany, mockSettingFindMany } = vi.hoisted(() => ({
  mockOutletFindFirst: vi.fn(),
  mockWeekFindMany: vi.fn(),
  mockSourceFileFindMany: vi.fn(),
  mockSettingFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    outlet: { findFirst: mockOutletFindFirst },
    week: { findMany: mockWeekFindMany },
    sourceFile: { findMany: mockSourceFileFindMany },
    setting: { findMany: mockSettingFindMany, createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OUTLET = { id: 1, code: '1016.MLGJAK', name: 'Malang Jakarta', area: 'JAWA TIMUR 1' };

// Month/period fixture: Juli 2026 (W1,W2) + Agustus 2026 (W1,W2,W4).
// db.sourceFile.findMany feeds BOTH the month resolver and the period tables;
// db.week.findMany feeds the period tables.
function setupPeriods() {
  mockWeekFindMany.mockReset().mockResolvedValue([
    { weekLabel: 'WEEK 1', monthKey: '2026-07' },
    { weekLabel: 'WEEK 2', monthKey: '2026-07' },
    { weekLabel: 'WEEK 1', monthKey: '2026-08' },
    { weekLabel: 'WEEK 2', monthKey: '2026-08' },
    { weekLabel: 'WEEK 4', monthKey: '2026-08' },
  ]);
  mockSourceFileFindMany.mockReset().mockResolvedValue([
    { monthLabel: 'Juli 2026', monthKey: '2026-07' },
    { monthLabel: 'Agustus 2026', monthKey: '2026-08' },
  ]);
}

beforeEach(() => {
  mockOutletFindFirst.mockReset().mockResolvedValue(OUTLET);
  mockSettingFindMany.mockReset().mockResolvedValue([]);
  setupPeriods();
  // The month resolver + settings cache live at module scope — reset them so
  // each test seeds its own fixture (mirrors the mutation-route contract).
  clearMonthResolverCache();
  invalidateSettingsCache();
});

describe('resolveOutletAndPeriod — FIX (BUG-3-c R-9) port to shared period-resolver', () => {
  it('auto path: resolves the same weekLabel in the chronologically previous month', async () => {
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'Agustus 2026', week: 'WEEK 2',
      compareWeek: null, compareMonthRaw: null,
    });
    expect(r.prevWeek).toBe('WEEK 2');
    expect(r.prevMonth).toBe('Juli 2026');
    expect(r.month).toBe('Agustus 2026');
    expect(r.outlet).toEqual(OUTLET);
    expect(r.thresholds).toBeTruthy();
  });

  it('auto path: no same-weekLabel in any previous month → {null, null} (no fallback)', async () => {
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'Agustus 2026', week: 'WEEK 4',
      compareWeek: null, compareMonthRaw: null,
    });
    // WEEK 4 exists only in Agustus — cumulative weeks make a cross-week
    // fallback meaningless, so no comparison.
    expect(r.prevWeek).toBe(null);
    expect(r.prevMonth).toBe(null);
  });

  it('FIX R-9 (a): same-month cross-week explicit compare is refused → {null, null}', async () => {
    // W4 current vs W1 of the SAME month used to run the comparison — a
    // 25-day cumulative window against a 7-day one (false "growth").
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'Agustus 2026', week: 'WEEK 4',
      compareWeek: 'WEEK 1', compareMonthRaw: 'Agustus 2026',
    });
    expect(r.prevWeek).toBe(null);
    expect(r.prevMonth).toBe(null);
    expect(r.compareMonth).toBe('Agustus 2026'); // explicit month still echoed
  });

  it('FIX R-9 (b): compareWeek WITHOUT compareMonth now finds the same weekLabel in a previous month', async () => {
    // Old inline behavior: prevMonth=null → the comparison silently vanished
    // (fetch-records guards `prevWeek && prevMonth`). Now Case 3 searches for
    // WEEK 2 in a month before Agustus → Juli WEEK 2.
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'Agustus 2026', week: 'WEEK 1',
      compareWeek: 'WEEK 2', compareMonthRaw: null,
    });
    expect(r.prevWeek).toBe('WEEK 2');
    expect(r.prevMonth).toBe('Juli 2026');
  });

  it('FIX R-9 (c): compareWeek equal to the current week (no compareMonth) resolves to a PREVIOUS month, never a self-compare', async () => {
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'Agustus 2026', week: 'WEEK 2',
      compareWeek: 'WEEK 2', compareMonthRaw: null,
    });
    // The backwards search only accepts monthLabel !== month — the current
    // period itself can never be picked as its own comparison baseline.
    expect(r.prevWeek).toBe('WEEK 2');
    expect(r.prevMonth).toBe('Juli 2026');
  });

  it('compareWeek without compareMonth and no same weekLabel elsewhere → prevMonth null (clean no-comparison)', async () => {
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'Agustus 2026', week: 'WEEK 1',
      compareWeek: 'WEEK 9', compareMonthRaw: null,
    });
    expect(r.prevMonth).toBe(null);
  });

  it('re-resolves the month label to the actual DB case before period resolution', async () => {
    const r = await resolveOutletAndPeriod({
      outletCode: OUTLET.code, month: 'agustus 2026', week: 'WEEK 2',
      compareWeek: null, compareMonthRaw: 'JULI 2026',
    });
    // FIX-DEEP-1: lowercase user input maps to the DB-case label, which then
    // drives the period search (an unresolved case would find 0 periods).
    expect(r.month).toBe('Agustus 2026');
    expect(r.compareMonth).toBe('Juli 2026');
    expect(r.prevWeek).toBe('WEEK 2');
    expect(r.prevMonth).toBe('Juli 2026');
  });

  it('throws EarlyHttpResponse (404) when the outlet does not exist', async () => {
    mockOutletFindFirst.mockResolvedValueOnce(null);
    await expect(
      resolveOutletAndPeriod({
        outletCode: '9999.NOPE', month: 'Agustus 2026', week: 'WEEK 2',
        compareWeek: null, compareMonthRaw: null,
      }),
    ).rejects.toBeInstanceOf(EarlyHttpResponse);
  });
});
