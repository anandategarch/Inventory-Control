// ============================================================
//  Rule Service — rule context building + recommendation engine
//  --------------------------------------------------------
//  buildRuleContext: builds RuleContext for rule evaluation per record
//  recommendAction: maps rule codes to human-readable recommended actions
// ============================================================
import type { RuntimeThresholds } from '@/lib/settings';
import { CFG_THRESHOLDS } from '@/config/thresholds';
import { evaluateRules, type RuleContext } from '@/engine/rules/evaluator';
import {
  calcGrowth,
  calcGrowthAbs,
  computeNominalDeviationGrowth,
  safeRatio,
  calcZScoreFromStats,
} from '@/lib/metrics';
import type { RecWithRels } from './types';

// ============================================================
//  Per-record rule evaluation + context building
//  Optional `t` = runtime thresholds from DB (falls back to CFG_THRESHOLDS)
//
//  Phase 4 optimization: `historicalStats` is now precomputed by SQL
//  (queryHistoricalStats) instead of passing the raw array of values.
//  This avoids loading 540K historical records into JS memory.
// ============================================================
export function buildRuleContext(
  curr: RecWithRels,
  prev: RecWithRels | null,
  historicalStats: { mean: number; stdDev: number; n: number } | null,
  t: RuntimeThresholds | typeof CFG_THRESHOLDS = CFG_THRESHOLDS,
): RuleContext {
  const bomGrowth = calcGrowthAbs(curr.qtyBom, prev?.qtyBom ?? null);
  const qtyDeviasiGrowth = calcGrowthAbs(curr.qtyDeviasi, prev?.qtyDeviasi ?? null);
  // FIX (audit issue #4): Use magnitude growth for nominalDeviasi — signed calcGrowth
  // is misleading when sign flips (-10M→-20M gives -100% but magnitude grew 100%).
  const nominalDeviasiGrowth = computeNominalDeviationGrowth(curr.nominalDeviasi, prev?.nominalDeviasi ?? null);
  const salesGrowth = calcGrowth(curr.nominalSales, prev?.nominalSales ?? null);

  // Phase 4: use precomputed stats (mean + stdDev) from SQL aggregate query
  // LOGIC-03 fix: enforce HISTORICAL_MIN_WEEKS — skip zScore if sample size too small
  // Phase 5: use calcZScoreFromStats from Metric Engine (single source of truth)
  const zScore = historicalStats && historicalStats.stdDev > 0 && historicalStats.n >= (t.HISTORICAL_MIN_WEEKS ?? 4)
    ? calcZScoreFromStats(curr.pctQtyDeviasiToBom, historicalStats.mean, historicalStats.stdDev)
    : null;

  // FIX (audit issue #1): Historical benchmark flag from zScore — NOT area/network.
  // zScore compares outlet vs its OWN history. Area/network comparison is done
  // separately via computeBenchmark() (benchmark.ts) in the route layer.
  // Old names ABOVE_NETWORK_AVG/ABOVE_AREA_AVG were misleading — renamed to
  // HISTORICAL_HIGH/HISTORICAL_WARNING to match Metric Engine computeZScore().
  let benchmarkFlag: string | null = null;
  if (zScore != null) {
    if (zScore > t.HISTORICAL_ZSCORE_HIGH) benchmarkFlag = 'HISTORICAL_HIGH';
    else if (zScore > t.HISTORICAL_ZSCORE_WARN) benchmarkFlag = 'HISTORICAL_WARNING';
  }

  // Bug 8 fix: compute isOverExplained on-the-fly (explained > absDev)
  // This is a fraud red flag: Waste+Susut+Trial exceeds total deviation.
  const explainedQty = Math.abs(curr.qtyWaste ?? 0) + Math.abs(curr.qtySusut ?? 0) + Math.abs(curr.qtyTrial ?? 0);
  const absDevQty = Math.abs(curr.qtyDeviasi ?? 0);
  const isOverExplained = absDevQty > 0 && explainedQty > absDevQty;

  // Bug 3 fix: expose prevDirection for flip-flop detection
  // Master context #30/#58: direction flip = LOSS↔SURPLUS between periods
  const prevDirection = prev?.direction ?? null;
  const isDirectionFlip = prevDirection != null && curr.direction != null &&
    prevDirection !== 'NEUTRAL' && curr.direction !== 'NEUTRAL' &&
    prevDirection !== curr.direction;

  return {
    salesGrowth, bomGrowth, qtyDeviasiGrowth, nominalDeviasiGrowth,
    deviationToSalesRatio: safeRatio(curr.absNominalDeviasi, curr.nominalSales),
    deviationToBomRatio: safeRatio(curr.absQtyDeviasi, curr.qtyBom != null ? Math.abs(curr.qtyBom) : null),
    benchmarkFlag, zScore,
    qtyDeviasi: curr.qtyDeviasi, nominalDeviasi: curr.nominalDeviasi,
    qtyWaste: curr.qtyWaste, qtySusut: curr.qtySusut, qtyTrial: curr.qtyTrial,
    qtyLossSurplus: curr.qtyLossSurplus,
    // FIX SIGN-1: Add nominalLossSurplus to context — 5 rules use it (HIGH_LOSS_NOMINAL,
    // RESIDUAL_LOSS_HIGH/WARN, HISTORICAL_ABNORMAL_LOSS/SURPLUS). Without this, rules never fire.
    nominalLossSurplus: curr.nominalLossSurplus,
    residualQty: curr.residualQty, residualRatio: curr.residualRatio,
    tolerancePct: curr.tolerancePct, pctQtyDeviasiToBom: curr.pctQtyDeviasiToBom,
    direction: curr.direction,
    prevDirection,
    isDirectionFlip,
    absNominalDeviasi: curr.absNominalDeviasi, absQtyDeviasi: curr.absQtyDeviasi,
    absNominalLossSurplus: curr.absNominalLossSurplus, absQtyLossSurplus: curr.absQtyLossSurplus,
    isOverExplained,
    // ===== P2 fix: inject runtime thresholds into context so rules.yaml =====
    // ===== can reference them as field names instead of hardcoded values.  =====
    // e.g. { pctQtyDeviasiToBom: { gt: stdDeviasiBomPct } }
    stdDeviasiBomPct: t.STD_DEVIASI_BOM_PCT,
    stdSusutPct: t.STD_SUSUT_PCT,
    stdWastePct: t.STD_WASTE_PCT,
    stdTrialPct: t.STD_TRIAL_PCT,
    fallbackTolerancePct: t.FALLBACK_TOLERANCE_PCT,
    residualLossWarnPct: t.RESIDUAL_LOSS_WARN_PCT,
    residualLossHighPct: t.RESIDUAL_LOSS_HIGH_PCT,
    highLossNominalThreshold: t.HIGH_LOSS_NOMINAL_THRESHOLD,
    historicalZscoreWarn: t.HISTORICAL_ZSCORE_WARN,
    historicalZscoreHigh: t.HISTORICAL_ZSCORE_HIGH,
    salesDeviationFactor: t.SALES_DEVIATION_FACTOR,
    bomDeviationFactor: t.BOM_DEVIATION_FACTOR,
  };
}

