// ============================================================
//  Analysis Engine — ranking, benchmarking, priority, worklist
// ============================================================
import type { InventoryRecord, Outlet, Item, Week, Prisma } from '@prisma/client';
import type {
  PriorityScore,
  InvestigationItem,
  ExecutiveSummary,
  BenchmarkResult,
  GrowthMetrics,
} from '@/types/inventory';
import { CFG_THRESHOLDS } from '@/config/thresholds';
import type { RuntimeThresholds } from '@/lib/settings';
import { evaluateRules, type RuleContext } from '@/engine/rules/evaluator';
import { calcGrowth, calcGrowthAbs, calcZScore, calcStdDev, safeRatio, calcAvgPrice } from '@/engine/calculations/growth';

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

// ============================================================
//  Executive Summary — current week vs previous week
// ============================================================
export function buildExecutiveSummary(
  current: RecWithRels[],
  previous: RecWithRels[],
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null
): ExecutiveSummary {
  // Sales is outlet-level denormalized — dedup by outlet
  const dedupSales = (recs: RecWithRels[]): number => {
    const seen = new Set<number>();
    let total = 0;
    for (const r of recs) {
      if (r.nominalSales != null && r.nominalSales > 0 && !seen.has(r.outletId)) {
        seen.add(r.outletId);
        total += r.nominalSales;
      }
    }
    return total;
  };

  const sum = (recs: RecWithRels[], field: keyof InventoryRecord): number => {
    let s = 0;
    for (const r of recs) {
      const v = r[field];
      if (typeof v === 'number' && !isNaN(v)) s += v;
    }
    return s;
  };

  // Sales uses absolute value? No — sales is positive. Use as-is.
  const salesCurr = dedupSales(current);
  const salesPrev = dedupSales(previous);

  // BOM, COM are negative — use absolute sum for "magnitude"
  const qtyBomCurr = Math.abs(sum(current, 'qtyBom'));
  const qtyBomPrev = Math.abs(sum(previous, 'qtyBom'));
  const qtyDevCurr = sum(current, 'absQtyDeviasi');
  const qtyDevPrev = sum(previous, 'absQtyDeviasi');
  const qtyWasteCurr = Math.abs(sum(current, 'qtyWaste'));
  const qtyWastePrev = Math.abs(sum(previous, 'qtyWaste'));
  const qtySusutCurr = Math.abs(sum(current, 'qtySusut'));
  const qtySusutPrev = Math.abs(sum(previous, 'qtySusut'));
  const qtyTrialCurr = Math.abs(sum(current, 'qtyTrial'));
  const qtyTrialPrev = Math.abs(sum(previous, 'qtyTrial'));
  const qtyLSCurr = sum(current, 'absQtyLossSurplus');
  const qtyLSPrev = sum(previous, 'absQtyLossSurplus');
  const nomDevCurr = sum(current, 'absNominalDeviasi');
  const nomDevPrev = sum(previous, 'absNominalDeviasi');

  // Loss / Surplus split
  let totalLoss = 0, totalSurplus = 0;
  for (const r of current) {
    if (r.nominalDeviasi == null) continue;
    if (r.nominalDeviasi > 0) totalLoss += r.nominalDeviasi;
    else if (r.nominalDeviasi < 0) totalSurplus += Math.abs(r.nominalDeviasi);
  }

  // Residual
  let residualLossQty = 0;
  for (const r of current) {
    if (r.residualQty != null && r.residualQty > 0) residualLossQty += r.residualQty;
  }
  const residualLossPct = qtyDevCurr > 0 ? residualLossQty / qtyDevCurr : null;

  return {
    period: { monthLabel, weekLabel, comparisonWeek: prevWeekLabel },
    sales: { current: salesCurr, previous: salesPrev || null, growth: calcGrowth(salesCurr, salesPrev || null) },
    nominalDeviasi: { current: nomDevCurr, previous: nomDevPrev || null, growth: calcGrowth(nomDevCurr, nomDevPrev || null) },
    qtyBom: { current: qtyBomCurr, previous: qtyBomPrev || null, growth: calcGrowth(qtyBomCurr, qtyBomPrev || null) },
    qtyDeviasi: { current: qtyDevCurr, previous: qtyDevPrev || null, growth: calcGrowth(qtyDevCurr, qtyDevPrev || null) },
    qtyWaste: { current: qtyWasteCurr, previous: qtyWastePrev || null, growth: calcGrowth(qtyWasteCurr, qtyWastePrev || null) },
    qtySusut: { current: qtySusutCurr, previous: qtySusutPrev || null, growth: calcGrowth(qtySusutCurr, qtySusutPrev || null) },
    qtyTrial: { current: qtyTrialCurr, previous: qtyTrialPrev || null, growth: calcGrowth(qtyTrialCurr, qtyTrialPrev || null) },
    qtyLossSurplus: { current: qtyLSCurr, previous: qtyLSPrev || null, growth: calcGrowth(qtyLSCurr, qtyLSPrev || null) },
    totalLoss, totalSurplus,
    lossToSales: salesCurr > 0 ? totalLoss / salesCurr : null,
    surplusToSales: salesCurr > 0 ? totalSurplus / salesCurr : null,
    deviationToBom: qtyBomCurr > 0 ? qtyDevCurr / qtyBomCurr : null,
    residualLossQty, residualLossPct,
  };
}

