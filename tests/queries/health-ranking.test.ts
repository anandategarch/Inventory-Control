// Tests for src/lib/queries/health-ranking.ts
// Covers: queryOutletHealthRanking, queryVarianceAnalysis, queryHistoricalCriticalItems
// Mock @/lib/db; verify SQL invocation + result transformation.
//
// H-10 (G1 scan-share): queryOutletHealthRanking now derives from the shared
// queryOutletAggregateScan (q-outlet-agg) — its raw SQL returns the SUPERSET
// row shape (f-prefixed FILTER columns + unfiltered columns), and health
// shapes/filters/sorts in JS. The aggregation-cache is mocked as a passthrough
// so the scan's SQL still runs against the mocked db.$queryRaw.
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

// Passthrough for cachedSharedQuery — the scan's computeFn runs verbatim.
vi.mock('@/lib/aggregation-cache', () => ({
  buildCacheKey: (parts: { route: string; [k: string]: unknown }) =>
    `${parts.route}\x1f${JSON.stringify(parts)}`,
  withCacheAndDedup: async (_key: string, _ttl: number, compute: () => Promise<unknown>) =>
    ({ data: await compute(), cached: false, stale: false }),
}));

vi.mock('@/lib/settings', () => ({
  getRuntimeThresholds: async () => ({ HIGH_LOSS_NOMINAL_THRESHOLD: 50_000_000 }),
}));

describe('queryOutletHealthRanking', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('shapes health rows from the shared superset scan (f-columns + filter + sort)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        // Superset row — unfiltered + f-prefixed FILTER columns (raw SQL shape)
        outletId: 1,
        outletCode: 'JKT-001',
        outletName: 'Outlet Jakarta 1',
        area: 'JAKARTA',
        sales: 50_000_000,
        fNominalDeviasi: -3_000_000,
        fTotalQtyDeviasi: 100,
        fTotalQtyBom: 1000,
        fTotalQtyWaste: 20,
        fTotalQtySusut: 10,
        fTotalQtyTrial: 5,
        fTotalResidualQty: 50,
        fLossNominal: 2_000_000,
        zeroDevCount: 5,
        nonZeroDevCount: 80,
        // Unfiltered columns (recommendation variants) — ignored by health
        nominalDeviasi: -3_100_000,
        devBom: 0.1,
        direction: 'LOSS',
        topItem: 'Ayam Fillet',
      },
      {
        // Larger |fNominalDeviasi| — must sort FIRST (absNominal DESC)
        outletId: 2,
        outletCode: 'JKT-002',
        outletName: 'Outlet Jakarta 2',
        area: 'JAKARTA',
        sales: 60_000_000,
        fNominalDeviasi: -7_000_000,
        fTotalQtyDeviasi: 200,
        fTotalQtyBom: 2000,
        fTotalQtyWaste: 30,
        fTotalQtySusut: 15,
        fTotalQtyTrial: 8,
        fTotalResidualQty: 60,
        fLossNominal: 5_000_000,
        zeroDevCount: 2,
        nonZeroDevCount: 90,
        nominalDeviasi: -7_100_000,
        devBom: 0.12,
        direction: 'LOSS',
        topItem: 'Bawang',
      },
      {
        // All-zero-dev outlet — must be FILTERED OUT (old HAVING clause)
        outletId: 3,
        outletCode: 'JKT-003',
        outletName: 'Outlet Jakarta 3',
        area: 'JAKARTA',
        sales: 0,
        fNominalDeviasi: 0,
        fTotalQtyDeviasi: 0,
        fTotalQtyBom: 500,
        fTotalQtyWaste: 0,
        fTotalQtySusut: 0,
        fTotalQtyTrial: 0,
        fTotalResidualQty: 0,
        fLossNominal: 0,
        zeroDevCount: 40,
        nonZeroDevCount: 0,
        nominalDeviasi: 0,
        devBom: 0,
        direction: 'NEUTRAL',
        topItem: null,
      },
    ]);
    const r = await queryOutletHealthRanking('WEEK 1', 'Agustus 2026', {});
    expect(r.length).toBe(2); // zero-dev outlet dropped
    expect(r[0].outletCode).toBe('JKT-002'); // |−7M| > |−3M| → sorted first
    expect(r[0].absNominal).toBe(7_000_000);
    expect(r[1].outletCode).toBe('JKT-001');
    expect(r[1].absNominal).toBe(3_000_000);
    expect(r[1].nominalDeviasi).toBe(-3_000_000); // f-column, NOT unfiltered −3.1M
    expect(r[1].totalQtyDeviasi).toBe(100);
    expect(r[1].zeroDevCount).toBe(5);
    expect(r[1].nonZeroDevCount).toBe(80);
    expect(r[1].lossNominal).toBe(2_000_000);
    expect(r[1].sales).toBe(50_000_000);
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
    // FIX (AUDIT-PERF-4): top-N pushdown — verify the new SQL shape. The original
    // SELECT lives in a `variance` CTE; `ranked` computes rw (delta DESC) + ri
    // (delta ASC) with deterministic tie-breaks; only the top-5 union egresses.
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('WITH variance AS');
    expect(sqlText).toContain('ROW_NUMBER() OVER (ORDER BY v."delta" DESC, v."itemName", v."outletCode")');
    expect(sqlText).toContain('ROW_NUMBER() OVER (ORDER BY v."delta" ASC, v."itemName", v."outletCode")');
    expect(sqlText).toContain('WHERE rw <= 5 OR ri <= 5');
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
