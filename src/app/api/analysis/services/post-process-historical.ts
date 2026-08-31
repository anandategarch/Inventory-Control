// ============================================================
//  post-process-historical — Sub-step 4: buildHistoricalAnalysis
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    Filter topFlagByKey for HISTORICAL_* flags, fetch per-record fields
//    via SQL (queryHistoricalCriticalItems), compute zScore + sort + slice
//    top 200 (Phase B-4 limit for pagination).
//
//  Computes Z-Score for 4 metrics:
//    - Dev/BOM (pctQtyDeviasiToBom) — primary, used for rule evaluation
//    - Waste (nominalWaste) — |current waste| vs historical mean
//    - Susut (nominalSusut) — |current susut| vs historical mean
//    - Trial (nominalTrial) — |current trial| vs historical mean
// ============================================================
import { calcZScoreFromStats } from '@/lib/metrics';
import { queryHistoricalCriticalItems } from '@/lib/queries';
import type { SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { FetchedRecords } from './fetch-records';

/**
 * Sub-step 4 — build historical critical-items analysis.
 * Filters topFlagByKey for HISTORICAL_* flags, fetches per-record fields via SQL,
 * computes zScore + sorts + slices top 50.
 */
export async function buildHistoricalAnalysis(
  topFlagByKey: Map<string, SqlRuleFlag>,
  week: string,
  month: string,
  filterOpts: FetchedRecords['filterOpts'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
): Promise<{ criticalItems: Array<Record<string, unknown>> }> {
  // ============================================================
  //  Historical Analysis (SQL-OPTIMIZE + Multi-Metric Phase B-1)
  //  --------------------------------------------------------
  //  Computes Z-Score for 4 metrics:
  //  - Dev/BOM (pctQtyDeviasiToBom) — primary, used for rule evaluation
  //  - Waste (nominalWaste) — |current waste| vs historical mean
  //  - Susut (nominalSusut) — |current susut| vs historical mean
  //  - Trial (nominalTrial) — |current trial| vs historical mean
  // ============================================================
  const histCriticalKeys = [...topFlagByKey.values()]
    .filter((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_ABNORMAL_SURPLUS' || f.ruleCode === 'HISTORICAL_WARNING')
    .map(f => ({ outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian }));
  const histCriticalRows = await queryHistoricalCriticalItems(week, month, filterOpts, histCriticalKeys);
  const histCriticalItems = histCriticalRows.map(row => {
    const key = `${row.outletId}|${row.itemId}`;
    const stats = historicalByOutletItem.get(key);
    if (!stats || stats.devBom.stdDev <= 0) return null;
    // ZS-03 FIX: Don't coerce null to 0 — pass raw value to calcZScoreFromStats
    const zScore = calcZScoreFromStats(row.pctQtyDeviasiToBom, stats.devBom.mean, stats.devBom.stdDev);

    // Phase B-1 MM-01 + ZS-02 FIX: Multi-metric Z-Scores with per-metric MIN_WEEKS + stdDev guards
    // QTY Deviasi: Z-Score uses ABS(current) vs mean(ABS(weekly)) per PRD §5.2
    const qtyDeviasiZScore = (stats.qtyDeviasi.n >= 4 && stats.qtyDeviasi.stdDev > 0)
      ? calcZScoreFromStats(row.qtyDeviasi, stats.qtyDeviasi.mean, stats.qtyDeviasi.stdDev) : 0;
    const wasteZScore = (stats.waste.n >= 4 && stats.waste.stdDev > 0)
      ? calcZScoreFromStats(row.qtyWaste, stats.waste.mean, stats.waste.stdDev) : 0;
    const susutZScore = (stats.susut.n >= 4 && stats.susut.stdDev > 0)
      ? calcZScoreFromStats(row.qtySusut, stats.susut.mean, stats.susut.stdDev) : 0;
    const trialZScore = (stats.trial.n >= 4 && stats.trial.stdDev > 0)
      ? calcZScoreFromStats(row.qtyTrial, stats.trial.mean, stats.trial.stdDev) : 0;

    return {
      itemName: row.itemName,
      outletCode: row.outletCode,
      area: row.area,
      currentDevBom: row.pctQtyDeviasiToBom ?? 0,
      historicalAvg: stats.devBom.mean,
      zScore: zScore ?? 0,
      absNominal: row.absNominalDeviasi ?? 0,
      // QTY Deviasi: current value SIGNED (nilai asli, bisa negatif/positif untuk direction)
      // Z-Score uses ABS magnitude (per PRD §5.2) — computed above
      currentQtyDeviasi: row.qtyDeviasi ?? 0, // signed value for display
      qtyDeviasiZScore: qtyDeviasiZScore ?? 0,
      qtyDeviasiHistoricalAvg: stats.qtyDeviasi.mean, // mean of ABS weekly values
      // Multi-metric current values + zScores (Phase B-1)
      currentWaste: Math.abs(row.qtyWaste ?? 0),
      currentSusut: Math.abs(row.qtySusut ?? 0),
      currentTrial: Math.abs(row.qtyTrial ?? 0),
      wasteZScore: wasteZScore ?? 0,
      susutZScore: susutZScore ?? 0,
      trialZScore: trialZScore ?? 0,
      wasteHistoricalAvg: stats.waste.mean,
      susutHistoricalAvg: stats.susut.mean,
      trialHistoricalAvg: stats.trial.mean,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  histCriticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  // FIX: return top 200 (was 50) — Phase B-4: increased limit for pagination.
  // HistoricalZScoreCard shows 20 initially with "load more" button.
  return { criticalItems: histCriticalItems.slice(0, 200) };
}
