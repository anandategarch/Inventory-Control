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
  // Sales is outlet-level denormalized — take MAX per outlet (not sum, not first)
  const dedupSales = (recs: RecWithRels[]): number => {
    const byOutlet = new Map<number, number>();
    for (const r of recs) {
      if (r.nominalSales != null && r.nominalSales > 0) {
        const existing = byOutlet.get(r.outletId) ?? 0;
        if (r.nominalSales > existing) byOutlet.set(r.outletId, r.nominalSales);
      }
    }
    let total = 0;
    for (const v of byOutlet.values()) total += v;
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
  const byOutlet = new Map<number, {
    outlet: Outlet; absNominal: number; devBomSum: number; devBomCount: number;
    area: string; sales: number; // sales deduplicated (1 unique value per outlet)
    lossAmount: number; surplusAmount: number; // BUG FIX #003: track direction
  }>();
  for (const r of recs) {
    const k = r.outletId;
    const existing = byOutlet.get(k);
    if (existing) {
      existing.absNominal += r.absNominalDeviasi ?? 0;
      // Sales: take MAX per outlet (not first non-null, not sum)
      if (r.nominalSales != null && r.nominalSales > existing.sales) {
        existing.sales = r.nominalSales;
      }
      if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
        existing.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
        existing.devBomCount++;
      }
      if (r.nominalDeviasi != null && r.nominalDeviasi > 0) existing.lossAmount += r.nominalDeviasi;
      else if (r.nominalDeviasi != null && r.nominalDeviasi < 0) existing.surplusAmount += Math.abs(r.nominalDeviasi);
    } else {
      byOutlet.set(k, {
        outlet: r.outlet, absNominal: r.absNominalDeviasi ?? 0,
        devBomSum: r.pctQtyDeviasiToBom != null && r.qtyBom !== 0 ? Math.abs(r.pctQtyDeviasiToBom) : 0,
        devBomCount: r.pctQtyDeviasiToBom != null && r.qtyBom !== 0 ? 1 : 0,
        area: r.area,
        sales: r.nominalSales ?? 0,
        lossAmount: r.nominalDeviasi != null && r.nominalDeviasi > 0 ? r.nominalDeviasi : 0,
        surplusAmount: r.nominalDeviasi != null && r.nominalDeviasi < 0 ? Math.abs(r.nominalDeviasi) : 0,
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
      sales: v.sales,
      // BUG FIX #003: Include direction info for loss/surplus drill-down
      lossAmount: v.lossAmount,
      surplusAmount: v.surplusAmount,
      direction: v.lossAmount > v.surplusAmount ? 'LOSS' : 'SURPLUS',
    }))
    .sort((a, b) => b.absNominal - a.absNominal)
    .slice(0, n);
}

// ============================================================
//  Top outlets by Sales (for card drill-down)
//  BUG FIX #3: Sales is duplicated per item row — take 1 unique per outlet
// ============================================================
export function topOutletsBySales(recs: RecWithRels[], n = 10) {
  const byOutlet = new Map<number, { outlet: Outlet; area: string; sales: number; absNominal: number }>();
  for (const r of recs) {
    const k = r.outletId;
    const existing = byOutlet.get(k);
    if (existing) {
      // Sales: take MAX per outlet
      if (r.nominalSales != null && r.nominalSales > existing.sales) {
        existing.sales = r.nominalSales;
      }
      existing.absNominal += r.absNominalDeviasi ?? 0;
    } else {
      byOutlet.set(k, {
        outlet: r.outlet, area: r.area,
        sales: r.nominalSales ?? 0,
        absNominal: r.absNominalDeviasi ?? 0,
      });
    }
  }
  return [...byOutlet.values()]
    .map((v) => ({
      outletCode: v.outlet.code, outletName: v.outlet.name, area: v.area,
      sales: v.sales, absNominal: v.absNominal,
      devToSalesRatio: v.sales > 0 ? v.absNominal / v.sales : null,
    }))
    .filter((v) => v.sales > 0)
    .sort((a, b) => b.sales - a.sales)
    .slice(0, n);
}

// ============================================================
//  Top items by Waste (for card drill-down)
// ============================================================
export function topItemsByWaste(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.qtyWaste != null && Math.abs(r.qtyWaste) > 0)
    .sort((a, b) => Math.abs(b.qtyWaste ?? 0) - Math.abs(a.qtyWaste ?? 0))
    .slice(0, n)
    .map((r) => ({
      itemName: r.item.name, outletCode: r.outlet.code,
      qtyWaste: Math.abs(r.qtyWaste ?? 0),
      nominalWaste: Math.abs(r.nominalWaste ?? 0),
    }));
}

