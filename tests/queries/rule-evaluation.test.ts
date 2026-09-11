// Tests for src/lib/queries/rule-evaluation.ts
// evaluateHistoricalRulesSql + evaluateRulesSql both use $queryRaw via
// withStatementTimeout — tested with mocked db (the SQL flag-expansion
// contract is what matters; the guards live inside the SQL text).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRulesSql, evaluateHistoricalRulesSql } from '@/lib/queries/rule-evaluation';
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

describe('evaluateHistoricalRulesSql', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  const HIST_PERIODS = [
    { monthLabel: 'Mei 2026', weekLabel: 'WEEK 1' },
    { monthLabel: 'Juni 2026', weekLabel: 'WEEK 1' },
    { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' },
    { monthLabel: 'Agustus 2026', weekLabel: 'WEEK 1' },
  ];

  it('returns [] without hitting the DB when historicalPeriods is empty', async () => {
    const flags = await evaluateHistoricalRulesSql('WEEK 1', 'September 2026', [], {}, baseThresholds());
    expect(flags).toEqual([]);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('expands f_hist_abnormal rows (LOSS direction + z > high)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 1, itemId: 10, akunPenyesuaian: null, f_hist_abnormal: 1, f_hist_abnormal_surplus: 0, f_hist_warning: 0 },
    ]);
    const flags = await evaluateHistoricalRulesSql('WEEK 1', 'September 2026', HIST_PERIODS, {}, baseThresholds());
    expect(flags).toHaveLength(1);
    expect(flags[0].ruleCode).toBe('HISTORICAL_ABNORMAL');
    expect(flags[0].severity).toBe('ABNORMAL');
    expect(flags[0].category).toBe('HISTORICAL');
    expect(flags[0].priority).toBe(78);
  });

  it('expands f_hist_abnormal_surplus rows (SURPLUS direction + z > high)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 2, itemId: 20, akunPenyesuaian: 'AKUN_X', f_hist_abnormal: 0, f_hist_abnormal_surplus: 1, f_hist_warning: 0 },
    ]);
    const flags = await evaluateHistoricalRulesSql('WEEK 1', 'September 2026', HIST_PERIODS, {}, baseThresholds());
    expect(flags).toHaveLength(1);
    expect(flags[0].ruleCode).toBe('HISTORICAL_ABNORMAL_SURPLUS');
    expect(flags[0].severity).toBe('ABNORMAL');
    expect(flags[0].priority).toBe(77);
    expect(flags[0].akunPenyesuaian).toBe('AKUN_X');
  });

  it('expands f_hist_warning rows (warn < z <= high)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 3, itemId: 30, akunPenyesuaian: null, f_hist_abnormal: 0, f_hist_abnormal_surplus: 0, f_hist_warning: 1 },
    ]);
    const flags = await evaluateHistoricalRulesSql('WEEK 1', 'September 2026', HIST_PERIODS, {}, baseThresholds());
    expect(flags).toHaveLength(1);
    expect(flags[0].ruleCode).toBe('HISTORICAL_WARNING');
    expect(flags[0].severity).toBe('WARNING');
    expect(flags[0].priority).toBe(58);
  });

  it('returns [] when the DB returns no flagged rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const flags = await evaluateHistoricalRulesSql('WEEK 1', 'September 2026', HIST_PERIODS, {}, baseThresholds());
    expect(flags).toEqual([]);
  });

  it('SQL: inline weekly_dev/hist/stats baseline + curr + z guards (ZS-05, stdDev, minWeeks)', async () => {
    // PERF (TAHAP-2 / P2-7) regression guard: the query must inline the
    // historical baseline (same weekly_dev shape as queryHistoricalStatsMultiMetric)
    // and enforce the JS loop's skip conditions in SQL.
    mockQueryRaw.mockResolvedValueOnce([]);
    await evaluateHistoricalRulesSql('WEEK 1', 'September 2026', HIST_PERIODS, {}, baseThresholds({ HISTORICAL_MIN_WEEKS: 4, HISTORICAL_ZSCORE_WARN: 1.5, HISTORICAL_ZSCORE_HIGH: 2 }));
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    // Baseline pipeline mirrors queryHistoricalStatsMultiMetric (devBom metric)
    expect(sqlText).toContain('WITH weekly_dev AS');
    expect(sqlText).toContain('SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))');
    // Same sample-variance formula computeStats used, clamped at 0
    expect(sqlText).toContain('SQRT(GREATEST(0, ("sumSq" - n * "mean" * "mean") / (n - 1)))');
    // Guards: pct NOT NULL (ZS-05) + stdDev > 0 + n >= minWeeks
    expect(sqlText).toContain('c."pctQtyDeviasiToBom" IS NOT NULL');
    expect(sqlText).toContain('s."stdDev" > 0');
    expect(sqlText).toContain('s.n >=');
    // zScore = (ABS(pct) - mean) / stdDev
    expect(sqlText).toContain('(ABS(c."pctQtyDeviasiToBom") - s."mean") / s."stdDev"');
    // Signed z + only-flagged rows egress
    expect(sqlText).toContain('> 0');
    expect(sqlText).toContain('ORDER BY "outletId", "itemId"');
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
        // CONFIG-11: 4 new BOM correlation f_* columns (all 0 = not firing)
        f_waste_bom_mismatch: 0,
        f_susut_bom_mismatch: 0,
        f_trial_bom_mismatch: 0,
        f_bom_disproportionate: 0,
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
        // CONFIG-11: 4 new BOM correlation f_* columns
        f_waste_bom_mismatch: 0,
        f_susut_bom_mismatch: 0,
        f_trial_bom_mismatch: 0,
        f_bom_disproportionate: 0,
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
    // FIX (AUDIT-PERF-3): the main SELECT is wrapped in a `flags` CTE and only
    // rows with at least one fired rule (sum of the 16 flag columns > 0) egress.
    expect(sqlText).toContain('flags AS');
    expect(sqlText).toContain('FROM flags');
    expect(sqlText).toContain('"f_tol_breach_high" + "f_tol_breach"');
    expect(sqlText).toContain('"f_bom_disproportionate") > 0');
    // All 16 flag columns still selected + row order preserved
    expect(sqlText).toContain('"f_trial_bom_mismatch", "f_bom_disproportionate"');
    expect(sqlText).toContain('ORDER BY "outletId", "itemId"');
  });

  // ============================================================
  //  EVAL-06 / CONFIG-11: New BOM correlation rules (4 rules)
  //  ----------------------------------------------------------
  //  Each test sets one f_*_bom_* (or f_bom_disproportionate) column to 1
  //  and verifies the corresponding rule code surfaces with correct
  //  severity/category/priority per the SQL RULE_MAP.
  // ============================================================

  it('WASTE_BOM_MISMATCH flag surfaces when f_waste_bom_mismatch = 1', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'AKUN_W',
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
        f_waste_bom_mismatch: 1,
        f_susut_bom_mismatch: 0,
        f_trial_bom_mismatch: 0,
        f_bom_disproportionate: 0,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    expect(flags.length).toBe(1);
    const wasteFlag = flags[0];
    expect(wasteFlag.ruleCode).toBe('WASTE_BOM_MISMATCH');
    expect(wasteFlag.severity).toBe('WARNING');
    expect(wasteFlag.category).toBe('BOM');
    expect(wasteFlag.priority).toBe(55);
  });

  it('SUSUT_BOM_MISMATCH flag surfaces when f_susut_bom_mismatch = 1', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'AKUN_S',
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
        f_waste_bom_mismatch: 0,
        f_susut_bom_mismatch: 1,
        f_trial_bom_mismatch: 0,
        f_bom_disproportionate: 0,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    expect(flags.length).toBe(1);
    const susutFlag = flags[0];
    expect(susutFlag.ruleCode).toBe('SUSUT_BOM_MISMATCH');
    expect(susutFlag.severity).toBe('WARNING');
    expect(susutFlag.category).toBe('BOM');
    expect(susutFlag.priority).toBe(54);
  });

  it('TRIAL_BOM_MISMATCH flag surfaces when f_trial_bom_mismatch = 1', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'AKUN_T',
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
        f_waste_bom_mismatch: 0,
        f_susut_bom_mismatch: 0,
        f_trial_bom_mismatch: 1,
        f_bom_disproportionate: 0,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    expect(flags.length).toBe(1);
    const trialFlag = flags[0];
    expect(trialFlag.ruleCode).toBe('TRIAL_BOM_MISMATCH');
    expect(trialFlag.severity).toBe('WARNING');
    expect(trialFlag.category).toBe('BOM');
    expect(trialFlag.priority).toBe(53);
  });

  it('BOM_DEVIATION_DISPROPORTIONATE flag surfaces when f_bom_disproportionate = 1', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'AKUN_D',
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
        f_waste_bom_mismatch: 0,
        f_susut_bom_mismatch: 0,
        f_trial_bom_mismatch: 0,
        f_bom_disproportionate: 1,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    expect(flags.length).toBe(1);
    const dispropFlag = flags[0];
    expect(dispropFlag.ruleCode).toBe('BOM_DEVIATION_DISPROPORTIONATE');
    expect(dispropFlag.severity).toBe('WARNING');
    expect(dispropFlag.category).toBe('BOM');
    expect(dispropFlag.priority).toBe(56);
  });

  it('multiple BOM correlation rules can fire on the same row (priority-sorted)', async () => {
    // Verify that when 2+ new BOM rules fire on the same record, both surface
    // as separate flags (RULE_MAP iterates all 16 SQL columns).
    mockQueryRaw.mockResolvedValueOnce([
      {
        outletId: 1,
        itemId: 10,
        akunPenyesuaian: 'AKUN_MULTI',
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
        f_waste_bom_mismatch: 1,
        f_susut_bom_mismatch: 1,
        f_trial_bom_mismatch: 1,
        f_bom_disproportionate: 1,
      },
    ]);
    const flags = await evaluateRulesSql('WEEK 1', 'M', null, null, {}, baseThresholds());
    expect(flags.length).toBe(4);
    const codes = flags.map((f) => f.ruleCode).sort();
    expect(codes).toEqual([
      'BOM_DEVIATION_DISPROPORTIONATE',
      'SUSUT_BOM_MISMATCH',
      'TRIAL_BOM_MISMATCH',
      'WASTE_BOM_MISMATCH',
    ]);
    // All 4 should be WARNING + BOM category
    expect(flags.every((f) => f.severity === 'WARNING' && f.category === 'BOM')).toBe(true);
  });
});
