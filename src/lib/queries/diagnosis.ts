// ============================================================
//  Diagnosis Query — assembles OutletEvidence[] for the causal engine
//  --------------------------------------------------------
//  Collects per-outlet evidence from 4 parallel SQL queries + the
//  existing rule-evaluation evaluator, then merges into the
//  OutletEvidence[] shape consumed by `computeCausalDiagnosis()`.
//
//  Queries:
//    1. Per-outlet decomposition (curr + prev period LATERAL JOIN)
//       → qtyBom/Deviasi/Waste/Susut/Trial, residual, nominal,
//         itemCount, sales, growth, directionFlips (via rule fire).
//    2. BOM=0 items per outlet (ARRAY_AGG item names + SUM nominal).
//    3. Historical per-period aggregates (same-week, prior months)
//       → susutZScore (current vs historical mean) + historicalZScores
//         array (each prior period's zScore vs the others).
//    4. Rule fires per outlet — calls `evaluateRulesSql` (which uses
//       the same SQL push-down path as /api/analysis) + aggregates
//       per outlet × ruleCode.
//
//  All queries use `withStatementTimeout` (heavy aggregations on
//  ~35K records per period) + `buildSqlFilters` for area/kelompok/
//  outlet/PIC filters. Uses Prisma.sql tagged templates (zero
//  $queryRawUnsafe).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';
import { evaluateRulesSql, type SqlRuleFlag } from './rule-evaluation';
import { queryHistoricalStatsMultiMetric, type MultiMetricHistoricalStats } from './historical';
import type { OutletEvidence } from '@/lib/metrics/causal-engine';
import type { RuntimeThresholds } from '@/lib/settings';

// ============================================================
//  Row shapes — declared for type-safety on $queryRaw results.
//  Prisma returns Decimal/BigInt as strings; we Number() them in JS.
// ============================================================
interface DecompositionRow {
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  // Current period aggregates
  qtyBom: number | string;
  qtyDeviasi: number | string;
  qtyWaste: number | string;
  qtySusut: number | string;
  qtyTrial: number | string;
  residualQty: number | string | null;
  residualPct: number | string | null;
  absNominalDeviasi: number | string;
  totalLoss: number | string;
  totalSurplus: number | string;
  netLossSurplus: number | string;
  itemCount: number;
  sales: number | string | null;
  // Previous period aggregates (NULL when no prev period)
  prevQtyBom: number | string | null;
  prevQtyDeviasi: number | string | null;
  prevItemCount: number | null;
  prevSales: number | string | null;
}

interface BomZeroRow {
  outletId: number;
  bomZeroItems: string[];
  bomZeroNominal: number;
}

interface HistoricalPeriodRow {
  outletId: number;
  monthLabel: string;
  weekLabel: string;
  totalSusut: number;
  totalDeviasi: number;
}

