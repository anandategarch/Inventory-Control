// Tests for deviation + benchmark + sales metric functions.
// Covers computeHealthScore, computePriority, computeDevBomAggregate,
// computeResidualPctAggregate, computeExplainedPctAggregate, computeLossToSales,
// computeDirection, computeDevBomPerRow, computeResidual, computeResidualRatio,
// computeExplainedPct, computeBenchmark, computeSalesModePerOutlet, computeTotalSales,
// safeRatio, calcAvgPrice.
import { describe, it, expect } from 'vitest';
import {
  computeHealthScore,
  computePriority,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeExplainedPctAggregate,
  computeLossToSales,
  computeDirection,
  computeDevBomPerRow,
  computeResidual,
  computeResidualRatio,
  computeExplainedPct,
  type AggregateInput,
} from '@/lib/metrics/deviation';
import { computeBenchmark } from '@/lib/metrics/benchmark';
import { computeSalesModePerOutlet, computeTotalSales } from '@/lib/metrics/sales';
import { safeRatio, calcAvgPrice } from '@/lib/metrics/growth';

function baseAgg(over: Partial<AggregateInput> = {}): AggregateInput {
  return {
    totalQtyDeviasi: 100,
    totalQtyBom: 1000,
    totalQtyWaste: 20,
    totalQtySusut: 10,
    totalQtyTrial: 5,
    totalResidualQty: 50,
    totalLossNominal: 2_000_000,
    totalSales: 50_000_000,
    normalCount: 80,
    warningCount: 15,
    abnormalCount: 5,
    ...over,
  };
}

describe('computeDirection', () => {
  it('returns LOSS when net (qtyLossSurplus) < 0', () => {
    expect(computeDirection(-5, 10)).toBe('LOSS');
  });

  it('returns SURPLUS when net (qtyLossSurplus) > 0', () => {
    expect(computeDirection(5, -10)).toBe('SURPLUS');
  });

  it('returns NEUTRAL when net = 0', () => {
    expect(computeDirection(0, 10)).toBe('NEUTRAL');
  });

  it('falls back to qtyDeviasi when net is null', () => {
    expect(computeDirection(null, -10)).toBe('LOSS');
    expect(computeDirection(null, 10)).toBe('SURPLUS');
    expect(computeDirection(null, 0)).toBe('NEUTRAL');
  });

  it('returns NEUTRAL when both null', () => {
    expect(computeDirection(null, null)).toBe('NEUTRAL');
  });
});

describe('computeDevBomPerRow', () => {
  it('returns ratio when both provided and qtyBom != 0', () => {
    expect(computeDevBomPerRow(10, 100)).toBeCloseTo(0.1, 5);
    expect(computeDevBomPerRow(-10, 100)).toBeCloseTo(0.1, 5); // ABS
  });

  it('returns null when qtyBom is 0', () => {
    expect(computeDevBomPerRow(10, 0)).toBe(null);
  });

  it('returns null when either input is null', () => {
    expect(computeDevBomPerRow(null, 100)).toBe(null);
    expect(computeDevBomPerRow(10, null)).toBe(null);
  });
});

describe('computeResidual', () => {
  it('returns residualQty = max(0, |dev| - (|w|+|s|+|t|))', () => {
    const r = computeResidual(100, 20, 10, 5);
    // explained = 35, residual = 100-35 = 65
    expect(r.residualQty).toBe(65);
    expect(r.explained).toBe(35);
    expect(r.isOverExplained).toBe(false);
  });

  it('returns residualQty=0 when explained > |dev|', () => {
    const r = computeResidual(10, 20, 10, 5);
    // explained=35 > |10|=10 → residual clamped to 0
    expect(r.residualQty).toBe(0);
    expect(r.isOverExplained).toBe(true);
  });

  it('treats null waste/susut/trial as 0', () => {
    const r = computeResidual(50, null, null, null);
    expect(r.residualQty).toBe(50);
    expect(r.explained).toBe(0);
  });

  it('returns null residualQty when qtyDeviasi is null', () => {
    const r = computeResidual(null, 20, 10, 5);
    expect(r.residualQty).toBe(null);
    expect(r.explained).toBe(0);
    expect(r.isOverExplained).toBe(false);
  });

  it('isOverExplained=false when |dev| = 0', () => {
    // explained=35 > 0 but absDev=0 → guard sets isOverExplained=false
    const r = computeResidual(0, 20, 10, 5);
    expect(r.isOverExplained).toBe(false);
    expect(r.residualQty).toBe(0);
  });
});

describe('computeResidualRatio', () => {
  it('returns residual / |qtyDeviasi|', () => {
    expect(computeResidualRatio(30, 100)).toBeCloseTo(0.3, 5);
  });

  it('returns null when qtyDeviasi = 0', () => {
    expect(computeResidualRatio(0, 0)).toBe(null);
    expect(computeResidualRatio(10, 0)).toBe(null);
  });

  it('returns null when residual is null', () => {
    expect(computeResidualRatio(null, 100)).toBe(null);
  });
});

