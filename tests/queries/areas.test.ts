// Tests for src/lib/queries/areas.ts — queryAreaAnalysis.
// Mock @/lib/db; verify SQL invocation + result transformation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryAreaAnalysis } from '@/lib/queries/areas';

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

describe('queryAreaAnalysis', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns area rows with all expected fields', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        area: 'JAWA BARAT',
        outletCount: 5,
        totalSales: 100_000_000,
        totalAbsNominal: 5_000_000,
        avgDevBom: 0.05,
        lossToSales: 0.02,
      },
      {
        area: 'JAWA TIMUR',
        outletCount: 3,
        totalSales: 50_000_000,
        totalAbsNominal: 2_000_000,
        avgDevBom: 0.08,
        lossToSales: null, // no sales → null
      },
    ]);
    const r = await queryAreaAnalysis('WEEK 1', 'Agustus 2026', {});
    expect(r.length).toBe(2);
    expect(r[0].area).toBe('JAWA BARAT');
    expect(r[0].outletCount).toBe(5);
    expect(r[0].totalSales).toBe(100_000_000);
    expect(r[0].lossToSales).toBe(0.02);
    expect(r[1].lossToSales).toBe(null);
  });

  it('returns empty array when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryAreaAnalysis('WEEK 1', 'M', {});
    expect(r).toEqual([]);
  });

  it('intentionally strips area filter (breakdown covers ALL areas)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryAreaAnalysis('WEEK 1', 'M', { area: 'JAWA BARAT' });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // The query uses a CTE pipeline (area_sales, area_aggs).
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('area_sales');
    expect(sqlText).toContain('area_aggs');
    expect(sqlText).toContain('OutletPeriodSales');
  });

  it('uses InventoryRecord.area (not Outlet.area) for grouping', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryAreaAnalysis('WEEK 1', 'M', {});
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('ir.area');
    expect(sqlText).toContain('fp.area');
  });
});