// ============================================================
//  Top items by Susut (for card drill-down)
// ============================================================
export function topItemsBySusut(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.qtySusut != null && Math.abs(r.qtySusut) > 0)
    .sort((a, b) => Math.abs(b.qtySusut ?? 0) - Math.abs(a.qtySusut ?? 0))
    .slice(0, n)
    .map((r) => ({
      itemName: r.item.name, outletCode: r.outlet.code,
      qtySusut: Math.abs(r.qtySusut ?? 0),
      nominalSusut: Math.abs(r.nominalSusut ?? 0),
    }));
}

// ============================================================
//  Top items by Trial (for card drill-down)
// ============================================================
export function topItemsByTrial(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.qtyTrial != null && Math.abs(r.qtyTrial) > 0)
    .sort((a, b) => Math.abs(b.qtyTrial ?? 0) - Math.abs(a.qtyTrial ?? 0))
    .slice(0, n)
    .map((r) => ({
      itemName: r.item.name, outletCode: r.outlet.code,
      qtyTrial: Math.abs(r.qtyTrial ?? 0),
      nominalTrial: Math.abs(r.nominalTrial ?? 0),
    }));
}

// ============================================================
//  Top items by Loss/Surplus (for card drill-down)
// ============================================================
export function topItemsByLossSurplus(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.qtyLossSurplus != null && Math.abs(r.qtyLossSurplus) > 0)
    .sort((a, b) => Math.abs(b.qtyLossSurplus ?? 0) - Math.abs(a.qtyLossSurplus ?? 0))
    .slice(0, n)
    .map((r) => ({
      itemName: r.item.name, outletCode: r.outlet.code,
      qtyLossSurplus: Math.abs(r.qtyLossSurplus ?? 0),
      nominalLossSurplus: Math.abs(r.nominalLossSurplus ?? 0),
      direction: r.direction,
    }));
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
    // Sales: take MAX per outlet (not first non-null, not sum)
    const salesByOutlet = new Map<number, number>();
    let devBomSum = 0, devBomCount = 0, nominal = 0;
    for (const r of recs) {
      if (r.nominalSales != null && r.nominalSales > 0) {
        const existing = salesByOutlet.get(r.outletId) ?? 0;
        if (r.nominalSales > existing) salesByOutlet.set(r.outletId, r.nominalSales);
      }
      if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
        devBomSum += Math.abs(r.pctQtyDeviasiToBom);
        devBomCount++;
      }
      nominal += r.absNominalDeviasi ?? 0;
    }
    let sales = 0;
    for (const v of salesByOutlet.values()) sales += v;
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

// ============================================================
//  Area Analysis — aggregate metrics per area
// ============================================================
export function computeAreaAnalysis(recs: RecWithRels[]) {
  const byArea = new Map<string, {
    outletIds: Set<number>;
    salesByOutlet: Map<number, number>;
    absNominal: number;
    devBomSum: number;
    devBomCount: number;
    lossNominal: number;
  }>();

  for (const r of recs) {
    const a = r.area || 'UNKNOWN';
    let entry = byArea.get(a);
    if (!entry) {
      entry = {
        outletIds: new Set(),
        salesByOutlet: new Map(),
        absNominal: 0,
        devBomSum: 0,
        devBomCount: 0,
        lossNominal: 0,
      };
      byArea.set(a, entry);
    }
    entry.outletIds.add(r.outletId);
    if (r.nominalSales != null && r.nominalSales > 0) {
      const existing = entry.salesByOutlet.get(r.outletId) ?? 0;
      if (r.nominalSales > existing) entry.salesByOutlet.set(r.outletId, r.nominalSales);
    }
    entry.absNominal += r.absNominalDeviasi ?? 0;
    if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
      entry.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
      entry.devBomCount++;
    }
    if (r.nominalDeviasi != null && r.nominalDeviasi > 0) {
      entry.lossNominal += r.nominalDeviasi;
    }
  }

  return [...byArea.entries()]
    .map(([area, v]) => {
      let totalSales = 0;
      for (const s of v.salesByOutlet.values()) totalSales += s;
      return {
        area,
        outletCount: v.outletIds.size,
        totalSales,
        totalAbsNominal: v.absNominal,
        avgDevBom: v.devBomCount > 0 ? v.devBomSum / v.devBomCount : 0,
        lossToSales: totalSales > 0 ? v.lossNominal / totalSales : null,
      };
    })
    .sort((a, b) => b.totalAbsNominal - a.totalAbsNominal);
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
  }> = [];

  for (const curr of current) {
    if (curr.absNominalDeviasi == null || curr.absNominalDeviasi === 0) continue;
    const key = `${curr.outletId}|${curr.itemId}`;
    const prev = prevByOutletItem.get(key);
    if (!prev || prev.absNominalDeviasi == null || prev.absNominalDeviasi === 0) continue;
    const delta = curr.absNominalDeviasi - prev.absNominalDeviasi;
    deltas.push({
      itemName: curr.item.name,
      outletCode: curr.outlet.code,
      area: curr.area,
      currentAbsNominal: curr.absNominalDeviasi,
      previousAbsNominal: prev.absNominalDeviasi,
      delta,
      direction: curr.direction || 'NEUTRAL',
    });
  }

  const topWorsened = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, 5);
  const topImproved = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 5);
  return { topWorsened, topImproved };
}