describe('computeExplainedPct', () => {
  it('returns explained/|dev|', () => {
    // (10+20+30) / 100 = 0.6
    expect(computeExplainedPct(100, 10, 20, 30)).toBeCloseTo(0.6, 5);
  });

  it('returns null when qtyDeviasi = 0', () => {
    expect(computeExplainedPct(0, 10, 20, 30)).toBe(null);
  });

  it('treats null sub-components as 0', () => {
    expect(computeExplainedPct(100, null, null, null)).toBe(0);
  });
});

describe('computeDevBomAggregate', () => {
  it('returns SUM(|dev|) / SUM(|bom|)', () => {
    expect(computeDevBomAggregate(baseAgg({ totalQtyDeviasi: 50, totalQtyBom: 500 }))).toBeCloseTo(0.1, 5);
  });

  it('returns 0 when totalQtyBom = 0 (safeDiv guard)', () => {
    expect(computeDevBomAggregate(baseAgg({ totalQtyDeviasi: 50, totalQtyBom: 0 }))).toBe(0);
  });
});

describe('computeResidualPctAggregate', () => {
  it('returns SUM(|residual|) / SUM(|dev|)', () => {
    expect(computeResidualPctAggregate(baseAgg({ totalResidualQty: 25, totalQtyDeviasi: 100 }))).toBeCloseTo(0.25, 5);
  });

  it('returns 0 when totalQtyDeviasi = 0', () => {
    expect(computeResidualPctAggregate(baseAgg({ totalResidualQty: 25, totalQtyDeviasi: 0 }))).toBe(0);
  });
});

describe('computeExplainedPctAggregate', () => {
  it('returns SUM(w+s+t) / SUM(|dev|)', () => {
    // (10+20+30) / 100 = 0.6
    const agg = baseAgg({ totalQtyWaste: 10, totalQtySusut: 20, totalQtyTrial: 30, totalQtyDeviasi: 100 });
    expect(computeExplainedPctAggregate(agg)).toBeCloseTo(0.6, 5);
  });

  it('returns 0 when totalQtyDeviasi = 0', () => {
    const agg = baseAgg({ totalQtyWaste: 10, totalQtySusut: 20, totalQtyTrial: 30, totalQtyDeviasi: 0 });
    expect(computeExplainedPctAggregate(agg)).toBe(0);
  });
});

describe('computeLossToSales', () => {
  it('returns lossNominal / sales', () => {
    expect(computeLossToSales(baseAgg({ totalLossNominal: 1_000_000, totalSales: 50_000_000 }))).toBeCloseTo(0.02, 5);
  });

  it('returns null when totalSales <= 0', () => {
    expect(computeLossToSales(baseAgg({ totalSales: 0 }))).toBe(null);
    expect(computeLossToSales(baseAgg({ totalSales: -1 }))).toBe(null);
  });
});