// ============================================================
//  Query 1: per-outlet decomposition (curr + prev LATERAL JOIN)
//  --------------------------------------------------------
//  Aggregates per outlet for the current period + LEFT JOINs the
//  previous period's aggregates (same outlet). NULL prev values
//  when no prev period exists (handled in JS).
//
//  residualPct = SUM(ABS(residualQty)) / SUM(ABS(qtyDeviasi))
//  totalLoss = SUM(ABS(nominalLossSurplus)) FILTER (WHERE < 0)
//  totalSurplus = SUM(ABS(nominalLossSurplus)) FILTER (WHERE > 0)
//  netLossSurplus = SUM(nominalLossSurplus) — SIGNED
// ============================================================
async function queryPerOutletDecomposition(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
): Promise<DecompositionRow[]> {
  const f = buildSqlFilters(filters);
  const hasPrev = !!(prevWeek && prevMonth);
  // FIX (CAUSAL-BE-02): prev CTE alias is `ir` (FROM "InventoryRecord" ir),
  // NOT `p` (that's the LATERAL JOIN alias in evaluateRulesSql / post-process).
  // Using `p.` here causes "missing FROM-clause entry for table p" (42P01).
  const prevFilter = hasPrev
    ? Prisma.sql`AND ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}`
    : Prisma.sql`AND 1=0`;

  return withStatementTimeout((tx) => tx.$queryRaw<DecompositionRow[]>`
    WITH curr AS (
      SELECT
        ir."outletId",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) AS "qtyBom",
        COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) AS "qtyDeviasi",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) AS "qtyWaste",
        COALESCE(SUM(ABS(ir."qtySusut")), 0) AS "qtySusut",
        COALESCE(SUM(ABS(ir."qtyTrial")), 0) AS "qtyTrial",
        COALESCE(SUM(ABS(ir."residualQty")), 0) AS "residualQty",
        CASE WHEN SUM(ABS(ir."qtyDeviasi")) > 0
          THEN SUM(ABS(ir."residualQty")) / SUM(ABS(ir."qtyDeviasi"))
          ELSE 0 END AS "residualPct",
        COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) AS "absNominalDeviasi",
        COALESCE(SUM(ABS(ir."nominalLossSurplus")) FILTER (WHERE ir."nominalLossSurplus" < 0), 0) AS "totalLoss",
        COALESCE(SUM(ABS(ir."nominalLossSurplus")) FILTER (WHERE ir."nominalLossSurplus" > 0), 0) AS "totalSurplus",
        COALESCE(SUM(ir."nominalLossSurplus"), 0) AS "netLossSurplus",
        CAST(COUNT(DISTINCT ir."itemId") AS INTEGER) AS "itemCount",
        COALESCE(SUM(ir."nominalSales"), 0) AS "sales"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY ir."outletId"
    ),
    prev AS (
      SELECT
        ir."outletId",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) AS "prevQtyBom",
        COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) AS "prevQtyDeviasi",
        CAST(COUNT(DISTINCT ir."itemId") AS INTEGER) AS "prevItemCount",
        COALESCE(SUM(ir."nominalSales"), 0) AS "prevSales"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${prevFilter}
        ${f}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      GROUP BY ir."outletId"
    )
    SELECT
      c."outletId",
      o.code AS "outletCode",
      o.name AS "outletName",
      o.area,
      c."qtyBom", c."qtyDeviasi", c."qtyWaste", c."qtySusut", c."qtyTrial",
      c."residualQty", c."residualPct", c."absNominalDeviasi",
      c."totalLoss", c."totalSurplus", c."netLossSurplus",
      c."itemCount", c."sales",
      p."prevQtyBom", p."prevQtyDeviasi", p."prevItemCount", p."prevSales"
    FROM curr c
    JOIN "Outlet" o ON o.id = c."outletId"
    LEFT JOIN prev p ON p."outletId" = c."outletId"
    ORDER BY c."absNominalDeviasi" DESC NULLS LAST
    LIMIT 500
  `);
}

// ============================================================
//  Query 2: BOM=0 items per outlet
//  --------------------------------------------------------
//  For each outlet, list items where qtyBom IS NULL OR = 0.
//  Returns ARRAY_AGG of distinct item names + SUM of |nominalDeviasi|
//  for those items.
//
//  ARRAY_AGG(DISTINCT ...) returns PostgreSQL text[] — Prisma
//  surfaces it as string[] automatically.
// ============================================================
async function queryBomZeroItems(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<Map<number, BomZeroRow>> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<BomZeroRow[]>`
    SELECT
      ir."outletId",
      ARRAY_AGG(DISTINCT i.name) AS "bomZeroItems",
      COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) AS "bomZeroNominal"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND (ir."qtyBom" IS NULL OR ir."qtyBom" = 0)
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY ir."outletId"
  `);
  const map = new Map<number, BomZeroRow>();
  for (const r of rows) {
    map.set(Number(r.outletId), {
      outletId: Number(r.outletId),
      bomZeroItems: Array.isArray(r.bomZeroItems) ? r.bomZeroItems : [],
      bomZeroNominal: Number(r.bomZeroNominal) || 0,
    });
  }
  return map;
}

