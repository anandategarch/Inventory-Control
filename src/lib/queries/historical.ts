// ============================================================
//  Historical Stats — per outlet+item, ONE OBSERVATION PER WEEK
//  --------------------------------------------------------
//  Multi-metric: computes historical mean/stdDev/n for:
//  - Dev/BOM ratio (SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom)))
//  - Waste (SUM(ABS(nominalWaste)))
//  - Susut (SUM(ABS(nominalSusut)))
//  - Trial (SUM(ABS(nominalTrial)))
//
//  Returns Map<"outletId|itemId", { devBom, waste, susut, trial }>
//  Each metric has { mean, stdDev, n }.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

export interface MetricStats {
  mean: number;
  stdDev: number;
  n: number;
}

export interface MultiMetricHistoricalStats {
  devBom: MetricStats;
  waste: MetricStats;
  susut: MetricStats;
  trial: MetricStats;
}

// Legacy type for backward compat (analysis route still uses single-metric)
export type HistoricalStatsMap = Map<string, { mean: number; stdDev: number; n: number }>;

function computeStats(n: number, mean: number, sumSq: number): MetricStats {
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  return { mean: mean || 0, stdDev: Math.sqrt(variance), n };
}

export async function queryHistoricalStats(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts
): Promise<HistoricalStatsMap> {
  const multi = await queryHistoricalStatsMultiMetric(historicalPeriods, filters);
  // Convert to legacy single-metric format (devBom only) for backward compat
  const map: HistoricalStatsMap = new Map();
  for (const [key, val] of multi) {
    map.set(key, val.devBom);
  }
  return map;
}

export async function queryHistoricalStatsMultiMetric(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts
): Promise<Map<string, MultiMetricHistoricalStats>> {
  if (historicalPeriods.length === 0) return new Map();

  const f = buildSqlFilters(filters);

  const periodConditions = historicalPeriods.map((p) =>
    Prisma.sql`(ir."monthLabel" = ${p.monthLabel} AND ir."weekLabel" = ${p.weekLabel})`
  );
  const periodFilter = Prisma.join(periodConditions, ' OR ');

  // Multi-metric weekly aggregation:
  // 1. weekly_dev: per outlet+item+week → compute all 4 metrics
  // 2. final: per outlet+item → mean/sumSq/n for each metric
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
    outletId: number; itemId: number;
    // Dev/BOM
    devBomMean: number; devBomSumSq: number; devBomN: number;
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
      devBom: computeStats(Number(r.devBomN), Number(r.devBomMean), Number(r.devBomSumSq)),
      waste: computeStats(Number(r.wasteN), Number(r.wasteMean), Number(r.wasteSumSq)),
      susut: computeStats(Number(r.susutN), Number(r.susutMean), Number(r.susutSumSq)),
      trial: computeStats(Number(r.trialN), Number(r.trialMean), Number(r.trialSumSq)),
    });
  }
  return map;
}
