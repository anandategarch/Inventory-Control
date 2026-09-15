// ============================================================
//  Settings Runtime Thresholds — convenience object for the engine
//  ----------------------------------------------------------
//  getRuntimeThresholds(): all numeric thresholds in one typed
//  object, merged over defaults (DB values win).
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/settings.ts (old file deleted; '@/lib/settings' now
//  resolves to this folder's index.ts barrel — same import path).
// ============================================================
import { getAllSettings } from './store';

export interface RuntimeThresholds {
  STD_SUSUT_PCT: number;
  STD_WASTE_PCT: number;
  STD_TRIAL_PCT: number;
  STD_DEVIASI_BOM_PCT: number;
  FALLBACK_TOLERANCE_PCT: number;
  SALES_DEVIATION_FACTOR: number;
  BOM_DEVIATION_FACTOR: number;
  // FIX (FIX-SETTINGS / BUG-BOM-EVAL-03): configurable threshold for the
  // BOM_DEVIATION_DISPROPORTIONATE rule (decoupled from BOM_DEVIATION_FACTOR).
  BOM_DISPROPORTIONATE_FACTOR: number;
  RESIDUAL_LOSS_WARN_PCT: number;
  RESIDUAL_LOSS_HIGH_PCT: number;
  BENCHMARK_AREA_FACTOR: number;
  BENCHMARK_NETWORK_FACTOR: number;
  HISTORICAL_ZSCORE_WARN: number;
  HISTORICAL_ZSCORE_HIGH: number;
  HISTORICAL_MIN_WEEKS: number;
  // CHANGE-1: change-analysis thresholds (lens "Perubahan").
  CHANGE_ANOMALY_RATIO: number;
  CHANGE_MIN_PAIRS: number;
  CHANGE_MIN_NOMINAL: number;
  WEIGHT_DEV_BOM: number;
  WEIGHT_GROWTH: number;
  WEIGHT_RESIDUAL: number;
  WEIGHT_TOLERANCE: number;
  WEIGHT_HISTORY: number;
  TOP_N_ITEMS: number;
  TOP_N_OUTLETS: number;
  // FIX (AUDIT8-ROLLBACK-1, Item 15): configurable via Settings (was hardcoded 30).
  TOP_N_DEVIASI_RANK: number;
  HIGH_LOSS_NOMINAL_THRESHOLD: number;
  P2_NOMINAL_THRESHOLD: number;
  HEALTH_WEIGHT_DEV_BOM: number;
  HEALTH_WEIGHT_RESIDUAL: number;
  HEALTH_WEIGHT_LOSS_TO_SALES: number;
  HEALTH_WEIGHT_ABNORMAL: number;
  // P2 fix: Health Score thresholds (configurable via Settings)
  HEALTH_THRESH_DEV_BOM_GOOD: number;
  HEALTH_THRESH_DEV_BOM_BAD: number;
  HEALTH_THRESH_RESIDUAL_GOOD: number;
  HEALTH_THRESH_RESIDUAL_BAD: number;
  HEALTH_THRESH_LOSS_TO_SALES_GOOD: number;
  HEALTH_THRESH_LOSS_TO_SALES_BAD: number;
  HEALTH_THRESH_ABNORMAL_GOOD: number;
  HEALTH_THRESH_ABNORMAL_BAD: number;
}

export async function getRuntimeThresholds(): Promise<RuntimeThresholds> {
  const all = await getAllSettings();
  // FIX (BUG-2-4): Treat empty/whitespace strings as fallback.
  // `Number('') === 0`, so previously a cleared HISTORICAL_MIN_WEEKS
  // became 0 (bypassing the min-weeks guard). Now it returns the default.
  const num = (key: string, fallback: number): number => {
    const v = all.get(key);
    if (v == null || String(v).trim() === '') return fallback;
    const n = Number(v);
    return isNaN(n) ? fallback : n;
  };
  return {
    STD_SUSUT_PCT: num('STD_SUSUT_PCT', 0.10),
    STD_WASTE_PCT: num('STD_WASTE_PCT', 0.05),
    STD_TRIAL_PCT: num('STD_TRIAL_PCT', 0.03),
    STD_DEVIASI_BOM_PCT: num('STD_DEVIASI_BOM_PCT', 0.05),
    FALLBACK_TOLERANCE_PCT: num('FALLBACK_TOLERANCE_PCT', 0.05),
    SALES_DEVIATION_FACTOR: num('SALES_DEVIATION_FACTOR', 2.0),
    BOM_DEVIATION_FACTOR: num('BOM_DEVIATION_FACTOR', 2.0),
    // FIX (FIX-SETTINGS / BUG-BOM-EVAL-03): decoupled disproportionate
    // threshold (default 1.5×). SQL rule evaluator consumes via
    // thresholds.BOM_DISPROPORTIONATE_FACTOR — replaces hardcoded 1.5.
    BOM_DISPROPORTIONATE_FACTOR: num('BOM_DISPROPORTIONATE_FACTOR', 1.5),
    RESIDUAL_LOSS_WARN_PCT: num('RESIDUAL_LOSS_WARN_PCT', 0.50),
    RESIDUAL_LOSS_HIGH_PCT: num('RESIDUAL_LOSS_HIGH_PCT', 0.70),
    BENCHMARK_AREA_FACTOR: num('BENCHMARK_AREA_FACTOR', 1.5),
    BENCHMARK_NETWORK_FACTOR: num('BENCHMARK_NETWORK_FACTOR', 2.0),
    HISTORICAL_ZSCORE_WARN: num('HISTORICAL_ZSCORE_WARN', 1.5),
    HISTORICAL_ZSCORE_HIGH: num('HISTORICAL_ZSCORE_HIGH', 2.0),
    HISTORICAL_MIN_WEEKS: num('HISTORICAL_MIN_WEEKS', 4),
    // CHANGE-1: change-analysis thresholds (defaults mirror CFG_THRESHOLDS).
    CHANGE_ANOMALY_RATIO: num('CHANGE_ANOMALY_RATIO', 2.0),
    CHANGE_MIN_PAIRS: num('CHANGE_MIN_PAIRS', 4),
    CHANGE_MIN_NOMINAL: num('CHANGE_MIN_NOMINAL', 100_000),
    WEIGHT_DEV_BOM: num('WEIGHT_DEV_BOM', 30),
    WEIGHT_GROWTH: num('WEIGHT_GROWTH', 25),
    WEIGHT_RESIDUAL: num('WEIGHT_RESIDUAL', 20),
    WEIGHT_TOLERANCE: num('WEIGHT_TOLERANCE', 15),
    WEIGHT_HISTORY: num('WEIGHT_HISTORY', 10),
    TOP_N_ITEMS: num('TOP_N_ITEMS', 10),
    TOP_N_OUTLETS: num('TOP_N_OUTLETS', 10),
    // FIX (AUDIT8-ROLLBACK-1, Item 15): read from Settings (fallback 30 matches
    // the previous hardcoded value in outlet-items/route.ts).
    TOP_N_DEVIASI_RANK: num('TOP_N_DEVIASI_RANK', 30),
    HIGH_LOSS_NOMINAL_THRESHOLD: num('HIGH_LOSS_NOMINAL_THRESHOLD', 50_000_000),
    P2_NOMINAL_THRESHOLD: num('P2_NOMINAL_THRESHOLD', 10_000_000),
    HEALTH_WEIGHT_DEV_BOM: num('HEALTH_WEIGHT_DEV_BOM', 30),
    HEALTH_WEIGHT_RESIDUAL: num('HEALTH_WEIGHT_RESIDUAL', 25),
    HEALTH_WEIGHT_LOSS_TO_SALES: num('HEALTH_WEIGHT_LOSS_TO_SALES', 25),
    HEALTH_WEIGHT_ABNORMAL: num('HEALTH_WEIGHT_ABNORMAL', 20),
    HEALTH_THRESH_DEV_BOM_GOOD: num('HEALTH_THRESH_DEV_BOM_GOOD', 0.05),
    HEALTH_THRESH_DEV_BOM_BAD: num('HEALTH_THRESH_DEV_BOM_BAD', 0.50),
    HEALTH_THRESH_RESIDUAL_GOOD: num('HEALTH_THRESH_RESIDUAL_GOOD', 0.20),
    HEALTH_THRESH_RESIDUAL_BAD: num('HEALTH_THRESH_RESIDUAL_BAD', 0.80),
    HEALTH_THRESH_LOSS_TO_SALES_GOOD: num('HEALTH_THRESH_LOSS_TO_SALES_GOOD', 0.02),
    HEALTH_THRESH_LOSS_TO_SALES_BAD: num('HEALTH_THRESH_LOSS_TO_SALES_BAD', 0.15),
    HEALTH_THRESH_ABNORMAL_GOOD: num('HEALTH_THRESH_ABNORMAL_GOOD', 0.0),
    HEALTH_THRESH_ABNORMAL_BAD: num('HEALTH_THRESH_ABNORMAL_BAD', 0.50),
  };
}