// ============================================================
//  Per-record rule evaluation + context building
//  Optional `t` = runtime thresholds from DB (falls back to CFG_THRESHOLDS)
// ============================================================
export function buildRuleContext(
  curr: RecWithRels,
  prev: RecWithRels | null,
  historical: number[], // historical dev/bom ratios
  t: RuntimeThresholds | typeof CFG_THRESHOLDS = CFG_THRESHOLDS,
): RuleContext {
  const bomGrowth = calcGrowthAbs(curr.qtyBom, prev?.qtyBom ?? null);
  const qtyDeviasiGrowth = calcGrowthAbs(curr.qtyDeviasi, prev?.qtyDeviasi ?? null);
  const nominalDeviasiGrowth = calcGrowth(curr.nominalDeviasi, prev?.nominalDeviasi ?? null);
  const salesGrowth = calcGrowth(curr.nominalSales, prev?.nominalSales ?? null);
  const currPrice = calcAvgPrice(curr.nominalDeviasi, curr.qtyDeviasi);
  const prevPrice = calcAvgPrice(prev?.nominalDeviasi ?? null, prev?.qtyDeviasi ?? null);
  const priceGrowth = calcGrowth(currPrice, prevPrice);

  const stats = calcStdDev(historical);
  const zScore = stats && stats.stdDev > 0 ? calcZScore(curr.pctQtyDeviasiToBom, stats.mean, stats.stdDev) : null;

  // benchmark flag from zScore (uses runtime thresholds)
  let benchmarkFlag: string | null = null;
  if (zScore != null) {
    if (zScore > t.BENCHMARK_NETWORK_FACTOR) benchmarkFlag = 'ABOVE_NETWORK_AVG';
    else if (zScore > t.BENCHMARK_AREA_FACTOR) benchmarkFlag = 'ABOVE_AREA_AVG';
  }

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
    absNominalDeviasi: curr.absNominalDeviasi, absQtyDeviasi: curr.absQtyDeviasi,
  };
}

// ============================================================
//  Top items by various metrics
// ============================================================
export function topItemsByNominal(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.absNominalDeviasi != null && r.absNominalDeviasi > 0)
    .sort((a, b) => (b.absNominalDeviasi ?? 0) - (a.absNominalDeviasi ?? 0))
    .slice(0, n)
    .map((r) => ({
      itemName: r.item.name,
      outletCode: r.outlet.code,
      absNominal: r.absNominalDeviasi ?? 0,
      direction: r.direction as 'LOSS' | 'SURPLUS' | 'NEUTRAL',
    }));
}

export function topItemsByDevBom(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.pctQtyDeviasiToBom != null && r.qtyBom !== 0)
    .sort((a, b) => Math.abs(b.pctQtyDeviasiToBom ?? 0) - Math.abs(a.pctQtyDeviasiToBom ?? 0))
    .slice(0, n)
    .map((r) => ({
      itemName: r.item.name,
      outletCode: r.outlet.code,
      devBom: r.pctQtyDeviasiToBom ?? 0,
      tolerance: r.tolerancePct,
    }));
}

