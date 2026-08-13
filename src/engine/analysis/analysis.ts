// ============================================================
//  Analysis Engine — rule context, worklist, priorities, ranking
//  --------------------------------------------------------
//  Phase 5: Removed 20 dead functions (replaced by SQL queries
//  in src/lib/queries.ts during Phase 4). Only actively-called
//  functions remain. All metric computations use the Metric
//  Engine (src/lib/metrics) as single source of truth.
//
//  Actively-used functions (8):
//   - dedupSalesByOutlet (internal helper)
//   - buildRuleContext (called by /api/analysis route rule loop)
//   - recommendAction (called by buildWorklistFromFlags)
//   - buildWorklistFromFlags (called by /api/analysis route)
//   - computePrioritiesFromFlags (called by /api/analysis route)
//   - computeVarianceAnalysis (called by /api/analysis route)
//   - computeOutletHealthRanking (called by /api/analysis route)
//   - computeHistoricalAnalysis (called by /api/analysis route)
//
//  Removed (dead code, replaced by SQL queries):
//   - buildExecutiveSummary → queryExecSummary + buildExecSummaryFromSql
//   - topItemsByNominal → queryTopItemsByNominal
//   - topItemsByDevBom → queryTopItemsByDevBom
//   - topOutlets → queryTopOutlets
//   - topOutletsBySales → queryTopOutletsBySales
//   - topItemsByWaste/Susut/Trial/LossSurplus → queryTopItemsByCategory
//   - deviationBreakdown → queryDeviationBreakdown
//   - lossVsSurplus → queryLossVsSurplus
//   - buildWorklist → buildWorklistFromFlags (uses pre-computed flags)
//   - computePriorities → computePrioritiesFromFlags (uses pre-computed flags)
//   - buildTrend → queryTrendAgg
//   - computeAreaAnalysis → queryAreaAnalysis
//   - computePareto → queryPareto
//   - computeCostImpact → queryCostImpact
//   - computeItemConsistencyAnalysis → queryItemConsistency
//   - computeNetCostTrend → queryTrendAgg (derived in route)
// ============================================================
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';
import type {
  PriorityScore,
  InvestigationItem,
} from '@/types/inventory';
import { CFG_THRESHOLDS } from '@/config/thresholds';
import type { RuntimeThresholds } from '@/lib/settings';
import { evaluateRules, type RuleContext } from '@/engine/rules/evaluator';
import {
  calcGrowth,
  calcGrowthAbs,
  computeNominalDeviationGrowth,
  safeRatio,
  calcAvgPrice,
  computeHealthScore,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeLossToSales,
  calcZScoreFromStats,
  type AggregateInput,
  type HealthScoreWeights,
} from '@/lib/metrics';

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