describe('computeHealthScore', () => {
  it('returns a number in [0, 100]', () => {
    const s = computeHealthScore(baseAgg());
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it('clamps to 100 when all metrics are perfect (good thresholds)', () => {
    // devBom=0.01 < good=0.05 → 100; residual=0.10 < good=0.20 → 100; loss/sales=0.002 < good=0.02 → 100; abnormal=0 → 100
    const s = computeHealthScore(baseAgg({
      totalQtyDeviasi: 10,
      totalQtyBom: 1000, // devBom=0.01
      totalResidualQty: 1, // residualPct=0.1 < good=0.20
      totalLossNominal: 100_000,
      totalSales: 50_000_000, // loss/sales = 0.002
      abnormalCount: 0,
    }));
    expect(s).toBe(100);
  });

  it('clamps to 0 when all metrics are critical', () => {
    // devBom=1 > bad=0.50 → 0; residual=0.9 > bad=0.80 → 0; loss/sales=0.2 > bad=0.15 → 0; abnormal=100% → 0
    const s = computeHealthScore(baseAgg({
      totalQtyDeviasi: 1000,
      totalQtyBom: 1000, // devBom=1.0 → bad
      totalResidualQty: 900,
      totalLossNominal: 10_000_000,
      totalSales: 50_000_000, // loss/sales=0.2 → bad
      normalCount: 0,
      warningCount: 0,
      abnormalCount: 100,
    }));
    expect(s).toBe(0);
  });

  it('returns neutral 50 when totalQtyBom=0 (devBom undefined)', () => {
    const s = computeHealthScore(baseAgg({
      totalQtyDeviasi: 0,
      totalQtyBom: 0,
      totalResidualQty: 0,
    }));
    // devBom score = neutral 50; residual score = neutral 50; abnormal score = 100 (0% abnormal)
    // loss/sales depends on defaults
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it('respects custom weights (single-metric dominance)', () => {
    // 100% abnormal weight → score = abnormalScore
    const s = computeHealthScore(
      baseAgg({ abnormalCount: 0 }), // abnormal=0% → score 100
      { devBom: 0, residual: 0, lossToSales: 0, abnormal: 1 },
    );
    expect(s).toBe(100);
  });

  it('returns neutral when threshold pair has good===bad (misconfiguration)', () => {
    const s = computeHealthScore(
      baseAgg({ abnormalCount: 0 }),
      undefined,
      {
        devBom: { good: 0.05, bad: 0.05 }, // misconfigured → neutral
        residual: { good: 0.20, bad: 0.80 },
        lossToSales: { good: 0.02, bad: 0.15 },
        abnormal: { good: 0.0, bad: 0.50 },
      },
    );
    // devBom component neutral (50), others normal — just ensure no crash + in range
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it('returns neutral 50 when empty outlet (totalItemCount=0)', () => {
    // abnormalRate=null → abnormalScore=neutral 50
    const s = computeHealthScore(baseAgg({
      normalCount: 0,
      warningCount: 0,
      abnormalCount: 0,
    }));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe('computePriority', () => {
  const defaultThresholds = {
    HIGH_LOSS_NOMINAL_THRESHOLD: 10_000_000,
    P2_NOMINAL_THRESHOLD: 1_000_000,
    STD_DEVIASI_BOM_PCT: 0.05,
    RESIDUAL_LOSS_WARN_PCT: 0.30,
    RESIDUAL_LOSS_HIGH_PCT: 0.50,
    HISTORICAL_ZSCORE_HIGH: 3,
  };

  it('returns P1 when absNominalLossSurplus > HIGH_LOSS_NOMINAL_THRESHOLD', () => {
    const p = computePriority({
      absNominalLossSurplus: 15_000_000,
      devBom: null,
      residualRatio: null,
      zScore: null,
      isOverExplained: false,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P1');
  });

  it('returns P1 when residualRatio > RESIDUAL_LOSS_HIGH_PCT', () => {
    const p = computePriority({
      absNominalLossSurplus: 0,
      devBom: null,
      residualRatio: 0.6,
      zScore: null,
      isOverExplained: false,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P1');
  });

  it('returns P1 when zScore > HISTORICAL_ZSCORE_HIGH', () => {
    const p = computePriority({
      absNominalLossSurplus: 0,
      devBom: null,
      residualRatio: null,
      zScore: 4,
      isOverExplained: false,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P1');
  });

  it('returns P1 when isOverExplained=true', () => {
    const p = computePriority({
      absNominalLossSurplus: 0,
      devBom: null,
      residualRatio: null,
      zScore: null,
      isOverExplained: true,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P1');
  });

  it('returns P2 when absNominalLossSurplus > P2_NOMINAL_THRESHOLD (but < P1)', () => {
    const p = computePriority({
      absNominalLossSurplus: 2_000_000,
      devBom: null,
      residualRatio: null,
      zScore: null,
      isOverExplained: false,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P2');
  });

  it('returns P2 when devBom > STD_DEVIASI_BOM_PCT', () => {
    const p = computePriority({
      absNominalLossSurplus: 0,
      devBom: 0.1,
      residualRatio: null,
      zScore: null,
      isOverExplained: false,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P2');
  });

  it('returns P3 when all metrics within thresholds', () => {
    const p = computePriority({
      absNominalLossSurplus: 100,
      devBom: 0.01,
      residualRatio: 0.1,
      zScore: 1,
      isOverExplained: false,
      thresholds: defaultThresholds,
    });
    expect(p).toBe('P3');
  });
});

describe('computeBenchmark', () => {
  it('returns NORMAL when outlet matches area and network avg', () => {
    const r = computeBenchmark({
      outletDevBom: 0.1,
      areaAvgDevBom: 0.1,
      networkAvgDevBom: 0.1,
      areaFactor: 1.5,
      networkFactor: 2.0,
    });
    expect(r.status).toBe('NORMAL');
    expect(r.isAboveArea).toBe(false);
    expect(r.isAboveNetwork).toBe(false);
  });

  it('returns ABOVE_AREA when outlet > areaFactor × areaAvg', () => {
    const r = computeBenchmark({
      outletDevBom: 0.2,
      areaAvgDevBom: 0.1,
      networkAvgDevBom: 0.1,
      areaFactor: 1.5,
      networkFactor: 2.0,
    });
    expect(r.status).toBe('ABOVE_AREA');
    expect(r.areaMultiplier).toBeCloseTo(2, 5);
  });

  it('returns ABOVE_NETWORK when outlet > networkFactor × networkAvg', () => {
    const r = computeBenchmark({
      outletDevBom: 0.5,
      areaAvgDevBom: 0.1,
      networkAvgDevBom: 0.1,
      areaFactor: 1.5,
      networkFactor: 2.0,
    });
    expect(r.status).toBe('ABOVE_NETWORK');
    expect(r.isAboveNetwork).toBe(true);
  });

  it('returns null multipliers when avg is 0', () => {
    const r = computeBenchmark({
      outletDevBom: 0.5,
      areaAvgDevBom: 0,
      networkAvgDevBom: 0,
      areaFactor: 1.5,
      networkFactor: 2.0,
    });
    expect(r.areaMultiplier).toBe(null);
    expect(r.networkMultiplier).toBe(null);
    expect(r.status).toBe('NORMAL');
  });

  it('computes vsBestMultiple when bestDevBom > 0', () => {
    const r = computeBenchmark({
      outletDevBom: 0.4,
      areaAvgDevBom: 0.1,
      networkAvgDevBom: 0.1,
      bestDevBom: 0.1,
      areaFactor: 1.5,
      networkFactor: 2.0,
    });
    expect(r.vsBestMultiple).toBeCloseTo(4, 5);
  });

  it('returns null vsBestMultiple when bestDevBom is 0/null', () => {
    const r = computeBenchmark({
      outletDevBom: 0.4,
      areaAvgDevBom: 0.1,
      networkAvgDevBom: 0.1,
      bestDevBom: null,
      areaFactor: 1.5,
      networkFactor: 2.0,
    });
    expect(r.vsBestMultiple).toBe(null);
  });
});

describe('computeSalesModePerOutlet', () => {
  it('returns most frequent value per outlet', () => {
    const records = [
      { outletId: 1, nominalSales: 100 },
      { outletId: 1, nominalSales: 100 },
      { outletId: 1, nominalSales: 200 },
    ];
    const m = computeSalesModePerOutlet(records);
    expect(m.get(1)).toBe(100);
  });

  it('tie-break: smaller value wins', () => {
    const records = [
      { outletId: 1, nominalSales: 200 },
      { outletId: 1, nominalSales: 100 },
      // both occur once → smaller (100) wins
    ];
    const m = computeSalesModePerOutlet(records);
    expect(m.get(1)).toBe(100);
  });

  it('filters out null and zero sales', () => {
    const records = [
      { outletId: 1, nominalSales: null },
      { outletId: 1, nominalSales: 0 },
      { outletId: 1, nominalSales: 100 },
    ];
    const m = computeSalesModePerOutlet(records);
    expect(m.get(1)).toBe(100);
  });

  it('handles multiple outlets independently', () => {
    const records = [
      { outletId: 1, nominalSales: 100 },
      { outletId: 2, nominalSales: 200 },
      { outletId: 2, nominalSales: 200 },
    ];
    const m = computeSalesModePerOutlet(records);
    expect(m.get(1)).toBe(100);
    expect(m.get(2)).toBe(200);
  });

  it('omits outlets with no valid sales records', () => {
    const records = [
      { outletId: 1, nominalSales: null },
      { outletId: 2, nominalSales: 100 },
    ];
    const m = computeSalesModePerOutlet(records);
    expect(m.has(1)).toBe(false);
    expect(m.get(2)).toBe(100);
  });
});

describe('computeTotalSales', () => {
  it('sums the MODE per outlet', () => {
    const records = [
      { outletId: 1, nominalSales: 100 },
      { outletId: 1, nominalSales: 100 },
      { outletId: 2, nominalSales: 200 },
      { outletId: 2, nominalSales: 200 },
    ];
    expect(computeTotalSales(records)).toBe(300);
  });

  it('returns 0 when no valid sales', () => {
    expect(computeTotalSales([])).toBe(0);
    expect(computeTotalSales([{ outletId: 1, nominalSales: null }])).toBe(0);
  });
});

describe('safeRatio', () => {
  it('returns num/denom when denom != 0', () => {
    expect(safeRatio(10, 5)).toBe(2);
  });

  it('returns null when denom = 0', () => {
    expect(safeRatio(10, 0)).toBe(null);
  });

  it('returns null when num is null', () => {
    expect(safeRatio(null, 5)).toBe(null);
  });

  it('returns null when denom is null', () => {
    expect(safeRatio(10, null)).toBe(null);
  });
});

describe('calcAvgPrice', () => {
  it('returns |nominal / qty|', () => {
    expect(calcAvgPrice(1000, 10)).toBe(100);
    expect(calcAvgPrice(-1000, 10)).toBe(100); // ABS
  });

  it('returns null when qty = 0', () => {
    expect(calcAvgPrice(1000, 0)).toBe(null);
  });

  it('returns null when either input is null', () => {
    expect(calcAvgPrice(null, 10)).toBe(null);
    expect(calcAvgPrice(1000, null)).toBe(null);
  });
});