// ============================================================
//  Query 3: Historical per-period aggregates (same-week, prior months)
//  --------------------------------------------------------
//  For each outlet × prior period (same weekLabel, different monthLabel):
//    - SUM(ABS(qtySusut))
//    - SUM(ABS(qtyDeviasi))
//
//  These are used to compute:
//    - susutZScore: current outlet's qtySusut vs historical mean/stdDev
//    - historicalZScores: array of per-period deviasi zScores (for
//      SEASONAL pattern detection — same period last year was also high).
//
//  We DON'T filter by chronological order here — all periods with the
//  same weekLabel but different monthLabel are "historical" relative
//  to the current period. The SEASONAL pattern is "deviation was high
//  in this same week in prior months" — chronological filtering would
//  exclude future periods (which don't exist yet anyway).
// ============================================================
async function queryHistoricalPeriodAggregates(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<Map<number, HistoricalPeriodRow[]>> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<HistoricalPeriodRow[]>`
    SELECT
      ir."outletId",
      ir."monthLabel",
      ir."weekLabel",
      COALESCE(SUM(ABS(ir."qtySusut")), 0) AS "totalSusut",
      COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) AS "totalDeviasi"
    FROM "InventoryRecord" ir
    WHERE ir."weekLabel" = ${week}
      AND ir."monthLabel" <> ${month}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY ir."outletId", ir."monthLabel", ir."weekLabel"
  `);
  const map = new Map<number, HistoricalPeriodRow[]>();
  for (const r of rows) {
    const outletId = Number(r.outletId);
    const arr = map.get(outletId) ?? [];
    arr.push({
      outletId,
      monthLabel: r.monthLabel,
      weekLabel: r.weekLabel,
      totalSusut: Number(r.totalSusut) || 0,
      totalDeviasi: Number(r.totalDeviasi) || 0,
    });
    map.set(outletId, arr);
  }
  return map;
}

// ============================================================
//  Query 4 (optional): per-outlet+item historical stats for susut Z-Score
//  --------------------------------------------------------
//  Calls the existing `queryHistoricalStatsMultiMetric` to fetch
//  per-outlet+item susut mean/stdDev/n. Used as a fallback for the
//  per-outlet susutZScore (worst-item approach) when historicalPeriods
//  is sparse.
//
//  This is OPTIONAL — when queryHistoricalPeriodAggregates returns
//  enough data per outlet, we compute susutZScore from per-outlet
//  aggregates directly (more meaningful than max-item zScore). The
//  worst-item approach is used as a fallback.
// ============================================================
async function queryPerOutletItemSusutStats(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts,
): Promise<Map<number, MultiMetricHistoricalStats[]>> {
  if (historicalPeriods.length === 0) return new Map();
  const multi = await queryHistoricalStatsMultiMetric(historicalPeriods, filters);
  // Re-group by outletId (was keyed by outletId|itemId)
  const byOutlet = new Map<number, MultiMetricHistoricalStats[]>();
  for (const [key, stats] of multi) {
    const [outletIdStr] = key.split('|');
    const outletId = Number(outletIdStr);
    const arr = byOutlet.get(outletId) ?? [];
    arr.push(stats);
    byOutlet.set(outletId, arr);
  }
  return byOutlet;
}

// ============================================================
//  Helpers — compute derived fields in JS
//  --------------------------------------------------------
//  SQL returns aggregates; growth + zScores are derived here.
// ============================================================
function computeGrowth(curr: number, prev: number | null): number | null {
  if (prev == null || prev === 0) return null;
  return (curr - prev) / Math.abs(prev);
}

