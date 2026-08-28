// Tests for src/lib/queries/health-ranking.ts
// Covers: queryOutletHealthRanking, queryVarianceAnalysis, queryHistoricalCriticalItems
// Mock @/lib/db; verify SQL invocation + result transformation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  queryOutletHealthRanking,
  queryVarianceAnalysis,
  queryHistoricalCriticalItems,
} from '@/lib/queries/health-ranking';

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

describe('queryOutletHealthRanking', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns outlet health rows with all expected fields', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        outletCode: 'JKT-001',
        outletName: 'Outlet Jakarta 1',
        area: 'JAKARTA',
        absNominal: 5_000_000,
        nominalDeviasi: -3_000_000,
        totalQtyDeviasi: 100,
        totalQtyBom: 1000,
        totalQtyWaste: 20,
        totalQtySusut: 10,
        totalQtyTrial: 5,
        totalResidualQty: 50,
        lossNominal: 2_000_000,
        sales: 50_000_000,
        zeroDevCount: 5,
        nonZeroDevCount: 80,
      },
    ]);
    const r = await queryOutletHealthRanking('WEEK 1', 'Agustus 2026', {});
    expect(r.length).toBe(1);
    expect(r[0].outletCode).toBe('JKT-001');
    expect(r[0].absNominal).toBe(5_000_000);
    expect(r[0].zeroDevCount).toBe(5);
    expect(r[0].nonZeroDevCount).toBe(80);
  });

  it('returns empty array when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryOutletHealthRanking('WEEK 1', 'Agustus 2026', {});
    expect(r).toEqual([]);
  });
});

describe('queryVarianceAnalysis', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns empty arrays when prevWeek or prevMonth is null', async () => {
    const r = await queryVarianceAnalysis('WEEK 1', 'Agustus 2026', null, null, {});
    expect(r.topWorsened).toEqual([]);
    expect(r.topImproved).toEqual([]);
  });

  it('returns worsened and improved rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        itemName: 'Bahan A',
        outletCode: 'JKT-001',
        area: 'JAKARTA',
        currentNominal: -5_000_000,
        previousNominal: -1_000_000,
        selisih: -4_000_000,
        currentAbsNominal: 5_000_000,
        previousAbsNominal: 1_000_000,
        delta: 4_000_000,
      },
    ]);
    const r = await queryVarianceAnalysis('WEEK 2', 'Agustus 2026', 'WEEK 1', 'Agustus 2026', {});
    expect(r.topWorsened.length).toBe(1);
    expect(r.topWorsened[0].itemName).toBe('Bahan A');
  });
});

describe('queryHistoricalCriticalItems', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns empty array when flaggedKeys is empty', async () => {
    const r = await queryHistoricalCriticalItems('WEEK 1', 'Agustus 2026', {}, []);
    expect(r).toEqual([]);
  });

  it('returns critical item rows for flagged keys', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'COM DEVIASI - RESTO',
        itemName: 'Bahan A',
        outletCode: 'JKT-001',
        area: 'JAKARTA',
        pctQtyDeviasiToBom: 0.15,
        absNominalDeviasi: 5_000_000,
      },
    ]);
    const r = await queryHistoricalCriticalItems(
      'WEEK 1',
      'Agustus 2026',
      {},
      [{ outletId: 1, itemId: 10, akunPenyesuaian: 'COM DEVIASI - RESTO' }],
    );
    expect(r.length).toBe(1);
    expect(r[0].itemName).toBe('Bahan A');
    expect(r[0].pctQtyDeviasiToBom).toBe(0.15);
  });
});
