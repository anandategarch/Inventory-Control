// ============================================================
//  CFG_THRESHOLDS — tunable business thresholds
//  Edit values here WITHOUT touching engine code.
// ============================================================
export const CFG_THRESHOLDS = {
  // Growth mismatch — flag if deviation growth > salesGrowth * FACTOR
  SALES_DEVIATION_FACTOR: 2.0,      // dev growth > 2x sales growth → ABNORMAL
  BOM_DEVIATION_FACTOR: 2.0,        // dev growth > 2x BOM growth → ABNORMAL

  // Residual Loss — fraction of deviation unexplained by waste+susut+trial
  RESIDUAL_LOSS_WARN_PCT: 0.50,     // >50% residual → WARNING
  RESIDUAL_LOSS_HIGH_PCT: 0.70,     // >70% residual → ABNORMAL

  // Benchmarking — outlet dev/bom vs area average
  BENCHMARK_AREA_FACTOR: 1.5,       // >1.5x area avg → WARNING
  BENCHMARK_AREA_ZSCORE: 1.5,       // z-score > 1.5 → flag
  BENCHMARK_NETWORK_FACTOR: 2.0,    // >2x network avg → ABNORMAL

  // Historical abnormality
  HISTORICAL_ZSCORE_WARN: 1.5,
  HISTORICAL_ZSCORE_HIGH: 2.0,
  HISTORICAL_MIN_WEEKS: 4,          // need at least 4 weeks of history

  // Priority weights (operational score)
  WEIGHT_DEV_BOM: 30,
  WEIGHT_GROWTH: 25,
  WEIGHT_RESIDUAL: 20,
  WEIGHT_TOLERANCE: 15,
  WEIGHT_HISTORY: 10,

  // Ranking limits
  TOP_N_ITEMS: 10,
  TOP_N_OUTLETS: 10,

  // Tolerance — when "BELUM ADA TOLERANSI", use fallback
  FALLBACK_TOLERANCE_PCT: 0.05,     // 5% analytical flag

  // Standard tolerance thresholds (mirrors RuntimeThresholds for type compatibility)
  STD_SUSUT_PCT: 0.10,              // 10% max susut
  STD_WASTE_PCT: 0.05,              // 5% max waste
  STD_TRIAL_PCT: 0.03,              // 3% max trial
  STD_DEVIASI_BOM_PCT: 0.05,        // 5% max deviation/BOM
  HIGH_LOSS_NOMINAL_THRESHOLD: 1_000_000,  // Rp 1M loss threshold

  // Week period ranges (user confirmed: WEEK 1=1-7, WEEK 2=8-14, WEEK 3/4=15-30/31)
  WEEK_RANGES: {
    'WEEK 1': { start: 1, end: 7 },
    'WEEK 2': { start: 8, end: 14 },
    'WEEK 3': { start: 15, end: 31 }, // 30 or 31
    'WEEK 4': { start: 15, end: 31 }, // same as WEEK 3 (data may use either)
  } as Record<string, { start: number; end: number }>,

  // Sales deviation ratio (deviation growth / sales growth)
  SALES_DEV_RATIO_FLAG: 3.0,        // >3x → mismatch

  // UOM — per item, no conversion (per user decision)
  ENABLE_UOM_CONVERSION: false,
} as const;

export type CfgThresholds = typeof CFG_THRESHOLDS;