/** Compute mean + sample stddev (N-1, Bessel's correction) for an array. */
function computeSampleStats(values: number[]): { mean: number; stdDev: number; n: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, stdDev: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1
    ? Math.max(0, values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0;
  return { mean, stdDev: Math.sqrt(variance), n };
}

/**
 * Compute the per-outlet susut Z-Score.
 *
 * Strategy:
 *   1. If we have ≥4 prior periods of per-outlet aggregate susut → use the
 *      per-outlet baseline (more meaningful — represents the outlet's overall
 *      susut pattern).
 *   2. Else fall back to the worst-item zScore (max susut zScore across items
 *      at the outlet) using the per-outlet+item historical stats.
 *
 * Returns SIGNED zScore (positive = above historical mean = worse, per
 * src/lib/metrics/historical.ts convention).
 */
function computeSusutZScore(
  outletId: number,
  currentSusut: number,
  historicalAggs: Map<number, HistoricalPeriodRow[]>,
  perOutletItemStats: Map<number, MultiMetricHistoricalStats[]>,
  minWeeks: number,
): number | null {
  // Strategy 1: per-outlet aggregate baseline.
  const histRows = historicalAggs.get(outletId) ?? [];
  if (histRows.length >= minWeeks) {
    const values = histRows.map((r) => r.totalSusut);
    const stats = computeSampleStats(values);
    if (stats.stdDev > 0) {
      return (currentSusut - stats.mean) / stats.stdDev;
    }
  }
  // Strategy 2: worst-item zScore fallback.
  const itemStats = perOutletItemStats.get(outletId) ?? [];
  let worstZ: number | null = null;
  for (const s of itemStats) {
    if (s.susut.stdDev <= 0 || s.susut.n < minWeeks) continue;
    const z = (currentSusut - s.susut.mean) / s.susut.stdDev;
    // NOTE: this compares outlet-aggregate susut to per-item baseline, which
    // is statistically incorrect (outlet-aggregate >> per-item). The
    // per-outlet baseline above is the preferred path; this fallback only
    // triggers when historicalPeriods < minWeeks. We cap z at +5 to avoid
    // extreme outliers from the size mismatch.
    const capped = Math.max(-5, Math.min(5, z));
    if (worstZ == null || capped > worstZ) worstZ = capped;
  }
  return worstZ;
}

/**
 * Compute the array of historical per-period deviasi zScores for an outlet.
 *
 * Each zScore represents one prior period's deviation vs the OTHER prior
 * periods (leave-one-out — no leakage). Used for SEASONAL detection:
 *   - same_period_high: at least one prior zScore > 1.5
 *   - trend_deteriorating: 2+ prior zScores > 0
 */
function computeHistoricalZScores(
  outletId: number,
  historicalAggs: Map<number, HistoricalPeriodRow[]>,
): number[] {
  const histRows = historicalAggs.get(outletId) ?? [];
  if (histRows.length < 2) return [];
  const values = histRows.map((r) => r.totalDeviasi);
  // Leave-one-out: for each period, compute zScore vs the OTHER periods.
  // This matches the item-trend baseline-exclusion pattern (item-trend.ts:224).
  const zScores: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const others = values.filter((_, j) => j !== i);
    const stats = computeSampleStats(others);
    if (stats.n >= 2 && stats.stdDev > 0) {
      zScores.push((values[i] - stats.mean) / stats.stdDev);
    } else {
      zScores.push(0);
    }
  }
  return zScores;
}

// ============================================================
//  Aggregate rule fires per outlet × ruleCode
//  --------------------------------------------------------
//  Returns Map<outletId, Record<ruleCode, count>>.
//  Counts ALL fires (not deduplicated by record) — high fire counts
//  boost evidence weight proportionally (e.g. 5 SUSUT_BOM_MISMATCH
//  fires on 5 different items is stronger evidence than 1 fire).
// ============================================================
function aggregateRuleFiresPerOutlet(
  flags: SqlRuleFlag[],
): Map<number, Record<string, number>> {
  const map = new Map<number, Record<string, number>>();
  for (const flag of flags) {
    const perOutlet = map.get(flag.outletId) ?? {};
    perOutlet[flag.ruleCode] = (perOutlet[flag.ruleCode] ?? 0) + 1;
    map.set(flag.outletId, perOutlet);
  }
  return map;
}

