// Tests for src/lib/queries/outlets/top-outlets.ts
// Covers: queryTopOutlets, queryTopOutletsBySales
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTopOutlets, queryTopOutletsBySales } from '@/lib/queries/outlets/top-outlets';

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

describe('queryTopOutlets', () => {
  beforeEach(() => mockQueryRaw.mockReset());

  it('returns top outlet rows with all expected fields', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletCode: 'JKT-001',
        outletName: 'Outlet Jakarta 1',
        area: 'JAKARTA',
        absNominal: 5_000_000,
        nominalDeviasi: -3_000_000,
        devBom: 0.05,
        direction: 'LOSS',
        sales: 50_000_000,
        lossAmount: 2_000_000,
        surplusAmount: 0,
      },
    ]);
    const r = await queryTopOutlets('WEEK 1', 'Agustus 2026', {}, 10);
    expect(r.length).toBe(1);
    expect(r[0].outletCode).toBe('JKT-001');
    expect(r[0].absNominal).toBe(5_000_000);
    expect(r[0].direction).toBe('LOSS');
  });

  it('returns empty array when no data', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTopOutlets('WEEK 1', 'Agustus 2026', {});
    expect(r).toEqual([]);
  });
});

describe('queryTopOutletsBySales', () => {
  beforeEach(() => mockQueryRaw.mockReset());

  it('returns outlets sorted by sales', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletCode: 'JKT-001',
        outletName: 'Outlet Jakarta 1',
        area: 'JAKARTA',
        sales: 100_000_000,
        nominalDeviasi: -5_000_000,
        devToSalesRatio: 0.05,
      },
      {
        outletCode: 'BDG-001',
        outletName: 'Outlet Bandung 1',
        area: 'JAWA BARAT',
        sales: 80_000_000,
        nominalDeviasi: 2_000_000,
        devToSalesRatio: 0.025,
      },
    ]);
    const r = await queryTopOutletsBySales('WEEK 1', 'Agustus 2026', {}, 10);
    expect(r.length).toBe(2);
    expect(r[0].sales).toBeGreaterThan(r[1].sales);
  });
});
