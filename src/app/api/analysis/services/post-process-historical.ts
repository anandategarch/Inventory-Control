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
//
//  FX-HIST-EMPTY (this change): also returns a `meta` block so the
//  frontend empty state can give accurate feedback. The card used to
//  ALWAYS show the "minimal 4 bulan data" tip regardless of the real
//  reason criticalItems was empty. The meta block lets the card
//  differentiate between (a) no historical baseline, (b) too few
//  weeks, (c) stats too homogeneous (stdDev=0), (d) genuinely no
//  anomalies — current below historical avg.
// ============================================================
import { calcZScoreFromStats } from '@/lib/metrics';
import { queryHistoricalCriticalItems } from '@/lib/queries';
import type { SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { FetchedRecords } from './fetch-records';

export interface HistoricalAnalysisMeta {
  /** # of (monthLabel,weekLabel) pairs used as historical baseline (excluding current). */
  historicalPeriodsCount: number;
  /** Minimum weeks required to evaluate a record (from settings, default 4). */
  minWeeks: number;
  /** zScore > this → WARNING (from settings, default 1.5). */
  zWarnThreshold: number;
  /** zScore > this → ABNORMAL (from settings, default 2). */
  zHighThreshold: number;
  /** Total (outlet,item) pairs in the historical stats map. */
  statsCount: number;
  /** Pairs with stdDev > 0 AND n >= minWeeks (eligible for Z-Score). */
  validStatsCount: number;
  /** Total current records evaluated. */
  evaluatedCount: number;
  /** Records flagged by HISTORICAL_* rules. */
  flaggedCount: number;
  /**
   * Pre-computed reason for empty criticalItems — used by the frontend
   * to show a contextual empty-state message instead of the generic
   * "minimal 4 bulan" tip.
   *   - 'NO_HISTORICAL_DATA'   : no other month has this weekLabel
   *   - 'INSUFFICIENT_WEEKS'   : fewer than minWeeks historical periods
   *   - 'NO_VALID_STATS'       : stats exist but stdDev=0 / n<minWeeks for all
   *   - 'NO_ANOMALIES'         : valid baseline + valid stats, none flagged
   *   - 'ALL_FILTERED_BOM'     : flags exist but criticalItems all filtered
   *                              (BOM≈0 / historicalAvg=0) on the client
   *   - 'NON_EMPTY'            : criticalItems present (not an empty state)
   */
  reason:
    | 'NO_HISTORICAL_DATA'
    | 'INSUFFICIENT_WEEKS'
    | 'NO_VALID_STATS'
    | 'NO_ANOMALIES'
    | 'ALL_FILTERED_BOM'
    | 'NON_EMPTY';
}

export interface HistoricalAnalysisResult {
  criticalItems: Array<Record<string, unknown>>;
  meta: HistoricalAnalysisMeta;
}

/**
 * Sub-step 4 — build historical critical-items analysis.
 * Filters topFlagByKey for HISTORICAL_* flags, fetches per-record fields via SQL,
 * computes zScore + sorts + slices top 200. Also computes a `meta` block with
 * diagnostics for the frontend empty state.
 */
export async function buildHistoricalAnalysis(
  topFlagByKey: Map<string, SqlRuleFlag>,
  week: string,
  month: string,
  filterOpts: FetchedRecords['filterOpts'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
  // FX-HIST-EMPTY: new params for diagnostics (currRecordCount — PERF
  // TAHAP-2/P2-7 replaced the currSlim array with a plain count)
  currRecordCount: number,
  historicalPeriodsCount: number,
  thresholds: FetchedRecords['thresholds'],
): Promise<HistoricalAnalysisResult> {
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
  const flaggedCount = histCriticalKeys.length;
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

  // ============================================================
  //  FX-HIST-EMPTY: compute diagnostics for the frontend empty state.
  //  We compute validStatsCount by scanning the historicalByOutletItem
  //  map — same predicate as evaluateHistoricalRulesJs uses to skip a
  //  record (stats.devBom.stdDev <= 0 || stats.devBom.n < minWeeks).
  //  This is O(map.size) — small (5K-10K entries) and runs once.
  // ============================================================
  const minWeeks = thresholds.HISTORICAL_MIN_WEEKS ?? 4;
  const zWarnThreshold = thresholds.HISTORICAL_ZSCORE_WARN ?? 1.5;
  const zHighThreshold = thresholds.HISTORICAL_ZSCORE_HIGH ?? 2;
  const statsCount = historicalByOutletItem.size;
  let validStatsCount = 0;
  for (const stats of historicalByOutletItem.values()) {
    if (stats.devBom.stdDev > 0 && stats.devBom.n >= minWeeks) validStatsCount++;
  }
  const evaluatedCount = currRecordCount;

  // Determine the empty-state reason (NON_EMPTY if items present).
  let reason: HistoricalAnalysisMeta['reason'];
  if (histCriticalItems.length > 0) {
    reason = 'NON_EMPTY';
  } else if (historicalPeriodsCount === 0) {
    reason = 'NO_HISTORICAL_DATA';
  } else if (historicalPeriodsCount < minWeeks) {
    reason = 'INSUFFICIENT_WEEKS';
  } else if (validStatsCount === 0) {
    reason = 'NO_VALID_STATS';
  } else if (flaggedCount > 0) {
    // Backend emitted HISTORICAL_* flags but the row filter removed
    // all of them (BOM≈0 or historicalAvg=0). Client filter is
    // `Math.abs(currentDevBom) <= 5 && activeZ > 0 && historicalAvg > 0`.
    reason = 'ALL_FILTERED_BOM';
  } else {
    reason = 'NO_ANOMALIES';
  }

  // FIX: return top 200 (was 50) — Phase B-4: increased limit for pagination.
  // HistoricalZScoreCard shows 20 initially with "load more" button.
  return {
    criticalItems: histCriticalItems.slice(0, 200),
    meta: {
      historicalPeriodsCount,
      minWeeks,
      zWarnThreshold,
      zHighThreshold,
      statsCount,
      validStatsCount,
      evaluatedCount,
      flaggedCount,
      reason,
    },
  };
}
