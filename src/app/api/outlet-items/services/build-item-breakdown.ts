// ============================================================
//  build-item-breakdown — Section 4 of /api/outlet-items GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 673-line route.ts (lines ~514-612).
//
//  Responsibilities:
//    1. For each row in currentRecs, build the per-item breakdown row:
//       - Per-item BOM/deviasi/loss-surplus quantities + nominals
//       - Residual ratio + isOverExplained flag (FIX-DEEP-3C:
//         abs-each-then-sum so mixed-sign waste/susut/trial components
//         aren't undercounted)
//       - Historical growth vs prevByItemId (lookup by
//         `${itemId}|${akunPenyesuaian ?? ''}` — FIX BUG-1-4)
//       - Area multiplier (per-item ratio of devBom vs area avg)
//       - Metric Engine priority (Settings-driven thresholds)
//    2. Returns ItemBreakdownRow[] (one row per currentRecs entry).
//
//  Consumed by:
//    - buildRankings (sorts + slices into 3 ranked lists)
//    - route.ts (assembled into response.allItems field)
// ============================================================
import {
  computePriority,
  calcGrowthAbs,
  type PriorityInput,
} from '@/lib/metrics';
import { toNum } from '@/lib/format';
import type { RuntimeThresholds } from '@/lib/settings';
import type {
  CurrentRecRow,
  BenchRow,
  PrevByItemIdEntry,
  ItemBreakdownRow,
} from './types';

export function buildItemBreakdown(params: {
  currentRecs: CurrentRecRow[];
  prevByItemId: Map<string, PrevByItemIdEntry>;
  areaBench: BenchRow[];
  networkBench: BenchRow[];
  thresholds: RuntimeThresholds;
}): ItemBreakdownRow[] {
  const { currentRecs, prevByItemId, areaBench, networkBench, thresholds } = params;

  const priorityThresholds: PriorityInput['thresholds'] = {
    HIGH_LOSS_NOMINAL_THRESHOLD: thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
    P2_NOMINAL_THRESHOLD: thresholds.P2_NOMINAL_THRESHOLD,
    STD_DEVIASI_BOM_PCT: thresholds.STD_DEVIASI_BOM_PCT,
    RESIDUAL_LOSS_WARN_PCT: thresholds.RESIDUAL_LOSS_WARN_PCT,
    RESIDUAL_LOSS_HIGH_PCT: thresholds.RESIDUAL_LOSS_HIGH_PCT,
    HISTORICAL_ZSCORE_HIGH: thresholds.HISTORICAL_ZSCORE_HIGH,
  };

  return currentRecs.map(r => {
    const itemId = r.itemId;
    // FIX (BUG-1-4): Lookup prev record by (itemId, akunPenyesuaian) so
    //   multi-akun items get the matching-akun prev data.
    const prev = prevByItemId.get(`${itemId}|${r.akunPenyesuaian ?? ''}`);
    const qtyBom = toNum(r.qtyBom);
    const qtyDeviasi = toNum(r.qtyDeviasi);
    const pctDevBom = toNum(r.pctQtyDeviasiToBom);
    const nominalLS = toNum(r.nominalLossSurplus);
    const absNominalLS = toNum(r.absNominalLossSurplus) ?? 0;
    const residualRatio = toNum(r.residualRatio);
    const areaAvgDevBom = toNum(areaBench[0]?.avgDevBom) ?? 0;
    const networkAvgDevBom = toNum(networkBench[0]?.avgDevBom) ?? 0;

    // Over-explained check (inline; same logic as computeResidual)
    // FIX (FIX-DEEP-3C / DEEP-AUDIT-ENGINE-5): use abs-each-then-sum so the
    // explained magnitude is correct for mixed-sign inputs. Was
    // `Math.abs((w) + (s) + (t))` which undercounts explained magnitude when
    // components have mixed signs (e.g. w=+5, s=-3, t=-2 → wrong = |0| = 0,
    // correct = 5+3+2 = 10), suppressing valid isOverExplained flags. Mirrors
    // the fix applied to computeResidual (transform.ts).
    const isOverExplained = (() => {
      const explained = Math.abs(toNum(r.qtyWaste) ?? 0) + Math.abs(toNum(r.qtySusut) ?? 0) + Math.abs(toNum(r.qtyTrial) ?? 0);
      const absDev = Math.abs(toNum(r.qtyDeviasi) ?? 0);
      return absDev > 0 && explained > absDev;
    })();

    // Dev/BOM growth vs previous (Magnitude — use calcGrowthAbs)
    const prevPctDevBom = prev?.pctDevBom ?? null;
    const devBomGrowth = calcGrowthAbs(pctDevBom, prevPctDevBom);

    // Historical trend indicator
    const historicalTrend = devBomGrowth != null
      ? devBomGrowth > 0.1 ? '↑' : devBomGrowth < -0.1 ? '↓' : '→'
      : '?';

    // Area multiplier for this item (item-level: simple ratio of per-row devBom vs area avg)
    const areaMultiplier = areaAvgDevBom > 0 && pctDevBom != null
      ? Math.abs(pctDevBom) / areaAvgDevBom
      : null;

    // Metric Engine: priority (Settings-driven thresholds, no hardcoding)
    const priority = computePriority({
      absNominalLossSurplus: absNominalLS,
      devBom: pctDevBom,
      residualRatio,
      zScore: null, // zScore not computed at item level here (item-history route handles that)
      isOverExplained,
      thresholds: priorityThresholds,
    });

    return {
      itemId,
      itemName: r.itemName,
      satuan: r.satuan,
      qtyBom: Math.abs(qtyBom ?? 0),
      qtyCom: toNum(r.qtyCom),
      qtyDeviasi: qtyDeviasi,
      qtyWaste: Math.abs(toNum(r.qtyWaste) ?? 0),
      qtySusut: Math.abs(toNum(r.qtySusut) ?? 0),
      qtyTrial: Math.abs(toNum(r.qtyTrial) ?? 0),
      qtyLossSurplus: toNum(r.qtyLossSurplus),
      nominalDeviasi: toNum(r.nominalDeviasi),
      nominalLossSurplus: nominalLS,
      absNominalLossSurplus: absNominalLS,
      avgPrice: toNum(r.avgPrice),
      tolerancePct: toNum(r.tolerancePct),
      devBom: pctDevBom,
      direction: r.direction || 'NEUTRAL',
      residualQty: toNum(r.residualQty),
      residualRatio: residualRatio,
      isOverExplained,
      // Historical
      prevQtyDeviasi: prev?.qtyDeviasi ?? null,
      prevPctDevBom: prevPctDevBom,
      devBomGrowth: devBomGrowth,
      historicalTrend: historicalTrend as '↑' | '↓' | '→' | '?',
      // Benchmark — FIX: renamed network → allResto for clarity (both returned for compat)
      areaAvgDevBom: areaAvgDevBom,
      networkAvgDevBom: networkAvgDevBom, // backward compat
      allRestoAvgDevBom: networkAvgDevBom, // FIX: clearer name
      areaMultiplier: areaMultiplier,
      // Priority
      priority,
    };
  });
}
