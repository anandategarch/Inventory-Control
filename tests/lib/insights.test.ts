// Tests for the Insights derivation engine (GODSPLIT-W2-B).
// Covers buildInsights — the 9-rule textual insight generator moved
// out of components/dashboard/InsightsPanel.tsx into lib/insights.ts
// so it is pure, memoizable, and unit-testable. Focus: the threshold
// boundaries of every rule (health >20%/>5%, growth mismatch >2×,
// residual >0.5, area >10/>5 ppt, cost >5%/>2%, net-cost trend ±0.5 ppt,
// loss-share 0.70/0.40) plus the unconditional-health-verdict contract.
import { describe, it, expect } from 'vitest';
import { buildInsights, type Insight } from '@/lib/insights';
import type { AnalysisData } from '@/hooks/useAnalysis';

// Minimal, fully-typed AnalysisData fixture — every optional analytical
// field is absent so ONLY the health verdict fires on the baseline
// (rule 1 is a 3-branch if/else-if/else and therefore unconditional:
// the engine ALWAYS emits ≥1 insight; the panel's empty state is only
// reachable via rules 2-9 being silent, never via a zero-length result).
function baseData(over: Partial<AnalysisData> = {}): AnalysisData {
  return {
    success: true,
    period: {
      monthLabel: 'Juli 2026',
      weekLabel: 'W4',
      comparisonWeek: null,
      comparisonMonth: null,
    },
    filters: { area: null, kelompok: null, outletCode: null, itemName: null, pic: null },
    executiveSummary: {
      period: { monthLabel: 'Juli 2026', weekLabel: 'W4', comparisonWeek: null },
      sales: { current: 100_000_000, previous: 100_000_000, growth: 0 },
      nominalDeviasi: { current: 0, previous: 0, growth: 0 },
      qtyBom: { current: 0, previous: 0, growth: 0 },
      qtyDeviasi: { current: 0, previous: 0, growth: 0 },
      qtyWaste: { current: 0, previous: 0, growth: 0 },
      qtySusut: { current: 0, previous: 0, growth: 0 },
      qtyTrial: { current: 0, previous: 0, growth: 0 },
      qtyLossSurplus: { current: 0, previous: 0, growth: 0 },
      totalLoss: 0,
      totalSurplus: 0,
      lossToSales: null,
      surplusToSales: null,
      deviationToBom: null,
      residualLossQty: 0,
      residualLossPct: null,
    },
    // 2 abnormal / 100 total → 2% → baseline health verdict is "positive".
    healthStatus: { normal: 95, warning: 3, abnormal: 2 },
    dqStatus: { errors: 0, warnings: 0 },
    growthComparison: {
      salesGrowth: null,
      bomGrowth: null,
      qtyDeviasiGrowth: null,
      nominalDeviasiGrowth: null,
      deviationToSalesRatio: null,
      deviationToBomRatio: null,
    },
    topItemsByNominal: [],
    topItemsByDevBom: [],
    topItemsByWaste: [],
    topItemsBySusut: [],
    topItemsByTrial: [],
    topItemsByLossSurplus: [],
    deviationBreakdown: { waste: 0, susut: 0, trial: 0, residual: 0, total: 0 },
    lossVsSurplus: { loss: 0, surplus: 0, lossNominal: 0, surplusNominal: 0 },
    trend: [],
    durationMs: 0,
    ...over,
  };
}

function growth(over: Partial<AnalysisData['growthComparison']> = {}): AnalysisData['growthComparison'] {
  return {
    salesGrowth: null,
    bomGrowth: null,
    qtyDeviasiGrowth: null,
    nominalDeviasiGrowth: null,
    deviationToSalesRatio: null,
    deviationToBomRatio: null,
    ...over,
  };
}

function byId(insights: Insight[], id: string): Insight | undefined {
  return insights.find((i) => i.id === id);
}

