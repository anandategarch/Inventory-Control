// Tests for src/lib/queries/rule-evaluation.ts
// evaluateHistoricalRulesJs is a pure JS function (no DB) — tested directly.
// evaluateRulesSql uses $queryRaw via withStatementTimeout — tested with mocked db.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRulesSql, evaluateHistoricalRulesJs } from '@/lib/queries/rule-evaluation';
import type { RuntimeThresholds } from '@/lib/settings';

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

function baseThresholds(over: Partial<RuntimeThresholds> = {}): RuntimeThresholds {
  return {
    STD_SUSUT_PCT: 0.02,
    STD_WASTE_PCT: 0.03,
    STD_TRIAL_PCT: 0.01,
    STD_DEVIASI_BOM_PCT: 0.05,
    FALLBACK_TOLERANCE_PCT: 0.15,
    SALES_DEVIATION_FACTOR: 2,
    BOM_DEVIATION_FACTOR: 2,
    RESIDUAL_LOSS_WARN_PCT: 0.30,
    RESIDUAL_LOSS_HIGH_PCT: 0.50,
    BENCHMARK_AREA_FACTOR: 1.5,
    BENCHMARK_NETWORK_FACTOR: 2.0,
    HISTORICAL_ZSCORE_WARN: 2,
    HISTORICAL_ZSCORE_HIGH: 3,
    HISTORICAL_MIN_WEEKS: 4,
    WEIGHT_DEV_BOM: 0.30,
    WEIGHT_GROWTH: 0.20,
    WEIGHT_RESIDUAL: 0.25,
    WEIGHT_TOLERANCE: 0.10,
    WEIGHT_HISTORY: 0.15,
    TOP_N_ITEMS: 10,
    TOP_N_OUTLETS: 20,
    TOP_N_DEVIASI_RANK: 30,
    HIGH_LOSS_NOMINAL_THRESHOLD: 10_000_000,
    P2_NOMINAL_THRESHOLD: 1_000_000,
    HEALTH_WEIGHT_DEV_BOM: 0.30,
    HEALTH_WEIGHT_RESIDUAL: 0.25,
    HEALTH_WEIGHT_LOSS_TO_SALES: 0.25,
    HEALTH_WEIGHT_ABNORMAL: 0.20,
    ...over,
  } as RuntimeThresholds;
}

describe('evaluateHistoricalRulesJs', () => {
  it('returns empty flags when historicalByOutletItem map is empty', () => {
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.5 }],
      new Map(),
      baseThresholds(),
    );
    expect(flags).toEqual([]);
  });

  it('skips records when stats.stdDev <= 0', () => {
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.5 }],
      map,
      baseThresholds(),
    );
    expect(flags).toEqual([]);
  });

  it('skips records when stats.n < minWeeks', () => {
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 3 }], // n=3 < 4
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.5 }],
      map,
      baseThresholds({ HISTORICAL_MIN_WEEKS: 4 }),
    );
    expect(flags).toEqual([]);
  });

  it('fires HISTORICAL_ABNORMAL when LOSS direction + zScore > high', () => {
    // mean=0.2, stdDev=0.05, current=0.5 (|.|) → z = (0.5 - 0.2) / 0.05 = 6 > 3
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.5 }],
      map,
      baseThresholds({ HISTORICAL_ZSCORE_HIGH: 3 }),
    );
    expect(flags.some((f) => f.ruleCode === 'HISTORICAL_ABNORMAL')).toBe(true);
    expect(flags.some((f) => f.ruleCode === 'BENCHMARK_ABOVE_NETWORK')).toBe(true);
  });

  it('fires HISTORICAL_ABNORMAL_SURPLUS when SURPLUS direction + zScore > high', () => {
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: 1000, pctQtyDeviasiToBom: 0.5 }],
      map,
      baseThresholds({ HISTORICAL_ZSCORE_HIGH: 3 }),
    );
    expect(flags.some((f) => f.ruleCode === 'HISTORICAL_ABNORMAL_SURPLUS')).toBe(true);
    expect(flags.some((f) => f.ruleCode === 'BENCHMARK_ABOVE_NETWORK')).toBe(true);
  });

  it('fires HISTORICAL_WARNING + BENCHMARK_ABOVE_AREA when zScore between warn and high', () => {
    // mean=0.2, stdDev=0.05, current=0.35 → z = (0.35 - 0.2) / 0.05 = 3 → at boundary (high)
    // Use current=0.32 → z = 2.4 → between warn(2) and high(3)
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.32 }],
      map,
      baseThresholds({ HISTORICAL_ZSCORE_WARN: 2, HISTORICAL_ZSCORE_HIGH: 3 }),
    );
    expect(flags.some((f) => f.ruleCode === 'HISTORICAL_WARNING')).toBe(true);
    expect(flags.some((f) => f.ruleCode === 'BENCHMARK_ABOVE_AREA')).toBe(true);
    // Should NOT fire ABNORMAL (zScore not > high)
    expect(flags.some((f) => f.ruleCode === 'HISTORICAL_ABNORMAL')).toBe(false);
  });

  it('fires no historical rules when zScore <= warn', () => {
    // mean=0.2, stdDev=0.05, current=0.25 → z = 1 → below warn(2)
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.25 }],
      map,
      baseThresholds({ HISTORICAL_ZSCORE_WARN: 2, HISTORICAL_ZSCORE_HIGH: 3 }),
    );
    expect(flags).toEqual([]);
  });

  it('uses akunPenyesuaian as part of the key lookup', () => {
    // Even with same outletId + itemId, different akunPenyesuaian → same map entry
    // (the map is keyed only on outletId|itemId — akun is for downstream filtering)
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: 'AKUN_X', nominalLossSurplus: -1000, pctQtyDeviasiToBom: 0.5 }],
      map,
      baseThresholds(),
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.akunPenyesuaian === 'AKUN_X')).toBe(true);
  });

  it('handles null pctQtyDeviasiToBom (uses 0 fallback)', () => {
    const map = new Map([
      ['1|1', { mean: 0.2, stdDev: 0.05, n: 5 }],
    ]);
    const flags = evaluateHistoricalRulesJs(
      [{ outletId: 1, itemId: 1, akunPenyesuaian: null, nominalLossSurplus: -1000, pctQtyDeviasiToBom: null }],
      map,
      baseThresholds(),
    );
    // z = (0 - 0.2) / 0.05 = -4 → no flags fire (z < warn)
    expect(flags).toEqual([]);
  });
});

