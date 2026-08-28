// Tests for src/lib/queries/shared.ts — pure helpers + SQL fragment builders.
// computePareto8020 is a pure function (sort + cumsum + threshold).
// buildSqlFilters builds a Prisma.Sql fragment (no DB call) — tested by
// inspecting the resulting SQL text + parameter values.
// DIRECTION_FROM_SUM_SQL is a Prisma.sql constant.
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  computePareto8020,
  buildSqlFilters,
  DIRECTION_FROM_SUM_SQL,
} from '@/lib/queries/shared';

// Helper: extract SQL text from a Prisma.Sql.
// Prisma.Sql exposes .strings (array of text fragments) + .values (array of params).
function sqlText(sql: Prisma.Sql): string {
  const s = (sql as unknown as { strings?: unknown[] }).strings;
  if (Array.isArray(s)) return s.join('$PARAM$');
  return String(sql);
}

// Helper: extract parameter values from a Prisma.Sql.
function sqlValues(sql: Prisma.Sql): unknown[] {
  const v = (sql as unknown as { values?: unknown[] }).values;
  return Array.isArray(v) ? v : [];
}

describe('computePareto8020', () => {
  it('returns empty drivers + 0 magnitude when input is empty', () => {
    const r = computePareto8020([], (r) => r);
    expect(r.drivers).toEqual([]);
    expect(r.totalMagnitude).toBe(0);
    expect(r.totalCount).toBe(0);
  });

  it('returns empty drivers when totalMagnitude is 0 (all zeros)', () => {
    const r = computePareto8020(
      [{ v: 0 }, { v: 0 }, { v: 0 }],
      (x) => x.v,
    );
    expect(r.drivers).toEqual([]);
    expect(r.totalMagnitude).toBe(0);
    expect(r.totalCount).toBe(3);
  });

  it('sorts by |value| descending', () => {
    const rows = [{ v: 10 }, { v: 50 }, { v: 30 }];
    // threshold=1.0 so all drivers are included (no early break).
    const r = computePareto8020(rows, (x) => x.v, 1.0, 20);
    expect(r.drivers.map((d) => d.v)).toEqual([50, 30, 10]);
  });

  it('uses absolute value for sorting (negative values)', () => {
    const rows = [{ v: -100 }, { v: 50 }, { v: -75 }];
    const r = computePareto8020(rows, (x) => x.v);
    expect(r.drivers.map((d) => d.v)).toEqual([-100, -75, 50]);
  });

  it('accumulates sharePct + cumPct correctly', () => {
    // Total = 100+50+30+20 = 200. Shares: 50%, 25%, 15%, 10%
    const rows = [{ v: 100 }, { v: 50 }, { v: 30 }, { v: 20 }];
    const r = computePareto8020(rows, (x) => x.v, 0.80, 20);
    // cum: 50, 75, 90 → threshold 80% crossed at driver 3 → stops.
    expect(r.drivers.length).toBe(3);
    expect(r.drivers[0].sharePct).toBe(50);
    expect(r.drivers[0].cumPct).toBe(50);
    expect(r.drivers[1].sharePct).toBe(25);
    expect(r.drivers[1].cumPct).toBe(75);
    expect(r.drivers[2].cumPct).toBe(90); // crossed 80% threshold here → stops
    expect(r.remainderCount).toBe(1);
    expect(r.remainderPct).toBe(10); // 100 - 90 = 10
  });

  it('respects maxDrivers limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ v: 100 - i * 10 }));
    const r = computePareto8020(rows, (x) => x.v, 1.0, 3); // threshold 100% so only maxDrivers limits
    expect(r.drivers.length).toBe(3);
    expect(r.remainderCount).toBe(7);
  });

  it('rounds sharePct + cumPct to 1 decimal', () => {
    // Total = 3 → shares = 33.33%, 33.33%, 33.33%
    const rows = [{ v: 1 }, { v: 1 }, { v: 1 }];
    const r = computePareto8020(rows, (x) => x.v, 1.0, 20);
    expect(r.drivers[0].sharePct).toBe(33.3);
    expect(r.drivers[0].cumPct).toBe(33.3);
  });

  it('returns drivers with original row data spread in (WithPareto<T>)', () => {
    const rows = [{ v: 10, name: 'X' }];
    const r = computePareto8020(rows, (x) => x.v);
    expect(r.drivers[0]).toHaveProperty('name', 'X');
    expect(r.drivers[0]).toHaveProperty('v', 10);
    expect(r.drivers[0]).toHaveProperty('sharePct');
    expect(r.drivers[0]).toHaveProperty('cumPct');
  });

  it('remainderPct is never negative (clamped to 0)', () => {
    // Single row at 100% share → remainder = 0
    const rows = [{ v: 100 }];
    const r = computePareto8020(rows, (x) => x.v);
    expect(r.drivers.length).toBe(1);
    expect(r.remainderPct).toBe(0);
  });
});

