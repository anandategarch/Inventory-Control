// ============================================================
//  Item Trend Timeline — per-item, per-period QTY fluctuation
//  --------------------------------------------------------
//  Returns ALL periods (monthLabel × weekLabel) for a given item
//  with ABS magnitude aggregates + SIGNED qtyDeviasi (for
//  direction display) + Z-Score per period using the SAME-week
//  baseline (cumulative weeks pattern: W4 Juli is compared vs
//  [W4 Mei, W4 Juni], NOT vs [W1, W2, W4 Mei, W1, W2, W4 Juni]).
//
//  This powers the NEW "Trend Item" tab — shows fluktuasi
//  (fluctuation) per item across all periods with QTY values
//  (not nominal), Z-Score, and historical baseline.
//
//  Z-Score formula (per PRD §5.2):
//    z = (|current| - mean(|others|)) / STDDEV_SAMP(|others|)
//  where "others" = periods with the SAME weekLabel, EXCLUDING
//  the current period (no leakage). Each period's Z-Score is
//  computed against the baseline of OTHER same-week periods.
//
//  SIGNED zScore (per src/lib/metrics/historical.ts calcZScoreFromStats):
//    - Positive = current magnitude ABOVE historical mean (worse)
//    - Negative = current magnitude BELOW historical mean (better)
//    - Zero     = current equals historical mean
//
//  Minimum sample size: 4 OTHER same-week periods
//  (HISTORICAL_MIN_WEEKS_DEFAULT — PRD §5.2). When the baseline has fewer
//  than 4 periods OR stdDev = 0, zScore is null (insufficient data).
//
//  Implementation notes:
//  - Uses `withStatementTimeout` (heavy aggregation across ALL
//    InventoryRecord rows for this item, similar to heatmap.ts).
//  - Uses `buildSqlFilters` for area/kelompok/outletCode/picOutletCodes.
//  - itemName is matched EXACTLY (i.name = ${itemName}) — the
//    dashboard's item picker selects from a precise list, and the
//    filter builder's LIKE would over-match (e.g. "CABAI" matches
//    "CABAI FROZEN" AND "CABAI MERAH"). So itemName is NOT passed
//    through SqlFilterOpts; it's applied directly in the WHERE clause.
//  - Uses Prisma.sql tagged templates (zero $queryRawUnsafe).
//  - Sorting: monthKey ASC + weekLabel ASC (chronological). Uses
//    MAX(sf."monthKey") since the GROUP BY is on (monthLabel,
//    weekLabel) and all rows for the same monthLabel share one
//    SourceFile.monthKey.
//  - Baseline window (AUDIT A2 / MERGE-2-a): computed in JS, NOT via
//    the shared SQL fragments in ../historical-baseline.ts — this query
//    returns ALL periods and the same-week grouping + self-exclusion
//    happen post-query (byWeek map below). There is no SQL window
//    predicate to share; see that module's header.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';
import { computeSampleStats, HISTORICAL_MIN_WEEKS_DEFAULT } from '@/lib/metrics/sample-stats';

export type ItemTrendMetric = 'qtyDeviasi' | 'qtyWaste' | 'qtySusut' | 'qtyTrial';

