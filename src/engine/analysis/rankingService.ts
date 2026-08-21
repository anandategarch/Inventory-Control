// ============================================================
//  Ranking Service — health ranking, variance, historical, priorities, worklist
//  --------------------------------------------------------
//  Uses Metric Engine (src/lib/metrics) as single source of truth.
//  All metric computations go through computeHealthScore, computeDevBomAggregate,
//  computeResidualPctAggregate, computeLossToSales, calcZScoreFromStats.
// ============================================================
import type { PriorityScore, InvestigationItem } from '@/types/inventory';
import type { RuntimeThresholds } from '@/lib/settings';
import { CFG_THRESHOLDS } from '@/config/thresholds';
import { evaluateRules } from '@/engine/rules/evaluator';
import {
  computeHealthScore,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeLossToSales,
  calcZScoreFromStats,
  computePriority,
  type AggregateInput,
  type HealthScoreWeights,
  type HealthScoreThresholds,
} from '@/lib/metrics';
import { recommendAction } from './ruleService';
import type { RecWithRels } from './types';

// FIX FLOW-1 + API-CALC-1: shared direction computation from nominalLossSurplus sign
// (not stored curr.direction which may be inverted for un-migrated DBs)
function computeDirectionFromData(rec: RecWithRels | null): 'LOSS' | 'SURPLUS' | 'NEUTRAL' {
  if (!rec) return 'NEUTRAL';
  if (rec.nominalLossSurplus != null) {
    if (rec.nominalLossSurplus < 0) return 'LOSS';
    if (rec.nominalLossSurplus > 0) return 'SURPLUS';
    return 'NEUTRAL';
  }
  if (rec.qtyDeviasi != null) {
    if (rec.qtyDeviasi < 0) return 'LOSS';
    if (rec.qtyDeviasi > 0) return 'SURPLUS';
    return 'NEUTRAL';
  }
  return 'NEUTRAL';
}

