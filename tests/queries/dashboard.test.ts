// Tests for src/lib/queries/dashboard.ts — queryExecSummary, kpisToCostImpact,
// queryTrendAgg.
// H-10: the standalone queryDeviationBreakdown / queryLossVsSurplus /
// queryCostImpact were removed (dead code — zero production callers); the
// cost-impact ratio tests now cover kpisToCostImpact (the merged-scan
// derivation used by the live pipeline).
// Mock @/lib/db; verify SQL invocation + result transformation + edge cases.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  queryExecSummary,
  kpisToCostImpact,
  queryTrendAgg,
  type DashboardKpisRow,
} from '@/lib/queries/dashboard';

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

describe('queryExecSummary', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns first row from DB result (single-row aggregate)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        sales: 100_000_000,
        nominalDeviasi: -5_000_000,
        qtyBom: 1000,
        qtyDeviasi: 100,
        qtyWaste: 20,
        qtySusut: 10,
        qtyTrial: 5,
        qtyLossSurplus: 50,
        totalLoss: 3_000_000,
        totalSurplus: 500_000,
        residualLossQty: 30,
        residualLossNominal: 1_500_000,
        qtyDeviasiLoss: 60,
      },
    ]);
    const r = await queryExecSummary('WEEK 1', 'Agustus 2026', {});
    expect(r).not.toBeNull();
    expect(r!.sales).toBe(100_000_000);
    expect(r!.totalLoss).toBe(3_000_000);
    expect(r!.residualLossQty).toBe(30);
  });

  it('returns null when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryExecSummary('WEEK 1', 'M', {});
    expect(r).toBeNull();
  });

  it('uses CTE pipeline (sales_mode + aggs)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryExecSummary('WEEK 1', 'M', {});
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('sales_mode');
    expect(sqlText).toContain('aggs');
    expect(sqlText).toContain('OutletPeriodSales');
  });
});

// Helper: build a full DashboardKpisRow with all-zero defaults (mirrors
// the ZERO_KPIS constant in dashboard.ts, which is not exported).
function kpisRow(over: Partial<DashboardKpisRow> = {}): DashboardKpisRow {
  return {
    sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0,
    qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0,
    residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0,
    residualQtyAbs: 0, lossCount: 0, surplusCount: 0,
    wasteCost: 0, susutCost: 0, trialCost: 0, residualCost: 0, totalCost: 0,
    ...over,
  };
}

describe('kpisToCostImpact', () => {
  it('computes cost components + pct + toSales ratios from a merged KPI row', () => {
    const r = kpisToCostImpact(
      kpisRow({ wasteCost: 100_000, susutCost: 50_000, trialCost: 25_000, residualCost: 200_000, totalCost: 375_000 }),
      1_000_000,
    );
    expect(r.wasteCost).toBe(100_000);
    expect(r.totalCost).toBe(375_000);
    // wastePct = 100000/375000 = 0.2666...
    expect(r.wastePct).toBeCloseTo(0.2666, 3);
    // wasteToSales = 100000/1000000 = 0.1
    expect(r.wasteToSales).toBeCloseTo(0.1, 3);
    // totalCostToSales = 375000/1000000 = 0.375
    expect(r.totalCostToSales).toBeCloseTo(0.375, 3);
  });

  it('returns zeros for a null KPI row (no data for the period)', () => {
    const r = kpisToCostImpact(null, 0);
    expect(r.totalCost).toBe(0);
    expect(r.wastePct).toBe(0); // safeDiv guard
    expect(r.totalCostToSales).toBe(0);
  });

  it('returns zero percentages when totalCost = 0 (safeDiv guard)', () => {
    const r = kpisToCostImpact(kpisRow(), 1_000_000);
    expect(r.wastePct).toBe(0);
    expect(r.susutPct).toBe(0);
    expect(r.trialPct).toBe(0);
    expect(r.residualPct).toBe(0);
  });
});

describe('queryTrendAgg', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns TrendAggRow[] from DB rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        monthLabel: 'Juli 2026',
        weekLabel: 'WEEK 1',
        sales: 50_000_000,
        nominal: -1_000_000,
        devBom: 0.05,
        qtyBom: 1000,
        lossNominal: 800_000,
        surplusNominal: 200_000,
      },
      {
        monthLabel: 'Agustus 2026',
        weekLabel: 'WEEK 1',
        sales: 60_000_000,
        nominal: -1_200_000,
        devBom: 0.06,
        qtyBom: 1100,
        lossNominal: 900_000,
        surplusNominal: 250_000,
      },
    ]);
    const r = await queryTrendAgg({ weekLabel: 'WEEK 1' });
    expect(r.length).toBe(2);
    expect(r[0].monthLabel).toBe('Juli 2026');
    expect(r[1].sales).toBe(60_000_000);
  });

  it('returns empty array when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTrendAgg({});
    expect(r).toEqual([]);
  });

  it('applies weekLabel filter when provided (cumulative weeks — W4 vs W4)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTrendAgg({ weekLabel: 'WEEK 2' });
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('"weekLabel"');
  });

  it('uses CTE pipeline (filtered_periods + sales_per_period + period_aggs)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTrendAgg({});
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('filtered_periods');
    expect(sqlText).toContain('sales_per_period');
    expect(sqlText).toContain('period_aggs');
  });
});
