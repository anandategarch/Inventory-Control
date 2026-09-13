// ============================================================
//  Historical Stats — per outlet+item, ONE OBSERVATION PER WEEK
//  --------------------------------------------------------
//  Multi-metric: computes historical mean/stdDev/n for:
//  - Dev/BOM ratio (SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom)))
//  - QTY Deviasi (SUM(ABS(qtyDeviasi))) — absolute magnitude for Z-Score
//  - Waste (SUM(ABS(qtyWaste))) — uses QTY, not nominal
//  - Susut (SUM(ABS(qtySusut))) — uses QTY, not nominal
//  - Trial (SUM(ABS(qtyTrial))) — uses QTY, not nominal
//
//  NOTE: All metrics use ABS (magnitude) for Z-Score computation per PRD §5.2.
//  Display layer may show signed values (e.g. currentQtyDeviasi) for direction.
//
//  Returns Map<"outletId|itemId", { devBom, qtyDeviasi, waste, susut, trial }>
//  Each metric has { mean, stdDev, n }.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';
import { sameWeekPeriodPin } from './historical-baseline';
import { computeSampleStatsFromSums } from '@/lib/metrics/sample-stats';
import type { HistoricalStats } from '@/lib/metrics/historical';

// AUDIT A2 / MERGE-2-a: shape unified with metrics' HistoricalStats —
// MetricStats is now a TYPE ALIAS (no third { mean, stdDev, n } shape).
// Existing imports of MetricStats keep working unchanged (structurally
// identical interface).
export type MetricStats = HistoricalStats;
export interface MultiMetricHistoricalStats {
  devBom: MetricStats;
  qtyDeviasi: MetricStats;
  waste: MetricStats;
  susut: MetricStats;
  trial: MetricStats;
}

// AUDIT A2 / MERGE-2-a: computeStats moved to the shared module
// @/lib/metrics/sample-stats (computeSampleStatsFromSums) — it was
// duplicated in item-trend.ts with identical Bessel-corrected semantics.

export async function queryHistoricalStatsMultiMetric(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts
): Promise<Map<string, MultiMetricHistoricalStats>> {
  if (historicalPeriods.length === 0) return new Map();

  const f = buildSqlFilters(filters);

  // Same-week historical window (AUDIT A2 / MERGE-2-a): each (monthLabel,
  // weekLabel) pin renders via the shared fragment ./historical-baseline.ts
  // (sameWeekPeriodPin). The CALLER owns the window semantics — fetch-records.ts
  // builds the period list with the SAME weekLabel and months before the
  // running period (no future-month leakage).
  const periodConditions = historicalPeriods.map((p) =>
    sameWeekPeriodPin('ir', p.monthLabel, p.weekLabel)
  );
  const periodFilter = Prisma.join(periodConditions, ' OR ');

  // Multi-metric weekly aggregation:
  // 1. weekly_dev: per outlet+item+week → compute all 4 metrics
  // 2. final: per outlet+item → mean/sumSq/n for each metric
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
    outletId: number; itemId: number;
    // Dev/BOM
    devBomMean: number; devBomSumSq: number; devBomN: number;
    // QTY Deviasi (absolute magnitude)
    qtyDeviasiMean: number; qtyDeviasiSumSq: number; qtyDeviasiN: number;
    // Waste
    wasteMean: number; wasteSumSq: number; wasteN: number;
    // Susut
    susutMean: number; susutSumSq: number; susutN: number;
    // Trial
    trialMean: number; trialSumSq: number; trialN: number;
  }[]>`
    WITH weekly_dev AS (
      SELECT ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel",
        -- Dev/BOM ratio per week
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "weeklyDevBom",
        -- QTY Deviasi absolute per week (for Z-Score magnitude)
        SUM(ABS(ir."qtyDeviasi")) as "weeklyQtyDeviasi",
        -- Waste qty per week
        SUM(ABS(ir."qtyWaste")) as "weeklyWaste",
        -- Susut qty per week
        SUM(ABS(ir."qtySusut")) as "weeklySusut",
        -- Trial qty per week
        SUM(ABS(ir."qtyTrial")) as "weeklyTrial"
      FROM "InventoryRecord" ir
      WHERE (${periodFilter})
        ${f}
      GROUP BY ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel"
    )
    SELECT
      "outletId", "itemId",
      -- Dev/BOM stats (exclude NULLs)
      AVG("weeklyDevBom") as "devBomMean",
      SUM("weeklyDevBom" * "weeklyDevBom") as "devBomSumSq",
      CAST(COUNT("weeklyDevBom") AS INTEGER) as "devBomN",
      -- QTY Deviasi stats
      AVG("weeklyQtyDeviasi") as "qtyDeviasiMean",
      SUM("weeklyQtyDeviasi" * "weeklyQtyDeviasi") as "qtyDeviasiSumSq",
      CAST(COUNT("weeklyQtyDeviasi") AS INTEGER) as "qtyDeviasiN",
      -- Waste stats
      AVG("weeklyWaste") as "wasteMean",
      SUM("weeklyWaste" * "weeklyWaste") as "wasteSumSq",
      CAST(COUNT("weeklyWaste") AS INTEGER) as "wasteN",
      -- Susut stats
      AVG("weeklySusut") as "susutMean",
      SUM("weeklySusut" * "weeklySusut") as "susutSumSq",
      CAST(COUNT("weeklySusut") AS INTEGER) as "susutN",
      -- Trial stats
      AVG("weeklyTrial") as "trialMean",
      SUM("weeklyTrial" * "weeklyTrial") as "trialSumSq",
      CAST(COUNT("weeklyTrial") AS INTEGER) as "trialN"
    FROM weekly_dev
    GROUP BY "outletId", "itemId"
  `);

  const map = new Map<string, MultiMetricHistoricalStats>();
  for (const r of rows) {
    map.set(`${r.outletId}|${r.itemId}`, {
      devBom: computeSampleStatsFromSums(Number(r.devBomN), Number(r.devBomMean), Number(r.devBomSumSq)),
      qtyDeviasi: computeSampleStatsFromSums(Number(r.qtyDeviasiN), Number(r.qtyDeviasiMean), Number(r.qtyDeviasiSumSq)),
      waste: computeSampleStatsFromSums(Number(r.wasteN), Number(r.wasteMean), Number(r.wasteSumSq)),
      susut: computeSampleStatsFromSums(Number(r.susutN), Number(r.susutMean), Number(r.susutSumSq)),
      trial: computeSampleStatsFromSums(Number(r.trialN), Number(r.trialMean), Number(r.trialSumSq)),
    });
  }
  return map;
}