export function topOutlets(recs: RecWithRels[], n = 10) {
  const byOutlet = new Map<number, { outlet: Outlet; absNominal: number; devBomSum: number; devBomCount: number; area: string }>();
  for (const r of recs) {
    const k = r.outletId;
    const existing = byOutlet.get(k);
    if (existing) {
      existing.absNominal += r.absNominalDeviasi ?? 0;
      if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
        existing.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
        existing.devBomCount++;
      }
    } else {
      byOutlet.set(k, {
        outlet: r.outlet, absNominal: r.absNominalDeviasi ?? 0,
        devBomSum: r.pctQtyDeviasiToBom != null && r.qtyBom !== 0 ? Math.abs(r.pctQtyDeviasiToBom) : 0,
        devBomCount: r.pctQtyDeviasiToBom != null && r.qtyBom !== 0 ? 1 : 0,
        area: r.area,
      });
    }
  }
  // area averages
  const areaAvg = new Map<string, number>();
  const areaCount = new Map<string, number>();
  for (const v of byOutlet.values()) {
    if (v.devBomCount > 0) {
      const avg = v.devBomSum / v.devBomCount;
      areaAvg.set(v.area, (areaAvg.get(v.area) ?? 0) + avg);
      areaCount.set(v.area, (areaCount.get(v.area) ?? 0) + 1);
    }
  }
  const areaFinal = new Map<string, number>();
  for (const [area, sum] of areaAvg) {
    areaFinal.set(area, sum / (areaCount.get(area) ?? 1));
  }

  return [...byOutlet.values()]
    .map((v) => ({
      outletCode: v.outlet.code, outletName: v.outlet.name, area: v.area,
      absNominal: v.absNominal,
      devBom: v.devBomCount > 0 ? v.devBomSum / v.devBomCount : 0,
      areaAvg: areaFinal.get(v.area) ?? 0,
    }))
    .sort((a, b) => b.absNominal - a.absNominal)
    .slice(0, n);
}

// ============================================================
//  Deviation Breakdown (Waterfall)
// ============================================================
export function deviationBreakdown(recs: RecWithRels[]) {
  let waste = 0, susut = 0, trial = 0, residual = 0, total = 0;
  for (const r of recs) {
    waste += Math.abs(r.qtyWaste ?? 0);
    susut += Math.abs(r.qtySusut ?? 0);
    trial += Math.abs(r.qtyTrial ?? 0);
    residual += Math.abs(r.residualQty ?? 0);
    total += r.absQtyDeviasi ?? 0;
  }
  return { waste, susut, trial, residual, total };
}

// ============================================================
//  Loss vs Surplus
// ============================================================
export function lossVsSurplus(recs: RecWithRels[]) {
  let loss = 0, surplus = 0, lossNominal = 0, surplusNominal = 0;
  for (const r of recs) {
    if (r.direction === 'LOSS') {
      loss += r.absQtyDeviasi ?? 0;
      lossNominal += r.absNominalDeviasi ?? 0;
    } else if (r.direction === 'SURPLUS') {
      surplus += r.absQtyDeviasi ?? 0;
      surplusNominal += r.absNominalDeviasi ?? 0;
    }
  }
  return { loss, surplus, lossNominal, surplusNominal };
}

// ============================================================
//  Investigation Worklist
// ============================================================
export function buildWorklist(
  recs: RecWithRels[],
  prevByOutletItem: Map<string, RecWithRels>,
  historicalByOutletItem: Map<string, number[]>
): InvestigationItem[] {
  const items: InvestigationItem[] = [];

  for (const curr of recs) {
    const key = `${curr.outletId}|${curr.itemId}`;
    const prev = prevByOutletItem.get(key) ?? null;
    const historical = historicalByOutletItem.get(key) ?? [];
    const ctx = buildRuleContext(curr, prev, historical);
    const flags = evaluateRules(ctx);

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
      absNominalDeviasi: curr.absNominalDeviasi ?? 0,
      deviationToBom: curr.pctQtyDeviasiToBom,
      direction: curr.direction as 'LOSS' | 'SURPLUS' | 'NEUTRAL',
    });
  }

  // Sort: priority then absNominal
  const order = { P1: 0, P2: 1, P3: 2 };
  items.sort((a, b) => order[a.priority] - order[b.priority] || b.absNominalDeviasi - a.absNominalDeviasi);
  return items.slice(0, 100); // cap for UI
}