export interface ItemTrendPeriod {
  monthLabel: string;
  weekLabel: string;
  /** Sortable month key (e.g. "2026-07") from SourceFile — null if no SourceFile. */
  monthKey: string | null;
  /** FIX (SATUAN-BUG): item's unit of measure (e.g. "KG", "PCS", "LTR").
   *  Extracted via MAX(ir."satuan") — same unit across all records for 1 item.
   *  Used by Flip column/matrix tooltips to display the correct unit instead
   *  of hardcoded "kg" (which was wrong for non-KG items). */
  satuan: string | null;
  // ABS magnitude aggregates (for Z-Score + chart display)
  /** SUM(ABS(qtyBom)) — expected usage magnitude */
  qtyBom: number;
  /** SUM(ABS(qtyDeviasi)) — for Z-Score computation (magnitude) */
  qtyDeviasi: number;
  /** SUM(qtyDeviasi) — SIGNED for display (direction: <0 = LOSS, >0 = SURPLUS) */
  qtyDeviasiSigned: number;
  /** SUM(ABS(qtyWaste)) */
  qtyWaste: number;
  /** SUM(ABS(qtySusut)) */
  qtySusut: number;
  /** SUM(ABS(qtyTrial)) */
  qtyTrial: number;
  /** SUM(ABS(nominalDeviasi)) — for reference (chart uses QTY, not nominal) */
  nominalDeviasi: number;
  /** COUNT(DISTINCT outletId) — how many outlets had this item in this period */
  outletCount: number;
  /** COUNT(*) — number of underlying records aggregated */
  recordCount: number;
  // Z-Score (signed) for the selected metric — null when insufficient baseline
  zScore: number | null;
  // Historical baseline (computed from same-week OTHER periods)
  /** mean of ABS weekly values for selected metric */
  historicalMean: number;
  /** sample std dev (N-1, Bessel's correction) of ABS weekly values */
  historicalStdDev: number;
  /** n weeks of history (excluding current period) */
  sampleSize: number;
}

export interface ItemTrendResult {
  periods: ItemTrendPeriod[];
  metric: ItemTrendMetric;
}

// AUDIT A2 / MERGE-2-a: HISTORICAL_MIN_WEEKS moved to the shared module
// @/lib/metrics/sample-stats as HISTORICAL_MIN_WEEKS_DEFAULT (same value 4).
// This query layer intentionally uses the CONSTANT, not the Settings runtime
// value — only the analysis pipeline (post-process-historical via
// getRuntimeThresholds()) applies the runtime override; this route does not
// read Settings (ZEITGEIST unchanged by MERGE-2-a).

// Map metric → column accessor for Z-Score computation. All four metrics
// use ABS magnitude per PRD §5.2 (the value is already ABS in the aggregate).
function getMetricValue(p: ItemTrendPeriod, metric: ItemTrendMetric): number {
  switch (metric) {
    case 'qtyDeviasi': return p.qtyDeviasi;
    case 'qtyWaste': return p.qtyWaste;
    case 'qtySusut': return p.qtySusut;
    case 'qtyTrial': return p.qtyTrial;
  }
}

// AUDIT A2 / MERGE-2-a: computeSampleStats moved to the shared module
// @/lib/metrics/sample-stats — it was duplicated in queries/historical.ts
// (computeStats, SUM-SQ form) with identical Bessel-corrected semantics.

/**
 * Query the per-item, per-period trend timeline.
 *
 * Returns ALL periods (monthLabel × weekLabel) where this item appears,
 * with full QTY aggregates + Z-Score per period using the SAME-week
 * baseline (cumulative weeks pattern).
 *
 * @param itemName   Exact item name (e.g. "CABAI FROZEN") — matched via
 *                   `i.name = ${itemName}` (exact, not LIKE).
 * @param filters    Dashboard filters (area, kelompok, outletCode,
 *                   picOutletCodes). itemName in filters is IGNORED (the
 *                   explicit `itemName` arg takes precedence).
 * @param metric     Which QTY to Z-Score on (default: qtyDeviasi).
 */