// ============================================================
//  Sales MODE dedup — internal helper
//  Bug 6 fix: use MODE (most frequent value) not MAX.
//  Sales is outlet-level denormalized (same value on every item row).
//  MAX is vulnerable to typo (1 row with 10M instead of 1M → adopts wrong value).
//  MODE = most frequent value, robust against single-row typo.
// ============================================================
function dedupSalesByOutlet(recs: RecWithRels[]): Map<number, number> {
  const byOutlet = new Map<number, Map<number, number>>(); // outletId → (salesValue → count)
  for (const r of recs) {
    if (r.nominalSales != null && r.nominalSales > 0) {
      let counts = byOutlet.get(r.outletId);
      if (!counts) {
        counts = new Map();
        byOutlet.set(r.outletId, counts);
      }
      const rounded = Math.round(r.nominalSales * 100) / 100;
      counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
    }
  }
  const result = new Map<number, number>();
  for (const [outletId, counts] of byOutlet) {
    let bestVal = Infinity; // BUG-07 fix: start with Infinity so first entry always wins
    let bestCount = 0;
    for (const [val, count] of counts) {
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
//  OPTIMIZED: Build worklist from pre-computed flags
//  Avoids re-evaluating rules (which is the main bottleneck)
// ============================================================
export function buildWorklistFromFlags(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  t: RuntimeThresholds | typeof CFG_THRESHOLDS = CFG_THRESHOLDS,
): InvestigationItem[] {
  const items: InvestigationItem[] = [];

  for (const { curr, flags } of recsWithFlags) {
    if (flags.length === 0) continue;

    const top = flags[0];

    // FIX (BUG-2-1): Delegate to computePriority from the Metric Engine so
    // the Investigation Worklist's P-level matches the priority shown in the
    // item-history / outlet-items / outlet-focus detail views. Previously
    // this used a severity→P-level map (ABNORMAL→P1, WARNING→P2, else P3)
    // which diverged from computePriority's criteria-OR logic for cases like
    // (a) HIGH_LOSS_NOMINAL firing (was WARNING→P2) but absNominalLossSurplus
    // > HIGH_LOSS_NOMINAL_THRESHOLD (computePriority P1), or (b)
    // TOLERANCE_BREACH_HIGH firing (ABNORMAL→P1) with no P1 criterion met
    // (computePriority P2/P3). Now both code paths produce the same result.
    const evidence = top.evidence as Record<string, unknown>;
    const priority = computePriority({
      absNominalLossSurplus: curr.absNominalLossSurplus ?? 0,
      devBom: curr.pctQtyDeviasiToBom,
      residualRatio: curr.residualRatio,
      zScore: typeof evidence.zScore === 'number' ? evidence.zScore : null,
      isOverExplained: evidence.isOverExplained === true,
      thresholds: {
        HIGH_LOSS_NOMINAL_THRESHOLD: t.HIGH_LOSS_NOMINAL_THRESHOLD,
        P2_NOMINAL_THRESHOLD: t.P2_NOMINAL_THRESHOLD,
        STD_DEVIASI_BOM_PCT: t.STD_DEVIASI_BOM_PCT,
        RESIDUAL_LOSS_WARN_PCT: t.RESIDUAL_LOSS_WARN_PCT,
        RESIDUAL_LOSS_HIGH_PCT: t.RESIDUAL_LOSS_HIGH_PCT,
        HISTORICAL_ZSCORE_HIGH: t.HISTORICAL_ZSCORE_HIGH,
      },
    });

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
      // FIX FLOW-1: compute direction on-the-fly (not stored curr.direction)
      direction: computeDirectionFromData(curr),
    });
  }

  const order = { P1: 0, P2: 1, P3: 2 };
  items.sort((a, b) => order[a.priority] - order[b.priority] || b.absNominalDeviasi - a.absNominalDeviasi);
  return items.slice(0, 100);
}

// ============================================================
//  OPTIMIZED: Compute priorities from pre-computed flags
// ============================================================
export function computePrioritiesFromFlags(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  t: RuntimeThresholds | typeof CFG_THRESHOLDS = CFG_THRESHOLDS,
): PriorityScore[] {
  const scores: PriorityScore[] = [];

  for (const { curr, flags } of recsWithFlags) {
    if (flags.length === 0) continue;

    const top = flags[0];

    const devBomScore = curr.pctQtyDeviasiToBom != null ? Math.abs(curr.pctQtyDeviasiToBom) : 0;
    const residualScore = Math.abs(curr.residualRatio ?? 0);
    const tolBreach = curr.tolerancePct != null && curr.pctQtyDeviasiToBom != null
      ? Math.max(0, Math.abs(curr.pctQtyDeviasiToBom) - Math.abs(curr.tolerancePct))
      : Math.abs(curr.pctQtyDeviasiToBom ?? 0) * 0.5;
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
// ============================================================
export function computeVarianceAnalysis(
  current: RecWithRels[],
  prevByOutletItem: Map<string, RecWithRels>
) {
  // Rev 6: Return signed nominalDeviasi (actual, not abs) + rename delta → selisih.
  // Sort still by abs(selisih) to surface biggest changes (regardless of direction).
  const deltas: Array<{
    itemName: string;
    outletCode: string;
    area: string;
    currentNominal: number;
    previousNominal: number;
    selisih: number;
    currentAbsNominal: number;
    previousAbsNominal: number;
    delta: number;
    direction: string;
    varianceDirection: string;
  }> = [];

  for (const curr of current) {
    if (curr.absNominalDeviasi == null) continue;
    // FIX (BUG 4): Include akunPenyesuaian in key — matches analysis route's prevByOutletItem
    const key = `${curr.outletId}|${curr.itemId}|${curr.akunPenyesuaian ?? ''}`;
    const prev = prevByOutletItem.get(key);
    if (!prev || prev.absNominalDeviasi == null) continue;
    const delta = curr.absNominalDeviasi - prev.absNominalDeviasi;
    // Rev 6: selisih = signed difference (current nominalDeviasi - previous nominalDeviasi)
    const currentNominal = curr.nominalDeviasi ?? 0;
    const previousNominal = prev.nominalDeviasi ?? 0;
    const selisih = currentNominal - previousNominal;
    const varianceDirection = delta > 0 ? 'WORSENED' : delta < 0 ? 'IMPROVED' : 'STABLE';
    deltas.push({
      itemName: curr.item.name,
      outletCode: curr.outlet.code,
      area: curr.area,
      currentNominal,
      previousNominal,
      selisih,
      currentAbsNominal: curr.absNominalDeviasi,
      previousAbsNominal: prev.absNominalDeviasi,
      delta,
      // FIX FLOW-1: compute direction on-the-fly (not stored curr.direction)
      direction: computeDirectionFromData(curr),
      varianceDirection,
    });
  }

  // FIX CALC2-1: After CALC-1 sign convention fix (LOSS=negative), sorting by signed `selisih`
  // is INVERTED — LOSS worsening (-5M→-10M) gives selisih=-5M (negative), which would rank
  // as "improved" under ascending sort. Use `delta` (magnitude change) instead:
  //   delta > 0 = magnitude grew = WORSENED (regardless of sign)
  //   delta < 0 = magnitude shrank = IMPROVED
  const topWorsened = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, 5);
  const topImproved = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 5);
  return { topWorsened, topImproved };
}

// ============================================================
//  Outlet Health Ranking — health score per outlet (worst first)
//  Phase 4: Uses Metric Engine as single source of truth.
// ============================================================
export function computeOutletHealthRanking(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  zeroDevByOutlet?: Map<number, number>,
  healthScoreWeights?: HealthScoreWeights,
  healthScoreThresholds?: HealthScoreThresholds,
) {
  const salesByOutletMode = dedupSalesByOutlet(recsWithFlags.map((r) => r.curr));

  const byOutlet = new Map<number, {
    outlet: RecWithRels['outlet'];
    area: string;
    normal: number;
    warning: number;
    abnormal: number;
    absNominal: number;
    totalQtyDeviasi: number;
    totalQtyBom: number;
    totalQtyWaste: number;
    totalQtySusut: number;
    totalQtyTrial: number;
    totalResidualQty: number;
    lossNominal: number;
    sales: number;
  }>();

  const ensure = (r: RecWithRels) => {
    let e = byOutlet.get(r.outletId);
    if (!e) {
      e = {
        outlet: r.outlet,
        area: r.area,
        normal: 0, warning: 0, abnormal: 0, absNominal: 0,
        totalQtyDeviasi: 0, totalQtyBom: 0, totalQtyWaste: 0,
        totalQtySusut: 0, totalQtyTrial: 0, totalResidualQty: 0,
        lossNominal: 0, sales: 0,
      };
      byOutlet.set(r.outletId, e);
    }
    return e;
  };

  for (const { curr, flags } of recsWithFlags) {
    const e = ensure(curr);
    e.absNominal += curr.absNominalDeviasi ?? 0;
    e.totalQtyDeviasi += Math.abs(curr.qtyDeviasi ?? 0);
    e.totalQtyBom += Math.abs(curr.qtyBom ?? 0);
    e.totalQtyWaste += Math.abs(curr.qtyWaste ?? 0);
    e.totalQtySusut += Math.abs(curr.qtySusut ?? 0);
    e.totalQtyTrial += Math.abs(curr.qtyTrial ?? 0);
    e.totalResidualQty += Math.abs(curr.residualQty ?? 0);
    // FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
    if (curr.nominalLossSurplus != null && curr.nominalLossSurplus < 0) {
      e.lossNominal += Math.abs(curr.nominalLossSurplus);
    }
    if (flags.length === 0) {
      e.normal++;
    } else {
      const top = flags[0];
      if (top.severity === 'ABNORMAL') e.abnormal++;
      else if (top.severity === 'WARNING') e.warning++;
      else e.normal++;
    }
  }

  for (const [outletId, e] of byOutlet) {
    e.sales = salesByOutletMode.get(outletId) ?? 0;
  }

  if (zeroDevByOutlet) {
    for (const [outletId, cnt] of zeroDevByOutlet) {
      const e = byOutlet.get(outletId);
      if (e) e.normal += cnt;
    }
  }

  return [...byOutlet.values()]
    .map((v) => {
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

      const devBom = computeDevBomAggregate(aggregateInput);
      const residualPct = computeResidualPctAggregate(aggregateInput);
      const lossToSales = computeLossToSales(aggregateInput);
      const healthScore = computeHealthScore(aggregateInput, healthScoreWeights, healthScoreThresholds);

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