// ============================================================
//  Sales MODE dedup — internal helper
//  Bug 6 fix: use MODE (most frequent value) not MAX.
//  Sales is outlet-level denormalized (same value on every item row).
//  MAX is vulnerable to typo (1 row with 10M instead of 1M → adopts wrong value).
//  MODE = most frequent value, robust against single-row typo.
// ============================================================
function dedupSalesByOutlet(recs: RecWithRels[]): Map<number, number> {
  // Collect all sales values per outlet
  const byOutlet = new Map<number, Map<number, number>>(); // outletId → (salesValue → count)
  for (const r of recs) {
    if (r.nominalSales != null && r.nominalSales > 0) {
      let counts = byOutlet.get(r.outletId);
      if (!counts) {
        counts = new Map();
        byOutlet.set(r.outletId, counts);
      }
      // Bug 11 fix: round to 2 decimal places (preserve rupiah precision, avoid float comparison issues)
      const rounded = Math.round(r.nominalSales * 100) / 100;
      counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
    }
  }
  // Pick MODE (most frequent) per outlet
  const result = new Map<number, number>();
  for (const [outletId, counts] of byOutlet) {
    let bestVal = Infinity; // BUG-07 fix: start with Infinity so first entry always wins
    let bestCount = 0;
    for (const [val, count] of counts) {
      // BUG-07 fix: match SQL ORDER BY cnt DESC, nominalSales ASC
      // SQL picks SMALLER value on tie. JS must match.
      if (count > bestCount || (count === bestCount && val < bestVal)) {
        bestVal = val;
        bestCount = count;
      }
    }
    result.set(outletId, bestVal);
  }
  return result;
}

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
  const currPrice = calcAvgPrice(curr.nominalDeviasi, curr.qtyDeviasi);
  const prevPrice = calcAvgPrice(prev?.nominalDeviasi ?? null, prev?.qtyDeviasi ?? null);
  const priceGrowth = calcGrowth(currPrice, prevPrice);

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
  const explainedQty = Math.abs((curr.qtyWaste ?? 0) + (curr.qtySusut ?? 0) + (curr.qtyTrial ?? 0));
  const absDevQty = Math.abs(curr.qtyDeviasi ?? 0);
  const isOverExplained = absDevQty > 0 && explainedQty > absDevQty;

  // Bug 3 fix: expose prevDirection for flip-flop detection
  // Master context #30/#58: direction flip = LOSS↔SURPLUS between periods
  const prevDirection = prev?.direction ?? null;
  const isDirectionFlip = prevDirection != null && curr.direction != null &&
    prevDirection !== 'NEUTRAL' && curr.direction !== 'NEUTRAL' &&
    prevDirection !== curr.direction;

  return {
    salesGrowth, bomGrowth, qtyDeviasiGrowth, nominalDeviasiGrowth, priceGrowth,
    deviationToSalesRatio: safeRatio(curr.absNominalDeviasi, curr.nominalSales),
    deviationToBomRatio: safeRatio(curr.absQtyDeviasi, curr.qtyBom != null ? Math.abs(curr.qtyBom) : null),
    benchmarkFlag, zScore,
    qtyDeviasi: curr.qtyDeviasi, nominalDeviasi: curr.nominalDeviasi,
    qtyWaste: curr.qtyWaste, qtySusut: curr.qtySusut, qtyTrial: curr.qtyTrial,
    qtyLossSurplus: curr.qtyLossSurplus,
    residualQty: curr.residualQty, residualRatio: curr.residualRatio,
    tolerancePct: curr.tolerancePct, pctQtyDeviasiToBom: curr.pctQtyDeviasiToBom,
    direction: curr.direction,
    prevDirection,
    isDirectionFlip,
    absNominalDeviasi: curr.absNominalDeviasi, absQtyDeviasi: curr.absQtyDeviasi,
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

// ============================================================
//  OPTIMIZED: Build worklist from pre-computed flags
//  Avoids re-evaluating rules (which is the main bottleneck)
//  Optional `t` = runtime thresholds (not used in worklist itself,
//  but kept for API consistency)
// ============================================================
export function buildWorklistFromFlags(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  _t?: RuntimeThresholds | typeof CFG_THRESHOLDS,
): InvestigationItem[] {
  const items: InvestigationItem[] = [];

  for (const { curr, flags } of recsWithFlags) {
    if (flags.length === 0) continue;

    const top = flags[0];
    const priority: 'P1' | 'P2' | 'P3' =
      top.severity === 'ABNORMAL' ? 'P1' : top.severity === 'WARNING' ? 'P2' : 'P3';

    items.push({
      priority,
      outletCode: curr.outlet.code,
      outletName: curr.outlet.name,
      area: curr.area,
      itemName: curr.item.name,
      issue: top.ruleName,
      evidence: top.narrative || JSON.stringify(top.evidence).slice(0, 200),
      recommendedAction: recommendAction(flags.map((f) => f.ruleCode)),
      ruleCodes: flags.map((f) => f.ruleCode),
      absNominalDeviasi: curr.absNominalLossSurplus ?? 0, // NET per master context #36
      deviationToBom: curr.pctQtyDeviasiToBom,
      direction: curr.direction as 'LOSS' | 'SURPLUS' | 'NEUTRAL',
    });
  }

  const order = { P1: 0, P2: 1, P3: 2 };
  items.sort((a, b) => order[a.priority] - order[b.priority] || b.absNominalDeviasi - a.absNominalDeviasi);
  return items.slice(0, 100);
}

// ============================================================
//  OPTIMIZED: Compute priorities from pre-computed flags
//  Avoids re-evaluating rules (which is the main bottleneck)
//  Optional `t` = runtime thresholds from DB (falls back to CFG_THRESHOLDS)
// ============================================================
export function computePrioritiesFromFlags(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  t: RuntimeThresholds | typeof CFG_THRESHOLDS = CFG_THRESHOLDS,
): PriorityScore[] {
  const scores: PriorityScore[] = [];

  for (const { curr, flags } of recsWithFlags) {
    if (flags.length === 0) continue;

    const top = flags[0];

    // Use fields directly from the record (already computed at transform time)
    const devBomScore = curr.pctQtyDeviasiToBom != null ? Math.abs(curr.pctQtyDeviasiToBom) : 0;
    const residualScore = Math.abs(curr.residualRatio ?? 0);
    const tolBreach = curr.tolerancePct != null && curr.pctQtyDeviasiToBom != null
      ? Math.max(0, Math.abs(curr.pctQtyDeviasiToBom) - Math.abs(curr.tolerancePct))
      : Math.abs(curr.pctQtyDeviasiToBom ?? 0) * 0.5;
    // Growth and zScore are in the evidence (from rule context)
    const evidence = top.evidence as any;
    const growthScore = Math.max(
      Math.abs(evidence.qtyDeviasiGrowth ?? 0),
      Math.abs(evidence.nominalDeviasiGrowth ?? 0),
    );
    const histScore = Math.abs(evidence.zScore ?? 0);

    const financialScore = (curr.absNominalLossSurplus ?? 0) / 1_000_000; // NET per master context #36
    const operationalScore =
      devBomScore * t.WEIGHT_DEV_BOM +
      Math.min(growthScore, 5) * t.WEIGHT_GROWTH +
      residualScore * t.WEIGHT_RESIDUAL +
      tolBreach * t.WEIGHT_TOLERANCE +
      Math.min(histScore, 5) * t.WEIGHT_HISTORY;

    scores.push({
      itemId: curr.itemId,
      itemName: curr.item.name,
      outletId: curr.outletId,
      outletCode: curr.outlet.code,
      outletName: curr.outlet.name,
      area: curr.area,
      financialScore,
      operationalScore,
      financialRank: null,
      operationalRank: null,
      topAnomaly: top,
    });
  }

  const byFin = [...scores].sort((a, b) => b.financialScore - a.financialScore);
  byFin.forEach((s, i) => { s.financialRank = i + 1; });
  const byOps = [...scores].sort((a, b) => b.operationalScore - a.operationalScore);
  byOps.forEach((s, i) => { s.operationalRank = i + 1; });

  // Bug 1 fix: sort by combined finalScore (lower combined rank = higher priority)
  // finalScore = financialRank + operationalRank — lower = more critical
  // Without this, .slice(0, 20) in API route returns random 20 (DB order)
  const sorted = scores
    .map((s) => ({
      ...s,
      finalScore: (s.financialRank ?? 9999) + (s.operationalRank ?? 9999),
    }))
    .sort((a, b) => a.finalScore - b.finalScore);

  return sorted;
}

// ============================================================
//  Variance Analysis — items whose deviation changed most
//  Positive delta = worsened (deviasi naik)
//  Negative delta = improved (deviasi turun)
// ============================================================
export function computeVarianceAnalysis(
  current: RecWithRels[],
  prevByOutletItem: Map<string, RecWithRels>
) {
  const deltas: Array<{
    itemName: string;
    outletCode: string;
    area: string;
    currentAbsNominal: number;
    previousAbsNominal: number;
    delta: number;
    direction: string;
    varianceDirection: string;
  }> = [];

  for (const curr of current) {
    if (curr.absNominalDeviasi == null || curr.absNominalDeviasi === 0) continue;
    const key = `${curr.outletId}|${curr.itemId}`;
    const prev = prevByOutletItem.get(key);
    if (!prev || prev.absNominalDeviasi == null || prev.absNominalDeviasi === 0) continue;
    const delta = curr.absNominalDeviasi - prev.absNominalDeviasi;
    // Bug 7 fix: add varianceDirection to show whether the item worsened or
    // improved vs previous period. `direction` (curr.direction) shows the
    // item's current LOSS/SURPLUS status, which is misleading for variance
    // analysis — a LOSS item can still be improving if its deviation shrank.
    const varianceDirection = delta > 0 ? 'WORSENED' : delta < 0 ? 'IMPROVED' : 'STABLE';
    deltas.push({
      itemName: curr.item.name,
      outletCode: curr.outlet.code,
      area: curr.area,
      currentAbsNominal: curr.absNominalDeviasi,
      previousAbsNominal: prev.absNominalDeviasi,
      delta,
      direction: curr.direction || 'NEUTRAL',
      varianceDirection,
    });
  }

  const topWorsened = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, 5);
  const topImproved = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 5);
  return { topWorsened, topImproved };
}