// ============================================================
//  Outlet Health Ranking — health score per outlet (worst first)
//  Uses pre-computed flags from recsWithFlags
// ============================================================
export function computeOutletHealthRanking(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  zeroDevByOutlet?: Map<number, number>
) {
  const byOutlet = new Map<number, {
    outlet: Outlet;
    area: string;
    normal: number;
    warning: number;
    abnormal: number;
    absNominal: number;
    devBomSum: number;
    devBomCount: number;
    residualSum: number;
    residualCount: number;
    lossNominal: number;
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
        devBomSum: 0,
        devBomCount: 0,
        residualSum: 0,
        residualCount: 0,
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
    if (curr.pctQtyDeviasiToBom != null && curr.qtyBom !== 0) {
      e.devBomSum += Math.abs(curr.pctQtyDeviasiToBom);
      e.devBomCount++;
    }
    if (curr.residualRatio != null) {
      e.residualSum += Math.abs(curr.residualRatio);
      e.residualCount++;
    }
    if (curr.nominalDeviasi != null && curr.nominalDeviasi > 0) {
      e.lossNominal += curr.nominalDeviasi;
    }
    if (curr.nominalSales != null && curr.nominalSales > e.sales) {
      e.sales = curr.nominalSales ?? 0;
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

  // Account for zero-deviation records (counted as normal elsewhere)
  if (zeroDevByOutlet) {
    for (const [outletId, cnt] of zeroDevByOutlet) {
      const e = byOutlet.get(outletId);
      if (e) e.normal += cnt;
    }
  }

  return [...byOutlet.values()]
    .map((v) => {
      const total = v.normal + v.warning + v.abnormal;
      const residualPct = v.residualCount > 0 ? v.residualSum / v.residualCount : null;
      const lossToSales = v.sales > 0 ? v.lossNominal / v.sales : null;
      const devBom = v.devBomCount > 0 ? v.devBomSum / v.devBomCount : 0;

      // ============================================================
      //  Health Score — composite weighted (Section 33 of master context)
      //  Skor = 30% % DEV TO BOM + 25% RESIDUAL + 25% LOSS/PENJUALAN + 20% Jumlah Masalah
      //  Each metric normalized to 0-100 (100 = healthy, 0 = critical)
      // ============================================================
      const clamp = (n: number) => Math.max(0, Math.min(100, n));
      // Dev/BOM: <5% → 100, >50% → 0 (linear)
      const devBomScore = clamp(100 - (devBom / 0.50) * 100);
      // Residual: <20% → 100, >80% → 0 (linear)
      const residualScore = residualPct != null ? clamp(100 - ((residualPct - 0.20) / 0.60) * 100) : 50;
      // Loss/Sales: <2% → 100, >15% → 0 (linear)
      const lossToSalesScore = lossToSales != null ? clamp(100 - ((lossToSales - 0.02) / 0.13) * 100) : 50;
      // Abnormal count: 0% abnormal → 100, >50% abnormal → 0 (linear)
      const abnormalRate = total > 0 ? v.abnormal / total : 0;
      const abnormalScore = clamp(100 - (abnormalRate / 0.50) * 100);

      const healthScore = Math.round(
        devBomScore * 0.30 + residualScore * 0.25 + lossToSalesScore * 0.25 + abnormalScore * 0.20
      );

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
//  Pareto — class A items (top contributors to total deviation cost)
//  classACount = # items accounting for 80% of total |NOMINAL DEVIASI|
// ============================================================
export function computePareto(recs: RecWithRels[]) {
  const items = [...recs]
    .filter((r) => r.absNominalDeviasi != null && r.absNominalDeviasi > 0)
    .map((r) => ({
      itemName: r.item.name,
      outletCode: r.outlet.code,
      absNominal: r.absNominalDeviasi ?? 0,
    }))
    .sort((a, b) => b.absNominal - a.absNominal);

  const totalAbsNominal = items.reduce((sum, it) => sum + it.absNominal, 0);
  let cum = 0;
  let classACount = 0;
  let classAPctOfCost = 0;
  const itemsWithCum = items.map((it) => {
    cum += it.absNominal;
    const cumPct = totalAbsNominal > 0 ? cum / totalAbsNominal : 0;
    return { ...it, cumPct };
  });
  for (const it of itemsWithCum) {
    if (it.cumPct <= 0.8) {
      classACount++;
      classAPctOfCost = it.cumPct;
    } else {
      break;
    }
  }

  return {
    classACount,
    classAPctOfCost,
    totalItems: items.length,
    totalAbsNominal,
    items: itemsWithCum.slice(0, 20),
  };
}

// ============================================================
//  Cost Impact — total |NOMINAL DEVIASI| as % of sales
// ============================================================
export function computeCostImpact(recs: RecWithRels[], salesTotal: number) {
  let totalCost = 0;
  let lossNominal = 0;
  let surplusNominal = 0;
  for (const r of recs) {
    totalCost += r.absNominalDeviasi ?? 0;
    if (r.nominalDeviasi != null && r.nominalDeviasi > 0) lossNominal += r.nominalDeviasi;
    else if (r.nominalDeviasi != null && r.nominalDeviasi < 0) surplusNominal += Math.abs(r.nominalDeviasi);
  }
  return {
    totalCost,
    pctOfSales: salesTotal > 0 ? totalCost / salesTotal : null,
    lossNominal,
    surplusNominal,
  };
}

// ============================================================
//  Item Consistency — pola item antar outlet (Section 22, 38 master context)
//  SYSTEMIC: ≥10 outlet menyimpang untuk item yang sama
//  WIDESPREAD: 5-9 outlet
//  ISOLATED: 2-4 outlet
//  Direction consistency juga dianalisis (10 LOSS > 5 LOSS + 5 SURPLUS)
// ============================================================
export function computeItemConsistencyAnalysis(
  current: RecWithRels[],
  _historicalByOutletItem?: Map<string, number[]>,
  _historicalPeriodCount?: number
) {
  // Group by itemName — count distinct outlets with significant deviation
  const byItem = new Map<string, {
    itemName: string;
    satuan: string;
    outlets: Set<string>;
    lossOutlets: Set<string>;
    surplusOutlets: Set<string>;
    totalAbsNominal: number;
    devBomSum: number;
    devBomCount: number;
  }>();

  for (const r of current) {
    if (r.absNominalDeviasi == null || r.absNominalDeviasi === 0) continue;
    const name = r.item.name;
    let e = byItem.get(name);
    if (!e) {
      e = {
        itemName: name,
        satuan: r.satuan ?? '',
        outlets: new Set(),
        lossOutlets: new Set(),
        surplusOutlets: new Set(),
        totalAbsNominal: 0,
        devBomSum: 0,
        devBomCount: 0,
      };
      byItem.set(name, e);
    }
    e.outlets.add(r.outlet.code);
    if (r.direction === 'LOSS') e.lossOutlets.add(r.outlet.code);
    else if (r.direction === 'SURPLUS') e.surplusOutlets.add(r.outlet.code);
    e.totalAbsNominal += r.absNominalDeviasi;
    if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
      e.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
      e.devBomCount++;
    }
  }

  // Classify by outlet count (master context Section 22, 38)
  const items = [...byItem.values()]
    .map((v) => {
      const outletCount = v.outlets.size;
      const lossOutlets = v.lossOutlets.size;
      const surplusOutlets = v.surplusOutlets.size;
      let consistency: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
      if (outletCount >= 10) consistency = 'SYSTEMIC';
      else if (outletCount >= 5) consistency = 'WIDESPREAD';
      else if (outletCount >= 2) consistency = 'ISOLATED';
      else consistency = 'ISOLATED'; // 1 outlet = isolated (single occurrence)
      return {
        itemName: v.itemName,
        satuan: v.satuan,
        outletCount,
        lossOutlets,
        surplusOutlets,
        totalAbsNominal: v.totalAbsNominal,
        avgDevBom: v.devBomCount > 0 ? v.devBomSum / v.devBomCount : 0,
        consistency,
      };
    })
    .sort((a, b) => b.totalAbsNominal - a.totalAbsNominal);

  // Return unified list — backward compat: map to systemic/episodic shape
  // but with proper outlet-count-based classification
  const systemic = items.filter((i) => i.consistency === 'SYSTEMIC').map((i) => ({
    itemName: i.itemName,
    outletCode: '', // aggregated across outlets
    area: '',
    occurrences: i.outletCount,
    avgDevBom: i.avgDevBom,
    absNominal: i.totalAbsNominal,
  }));
  const episodic = items.filter((i) => i.consistency !== 'SYSTEMIC').map((i) => ({
    itemName: i.itemName,
    outletCode: '',
    area: '',
    absNominal: i.totalAbsNominal,
    devBom: i.avgDevBom,
  }));

  // Also return unified items list with full classification
  return { systemic, episodic, items };
}

// ============================================================
//  Net Cost Trend — net (LOSS - SURPLUS) / SALES per week
//  Positive = net cost leak; Negative = net surplus recovery
// ============================================================
export function computeNetCostTrend(
  trendRecs: Array<{
    monthLabel: string; weekLabel: string; nominalSales: number | null;
    nominalDeviasi: number | null; outletId: number;
  }>,
  monthKeyByLabel: Map<string, string>
) {
  const byPeriod = new Map<string, {
    monthLabel: string; weekLabel: string; sortKey: string;
    salesByOutlet: Map<number, number>;
    lossNominal: number; surplusNominal: number;
  }>();

  for (const r of trendRecs) {
    const k = `${r.monthLabel}|${r.weekLabel}`;
    const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
    const sortKey = `${mk}|${r.weekLabel}`;
    let p = byPeriod.get(k);
    if (!p) {
      p = {
        monthLabel: r.monthLabel, weekLabel: r.weekLabel, sortKey,
        salesByOutlet: new Map(), lossNominal: 0, surplusNominal: 0,
      };
      byPeriod.set(k, p);
    }
    if (r.nominalSales != null && r.nominalSales > 0) {
      const existing = p.salesByOutlet.get(r.outletId) ?? 0;
      if (r.nominalSales > existing) p.salesByOutlet.set(r.outletId, r.nominalSales);
    }
    if (r.nominalDeviasi != null && r.nominalDeviasi > 0) p.lossNominal += r.nominalDeviasi;
    else if (r.nominalDeviasi != null && r.nominalDeviasi < 0) p.surplusNominal += Math.abs(r.nominalDeviasi);
  }

  return [...byPeriod.values()]
    .map((p) => {
      let sales = 0;
      for (const v of p.salesByOutlet.values()) sales += v;
      return {
        weekLabel: `${p.weekLabel} ${p.monthLabel.split(' ')[0].slice(0, 3)}`,
        sortKey: p.sortKey,
        netCostRatio: sales > 0 ? (p.lossNominal - p.surplusNominal) / sales : 0,
        lossNominal: p.lossNominal,
        surplusNominal: p.surplusNominal,
        sales,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey, ...rest }) => rest);
}

// ============================================================
//  Historical Analysis — items where current devBom deviates
//  significantly from historical mean (z-score > 2 = critical)
// ============================================================
export function computeHistoricalAnalysis(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  historicalByOutletItem: Map<string, number[]>
) {
  const criticalItems: Array<{
    itemName: string; outletCode: string; area: string;
    currentDevBom: number; historicalAvg: number; zScore: number; absNominal: number;
  }> = [];

  for (const { curr, flags } of recsWithFlags) {
    const histRule = flags.find((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_WARNING');
    if (!histRule) continue;
    const key = `${curr.outletId}|${curr.itemId}`;
    const hist = historicalByOutletItem.get(key) ?? [];
    if (hist.length === 0) continue;
    const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
    const variance = hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length;
    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? ((curr.pctQtyDeviasiToBom ?? 0) - mean) / stdDev : 0;
    criticalItems.push({
      itemName: curr.item.name,
      outletCode: curr.outlet.code,
      area: curr.area,
      currentDevBom: curr.pctQtyDeviasiToBom ?? 0,
      historicalAvg: mean,
      zScore,
      absNominal: curr.absNominalDeviasi ?? 0,
    });
  }

  criticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  return { criticalItems: criticalItems.slice(0, 10) };
}