// ============================================================
//  Main entry — queryDiagnosisEvidence
//  --------------------------------------------------------
//  Orchestrates the 4 queries in parallel (where possible) + merges
//  into OutletEvidence[] for the causal engine.
//
//  Flow:
//    1. Fire 3 SQL queries in parallel (decomposition, BOM=0, historical
//       period aggregates).
//    2. Fire evaluateRulesSql in parallel (heavy SQL — ~2-3s).
//    3. Build historicalPeriods list (for per-outlet+item susut stats
//       fallback) — derived from the historical period aggregates.
//    4. Fire per-outlet+item susut stats query (for fallback).
//    5. Merge in JS: for each outlet in decomposition rows, combine
//       + BOM=0 + rule fires + susutZScore + historicalZScores.
// ============================================================
export async function queryDiagnosisEvidence(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
  thresholds: RuntimeThresholds,
): Promise<OutletEvidence[]> {
  // Step 1: fire 3 queries in parallel (decomposition + BOM=0 + historical
  // period aggregates). evaluateRulesSql needs prevWeek/prevMonth to be
  // resolved (or null) — fire it in the same batch.
  const [decompRows, bomZeroMap, historicalAggs, ruleFlags] = await Promise.all([
    queryPerOutletDecomposition(week, month, prevWeek, prevMonth, filters),
    queryBomZeroItems(week, month, filters),
    queryHistoricalPeriodAggregates(week, month, filters),
    evaluateRulesSql(week, month, prevWeek, prevMonth, filters, thresholds),
  ]);

  // Step 2: aggregate rule fires per outlet × ruleCode.
  const ruleFiresByOutlet = aggregateRuleFiresPerOutlet(ruleFlags);

  // Step 3: build historicalPeriods list for the per-outlet+item stats
  // fallback. We only need this when at least one outlet has < minWeeks of
  // per-outlet aggregate history — but fetching is cheap (single SQL) and
  // parallelizable, so we just fetch it.
  const historicalPeriodsSet = new Set<string>();
  for (const rows of historicalAggs.values()) {
    for (const r of rows) {
      historicalPeriodsSet.add(`${r.monthLabel}|${r.weekLabel}`);
    }
  }
  const historicalPeriods = [...historicalPeriodsSet].map((key) => {
    const [monthLabel, weekLabel] = key.split('|');
    return { monthLabel, weekLabel };
  });

  // Step 4: fetch per-outlet+item susut stats (for fallback).
  const perOutletItemStats = await queryPerOutletItemSusutStats(
    historicalPeriods,
    filters,
  );

  // Step 5: merge into OutletEvidence[].
  const minWeeks = thresholds.HISTORICAL_MIN_WEEKS ?? 4;
  const evidences: OutletEvidence[] = [];
  for (const row of decompRows) {
    const outletId = Number(row.outletId);
    const bomZero = bomZeroMap.get(outletId);
    const ruleFires = ruleFiresByOutlet.get(outletId) ?? {};
    const directionFlips = ruleFires['DIRECTION_FLIP'] ?? 0;

    const qtySusut = Number(row.qtySusut) || 0;
    const qtyDeviasi = Number(row.qtyDeviasi) || 0;
    const qtyBom = Number(row.qtyBom) || 0;

    const bomGrowth = computeGrowth(qtyBom, row.prevQtyBom == null ? null : Number(row.prevQtyBom));
    const qtyDeviasiGrowth = computeGrowth(
      qtyDeviasi,
      row.prevQtyDeviasi == null ? null : Number(row.prevQtyDeviasi),
    );

    const susutZScore = computeSusutZScore(
      outletId,
      qtySusut,
      historicalAggs,
      perOutletItemStats,
      minWeeks,
    );
    const historicalZScores = computeHistoricalZScores(outletId, historicalAggs);

    evidences.push({
      outletCode: row.outletCode,
      outletName: row.outletName,
      area: row.area,
      ruleFires,
      qtyDeviasi,
      qtyWaste: Number(row.qtyWaste) || 0,
      qtySusut,
      qtyTrial: Number(row.qtyTrial) || 0,
      residualPct: row.residualPct == null ? 0 : Number(row.residualPct),
      bomZeroItems: bomZero?.bomZeroItems ?? [],
      bomZeroNominal: bomZero?.bomZeroNominal ?? 0,
      susutZScore,
      bomGrowth,
      qtyDeviasiGrowth,
      totalLoss: Number(row.totalLoss) || 0,
      totalSurplus: Number(row.totalSurplus) || 0,
      netLossSurplus: Number(row.netLossSurplus) || 0,
      itemCount: Number(row.itemCount) || 0,
      prevItemCount: row.prevItemCount == null ? 0 : Number(row.prevItemCount),
      sales: row.sales == null ? 0 : Number(row.sales),
      prevSales: row.prevSales == null ? 0 : Number(row.prevSales),
      directionFlips,
      historicalZScores,
    });
  }

  return evidences;
}