// ============================================================
//  Recommendation Engine (rule-based)
//  Called by buildWorklistFromFlags
// ============================================================
export function recommendAction(ruleCodes: string[]): string {
  const set = new Set(ruleCodes);
  const actions: string[] = [];

  if (set.has('RESIDUAL_LOSS_HIGH') || set.has('RESIDUAL_LOSS_WARN')) {
    actions.push('Validasi Actual Usage vs SOC + sampling fisik + cek pencatatan Waste/Susut/Trial');
  }
  if (set.has('OVER_EXPLAINED')) {
    actions.push('Indikasi fraud/salah input: Waste+Susut+Trial melampaui Deviasi — audit pencatatan SPV + cek double-counting');
  }
  if (set.has('DIRECTION_FLIP')) {
    actions.push('Arah deviasi berbalik antar periode — cek perubahan operasional, stock opname timing, atau error input');
  }
  if (set.has('BOM_DEVIATION_MISMATCH') || set.has('BOM_DOWN_DEV_UP')) {
    actions.push('Rekonsiliasi BOM aktual vs sistem + periksa receiving/transfer/UOM conversion');
  }
  if (set.has('SALES_DEVIATION_MISMATCH') || set.has('SALES_DEV_DECREASE')) {
    actions.push('Cek apakah deviation naik karena quantity atau price effect + audit transaksi inventory');
  }
  if (set.has('TOLERANCE_BREACH') || set.has('TOLERANCE_BREACH_HIGH')) {
    actions.push('Review SOC/standard + sampling pemakaian aktual per menu');
  }
  if (set.has('TOLERANCE_NOT_SET_HIGH_DEV')) {
    actions.push('Set tolerance baseline + monitoring deviasi tanpa official tolerance');
  }
  if (set.has('BENCHMARK_ABOVE_AREA') || set.has('BENCHMARK_ABOVE_NETWORK')) {
    actions.push('Benchmarking vs outlet serupa + cek prosedur operasional');
  }
  if (set.has('HISTORICAL_ABNORMAL') || set.has('HISTORICAL_ABNORMAL_SURPLUS') || set.has('HISTORICAL_WARNING')) {
    actions.push('Investigasi pola abnormal vs historical behavior (outlier detection)');
  }
  if (set.has('HIGH_LOSS_NOMINAL')) {
    actions.push('Prioritas financial impact: cek transaksi adjustment + receiving discrepancy');
  }

  return actions.length > 0 ? actions.join(' | ') : 'Investigasi lanjutan diperlukan';
}