// ============================================================
//  Outlet Health Ranking — health score per outlet (worst first)
//  Uses pre-computed flags from recsWithFlags
//
//  Phase 4: Uses Metric Engine (computeHealthScore, computeDevBomAggregate,
//  computeResidualPctAggregate, computeLossToSales) as single source of truth.
//  Previously: inline healthScore formula with hardcoded thresholds + simple-average devBom.
//  Now: aggregate SUM/SUM devBom (volume-weighted) + Settings-driven thresholds.
// ============================================================
export function computeOutletHealthRanking(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  zeroDevByOutlet?: Map<number, number>,
  healthScoreWeights?: HealthScoreWeights,
) {
  // BUG 2.2 fix: precompute sales per outlet via MODE (not MAX).
  // Previously used MAX which is vulnerable to single-row typos (1 row with 10M
  // instead of 1M → adopts wrong value, overstating health score).
  // Now consistent with dedupSalesByOutlet used elsewhere (Bug 6 fix).
  const salesByOutletMode = dedupSalesByOutlet(recsWithFlags.map((r) => r.curr));

  // Phase 4: Accumulate AGGREGATE sums (SUM/SUM) for Metric Engine — NOT simple-average
  // of per-row ratios. This aligns the dashboard health ranking with the Metric Engine
  // single source of truth (computeHealthScore + computeDevBomAggregate).
  // Previously: devBom = avg(|pctQtyDeviasiToBom|) (simple avg, unweighted)
  // Now: devBom = SUM(|qtyDeviasi|) / SUM(|qtyBom|) (aggregate, volume-weighted)
  const byOutlet = new Map<number, {
    outlet: Outlet;
    area: string;
    normal: number;
    warning: number;
    abnormal: number;
    absNominal: number;
    totalQtyDeviasi: number;   // SUM(ABS(qtyDeviasi))
    totalQtyBom: number;       // SUM(ABS(qtyBom))
    totalQtyWaste: number;     // SUM(ABS(qtyWaste))
    totalQtySusut: number;     // SUM(ABS(qtySusut))
    totalQtyTrial: number;     // SUM(ABS(qtyTrial))
    totalResidualQty: number;  // SUM(ABS(residualQty))
    lossNominal: number;       // SUM(nominalLossSurplus WHERE > 0)
    sales: number;
  }>();

  const ensure = (r: RecWithRels) => {
    let e = byOutlet.get(r.outletId);
    if (!e) {
      e = {
        outlet: r.outlet,
        area: r.area,
        normal: 0,
        warning: 0,
        abnormal: 0,
        absNominal: 0,
        totalQtyDeviasi: 0,
        totalQtyBom: 0,
        totalQtyWaste: 0,
        totalQtySusut: 0,
        totalQtyTrial: 0,
        totalResidualQty: 0,
        lossNominal: 0,
        sales: 0,
      };
      byOutlet.set(r.outletId, e);
    }
    return e;
  };

  for (const { curr, flags } of recsWithFlags) {
    const e = ensure(curr);
    e.absNominal += curr.absNominalDeviasi ?? 0;
    // Phase 4: accumulate aggregate sums for Metric Engine
    e.totalQtyDeviasi += Math.abs(curr.qtyDeviasi ?? 0);
    e.totalQtyBom += Math.abs(curr.qtyBom ?? 0);
    e.totalQtyWaste += Math.abs(curr.qtyWaste ?? 0);
    e.totalQtySusut += Math.abs(curr.qtySusut ?? 0);
    e.totalQtyTrial += Math.abs(curr.qtyTrial ?? 0);
    e.totalResidualQty += Math.abs(curr.residualQty ?? 0);
    // Bug A fix: use nominalLossSurplus (NET) not nominalDeviasi (GROSS)
    if (curr.nominalLossSurplus != null && curr.nominalLossSurplus > 0) {
      e.lossNominal += curr.nominalLossSurplus;
    }
    // Sales filled from MODE map below (not MAX per row)
    if (flags.length === 0) {
      e.normal++;
    } else {
      const top = flags[0];
      if (top.severity === 'ABNORMAL') e.abnormal++;
      else if (top.severity === 'WARNING') e.warning++;
      else e.normal++;
    }
  }

  // Fill sales from MODE map (BUG 2.2 fix — was MAX before)
  for (const [outletId, e] of byOutlet) {
    e.sales = salesByOutletMode.get(outletId) ?? 0;
  }

  // Account for zero-deviation records (counted as normal elsewhere)
  if (zeroDevByOutlet) {
    for (const [outletId, cnt] of zeroDevByOutlet) {
      const e = byOutlet.get(outletId);
      if (e) e.normal += cnt;
    }
  }

  return [...byOutlet.values()]
    .map((v) => {
      // Phase 4: Use Metric Engine for all aggregate metrics (single source of truth)
      const aggregateInput: AggregateInput = {
        totalQtyDeviasi: v.totalQtyDeviasi,
        totalQtyBom: v.totalQtyBom,
        totalQtyWaste: v.totalQtyWaste,
        totalQtySusut: v.totalQtySusut,
        totalQtyTrial: v.totalQtyTrial,
        totalResidualQty: v.totalResidualQty,
        totalLossNominal: v.lossNominal,
        totalSales: v.sales,
        normalCount: v.normal,
        warningCount: v.warning,
        abnormalCount: v.abnormal,
      };

      // Metric Engine: aggregate Dev/BOM (SUM/SUM), Residual%, Loss/Sales, HealthScore
      // FIX (audit issue #6): Pass runtime health score weights from Settings
      const devBom = computeDevBomAggregate(aggregateInput);
      const residualPct = computeResidualPctAggregate(aggregateInput);
      const lossToSales = computeLossToSales(aggregateInput);
      const healthScore = computeHealthScore(aggregateInput, healthScoreWeights);

      return {
        outletCode: v.outlet.code,
        outletName: v.outlet.name,
        area: v.area,
        healthScore,
        normal: v.normal,
        warning: v.warning,
        abnormal: v.abnormal,
        absNominal: v.absNominal,
        residualPct,
        lossToSales,
        devBom,
        sales: v.sales,
      };
    })
    .sort((a, b) => a.healthScore - b.healthScore || b.abnormal - a.abnormal);
}