export async function queryItemTrendTimeline(
  itemName: string,
  filters: SqlFilterOpts,
  metric: ItemTrendMetric = 'qtyDeviasi',
  weekLabel?: string | null,
): Promise<ItemTrendResult> {
  // NOTE: buildSqlFilters applies `itemName` as a LIKE filter (substring match),
  // which would over-match the trend query (e.g. "CABAI" matches both
  // "CABAI FROZEN" and "CABAI MERAH"). Strip itemName from filters and apply
  // an EXACT match (`i.name = ${itemName}`) in the WHERE clause below.
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  // Build week filter — if weekLabel provided, only show that week across all months
  // (e.g. WEEK 4 → show W4 of Januari, Februari, Maret, etc.)
  const weekFilter = weekLabel
    ? Prisma.sql`AND ir."weekLabel" = ${weekLabel}`
    : Prisma.empty;

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    monthLabel: string;
    weekLabel: string;
    monthKey: string | null;
    satuan: string | null;
    qtyBom: number;
    qtyDeviasi: number;
    qtyDeviasiSigned: number;
    qtyWaste: number;
    qtySusut: number;
    qtyTrial: number;
    nominalDeviasi: number;
    outletCount: number;
    recordCount: number;
  }>>`
    SELECT
      ir."monthLabel",
      ir."weekLabel",
      MAX(sf."monthKey") as "monthKey",
      MAX(ir."satuan") as "satuan",
      COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
      COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) as "qtyDeviasi",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasiSigned",
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "qtyWaste",
      COALESCE(SUM(ABS(ir."qtySusut")), 0) as "qtySusut",
      COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "qtyTrial",
      COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) as "nominalDeviasi",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      CAST(COUNT(*) AS INTEGER) as "recordCount"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    LEFT JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE i.name = ${itemName}
      ${f}
      ${weekFilter}
    GROUP BY ir."monthLabel", ir."weekLabel"
    ORDER BY MAX(sf."monthKey") ASC NULLS LAST, ir."weekLabel" ASC
  `);

  // Build the periods array (already sorted chronologically by SQL ORDER BY)
  const periods: ItemTrendPeriod[] = rows.map((r) => ({
    monthLabel: r.monthLabel,
    weekLabel: r.weekLabel,
    monthKey: r.monthKey ?? null,
    satuan: r.satuan ?? null,
    qtyBom: Number(r.qtyBom) || 0,
    qtyDeviasi: Number(r.qtyDeviasi) || 0,
    qtyDeviasiSigned: Number(r.qtyDeviasiSigned) || 0,
    qtyWaste: Number(r.qtyWaste) || 0,
    qtySusut: Number(r.qtySusut) || 0,
    qtyTrial: Number(r.qtyTrial) || 0,
    nominalDeviasi: Number(r.nominalDeviasi) || 0,
    outletCount: Number(r.outletCount) || 0,
    recordCount: Number(r.recordCount) || 0,
    zScore: null,
    historicalMean: 0,
    historicalStdDev: 0,
    sampleSize: 0,
  }));

  // Group periods by weekLabel (cumulative weeks: W4 vs W4, not W4 vs W1).
  // Per PRD §5.2 + historical.ts pattern, Z-Score baseline = same-week periods
  // EXCLUDING the current period (no leakage).
  const byWeek = new Map<string, ItemTrendPeriod[]>();
  for (const p of periods) {
    const arr = byWeek.get(p.weekLabel) ?? [];
    arr.push(p);
    byWeek.set(p.weekLabel, arr);
  }

  // Compute Z-Score per period using the same-week baseline (excluding self).
  // SIGNED zScore (positive = above mean = worse, negative = below = better)
  // per src/lib/metrics/historical.ts calcZScoreFromStats convention.
  for (const p of periods) {
    const sameWeekPeriods = byWeek.get(p.weekLabel) ?? [];
    const baselineValues = sameWeekPeriods
      .filter((q) => q !== p)
      .map((q) => Math.abs(getMetricValue(q, metric)));

    const stats = computeSampleStats(baselineValues);
    p.historicalMean = stats.mean;
    p.historicalStdDev = stats.stdDev;
    p.sampleSize = stats.n;

    if (stats.n >= HISTORICAL_MIN_WEEKS_DEFAULT && stats.stdDev > 0) {
      const currentAbs = Math.abs(getMetricValue(p, metric));
      p.zScore = (currentAbs - stats.mean) / stats.stdDev;
    } else {
      p.zScore = null;
    }
  }

  return { periods, metric };
}
