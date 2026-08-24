import { describe, it, expect } from 'vitest';
import { computeDeviationDrivers } from '@/app/api/analysis/services/deviation-drivers';
import { computeGrowthDrivers } from '@/app/api/analysis/services/growth-drivers';
import { buildExecSummaryFromSql } from '@/app/api/analysis/services/exec-summary';
import { buildTrend, buildMultiPeriodComparison, buildNetCostTrend } from '@/app/api/analysis/services/trend-builder';
import type { DeviationDriverItemRow } from '@/lib/queries/dashboard';
import type { TrendAggRow } from '@/lib/queries/dashboard';

// Mock RecWithRels for growth drivers test
const mockRec = (overrides: Record<string, unknown> = {}) => ({
  outletId: 1, itemId: 1, akunPenyesuaian: null,
  qtyBom: 100, qtyDeviasi: 50, qtyWaste: 10, qtySusut: 5, qtyTrial: 3,
  qtyLossSurplus: 30, nominalDeviasi: 5000000, nominalLossSurplus: -2000000,
  nominalSales: 10000000, absNominalDeviasi: 5000000, absQtyDeviasi: 50,
  absNominalLossSurplus: 2000000, absQtyLossSurplus: 30,
  pctQtyDeviasiToBom: 0.5, tolerancePct: 0.1, direction: 'LOSS',
  residualQty: 30, residualRatio: 0.3,
  area: 'JAKARTA', outlet: { code: 'OUTLET1', name: 'Outlet 1', area: 'JAKARTA' },
  item: { name: 'Item 1' },
  ...overrides,
}) as never;

describe('deviation-drivers service', () => {
  it('returns 4 categories with correct labels', () => {
    const rows: DeviationDriverItemRow[] = [
      { itemName: 'Item A', wasteQty: 100, wasteNominal: 1000, susutQty: 50, susutNominal: 500, trialQty: 10, trialNominal: 100, residualQty: 200, residualNominal: 2000 },
      { itemName: 'Item B', wasteQty: 50, wasteNominal: 500, susutQty: 100, susutNominal: 1000, trialQty: 5, trialNominal: 50, residualQty: 100, residualNominal: 1000 },
    ];
    const result = computeDeviationDrivers(rows);
    expect(result.length).toBe(4);
    expect(result[0].category).toBe('waste');
    expect(result[1].category).toBe('susut');
    expect(result[2].category).toBe('trial');
    expect(result[3].category).toBe('residual');
  });

  it('computes Pareto 80% correctly for waste', () => {
    const rows: DeviationDriverItemRow[] = [
      { itemName: 'Big', wasteQty: 1000, wasteNominal: 10000, susutQty: 0, susutNominal: 0, trialQty: 0, trialNominal: 0, residualQty: 0, residualNominal: 0 },
      { itemName: 'Small', wasteQty: 100, wasteNominal: 1000, susutQty: 0, susutNominal: 0, trialQty: 0, trialNominal: 0, residualQty: 0, residualNominal: 0 },
    ];
    const result = computeDeviationDrivers(rows);
    const waste = result[0]; // waste category
    expect(waste.drivers.length).toBe(1); // Big alone is >80% (1000/1100 = 91%)
    expect(waste.drivers[0].item).toBe('Big');
    expect(waste.drivers[0].sharePct).toBeGreaterThan(80);
    expect(waste.remainderCount).toBe(1);
  });

  it('returns empty drivers for zero data', () => {
    const rows: DeviationDriverItemRow[] = [];
    const result = computeDeviationDrivers(rows);
    for (const cat of result) {
      expect(cat.drivers.length).toBe(0);
    }
  });
});