// ============================================================
//  Recommendation Engine (rule-based)
// ============================================================
export function recommendAction(ruleCodes: string[]): string {
  const set = new Set(ruleCodes);
  const actions: string[] = [];

  if (set.has('RESIDUAL_LOSS_HIGH') || set.has('RESIDUAL_LOSS_WARN')) {
    actions.push('Validasi Actual Usage vs SOC + sampling fisik + cek pencatatan Waste/Susut/Trial');
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
  if (set.has('HISTORICAL_ABNORMAL') || set.has('HISTORICAL_WARNING')) {
    actions.push('Investigasi pola abnormal vs historical behavior (outlier detection)');
  }
  if (set.has('HIGH_LOSS_NOMINAL')) {
    actions.push('Prioritas financial impact: cek transaksi adjustment + receiving discrepancy');
  }

  return actions.length > 0 ? actions.join(' | ') : 'Investigasi lanjutan diperlukan';
}

// ============================================================
//  Priority ranking
// ============================================================
export function computePriorities(
  recs: RecWithRels[],
  prevByOutletItem: Map<string, RecWithRels>,
  historicalByOutletItem: Map<string, number[]>
): PriorityScore[] {
  const scores: PriorityScore[] = [];

  for (const curr of recs) {
    const key = `${curr.outletId}|${curr.itemId}`;
    const prev = prevByOutletItem.get(key) ?? null;
    const historical = historicalByOutletItem.get(key) ?? [];
    const ctx = buildRuleContext(curr, prev, historical);
    const flags = evaluateRules(ctx);

    if (flags.length === 0) continue;

    const top = flags[0];
    const t = CFG_THRESHOLDS;

    const devBomScore = ctx.pctQtyDeviasiToBom != null ? Math.abs(ctx.pctQtyDeviasiToBom) : 0;
    const growthScore = Math.max(
      Math.abs(ctx.qtyDeviasiGrowth ?? 0),
      Math.abs(ctx.nominalDeviasiGrowth ?? 0),
    );
    const residualScore = Math.abs(ctx.residualRatio ?? 0);
    const tolBreach = ctx.tolerancePct != null && ctx.pctQtyDeviasiToBom != null
      ? Math.max(0, Math.abs(ctx.pctQtyDeviasiToBom) - Math.abs(ctx.tolerancePct))
      : Math.abs(ctx.pctQtyDeviasiToBom ?? 0) * 0.5; // fallback
    const histScore = Math.abs(ctx.zScore ?? 0);

    const financialScore = (curr.absNominalDeviasi ?? 0) / 1_000_000; // per million
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

  // Assign ranks
  const byFin = [...scores].sort((a, b) => b.financialScore - a.financialScore);
  byFin.forEach((s, i) => { s.financialRank = i + 1; });
  const byOps = [...scores].sort((a, b) => b.operationalScore - a.operationalScore);
  byOps.forEach((s, i) => { s.operationalRank = i + 1; });

  return scores;
}

// ============================================================
//  Trend (last N weeks for selected scope)
// ============================================================
export function buildTrend(
  recsByWeek: Array<{ weekLabel: string; recs: RecWithRels[] }>
) {
  return recsByWeek.map(({ weekLabel, recs }) => {
    const dedup = new Set<number>();
    let sales = 0;
    let devBomSum = 0, devBomCount = 0, nominal = 0;
    for (const r of recs) {
      if (r.nominalSales != null && r.nominalSales > 0 && !dedup.has(r.outletId)) {
        sales += r.nominalSales;
        dedup.add(r.outletId);
      }
      if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
        devBomSum += Math.abs(r.pctQtyDeviasiToBom);
        devBomCount++;
      }
      nominal += r.absNominalDeviasi ?? 0;
    }
    return {
      weekLabel,
      devBom: devBomCount > 0 ? devBomSum / devBomCount : 0,
      sales,
      nominal,
    };
  });
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
      absNominalDeviasi: curr.absNominalDeviasi ?? 0,
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

    const financialScore = (curr.absNominalDeviasi ?? 0) / 1_000_000;
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

  return scores;
}
