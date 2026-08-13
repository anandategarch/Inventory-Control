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
import { calcGrowth, calcGrowthAbs, safeRatio, calcAvgPrice, computeHealthScore, computeDevBomAggregate, computeResidualPctAggregate, computeLossToSales, type AggregateInput } from '@/lib/metrics';
import { calcZScore } from '@/engine/calculations/growth';

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

// ============================================================
//  Executive Summary — current week vs previous week
// ============================================================
// ============================================================
//  Bug 6 fix: dedupSalesMode — use MODE (most frequent value) not MAX
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

export function buildExecutiveSummary(
  current: RecWithRels[],
  previous: RecWithRels[],
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null
): ExecutiveSummary {
  // Bug 6 fix: use MODE per outlet (not MAX) — robust against typo
  const sumSales = (recs: RecWithRels[]): number => {
    const byOutlet = dedupSalesByOutlet(recs);
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
  const salesCurr = sumSales(current);
  const salesPrev = sumSales(previous);

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

  // Loss / Surplus split — Bug A fix: use nominalLossSurplus (NET) not nominalDeviasi (GROSS)
  let totalLoss = 0, totalSurplus = 0;
  for (const r of current) {
    if (r.nominalLossSurplus == null) continue;
    if (r.nominalLossSurplus > 0) totalLoss += r.nominalLossSurplus;
    else if (r.nominalLossSurplus < 0) totalSurplus += Math.abs(r.nominalLossSurplus);
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
  const nominalDeviasiGrowth = calcGrowth(curr.nominalDeviasi, prev?.nominalDeviasi ?? null);
  const salesGrowth = calcGrowth(curr.nominalSales, prev?.nominalSales ?? null);
  const currPrice = calcAvgPrice(curr.nominalDeviasi, curr.qtyDeviasi);
  const prevPrice = calcAvgPrice(prev?.nominalDeviasi ?? null, prev?.qtyDeviasi ?? null);
  const priceGrowth = calcGrowth(currPrice, prevPrice);

  // Phase 4: use precomputed stats (mean + stdDev) from SQL aggregate query
  // Phase 4: use precomputed stats (mean + stdDev) from SQL aggregate query
  // LOGIC-03 fix: enforce HISTORICAL_MIN_WEEKS — skip zScore if sample size too small
  const zScore = historicalStats && historicalStats.stdDev > 0 && historicalStats.n >= (t.HISTORICAL_MIN_WEEKS ?? 4)
    ? calcZScore(curr.pctQtyDeviasiToBom, historicalStats.mean, historicalStats.stdDev)
    : null;

  // benchmark flag from zScore (uses runtime thresholds)
  let benchmarkFlag: string | null = null;
  if (zScore != null) {
    if (zScore > t.BENCHMARK_NETWORK_FACTOR) benchmarkFlag = 'ABOVE_NETWORK_AVG';
    else if (zScore > t.BENCHMARK_AREA_FACTOR) benchmarkFlag = 'ABOVE_AREA_AVG';
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
//  Top items by various metrics
// ============================================================
export function topItemsByNominal(recs: RecWithRels[], n = 10) {
  return [...recs]
    .filter((r) => r.absNominalLossSurplus != null && r.absNominalLossSurplus > 0)
    .sort((a, b) => (b.absNominalLossSurplus ?? 0) - (a.absNominalLossSurplus ?? 0))
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
  // Bug 6 fix: use MODE (most frequent) per outlet, not MAX — robust against typo
  const salesByOutlet = dedupSalesByOutlet(recs);
  const byOutlet = new Map<number, {
    outlet: Outlet; absNominal: number; devBomSum: number; devBomCount: number;
    area: string; sales: number;
    lossAmount: number; surplusAmount: number;
  }>();
  for (const r of recs) {
    const k = r.outletId;
    const existing = byOutlet.get(k);
    if (existing) {
      existing.absNominal += r.absNominalDeviasi ?? 0;
      if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
        existing.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
        existing.devBomCount++;
      }
      // Bug A fix: use nominalLossSurplus (NET) not nominalDeviasi (GROSS)
      if (r.nominalLossSurplus != null && r.nominalLossSurplus > 0) existing.lossAmount += r.nominalLossSurplus;
      else if (r.nominalLossSurplus != null && r.nominalLossSurplus < 0) existing.surplusAmount += Math.abs(r.nominalLossSurplus);
    } else {
      byOutlet.set(k, {
        outlet: r.outlet, absNominal: r.absNominalDeviasi ?? 0,
        devBomSum: r.pctQtyDeviasiToBom != null && r.qtyBom !== 0 ? Math.abs(r.pctQtyDeviasiToBom) : 0,
        devBomCount: r.pctQtyDeviasiToBom != null && r.qtyBom !== 0 ? 1 : 0,
        area: r.area,
        sales: 0, // will be filled from salesByOutlet (MODE) below
        lossAmount: r.nominalLossSurplus != null && r.nominalLossSurplus > 0 ? r.nominalLossSurplus : 0,
        surplusAmount: r.nominalLossSurplus != null && r.nominalLossSurplus < 0 ? Math.abs(r.nominalLossSurplus) : 0,
      });
    }
  }
  // Fill sales from MODE map (Bug 6 fix)
  for (const [outletId, sales] of salesByOutlet) {
    const e = byOutlet.get(outletId);
    if (e) e.sales = sales;
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
  // Bug 6 fix: use MODE (most frequent) per outlet, not MAX
  const salesByOutlet = dedupSalesByOutlet(recs);
  const byOutlet = new Map<number, { outlet: Outlet; area: string; sales: number; absNominal: number }>();
  for (const r of recs) {
    const k = r.outletId;
    const existing = byOutlet.get(k);
    if (existing) {
      existing.absNominal += r.absNominalDeviasi ?? 0;
    } else {
      byOutlet.set(k, {
        outlet: r.outlet, area: r.area,
        sales: 0, // filled below from MODE
        absNominal: r.absNominalDeviasi ?? 0,
      });
    }
  }
  // Fill sales from MODE map
  for (const [outletId, sales] of salesByOutlet) {
    const e = byOutlet.get(outletId);
    if (e) e.sales = sales;
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
  historicalByOutletItem: Map<string, { mean: number; stdDev: number; n: number }>
): InvestigationItem[] {
  const items: InvestigationItem[] = [];

  for (const curr of recs) {
    const key = `${curr.outletId}|${curr.itemId}`;
    const prev = prevByOutletItem.get(key) ?? null;
    const historicalStats = historicalByOutletItem.get(key) ?? null;
    const ctx = buildRuleContext(curr, prev, historicalStats);
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
      absNominalDeviasi: curr.absNominalLossSurplus ?? 0, // NET per master context #36
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
//  Priority ranking
// ============================================================
export function computePriorities(
  recs: RecWithRels[],
  prevByOutletItem: Map<string, RecWithRels>,
  historicalByOutletItem: Map<string, { mean: number; stdDev: number; n: number }>
): PriorityScore[] {
  const scores: PriorityScore[] = [];

  for (const curr of recs) {
    const key = `${curr.outletId}|${curr.itemId}`;
    const prev = prevByOutletItem.get(key) ?? null;
    const historicalStats = historicalByOutletItem.get(key) ?? null;
    const ctx = buildRuleContext(curr, prev, historicalStats);
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

    const financialScore = (curr.absNominalLossSurplus ?? 0) / 1_000_000; // per million — NET per master context #36
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

  // Bug 1 fix: sort by combined finalScore (lower combined rank = higher priority)
  const sortedScores = scores
    .map((s) => ({ ...s, finalScore: (s.financialRank ?? 9999) + (s.operationalRank ?? 9999) }))
    .sort((a, b) => a.finalScore - b.finalScore);

  return sortedScores;
}

// ============================================================
//  Trend (last N weeks for selected scope)
// ============================================================
export function buildTrend(
  recsByWeek: Array<{ weekLabel: string; recs: RecWithRels[] }>
) {
  return recsByWeek.map(({ weekLabel, recs }) => {
    // Bug 6 fix: use MODE (most frequent) per outlet, not MAX
    const salesByOutlet = dedupSalesByOutlet(recs);
    let devBomSum = 0, devBomCount = 0, nominal = 0;
    for (const r of recs) {
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
//  Area Analysis — aggregate metrics per area
// ============================================================
export function computeAreaAnalysis(recs: RecWithRels[]) {
  // Bug 6 fix: precompute sales per outlet via MODE (not MAX)
  const salesByOutletAll = dedupSalesByOutlet(recs);
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
    // Fill sales from precomputed MODE map
    const sales = salesByOutletAll.get(r.outletId);
    if (sales != null && sales > 0) {
      entry.salesByOutlet.set(r.outletId, sales);
    }
    entry.absNominal += r.absNominalDeviasi ?? 0;
    if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
      entry.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
      entry.devBomCount++;
    }
    // Bug A fix: use nominalLossSurplus (NET) not nominalDeviasi (GROSS)
    if (r.nominalLossSurplus != null && r.nominalLossSurplus > 0) {
      entry.lossNominal += r.nominalLossSurplus;
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
// ============================================================
export function computeOutletHealthRanking(
  recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }>,
  zeroDevByOutlet?: Map<number, number>
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
      const devBom = computeDevBomAggregate(aggregateInput);
      const residualPct = computeResidualPctAggregate(aggregateInput);
      const lossToSales = computeLossToSales(aggregateInput);
      const healthScore = computeHealthScore(aggregateInput);

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
    // Bug A fix: use nominalLossSurplus (NET) not nominalDeviasi (GROSS)
    if (r.nominalLossSurplus != null && r.nominalLossSurplus > 0) lossNominal += r.nominalLossSurplus;
    else if (r.nominalLossSurplus != null && r.nominalLossSurplus < 0) surplusNominal += Math.abs(r.nominalLossSurplus);
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
  _historicalByOutletItem?: Map<string, { mean: number; stdDev: number; n: number }>,
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
  // Bug 6 fix: collect sales counts per outlet per period for MODE
  const byPeriod = new Map<string, {
    monthLabel: string; weekLabel: string; sortKey: string;
    salesCounts: Map<number, Map<number, number>>; // outletId → (salesValue → count)
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
        salesCounts: new Map(), lossNominal: 0, surplusNominal: 0,
      };
      byPeriod.set(k, p);
    }
    if (r.nominalSales != null && r.nominalSales > 0) {
      let outletCounts = p.salesCounts.get(r.outletId);
      if (!outletCounts) {
        outletCounts = new Map();
        p.salesCounts.set(r.outletId, outletCounts);
      }
      const rounded = Math.round(r.nominalSales * 100) / 100; // Bug 11 fix: 2 decimal places
      outletCounts.set(rounded, (outletCounts.get(rounded) ?? 0) + 1);
    }
    // Bug A fix: use nominalLossSurplus (NET) not nominalDeviasi (GROSS)
    // Note: this function is dead code (trend computed via SQL queryTrendAgg).
    // Input type doesn't have nominalLossSurplus, so keeping nominalDeviasi here.
    if (r.nominalDeviasi != null && r.nominalDeviasi > 0) p.lossNominal += r.nominalDeviasi;
    else if (r.nominalDeviasi != null && r.nominalDeviasi < 0) p.surplusNominal += Math.abs(r.nominalDeviasi);
  }

  return [...byPeriod.values()]
    .map((p) => {
      // Compute sales = sum of MODE per outlet (Bug 6 fix)
      let sales = 0;
      for (const outletCounts of p.salesCounts.values()) {
        let bestVal = 0, bestCount = 0;
        for (const [val, count] of outletCounts) {
          if (count > bestCount) { bestVal = val; bestCount = count; }
        }
        sales += bestVal;
      }
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
//
//  Phase 4 optimization: historicalByOutletItem now contains precomputed
//  stats (mean + stdDev + n) from SQL aggregate query, not raw arrays.
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
    // Phase 4: stats already computed by SQL (no need for calcStdDev on raw array)
    const zScore = calcZScore(curr.pctQtyDeviasiToBom ?? 0, stats.mean, stats.stdDev);
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