describe('evaluateRulesSql', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns empty flags when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const flags = await evaluateRulesSql('WEEK 1', 'Agustus 2026', null, null, {}, baseThresholds());
    expect(flags).toEqual([]);
  });

  it('returns flags from rows where f_* columns = 1', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'AKUN_X',
        f_tol_breach_high: 1,
        f_tol_breach: 0,
        f_tol_not_set: 0,
        f_over_explained: 0,
        f_resid_high: 0,
        f_resid_warn: 1, // also fires
        f_high_loss: 0,
        f_dir_flip: 0,
        f_sales_mismatch: 0,
        f_sales_decrease: 0,
        f_bom_mismatch: 0,
        f_bom_down_dev_up: 0,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'Agustus 2026', 'WEEK 1', 'Juli 2026', {}, baseThresholds());
    expect(flags.length).toBe(2);
    expect(flags.some((f) => f.ruleCode === 'TOLERANCE_BREACH_HIGH')).toBe(true);
    expect(flags.some((f) => f.ruleCode === 'RESIDUAL_LOSS_WARN')).toBe(true);
    // Severity + category + priority propagated
    const tolBreachHigh = flags.find((f) => f.ruleCode === 'TOLERANCE_BREACH_HIGH')!;
    expect(tolBreachHigh.severity).toBe('ABNORMAL');
    expect(tolBreachHigh.category).toBe('TOLERANCE');
    expect(tolBreachHigh.priority).toBe(80);
  });

  it('returns empty flags when all f_* columns = 0', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: null,
        f_tol_breach_high: 0,
        f_tol_breach: 0,
        f_tol_not_set: 0,
        f_over_explained: 0,
        f_resid_high: 0,
        f_resid_warn: 0,
        f_high_loss: 0,
        f_dir_flip: 0,
        f_sales_mismatch: 0,
        f_sales_decrease: 0,
        f_bom_mismatch: 0,
        f_bom_down_dev_up: 0,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    expect(flags).toEqual([]);
  });

  it('uses prevFilter sentinel (1=0) when no prev period provided', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('1=0');
  });

  it('uses prevWeek + prevMonth filter when provided', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await evaluateRulesSql('WEEK 1', 'Agustus 2026', 'WEEK 1', 'Juli 2026', {}, baseThresholds());
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // Verify the SQL contains LATERAL joins + WITH curr AS + prev AS + hist AS
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('WITH curr AS');
    expect(sqlText).toContain('LATERAL');
    expect(sqlText).toContain('prev AS');
  });
});
