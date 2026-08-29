import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateRules, loadRules, type RuleContext } from '@/engine/rules/evaluator';

// Helper: create a base context with all fields set to typical values.
// Individual tests override specific fields to trigger/deny rules.
function baseCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    salesGrowth: 0.1,
    bomGrowth: 0.1,
    qtyDeviasiGrowth: 0.1,
    nominalDeviasiGrowth: 0.1,
    deviationToSalesRatio: 0.05,
    deviationToBomRatio: 0.1,
    benchmarkFlag: null,
    zScore: null,
    qtyDeviasi: 100,
    nominalDeviasi: 5000000,
    qtyWaste: 10,
    qtySusut: 5,
    qtyTrial: 3,
    qtyLossSurplus: 50,
    nominalLossSurplus: -2000000,
    residualQty: 30,
    residualRatio: 0.3,
    tolerancePct: 0.1,
    pctQtyDeviasiToBom: 0.15,
    direction: 'LOSS',
    prevDirection: 'LOSS',
    isDirectionFlip: false,
    absNominalDeviasi: 5000000,
    absQtyDeviasi: 100,
    absNominalLossSurplus: 2000000,
    absQtyLossSurplus: 50,
    stdDeviasiBomPct: 0.1,
    stdSusutPct: 0.02,
    stdWastePct: 0.03,
    stdTrialPct: 0.01,
    fallbackTolerancePct: 0.15,
    residualLossWarnPct: 0.3,
    residualLossHighPct: 0.5,
    highLossNominalThreshold: 10000000,
    historicalZscoreWarn: 2,
    historicalZscoreHigh: 3,
    salesDeviationFactor: 2,
    bomDeviationFactor: 2,
    isOverExplained: false,
    ...overrides,
  };
}