describe('DIRECTION_FROM_SUM_SQL', () => {
  it('is a Prisma.Sql fragment', () => {
    expect(DIRECTION_FROM_SUM_SQL).toBeDefined();
    const text = sqlText(DIRECTION_FROM_SUM_SQL);
    expect(text).toContain('CASE');
    expect(text).toContain('LOSS');
    expect(text).toContain('SURPLUS');
    expect(text).toContain('NEUTRAL');
    expect(text).toContain('nominalLossSurplus');
    expect(text).toContain('qtyDeviasi');
  });

  it('has 5 branches (2 nominal + 2 qty fallback + ELSE)', () => {
    const text = sqlText(DIRECTION_FROM_SUM_SQL);
    // WHEN count (5 branches = 4 WHEN + 1 ELSE)
    const whenCount = (text.match(/WHEN/g) || []).length;
    expect(whenCount).toBe(4);
  });
});

describe('buildSqlFilters', () => {
  it('returns empty fragment when no filters apply', () => {
    const f = buildSqlFilters({});
    const text = sqlText(f);
    expect(text.trim()).toBe('');
    expect(sqlValues(f)).toEqual([]);
  });

  it('adds area filter when area is provided', () => {
    const f = buildSqlFilters({ area: 'JAWA TIMUR 1' });
    const text = sqlText(f);
    expect(text).toContain('.area =');
    expect(text).toContain('ir'); // default alias
    expect(sqlValues(f)).toContain('JAWA TIMUR 1');
  });

  it('respects custom alias (e.g. "c" for self-join queries)', () => {
    const f = buildSqlFilters({ area: 'X' }, 'c');
    const text = sqlText(f);
    expect(text).toContain('c.area');
  });

  it('adds kelompok filter via LEFT(SUBSTRING(...), 3) extraction', () => {
    const f = buildSqlFilters({ kelompok: 'BDG' });
    const text = sqlText(f);
    // Build the expected substring dynamically to avoid parser confusion with the literal.
    const expected = ['LEFT(', 'SUBSTRING(code ', 'FROM'].join('');
    expect(text).toContain(expected);
    expect(text).toContain('UPPER(');
    expect(text).toContain('"Outlet"');
    expect(sqlValues(f)).toContain('BDG');
  });

  it('adds outletCode filter via subquery on Outlet.code', () => {
    const f = buildSqlFilters({ outletCode: '1251.CBIPAS' });
    const text = sqlText(f);
    expect(text).toContain('"outletId" IN (SELECT id FROM "Outlet" WHERE code =');
    expect(sqlValues(f)).toContain('1251.CBIPAS');
  });

  it('adds picOutletCodes filter via IN clause', () => {
    const f = buildSqlFilters({ picOutletCodes: ['A.B1', 'B.C2'] });
    const text = sqlText(f);
    expect(text).toContain('IN (SELECT id FROM "Outlet" WHERE code IN');
    const vals = sqlValues(f);
    expect(vals).toContain('A.B1');
    expect(vals).toContain('B.C2');
  });

  it('skips picOutletCodes filter when array is empty', () => {
    const f = buildSqlFilters({ picOutletCodes: [] });
    const text = sqlText(f);
    expect(text.trim()).toBe('');
  });

  it('adds itemName filter with LOWER() on both sides (case-insensitive)', () => {
    const f = buildSqlFilters({ itemName: 'ayam' });
    const text = sqlText(f);
    expect(text).toContain('LOWER(name) LIKE LOWER');
    // %ayam% is the PARAMETER VALUE (not in SQL text).
    expect(sqlValues(f)).toContain('%ayam%');
  });

  it('combines multiple filters with Prisma.join (space-separated)', () => {
    const f = buildSqlFilters({
      area: 'X',
      outletCode: 'A.B1',
      itemName: 'ayam',
    });
    const text = sqlText(f);
    expect(text).toContain('.area =');
    expect(text).toContain('"outletId" IN');
    expect(text).toContain('LOWER(name) LIKE');
  });

  it('returns the single fragment directly when only 1 filter', () => {
    // branch: parts.length === 1 → return parts[0]
    const f = buildSqlFilters({ area: 'X' });
    const text = sqlText(f);
    expect(text).toContain('.area =');
  });
});