describe('growth-drivers service', () => {
  it('returns 4 metrics', () => {
    const result = computeGrowthDrivers([mockRec()], [mockRec({ nominalSales: 5000000 })]);
    expect(result.length).toBe(4);
    expect(result[0].metric).toBe('sales');
    expect(result[1].metric).toBe('bom');
    expect(result[2].metric).toBe('qtyDeviasi');
    expect(result[3].metric).toBe('nominalDeviasi');
  });

  it('detects sales growth (up driver)', () => {
    const curr = [mockRec({ nominalSales: 15000000 })];
    const prev = [mockRec({ nominalSales: 10000000 })];
    const result = computeGrowthDrivers(curr, prev);
    const sales = result[0];
    expect(sales.up.drivers.length).toBeGreaterThan(0);
    expect(sales.up.drivers[0].delta).toBeGreaterThan(0);
  });

  it('detects sales decrease (down driver)', () => {
    const curr = [mockRec({ nominalSales: 5000000 })];
    const prev = [mockRec({ nominalSales: 10000000 })];
    const result = computeGrowthDrivers(curr, prev);
    const sales = result[0];
    expect(sales.down.drivers.length).toBeGreaterThan(0);
    expect(sales.down.drivers[0].delta).toBeLessThan(0);
  });

  it('caps drivers at 20', () => {
    const curr = Array.from({ length: 30 }, (_, i) => mockRec({ itemId: i + 1, item: { name: `Item ${i}` }, nominalSales: 1000000 * (i + 1) }));
    const prev: never[] = [];
    const result = computeGrowthDrivers(curr, prev);
    for (const metric of result) {
      expect(metric.up.drivers.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('exec-summary service', () => {
  it('builds summary from valid SQL rows', () => {
    const curr = {
      sales: 10000000, nominalDeviasi: 5000000, qtyBom: 100, qtyDeviasi: 50,
      qtyWaste: 10, qtySusut: 5, qtyTrial: 3, qtyLossSurplus: 30,
      totalLoss: 2000000, totalSurplus: 500000, residualLossQty: 20, residualLossNominal: 1000000,
      qtyDeviasiLoss: 40,
    };
    const summary = buildExecSummaryFromSql(curr, null, 'Agustus 2026', 'WEEK 1', null);
    expect(summary.period.monthLabel).toBe('Agustus 2026');
    expect(summary.sales.current).toBe(10000000);
    expect(summary.sales.previous).toBe(null);
    expect(summary.sales.growth).toBe(null);
  });

  it('handles null curr (empty period)', () => {
    const summary = buildExecSummaryFromSql(null, null, 'Empty', 'WEEK 1', null);
    expect(summary.sales.current).toBe(0);
    expect(summary.nominalDeviasi.current).toBe(0);
  });
});

describe('trend-builder service', () => {
  const mockRows: TrendAggRow[] = [
    { monthLabel: 'Januari 2026', weekLabel: 'WEEK 1', sales: 100, nominal: 50, devBom: 0.5, qtyBom: 100, lossNominal: 30, surplusNominal: 20 },
    { monthLabel: 'Februari 2026', weekLabel: 'WEEK 1', sales: 120, nominal: 60, devBom: 0.5, qtyBom: 100, lossNominal: 35, surplusNominal: 25 },
  ];
  const monthKeyMap = new Map([['Januari 2026', '2026-01'], ['Februari 2026', '2026-02']]);

  it('builds trend array sorted chronologically', () => {
    const trend = buildTrend(mockRows, monthKeyMap);
    expect(trend.length).toBe(2);
    expect(trend[0].weekLabel).toContain('WEEK 1');
    expect(trend[0].weekLabel).toContain('Jan');
  });

  it('builds multi-period comparison with growth', () => {
    const mpc = buildMultiPeriodComparison(mockRows, monthKeyMap);
    expect(mpc.length).toBe(2);
    expect(mpc[0].growthPct).toBe(null); // first period has no prev
    expect(mpc[1].growthPct).not.toBe(null); // second period has growth
  });

  it('builds net cost trend', () => {
    const nct = buildNetCostTrend(mockRows, monthKeyMap);
    expect(nct.length).toBe(2);
    expect(nct[0].netCostRatio).toBe((30 - 20) / 100); // (loss - surplus) / sales
  });
});