describe('buildInsights — rule 1: health verdict', () => {
  it('fires critical above 20% abnormal and warning at exactly 20%', () => {
    const critical = buildInsights(baseData({ healthStatus: { normal: 70, warning: 5, abnormal: 25 } }));
    expect(critical).toHaveLength(1);
    expect(critical[0].id).toBe('health');
    expect(critical[0].severity).toBe('critical');
    expect(critical[0].icon).toBe('shield-alert');
    expect(critical[0].title).toBe('Kondisi Inventory KRITIS');

    // Boundary: 20% exactly is NOT > 20 → falls into the warning band.
    const boundary = buildInsights(baseData({ healthStatus: { normal: 75, warning: 5, abnormal: 20 } }));
    expect(boundary[0].severity).toBe('warning');
  });

  it('fires warning above 5% and positive at exactly 5%', () => {
    const warning = buildInsights(baseData({ healthStatus: { normal: 85, warning: 5, abnormal: 10 } }));
    expect(warning[0].severity).toBe('warning');
    expect(warning[0].icon).toBe('alert-triangle');
    expect(warning[0].title).toBe('Kondisi Inventory Perlu Perhatian');

    // Boundary: 5% exactly is NOT > 5 → positive.
    const boundary = buildInsights(baseData({ healthStatus: { normal: 90, warning: 5, abnormal: 5 } }));
    expect(boundary[0].severity).toBe('positive');
    expect(boundary[0].icon).toBe('lightbulb');
    expect(boundary[0].title).toBe('Kondisi Inventory Sehat');
  });

  it('always emits exactly one health insight on minimal/empty data', () => {
    // Rule 1 is unconditional (3-branch ladder) — an empty payload still
    // yields the positive verdict, never a zero-length array.
    const lean = buildInsights(baseData());
    expect(lean).toHaveLength(1);
    expect(lean[0].id).toBe('health');
    expect(lean[0].severity).toBe('positive');

    const zeroed = buildInsights(baseData({ healthStatus: { normal: 0, warning: 0, abnormal: 0 } }));
    expect(zeroed).toHaveLength(1);
    expect(zeroed[0].severity).toBe('positive');
  });
});