// ============================================================
//  Historical Analysis — critical items based on Z-Score
//  Phase 4: uses pre-computed historical stats from SQL aggregate query
//  (queryHistoricalStats), not raw arrays of historical records.
//  Phase 5: uses calcZScoreFromStats from Metric Engine (single source of truth)
// ============================================================
export function computeHistoricalAnalysis(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  historicalByOutletItem: Map<string, { mean: number; stdDev: number; n: number }>
) {
  const criticalItems: Array<{
    itemName: string; outletCode: string; area: string;
    currentDevBom: number; historicalAvg: number; zScore: number; absNominal: number;
  }> = [];

  for (const { curr, flags } of recsWithFlags) {
    const histRule = flags.find((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_WARNING');
    if (!histRule) continue;
    const key = `${curr.outletId}|${curr.itemId}`;
    const stats = historicalByOutletItem.get(key);
    if (!stats || stats.stdDev <= 0) continue;
    // Phase 5: use calcZScoreFromStats from Metric Engine (single source of truth)
    const zScore = calcZScoreFromStats(curr.pctQtyDeviasiToBom ?? 0, stats.mean, stats.stdDev);
    criticalItems.push({
      itemName: curr.item.name,
      outletCode: curr.outlet.code,
      area: curr.area,
      currentDevBom: curr.pctQtyDeviasiToBom ?? 0,
      historicalAvg: stats.mean,
      zScore: zScore ?? 0,
      absNominal: curr.absNominalDeviasi ?? 0,
    });
  }

  criticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  return { criticalItems: criticalItems.slice(0, 10) };
}
