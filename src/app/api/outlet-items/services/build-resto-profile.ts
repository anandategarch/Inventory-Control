// ============================================================
//  build-resto-profile — Section 3 of /api/outlet-items GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 673-line route.ts (lines ~307-512).
//
//  Responsibilities:
//    1. Compute current-period aggregate metrics (qtyBom, qtyDeviasi,
//       nominalLossSurplus, residualQty, severity counts) by iterating
//       currentRecs.
//    2. Build AggregateInput + invoke Metric Engine for devBomAggregate,
//       residualPctAggregate, explainedPctAggregate, lossToSales,
//       healthScore.
//    3. Compute previous-period aggregates + prevByItemId Map (keyed by
//       `${itemId}|${akunPenyesuaian ?? ''}` so multi-akun items match
//       the right prev record — FIX BUG-1-4).
//    4. Compute growth metrics via Metric Engine (calcGrowth,
//       calcGrowthAbs, computeNominalDeviationGrowth, computeGrowthResult).
//    5. Assemble the 6-section restoProfile object:
//       Performance, Behavior, Historical, Benchmark, TopRisk, Investigation.
//
//  Returns both restoProfile AND prevByItemId (the latter is consumed by
//  buildItemBreakdown for per-item growth lookup).
// ============================================================
import {
  computeSalesModePerOutlet,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeExplainedPctAggregate,
  computeLossToSales,
  computeHealthScore,
  calcGrowth,
  calcGrowthAbs,
  computeGrowthResult,
  computeNominalDeviationGrowth,
  type AggregateInput,
  type HealthScoreWeights,
  type HealthScoreThresholds,
} from '@/lib/metrics';
import { toNum } from '@/lib/format';
import type { RuntimeThresholds } from '@/lib/settings';
import type {
  OutletLookup,
  CurrentRecRow,
  PrevRecRow,
  BenchRow,
  PrevByItemIdEntry,
} from './types';

export interface BuildRestoProfileResult {
  restoProfile: Record<string, unknown>;
  prevByItemId: Map<string, PrevByItemIdEntry>;
}