describe('buildInsights — rule 2: growth mismatch', () => {
  it('fires critical only when nominalDeviasiGrowth > 2× positive salesGrowth', () => {
    const fires = buildInsights(baseData({
      growthComparison: growth({ salesGrowth: 0.1, nominalDeviasiGrowth: 0.25 }),
    }));
    const mismatch = byId(fires, 'growth-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe('critical');
    expect(mismatch!.certainty).toBe('INDIKASI');
    expect(mismatch!.icon).toBe('zap');

    // Boundary: exactly 2× (0.20 vs 0.10) is NOT > 2× → silent.
    const at2x = buildInsights(baseData({
      growthComparison: growth({ salesGrowth: 0.1, nominalDeviasiGrowth: 0.2 }),
    }));
    expect(byId(at2x, 'growth-mismatch')).toBeUndefined();

    // Negative salesGrowth never fires (requires salesGrowth > 0).
    const declining = buildInsights(baseData({
      growthComparison: growth({ salesGrowth: -0.05, nominalDeviasiGrowth: 0.5 }),
    }));
    expect(byId(declining, 'growth-mismatch')).toBeUndefined();
  });
});

describe('buildInsights — rule 3: residual dominance', () => {
  it('fires warning above 0.5 residual share; silent at exactly 0.5 and when total = 0', () => {
    const fires = buildInsights(baseData({
      deviationBreakdown: { waste: 10, susut: 10, trial: 10, residual: 60, total: 100 },
    }));
    const residual = byId(fires, 'residual');
    expect(residual).toBeDefined();
    expect(residual!.severity).toBe('warning');
    expect(residual!.icon).toBe('alert-triangle');

    // Boundary: 50/100 = exactly 0.5 is NOT > 0.5 → silent.
    const boundary = buildInsights(baseData({
      deviationBreakdown: { waste: 10, susut: 10, trial: 10, residual: 50, total: 100 },
    }));
    expect(byId(boundary, 'residual')).toBeUndefined();

    // total = 0 hits the `b.total || 1` guard → residualPct 0 → silent.
    const noTotal = buildInsights(baseData({
      deviationBreakdown: { waste: 0, susut: 0, trial: 0, residual: 0, total: 0 },
    }));
    expect(byId(noTotal, 'residual')).toBeUndefined();
  });
});

describe('buildInsights — rule 4: worst area', () => {
  it('picks the highest lossToSales area, goes critical above 10 ppt, and emits an area actionTarget', () => {
    // Best area listed FIRST — proves the sort is by lossToSales, not input order.
    const insights = buildInsights(baseData({
      areaAnalysis: [
        { area: 'JAKARTA', outletCount: 5, totalSales: 100, totalAbsNominal: 5, avgDevBom: 0.05, lossToSales: 0.02 },
        { area: 'PAPUA&MALUKU', outletCount: 3, totalSales: 50, totalAbsNominal: 8, avgDevBom: 0.16, lossToSales: 0.15 },
      ],
    }));
    const worst = byId(insights, 'area-worst');
    expect(worst).toBeDefined();
    expect(worst!.severity).toBe('critical'); // 15 ppt > 10
    expect(worst!.title).toBe('Area Terburuk: PAPUA&MALUKU');
    expect(worst!.action).toBe('Fokus ke PAPUA&MALUKU');
    expect(worst!.actionTarget).toEqual({ type: 'area', value: 'PAPUA&MALUKU' });
    expect(worst!.icon).toBe('map-pin');

    // Single area (< 2) never fires.
    const solo = buildInsights(baseData({
      areaAnalysis: [
        { area: 'JAKARTA', outletCount: 5, totalSales: 100, totalAbsNominal: 5, avgDevBom: 0.05, lossToSales: 0.15 },
      ],
    }));
    expect(byId(solo, 'area-worst')).toBeUndefined();
  });
});

describe('buildInsights — rule 5: cost impact tiers', () => {
  it('classifies pctOfSales into critical > 5%, warning 2–5%, info ≤ 2%', () => {
    const mk = (pctOfSales: number) => buildInsights(baseData({
      costImpact: { totalCost: 10_000_000, pctOfSales, lossNominal: 6_000_000, surplusNominal: 4_000_000 },
    }));
    expect(byId(mk(0.06), 'cost-impact')!.severity).toBe('critical');
    expect(byId(mk(0.03), 'cost-impact')!.severity).toBe('warning');
    expect(byId(mk(0.01), 'cost-impact')!.severity).toBe('info');
    expect(byId(mk(0.06), 'cost-impact')!.icon).toBe('coins');
    // Absent costImpact → rule silent.
    expect(byId(buildInsights(baseData()), 'cost-impact')).toBeUndefined();
  });
});

describe('buildInsights — rules 6 & 9: systemic item + historical anomaly', () => {
  it('fires both with item actionTargets', () => {
    const insights = buildInsights(baseData({
      itemConsistencyAnalysis: {
        systemic: [
          { itemName: 'Ayam Fillet', outletCode: '1097.CKGBOU', area: 'JAKARTA', occurrences: 9, avgDevBom: 0.3, absNominal: 5_000_000 },
        ],
        episodic: [],
      },
      growthComparison: growth({
        historicalAnalysis: {
          criticalItems: [
            {
              itemName: 'Ayam Fillet', outletCode: '1097.CKGBOU', area: 'JAKARTA',
              currentDevBom: 0.25, historicalAvg: 0.08, zScore: 3.2, absNominal: 5_000_000,
              currentQtyDeviasi: 50, qtyDeviasiZScore: 2.1, qtyDeviasiHistoricalAvg: 10,
              currentWaste: 1, currentSusut: 1, currentTrial: 1,
              wasteZScore: 0.5, susutZScore: 0.5, trialZScore: 0.5,
              wasteHistoricalAvg: 1, susutHistoricalAvg: 1, trialHistoricalAvg: 1,
            },
          ],
        },
      }),
    }));
    const systemic = byId(insights, 'systemic');
    expect(systemic).toBeDefined();
    expect(systemic!.severity).toBe('critical');
    expect(systemic!.certainty).toBe('INDIKASI');
    expect(systemic!.icon).toBe('package');
    expect(systemic!.actionTarget).toEqual({ type: 'item', value: 'Ayam Fillet' });

    const anomaly = byId(insights, 'historical-anomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly!.severity).toBe('critical');
    expect(anomaly!.title).toBe('Anomali Historical: 1097.CKGBOU');
    expect(anomaly!.actionTarget).toEqual({ type: 'item', value: 'Ayam Fillet' });
  });
});

describe('buildInsights — rule 7: net cost trend', () => {
  it('flags worsening/improving only beyond ±0.5 ppt', () => {
    const nct = (first: number, last: number) => [
      { weekLabel: 'W1', netCostRatio: first, lossNominal: 1, surplusNominal: 1, sales: 100 },
      { weekLabel: 'W4', netCostRatio: last, lossNominal: 1, surplusNominal: 1, sales: 100 },
    ];

    const worsening = buildInsights(baseData({ netCostTrend: nct(0.1, 0.25) }));
    expect(byId(worsening, 'nct-worsening')!.severity).toBe('warning');
    expect(byId(worsening, 'nct-worsening')!.icon).toBe('trending-down');

    const improving = buildInsights(baseData({ netCostTrend: nct(0.25, 0.1) }));
    expect(byId(improving, 'nct-improving')!.severity).toBe('positive');
    expect(byId(improving, 'nct-improving')!.icon).toBe('trending-up');

    // Boundary: exactly +0.5 ppt (0 → 0.005) is NOT > 0.5 → silent.
    const flat = buildInsights(baseData({ netCostTrend: nct(0, 0.005) }));
    expect(byId(flat, 'nct-worsening')).toBeUndefined();
    expect(byId(flat, 'nct-improving')).toBeUndefined();

    // Sub-threshold drift (0.4 ppt) → silent; single point → silent.
    const drift = buildInsights(baseData({ netCostTrend: nct(0.1, 0.104) }));
    expect(byId(drift, 'nct-worsening')).toBeUndefined();
    const single = buildInsights(baseData({
      netCostTrend: [{ weekLabel: 'W1', netCostRatio: 0.1, lossNominal: 1, surplusNominal: 1, sales: 100 }],
    }));
    expect(byId(single, 'nct-worsening')).toBeUndefined();
    expect(byId(single, 'nct-improving')).toBeUndefined();
  });
});

describe('buildInsights — rule 8: LOSS/SURPLUS balance', () => {
  it('uses strict 0.70 / 0.40 boundaries on loss share', () => {
    const lvs = (lossNominal: number, surplusNominal: number) =>
      baseData({ lossVsSurplus: { loss: 0, surplus: 0, lossNominal, surplusNominal } });

    // 75% loss share → loss dominance warning.
    const lossDom = buildInsights(lvs(75, 25));
    expect(byId(lossDom, 'loss-dominance')!.severity).toBe('warning');
    expect(byId(lossDom, 'loss-dominance')!.icon).toBe('trending-down');

    // Boundary: exactly 0.70 is NOT > 0.70 → silent.
    expect(byId(buildInsights(lvs(70, 30)), 'loss-dominance')).toBeUndefined();

    // 30% loss share (70% surplus) → surplus dominance warning.
    const surplusDom = buildInsights(lvs(30, 70));
    expect(byId(surplusDom, 'surplus-dominance')!.severity).toBe('warning');
    expect(byId(surplusDom, 'surplus-dominance')!.icon).toBe('trending-up');

    // Boundary: exactly 0.40 is NOT < 0.40 → silent.
    expect(byId(buildInsights(lvs(40, 60)), 'surplus-dominance')).toBeUndefined();

    // Zero totals → rule silent entirely.
    expect(byId(buildInsights(lvs(0, 0)), 'loss-dominance')).toBeUndefined();
    expect(byId(buildInsights(lvs(0, 0)), 'surplus-dominance')).toBeUndefined();
  });
});
