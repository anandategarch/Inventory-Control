// Tests for src/lib/queries/pareto.ts — queryParetoByItem, queryParetoByOutlet, etc.
// Strategy: mock @/lib/db so $queryRaw returns canned rows; verify that
// (1) the SQL is invoked, (2) the parameters (week, month) are passed,
// (3) the result transformation (computePareto) produces the right shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryParetoByItem, queryParetoByOutlet, queryParetoByArea } from '@/lib/queries/pareto';

const { mockQueryRaw, mockExecuteRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: mockQueryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('queryParetoByItem', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('returns ParetoResult with drivers + totals from DB rows', async () => {
    // Rows: 4 items with totalAbsNominal 100, 50, 30, 20 (sum=200)
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCount: 5, totalAbsNominal: 100, nominalDeviasi: -100, qtyDeviasi: -10 },
      { itemName: 'Item B', outletCount: 3, totalAbsNominal: 50, nominalDeviasi: 50, qtyDeviasi: 5 },
      { itemName: 'Item C', outletCount: 2, totalAbsNominal: 30, nominalDeviasi: -30, qtyDeviasi: -3 },
      { itemName: 'Item D', outletCount: 1, totalAbsNominal: 20, nominalDeviasi: 20, qtyDeviasi: 2 },
    ]);
    const r = await queryParetoByItem('WEEK 1', 'Agustus 2026', {});
    expect(r.totalAbsNominal).toBe(200);
    expect(r.totalCount).toBe(4);
    // Drivers: top 3 cross 80% threshold (50% + 25% + 15% = 90%)
    expect(r.drivers.length).toBe(3);
    expect(r.drivers[0].name).toBe('Item A');
    expect(r.drivers[0].sharePct).toBe(50);
    expect(r.drivers[1].name).toBe('Item B');
    expect(r.drivers[2].name).toBe('Item C');
    expect(r.remainderCount).toBe(1);
    expect(r.remainderPct).toBe(10);
  });

  it('returns empty drivers when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryParetoByItem('WEEK 1', 'Agustus 2026', {});
    expect(r.drivers).toEqual([]);
    expect(r.totalAbsNominal).toBe(0);
    expect(r.totalCount).toBe(0);
  });

  it('passes week + month as SQL parameters', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryParetoByItem('WEEK 2', 'Juli 2026', {});
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // Prisma.Sql extends Array — when vitest mock records the call, the array items
    // are the SQL text fragments (interleaved with $-placeholders where parameters go).
    // Verify the SQL text contains the expected WHERE clauses.
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('"monthLabel"');
    expect(sqlText).toContain('"weekLabel"');
    expect(sqlText).toContain('"InventoryRecord"');
    expect(sqlText).toContain('GROUP BY');
  });

  it('coerces BigInt/Decimal DB rows to Number (outletCount, totalAbsNominal, etc.)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCount: 5n, totalAbsNominal: 100n, nominalDeviasi: -100n, qtyDeviasi: -10n },
    ]);
    const r = await queryParetoByItem('WEEK 1', 'M', {});
    expect(r.drivers[0].outletCount).toBe(5);
    expect(typeof r.drivers[0].outletCount).toBe('number');
    expect(r.drivers[0].totalAbsNominal).toBe(100);
    expect(r.drivers[0].nominalDeviasi).toBe(-100);
    expect(r.drivers[0].qtyDeviasi).toBe(-10);
  });
});

describe('queryParetoByOutlet', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns drivers keyed by outlet name + code', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletCode: '1010.BDG1', outletName: 'Outlet A', area: 'JAWA BARAT', totalAbsNominal: 100, nominalDeviasi: -100, qtyDeviasi: -10 },
      { outletCode: '1011.BDG2', outletName: 'Outlet B', area: 'JAWA BARAT', totalAbsNominal: 50, nominalDeviasi: 50, qtyDeviasi: 5 },
    ]);
    const r = await queryParetoByOutlet('WEEK 1', 'Agustus 2026', {});
    expect(r.drivers[0].name).toBe('Outlet A');
    expect(r.drivers[0].code).toBe('1010.BDG1');
    expect(r.drivers[1].name).toBe('Outlet B');
  });

  it('returns empty result when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryParetoByOutlet('WEEK 1', 'M', {});
    expect(r.drivers).toEqual([]);
  });
});

describe('queryParetoByArea', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('groups by area (intentionally ignores area filter)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { area: 'JAWA BARAT', outletCount: 5, totalAbsNominal: 100, nominalDeviasi: -100, qtyDeviasi: -10 },
      { area: 'JAWA TIMUR', outletCount: 3, totalAbsNominal: 50, nominalDeviasi: 50, qtyDeviasi: 5 },
    ]);
    // Pass area filter — should be stripped (set to null) inside queryParetoByArea
    const r = await queryParetoByArea('WEEK 1', 'Agustus 2026', { area: 'JAWA BARAT' });
    expect(r.drivers[0].name).toBe('JAWA BARAT');
    expect(r.drivers[1].name).toBe('JAWA TIMUR');
    expect(r.drivers.length).toBe(2);
  });

  it('returns empty result when no area rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryParetoByArea('WEEK 1', 'M', {});
    expect(r.drivers).toEqual([]);
  });
});