export function buildRestoProfile(params: {
  outlet: OutletLookup;
  currentRecs: CurrentRecRow[];
  prevRecs: PrevRecRow[];
  areaBench: BenchRow[];
  networkBench: BenchRow[];
  thresholds: RuntimeThresholds;
}): BuildRestoProfileResult {
  const { outlet, currentRecs, prevRecs, areaBench, networkBench, thresholds } = params;

  // Sales via MODE (Metric Engine: computeSalesModePerOutlet)
  // Tie-break: smaller value wins (consistent SQL + JS)
  const currentSalesMap = computeSalesModePerOutlet(
    currentRecs.map(r => ({ outletId: outlet.id, nominalSales: toNum(r.nominalSales) })),
  );
  const bestSales = currentSalesMap.get(outlet.id) ?? 0;

  // Aggregate metrics — build AggregateInput for Metric Engine
  let totalQtyBom = 0, totalQtyDeviasi = 0, totalNominalDeviasi = 0;
  let totalQtyWaste = 0, totalQtySusut = 0, totalQtyTrial = 0;
  let totalQtyLossSurplus = 0, totalNominalLossSurplus = 0;
  let totalResidualQty = 0, totalAbsNominalLossSurplus = 0;
  let totalLossNominal = 0, totalSurplusNominal = 0;
  let normalCount = 0, warningCount = 0, abnormalCount = 0;

  for (const r of currentRecs) {
    const qb = toNum(r.qtyBom) ?? 0;
    const qd = toNum(r.qtyDeviasi) ?? 0;
    const nd = toNum(r.nominalDeviasi) ?? 0;
    const qls = toNum(r.qtyLossSurplus) ?? 0;
    const nls = toNum(r.nominalLossSurplus) ?? 0;
    const anls = toNum(r.absNominalLossSurplus) ?? 0;

    totalQtyBom += Math.abs(qb);
    totalQtyDeviasi += Math.abs(qd);
    totalNominalDeviasi += Math.abs(nd);
    totalQtyWaste += Math.abs(toNum(r.qtyWaste) ?? 0);
    totalQtySusut += Math.abs(toNum(r.qtySusut) ?? 0);
    totalQtyTrial += Math.abs(toNum(r.qtyTrial) ?? 0);
    totalQtyLossSurplus += Math.abs(qls);
    totalNominalLossSurplus += nls;
    totalAbsNominalLossSurplus += anls;
    totalResidualQty += Math.abs(toNum(r.residualQty) ?? 0);

    // FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
    if (nls < 0) totalLossNominal += Math.abs(nls);
    else if (nls > 0) totalSurplusNominal += nls;

    // Count severity
    // FIX (BUG 5): Use AND-zero criterion (qtyDeviasi AND absNominalDeviasi both ~0)
    // — matches analysis route. Previously: single-field |qd|<0.01 → price-only
    // variance items (qty=0 but nominal>0) were wrongly counted as normal.
    const isZeroDev = (qd === 0 || Math.abs(qd) < 0.01) && (nd === 0 || Math.abs(nd) < 0.01);
    if (isZeroDev) normalCount++;
    // FIX CALC-2: ABS() on BOTH sides — pctQtyDeviasiToBom and tolerancePct are SIGNED in Excel
    // (both negative for LOSS items). Without ABS, any positive > any negative → always abnormal.
    else if (Math.abs(toNum(r.pctQtyDeviasiToBom) ?? 0) > Math.abs(toNum(r.tolerancePct) ?? thresholds.FALLBACK_TOLERANCE_PCT)) abnormalCount++;
    else warningCount++;
  }

  const aggregateInput: AggregateInput = {
    totalQtyDeviasi,
    totalQtyBom,
    totalQtyWaste,
    totalQtySusut,
    totalQtyTrial,
    totalResidualQty,
    totalLossNominal,
    totalSales: bestSales,
    normalCount,
    warningCount,
    abnormalCount,
  };

  // Previous period aggregates
  let prevQtyBom = 0, prevQtyDeviasi = 0, prevNominalDeviasi = 0;
  // FIX (BUG-1-4): Key prevByItemId by `${itemId}|${akunPenyesuaian ?? ''}` so
  //   multi-akun items get the matching-akun prev record instead of the LAST
  //   row's prev data. Matches the pattern used in outlet-focus/route.ts:495
  //   (`${r.itemId}|${r.akunPenyesuaian ?? ''}`) and analysis/route.ts:321.
  const prevByItemId = new Map<string, PrevByItemIdEntry>();
  for (const r of prevRecs) {
    const qd = toNum(r.qtyDeviasi) ?? 0;
    const nd = toNum(r.nominalDeviasi) ?? 0;
    const qb = toNum(r.qtyBom) ?? 0;
    const pdb = toNum(r.pctQtyDeviasiToBom);
    prevQtyBom += Math.abs(qb);
    prevQtyDeviasi += Math.abs(qd);
    prevNominalDeviasi += Math.abs(nd);
    prevByItemId.set(`${r.itemId}|${r.akunPenyesuaian ?? ''}`, { qtyDeviasi: qd, nominalDeviasi: nd, qtyBom: qb, pctDevBom: pdb });
  }
  // Previous sales via Metric Engine MODE
  const prevSalesMap = computeSalesModePerOutlet(
    prevRecs
      .filter((r): r is typeof r & { nominalSales: number | null } => true)
      .map(r => ({ outletId: outlet.id, nominalSales: toNum(r.nominalSales) })),
  );
  const prevBestSales = prevSalesMap.get(outlet.id) ?? 0;

  // Metric Engine: aggregate metrics
  const devBomAggregate = computeDevBomAggregate(aggregateInput);
  const residualPctAggregate = computeResidualPctAggregate(aggregateInput);
  const explainedPctAggregate = computeExplainedPctAggregate(aggregateInput);
  const lossToSales = computeLossToSales(aggregateInput);
  // FIX (BUG-3-c SEDANG-1): pass the RUNTIME health score weights + thresholds
  // from Settings — same pattern as the analysis route's post-process-health-
  // ranking.ts (weights HEALTH_WEIGHT_* + thresholds HEALTH_THRESH_*). This used
  // to call computeHealthScore(aggregateInput) with NO weights/thresholds, so
  // the health ring on the Resto tab kept scoring against the compiled-in
  // defaults and silently DIVERGED from /api/analysis after the user changed
  // any HEALTH_* setting (two different scores for the same outlet).
  const healthScoreWeights: HealthScoreWeights = {
    devBom: thresholds.HEALTH_WEIGHT_DEV_BOM,
    residual: thresholds.HEALTH_WEIGHT_RESIDUAL,
    lossToSales: thresholds.HEALTH_WEIGHT_LOSS_TO_SALES,
    abnormal: thresholds.HEALTH_WEIGHT_ABNORMAL,
  };
  const healthScoreThresholds: HealthScoreThresholds = {
    devBom: { good: thresholds.HEALTH_THRESH_DEV_BOM_GOOD, bad: thresholds.HEALTH_THRESH_DEV_BOM_BAD },
    residual: { good: thresholds.HEALTH_THRESH_RESIDUAL_GOOD, bad: thresholds.HEALTH_THRESH_RESIDUAL_BAD },
    lossToSales: { good: thresholds.HEALTH_THRESH_LOSS_TO_SALES_GOOD, bad: thresholds.HEALTH_THRESH_LOSS_TO_SALES_BAD },
    abnormal: { good: thresholds.HEALTH_THRESH_ABNORMAL_GOOD, bad: thresholds.HEALTH_THRESH_ABNORMAL_BAD },
  };
  const healthScore = computeHealthScore(aggregateInput, healthScoreWeights, healthScoreThresholds);

  // Metric Engine: growth
  const salesGrowth = calcGrowth(bestSales, prevBestSales);
  const qtyBomGrowth = calcGrowthAbs(totalQtyBom, prevQtyBom); // BOM is consumption, use abs growth
  const qtyDeviasiGrowth = calcGrowth(totalQtyDeviasi, prevQtyDeviasi);
  const nominalDeviasiGrowth = computeNominalDeviationGrowth(totalNominalDeviasi, prevNominalDeviasi);

  // Metric Engine: growth result (with direction flip + trend)
  const devGrowthResult = computeGrowthResult(totalQtyDeviasi, prevQtyDeviasi, 0.1);

  const restoProfile = {
    // 1. Performance
    performance: {
      sales: bestSales,
      salesGrowth,
      qtyBom: totalQtyBom,
      qtyBomGrowth,
      qtyDeviasi: totalQtyDeviasi,
      qtyDeviasiGrowth,
      nominalDeviasi: totalNominalDeviasi,
      nominalDeviasiGrowth,
      nominalLossSurplus: totalNominalLossSurplus,
      devBom: devBomAggregate,
      lossToSales,
    },
    // 2. Behavior
    behavior: {
      lossNominal: totalLossNominal,
      surplusNominal: totalSurplusNominal,
      lossPct: totalAbsNominalLossSurplus > 0 ? totalLossNominal / totalAbsNominalLossSurplus : null,
      surplusPct: totalAbsNominalLossSurplus > 0 ? totalSurplusNominal / totalAbsNominalLossSurplus : null,
      qtyWaste: totalQtyWaste,
      qtySusut: totalQtySusut,
      qtyTrial: totalQtyTrial,
      qtyLossSurplus: totalQtyLossSurplus,
      residualQty: totalResidualQty,
      residualPct: residualPctAggregate,
      explainedPct: explainedPctAggregate,
    },
    // 3. Historical (current vs previous)
    historical: {
      prevQtyBom: prevQtyBom,
      prevQtyDeviasi: prevQtyDeviasi,
      prevNominalDeviasi: prevNominalDeviasi,
      bomGrowth: qtyBomGrowth,
      deviasiGrowth: qtyDeviasiGrowth,
      nominalGrowth: nominalDeviasiGrowth,
      // FIX H3 (AUDIT-3): when prevRecs is empty, devGrowthResult.trend='NEW' (computed
      // from zero base) was mapped to 'DETERIORATING' — a false alarm with no baseline.
      // Guard: if no prev period data, return 'INSUFFICIENT_DATA' instead.
      trend: prevRecs.length === 0 ? 'INSUFFICIENT_DATA'
        : devGrowthResult.trend === 'INCREASING' ? 'DETERIORATING'
        : devGrowthResult.trend === 'DECREASING' ? 'IMPROVING'
        : devGrowthResult.trend === 'NEW' ? 'DETERIORATING'  // onset from zero base
        : devGrowthResult.trend === 'RESOLVED' ? 'IMPROVING'
        : 'STABLE',
    },
    // 4. Benchmark — Metric Engine: computeBenchmark
    //  Phase 3: outletDevBom and areaAvgDevBom both use SUM(ABS)/SUM(ABS)
    //  (was: outletDevBom = SUM/SUM, areaAvgDevBom = AVG(ABS) — mismatch)
    benchmark: (() => {
      const areaAvgDevBom = toNum(areaBench[0]?.avgDevBom) ?? 0;
      const networkAvgDevBom = toNum(networkBench[0]?.avgDevBom) ?? 0;
      // Map trend to "ABOVE_NETWORK" / "ABOVE_AREA" / "NORMAL" using Settings factors
      const areaMultiplier = areaAvgDevBom > 0 ? devBomAggregate / areaAvgDevBom : null;
      const networkMultiplier = networkAvgDevBom > 0 ? devBomAggregate / networkAvgDevBom : null;
      const isAboveNetwork = networkMultiplier != null && networkMultiplier > thresholds.BENCHMARK_NETWORK_FACTOR;
      const isAboveArea = !isAboveNetwork && areaMultiplier != null && areaMultiplier > thresholds.BENCHMARK_AREA_FACTOR;
      const status = isAboveNetwork ? 'ABOVE_NETWORK' : isAboveArea ? 'ABOVE_AREA' : 'NORMAL';
      return {
        areaAvgDevBom,
        networkAvgDevBom, // backward compat
        allRestoAvgDevBom: networkAvgDevBom, // FIX: clearer name
        outletDevBom: devBomAggregate,
        areaMultiplier,
        networkMultiplier, // backward compat
        allRestoMultiplier: networkMultiplier, // FIX: clearer name
        isAboveArea,
        isAboveNetwork,
        status,
      };
    })(),
    // 5. Top Risk (top 5 per category)
    topRisk: {
      byNominal: [...currentRecs]
        .sort((a, b) => (toNum(b.absNominalLossSurplus) ?? 0) - (toNum(a.absNominalLossSurplus) ?? 0))
        .slice(0, 5)
        .map(r => ({ itemName: r.itemName, value: toNum(r.absNominalLossSurplus) ?? 0, direction: r.direction || 'NEUTRAL' })),
      byDevBom: [...currentRecs]
        .sort((a, b) => Math.abs(toNum(b.pctQtyDeviasiToBom) ?? 0) - Math.abs(toNum(a.pctQtyDeviasiToBom) ?? 0))
        .slice(0, 5)
        .map(r => ({ itemName: r.itemName, value: toNum(r.pctQtyDeviasiToBom) ?? 0 })),
      byResidual: [...currentRecs]
        .sort((a, b) => (toNum(b.residualRatio) ?? 0) - (toNum(a.residualRatio) ?? 0))
        .slice(0, 5)
        .map(r => ({ itemName: r.itemName, value: toNum(r.residualRatio) ?? 0 })),
    },
    // 6. Investigation counts + health score (Metric Engine)
    investigation: {
      normal: normalCount,
      warning: warningCount,
      abnormal: abnormalCount,
      total: normalCount + warningCount + abnormalCount,
      healthScore,
    },
  };

  return { restoProfile, prevByItemId };
}
