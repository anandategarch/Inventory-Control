// ============================================================
//  SAMPLE STATS — shared mean/stdDev/n for z-score baselines
//  --------------------------------------------------------
//  AUDIT A2 / MERGE-2-a: the sample statistics behind the z-score
//  historical baseline were implemented 2× in pure JS with identical
//  semantics (sample variance, Bessel correction n-1):
//    1. src/lib/queries/historical.ts — computeStats(n, mean, sumSq)
//       SUM-SQ form (values come from SQL AVG + SUM(x*x) + COUNT
//       aggregates of a two-level CTE).
//    2. src/lib/queries/item-trend.ts — computeSampleStats(values)
//       array form (values come from JS-grouped same-week periods).
//  (A third implementation lives entirely in SQL —
//  queries/pareto/historical.ts uses AVG() + STDDEV_SAMP() — and is
//  intentionally left in SQL.)
//  The z-score FORMULA itself was already shared (./historical.ts
//  computeZScore / calcZScoreFromStats); this module removes the
//  remaining stats-shape duplication flagged by audit item A2.
//
//  Both functions return metrics' HistoricalStats ({ mean, stdDev,
//  n }) — there is no third stats shape (queries/historical.ts
//  MetricStats is now a type alias of HistoricalStats).
// ============================================================
import type { HistoricalStats } from './historical';

/**
 * Compute sample stats (mean + stdDev + n) from the SQL-aggregate
 * SUM-SQ form:
 *
 *   variance = (sumSq - n * mean²) / (n - 1)
 *
 * Input shape comes straight from a two-level SQL aggregation
 * (AVG(x) as mean, SUM(x * x) as sumSq, COUNT(x) as n — e.g.
 * queryHistoricalStatsMultiMetric's weekly_dev CTE), where mean and
 * sumSq are computed INDEPENDENTLY by the database. The identity
 * variance = E[x²] - E[x]² recovers the sample variance from that
 * form.
 *
 * - Sample variance: Bessel's correction (divide by n - 1), matching
 *   SQL STDDEV_SAMP and computeSampleStats below. n <= 1 → variance
 *   0 (no division by zero).
 * - Math.max(0, ...): floating-point guard. Because mean and sumSq
 *   are computed (and rounded) independently, sumSq - n·mean² can
 *   come out slightly NEGATIVE for constant / near-constant data
 *   (true variance 0) — Math.sqrt of that would be NaN, so clamp
 *   to 0 first.
 * - `mean || 0`: SQL AVG over an all-NULL group returns NULL, which
 *   the caller's Number() coercion turns into NaN (undefined) or 0
 *   (null) — normalize any falsy mean to 0.
 *
 * Verbatim (body byte-identical) from queries/historical.ts
 * computeStats — moved here by MERGE-2-a.
 */
export function computeSampleStatsFromSums(n: number, mean: number, sumSq: number): HistoricalStats {
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  return { mean: mean || 0, stdDev: Math.sqrt(variance), n };
}

/**
 * Compute sample stats (mean + sample stdDev + n) for an array of
 * observed values.
 *
 * - n = 0 → { mean: 0, stdDev: 0, n: 0 } (no division by zero).
 * - Sample variance with Bessel's correction (divide by n - 1),
 *   matching computeSampleStatsFromSums above and SQL STDDEV_SAMP.
 *   n <= 1 → variance 0.
 * - Math.max(0, ...): floating-point guard — the running sum of
 *   squared deviations can come out a tiny negative for constant
 *   data (true variance 0); clamp before Math.sqrt.
 *
 * Verbatim (body byte-identical) from queries/item-trend.ts
 * computeSampleStats — moved here by MERGE-2-a.
 */
export function computeSampleStats(values: number[]): HistoricalStats {
  const n = values.length;
  if (n === 0) return { mean: 0, stdDev: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1
    ? Math.max(0, values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0;
  return { mean, stdDev: Math.sqrt(variance), n };
}

/**
 * Default minimum number of same-week historical observations required
 * before a Z-Score is computed (PRD §5.2 — default 4 baseline weeks).
 *
 * Where the threshold comes from at runtime:
 * - Analysis pipeline (post-process-historical + metrics computeZScore):
 *   reads the RUNTIME override `getRuntimeThresholds().HISTORICAL_MIN_WEEKS`
 *   (Settings key 'HISTORICAL_MIN_WEEKS', default 4) — never hardcode 4
 *   there.
 * - queryItemTrendTimeline (queries/item-trend.ts): uses this CONSTANT.
 *   The query layer has no Settings access and its route does not read
 *   Settings — that ZEITGEIST is intentionally unchanged by MERGE-2-a
 *   (making the route Settings-aware would be a separate, deliberate
 *   task).
 */
export const HISTORICAL_MIN_WEEKS_DEFAULT = 4;