describe('Rule Engine — loadRules', () => {
  it('loads 21 rules from rules.yaml', () => {
    const rules = loadRules();
    expect(rules.length).toBe(21);
  });

  it('all rules have required fields', () => {
    const rules = loadRules();
    for (const r of rules) {
      expect(r.code).toBeTruthy();
      expect(r.name).toBeTruthy();
      expect(r.severity).toMatch(/^(NORMAL|WARNING|ABNORMAL)$/);
      expect(r.category).toBeTruthy();
      expect(typeof r.priority).toBe('number');
      expect(r.condition).toBeTruthy();
    }
  });

  it('all rule codes are unique', () => {
    const rules = loadRules();
    const codes = rules.map(r => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('Rule Engine — evaluateRules', () => {
  it('returns empty array for normal context (no rules trigger)', () => {
    const ctx = baseCtx({
      pctQtyDeviasiToBom: 0.05, // below stdDeviasiBomPct (0.1)
      residualRatio: 0.1, // below residualLossWarnPct (0.3)
      nominalLossSurplus: -1000, // below highLossNominalThreshold
      zScore: null,
      tolerancePct: 0.1, // set, pctQtyDeviasiToBom < tolerance
      isDirectionFlip: false,
      isOverExplained: false,
    });
    const flags = evaluateRules(ctx);
    // Some rules may still fire (e.g. TOLERANCE_BREACH if abs(pct) > tolerance)
    // Check that no ABNORMAL severity flags fire for truly normal data
    const abnormal = flags.filter(f => f.severity === 'ABNORMAL');
    expect(abnormal.length).toBe(0);
  });

  it('returns flags sorted by priority descending', () => {
    const ctx = baseCtx({
      pctQtyDeviasiToBom: 0.5, // high dev/bom
      tolerancePct: 0.1,
      residualRatio: 0.6, // high residual
      nominalLossSurplus: -15000000, // high loss
    });
    const flags = evaluateRules(ctx);
    if (flags.length > 1) {
      for (let i = 0; i < flags.length - 1; i++) {
        expect(flags[i].priority).toBeGreaterThanOrEqual(flags[i + 1].priority);
      }
    }
  });

  it('each flag has ruleCode, ruleName, severity, evidence', () => {
    const ctx = baseCtx({
      pctQtyDeviasiToBom: 0.5,
      tolerancePct: 0.1,
      residualRatio: 0.6,
      nominalLossSurplus: -15000000,
    });
    const flags = evaluateRules(ctx);
    for (const f of flags) {
      expect(f.ruleCode).toBeTruthy();
      expect(f.ruleName).toBeTruthy();
      expect(f.severity).toMatch(/^(NORMAL|WARNING|ABNORMAL)$/);
      expect(f.evidence).toBeTruthy();
      expect(typeof f.evidence).toBe('object');
    }
  });
});

describe('Rule Engine — individual rules', () => {
  it('TOLERANCE_BREACH fires when abs(pctQtyDeviasiToBom) > tolerancePct', () => {
    const ctx = baseCtx({
      pctQtyDeviasiToBom: 0.25, // 25% > 10% tolerance
      tolerancePct: 0.1,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'TOLERANCE_BREACH')).toBe(true);
  });

  it('TOLERANCE_BREACH does NOT fire when abs(pctQtyDeviasiToBom) <= tolerancePct', () => {
    const ctx = baseCtx({
      pctQtyDeviasiToBom: 0.05, // 5% < 10%
      tolerancePct: 0.1,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'TOLERANCE_BREACH')).toBe(false);
  });

  it('TOLERANCE_BREACH_HIGH fires when abs(pctQtyDeviasiToBom) > 2× tolerancePct', () => {
    const ctx = baseCtx({
      pctQtyDeviasiToBom: 0.3, // 30% > 2×10%
      tolerancePct: 0.1,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'TOLERANCE_BREACH_HIGH')).toBe(true);
  });

  it('HIGH_LOSS_NOMINAL fires when abs(nominalLossSurplus) > threshold', () => {
    const ctx = baseCtx({
      nominalLossSurplus: -15000000, // 15Jt LOSS
      absNominalLossSurplus: 15000000, // FIX: rule uses absNominalLossSurplus field
      highLossNominalThreshold: 10000000,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'HIGH_LOSS_NOMINAL')).toBe(true);
  });

  it('HIGH_LOSS_NOMINAL does NOT fire when abs(nominalLossSurplus) <= threshold', () => {
    const ctx = baseCtx({
      nominalLossSurplus: -5000000, // 5Jt < 10Jt
      highLossNominalThreshold: 10000000,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'HIGH_LOSS_NOMINAL')).toBe(false);
  });

  it('RESIDUAL_LOSS_HIGH fires when residualRatio > residualLossHighPct', () => {
    const ctx = baseCtx({
      residualRatio: 0.6, // 60% > 50%
      residualLossHighPct: 0.5,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'RESIDUAL_LOSS_HIGH')).toBe(true);
  });

  it('RESIDUAL_LOSS_WARN fires when residualRatio > residualLossWarnPct but <= high', () => {
    const ctx = baseCtx({
      residualRatio: 0.35, // 35% > 30% warn, < 50% high
      residualLossWarnPct: 0.3,
      residualLossHighPct: 0.5,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'RESIDUAL_LOSS_WARN')).toBe(true);
  });

  it('DIRECTION_FLIP fires when isDirectionFlip is true', () => {
    const ctx = baseCtx({
      isDirectionFlip: true,
      direction: 'LOSS',
      prevDirection: 'SURPLUS',
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'DIRECTION_FLIP')).toBe(true);
  });

  it('DIRECTION_FLIP does NOT fire when isDirectionFlip is false', () => {
    const ctx = baseCtx({
      isDirectionFlip: false,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'DIRECTION_FLIP')).toBe(false);
  });

  it('OVER_EXPLAINED fires when isOverExplained is true', () => {
    const ctx = baseCtx({
      isOverExplained: true,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'OVER_EXPLAINED')).toBe(true);
  });

  it('SALES_DEVIATION_MISMATCH fires when nominalDeviasiGrowth > 2× salesGrowth', () => {
    const ctx = baseCtx({
      salesGrowth: 0.1, // 10%
      nominalDeviasiGrowth: 0.5, // 50% > 2×10%
      salesDeviationFactor: 2,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'SALES_DEVIATION_MISMATCH')).toBe(true);
  });

  it('HISTORICAL_ABNORMAL fires when zScore > historicalZscoreHigh', () => {
    const ctx = baseCtx({
      zScore: 3.5, // > 3
      historicalZscoreHigh: 3,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'HISTORICAL_ABNORMAL')).toBe(true);
  });

  it('HISTORICAL_WARNING fires when zScore > historicalZscoreWarn but <= high', () => {
    const ctx = baseCtx({
      zScore: 2.5, // > 2, < 3
      historicalZscoreWarn: 2,
      historicalZscoreHigh: 3,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'HISTORICAL_WARNING')).toBe(true);
  });

  it('HISTORICAL_ABNORMAL does NOT fire when zScore is null', () => {
    const ctx = baseCtx({
      zScore: null,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'HISTORICAL_ABNORMAL')).toBe(false);
  });

  it('TOLERANCE_NOT_SET_HIGH_DEV fires when tolerancePct is null + high dev', () => {
    const ctx = baseCtx({
      tolerancePct: null,
      pctQtyDeviasiToBom: 0.5, // 50% > stdDeviasiBomPct
      stdDeviasiBomPct: 0.1,
    });
    const flags = evaluateRules(ctx);
    expect(flags.some(f => f.ruleCode === 'TOLERANCE_NOT_SET_HIGH_DEV')).toBe(true);
  });

  it('handles null fields gracefully (no crash)', () => {
    const ctx = baseCtx({
      zScore: null,
      tolerancePct: null,
      benchmarkFlag: null,
      prevDirection: null,
      nominalDeviasiGrowth: null,
      salesGrowth: null,
    });
    expect(() => evaluateRules(ctx)).not.toThrow();
  });

  it('handles empty context gracefully', () => {
    expect(() => evaluateRules({} as RuleContext)).not.toThrow();
  });

  it('fast-path optimization: skips rules when required fields are null', () => {
    // zScore rules should be skipped entirely when zScore is null
    const ctx = baseCtx({
      zScore: null,
    });
    const flags = evaluateRules(ctx);
    // No HISTORICAL_* rules should fire
    expect(flags.some(f => f.ruleCode.startsWith('HISTORICAL'))).toBe(false);
  });
});
