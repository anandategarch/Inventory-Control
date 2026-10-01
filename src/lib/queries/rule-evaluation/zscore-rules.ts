// ============================================================
//  GODSPLIT-W3-B: zScore-family rule evaluators — dipindah VERBATIM
//  dari rule-evaluation.ts (566 LOC; barrel: ./index.ts).
//  evaluateHistoricalRulesSql (3 rule zScore devBom, PERF TAHAP-2/P2-7)
//  + evaluateWasteRulesSql (WASTE_SPIKE_2SIGMA, DEEP-WASTE-1).
//
//  NOTE (twins sengaja TIDAK didedupe — detail di ./shared.ts): kedua
//  fungsi memakai bentuk CTE hist+stats metric-swapped
//  (weeklyDevBom/weekly_dev vs weeklyWasteBom/weekly_waste). CTE
//  `stats` identik byte-per-byte antar keduanya, tapi mengekstraknya
//  jadi fragmen Prisma.sql ter-interpolasi menghilangkan teksnya dari
//  template strings yang di-assert test ('SQRT(GREATEST(0, ...))') —
//  jadi kedua salinan tetap inline verbatim di file ini.
//
//  Loop flag-expansion akhir kedua fungsi diganti pemanggilan
//  expandRuleFlags (./shared.ts, category tetap 'HISTORICAL' / 'WASTE')
//  — satu-satunya perubahan non-verbatim di file ini.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import type { RuntimeThresholds } from '@/lib/settings';
import { expandRuleFlags, type SqlRuleFlag } from './shared';

// ============================================================
//  HISTO (P2-7): zScore rules — SQL push-down
//  --------------------------------------------------------
//  Replaces evaluateHistoricalRulesJs, which required fetching the ENTIRE
//  current period as currSlim (5 columns × ~35K rows ≈ 700KB to Node) just
//  to loop over it in JS and look up pre-fetched stats in a Map. Only 3
//  rules consumed that data (HISTORICAL_ABNORMAL / _SURPLUS / WARNING) —
//  now they are computed in ONE SQL query that joins the current period
//  against an inline historical-baseline CTE (same weekly_dev structure
//  as queryHistoricalStatsMultiMetric, devBom metric only).
//
//  Semantics parity with the old JS loop:
//    - baseline = per (outlet, item) mean/stdDev/n of the WEEKLY
//      devBom ratio over `historicalPeriods` (same weekLabel, prior months),
//      with the same filters `f` applied — identical to the stats map that
//      queryHistoricalStatsMultiMetric produced (AVG ignores NULL weeks;
//      variance = GREATEST(0, (sumSq - n·mean²)/(n-1)) with n>1, else 0 —
//      the same formula computeStats used, evaluated server-side).
//    - a record is evaluated when: pctQtyDeviasiToBom IS NOT NULL
//      (ZS-05), stdDev > 0 and n >= HISTORICAL_MIN_WEEKS.
//    - zScore = (ABS(pctQtyDeviasiToBom) - mean) / stdDev (signed z, only
//      positive z fires — "current worse than historical").
//    - HISTORICAL_ABNORMAL       : COALESCE(nls,0) < 0 AND z > zHigh
//    - HISTORICAL_ABNORMAL_SURPLUS: COALESCE(nls,0) > 0 AND z > zHigh
//    - HISTORICAL_WARNING        : z > zWarn AND z <= zHigh
//      (EVAL-10 defaults: warn 1.5, high 2, minWeeks 4 — same fallbacks.)
//  Only flagged rows egress (typically tens — vs the 35K the JS loop needed).
//
//  NOTE: float addition order inside SUM can differ between this query and
//  the stats-map query (different GROUP BY shapes) — a zScore may differ in
//  the ~1e-15 relative range, which can only matter at an exact threshold
//  boundary. Accepted (documented) deviation from the JS path.
// ============================================================
export async function evaluateHistoricalRulesSql(
  week: string,
  month: string,
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts,
  thresholds: RuntimeThresholds,
): Promise<SqlRuleFlag[]> {
  if (historicalPeriods.length === 0) return [];

  const f = buildSqlFilters(filters);
  // EVAL-10 FIX defaults — identical to the old JS fallbacks.
  const minWeeks = thresholds.HISTORICAL_MIN_WEEKS ?? 4;
  const zWarn = thresholds.HISTORICAL_ZSCORE_WARN ?? 1.5;
  const zHigh = thresholds.HISTORICAL_ZSCORE_HIGH ?? 2;

  const periodConditions = historicalPeriods.map((p) =>
    Prisma.sql`(ir."monthLabel" = ${p.monthLabel} AND ir."weekLabel" = ${p.weekLabel})`
  );
  const periodFilter = Prisma.join(periodConditions, ' OR ');

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    outletId: number;
    itemId: number;
    akunPenyesuaian: string | null;
    f_hist_abnormal: number;
    f_hist_abnormal_surplus: number;
    f_hist_warning: number;
  }>>`
    WITH weekly_dev AS (
      SELECT ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "weeklyDevBom"
      FROM "InventoryRecord" ir
      WHERE (${periodFilter})
        ${f}
      GROUP BY ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel"
    ),
    hist AS (
      SELECT "outletId", "itemId",
        AVG("weeklyDevBom") as "mean",
        SUM("weeklyDevBom" * "weeklyDevBom") as "sumSq",
        CAST(COUNT("weeklyDevBom") AS INTEGER) as n
      FROM weekly_dev
      GROUP BY "outletId", "itemId"
    ),
    stats AS (
      SELECT "outletId", "itemId", "mean", n,
        CASE WHEN n > 1
          THEN SQRT(GREATEST(0, ("sumSq" - n * "mean" * "mean") / (n - 1)))
          ELSE 0 END as "stdDev"
      FROM hist
    ),
    curr AS (
      SELECT ir."outletId", ir."itemId", ir."akunPenyesuaian",
        ir."nominalLossSurplus", ir."pctQtyDeviasiToBom"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
    ),
    z AS (
      SELECT c."outletId", c."itemId", c."akunPenyesuaian",
        (ABS(c."pctQtyDeviasiToBom") - s."mean") / s."stdDev" as "zScore",
        COALESCE(c."nominalLossSurplus", 0) as "nls"
      FROM curr c
      JOIN stats s
        ON s."outletId" = c."outletId" AND s."itemId" = c."itemId"
      WHERE c."pctQtyDeviasiToBom" IS NOT NULL
        AND s."stdDev" > 0
        AND s.n >= ${minWeeks}
    )
    SELECT "outletId", "itemId", "akunPenyesuaian",
      CASE WHEN "nls" < 0 AND "zScore" > ${zHigh} THEN 1 ELSE 0 END as "f_hist_abnormal",
      CASE WHEN "nls" > 0 AND "zScore" > ${zHigh} THEN 1 ELSE 0 END as "f_hist_abnormal_surplus",
      CASE WHEN "zScore" > ${zWarn} AND "zScore" <= ${zHigh} THEN 1 ELSE 0 END as "f_hist_warning"
    FROM z
    WHERE (CASE WHEN "nls" < 0 AND "zScore" > ${zHigh} THEN 1 ELSE 0 END)
      + (CASE WHEN "nls" > 0 AND "zScore" > ${zHigh} THEN 1 ELSE 0 END)
      + (CASE WHEN "zScore" > ${zWarn} AND "zScore" <= ${zHigh} THEN 1 ELSE 0 END) > 0
    ORDER BY "outletId", "itemId"
  `);

  const HIST_RULE_MAP: Array<{ col: 'f_hist_abnormal' | 'f_hist_abnormal_surplus' | 'f_hist_warning'; code: string; severity: string; priority: number }> = [
    { col: 'f_hist_abnormal', code: 'HISTORICAL_ABNORMAL', severity: 'ABNORMAL', priority: 78 },
    { col: 'f_hist_abnormal_surplus', code: 'HISTORICAL_ABNORMAL_SURPLUS', severity: 'ABNORMAL', priority: 77 },
    { col: 'f_hist_warning', code: 'HISTORICAL_WARNING', severity: 'WARNING', priority: 58 },
  ];

  return expandRuleFlags(rows, HIST_RULE_MAP, 'HISTORICAL');
}

// ============================================================
//  DEEP-WASTE-1: WASTE_SPIKE_2SIGMA — waste z-score vs own
//  history, SQL push-down
//  --------------------------------------------------------
//  The "spike waste > 2σ" P2 rule from the offline deep waste
//  analysis, at RECORD grain (so it flows into the existing
//  anomaly surfaces — analysis payload flags, recommendations,
//  PDF anomali section — exactly like the 3 zScore rules above).
//  Same shape as evaluateHistoricalRulesSql with the METRIC
//  swapped: baseline = per (outlet, item) mean/stdDev/n of the
//  WEEKLY waste ratio (SUM(ABS(qtyWaste)) / SUM(ABS(qtyBom)),
//  same weekLabel, prior months, same filters), and the current
//  value is the record's own ABS(qtyWaste)/ABS(qtyBom) ratio.
//  A record is evaluated when:
//    - qtyWaste IS NOT NULL AND ABS(qtyWaste) > 0 (waste exists),
//    - ABS(qtyBom) > 0 (ratio computable),
//    - stdDev > 0 AND n >= HISTORICAL_MIN_WEEKS.
//  Only the z > zHigh tier fires (ABNORMAL) — a single rule code
//  per the DEEP-WASTE-1 plan (the network-level 2σ detector for
//  waste/sales per outlet lives in waste-series.ts).
// ============================================================
export async function evaluateWasteRulesSql(
  week: string,
  month: string,
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts,
  thresholds: RuntimeThresholds,
): Promise<SqlRuleFlag[]> {
  if (historicalPeriods.length === 0) return [];

  const f = buildSqlFilters(filters);
  // EVAL-10 FIX defaults — identical to the zScore rules above.
  const minWeeks = thresholds.HISTORICAL_MIN_WEEKS ?? 4;
  const zHigh = thresholds.HISTORICAL_ZSCORE_HIGH ?? 2;

  const periodConditions = historicalPeriods.map((p) =>
    Prisma.sql`(ir."monthLabel" = ${p.monthLabel} AND ir."weekLabel" = ${p.weekLabel})`
  );
  const periodFilter = Prisma.join(periodConditions, ' OR ');

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    outletId: number;
    itemId: number;
    akunPenyesuaian: string | null;
    f_waste_spike: number;
  }>>`
    WITH weekly_waste AS (
      SELECT ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyWaste")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "weeklyWasteBom"
      FROM "InventoryRecord" ir
      WHERE (${periodFilter})
        ${f}
      GROUP BY ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel"
    ),
    hist AS (
      SELECT "outletId", "itemId",
        AVG("weeklyWasteBom") as "mean",
        SUM("weeklyWasteBom" * "weeklyWasteBom") as "sumSq",
        CAST(COUNT("weeklyWasteBom") AS INTEGER) as n
      FROM weekly_waste
      GROUP BY "outletId", "itemId"
    ),
    stats AS (
      SELECT "outletId", "itemId", "mean", n,
        CASE WHEN n > 1
          THEN SQRT(GREATEST(0, ("sumSq" - n * "mean" * "mean") / (n - 1)))
          ELSE 0 END as "stdDev"
      FROM hist
    ),
    curr AS (
      SELECT ir."outletId", ir."itemId", ir."akunPenyesuaian",
        CASE WHEN ABS(ir."qtyBom") > 0
          THEN ABS(ir."qtyWaste") / ABS(ir."qtyBom")
          ELSE NULL END as "recordWasteBom"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."qtyWaste" IS NOT NULL AND ABS(ir."qtyWaste") > 0
        ${f}
    ),
    z AS (
      SELECT c."outletId", c."itemId", c."akunPenyesuaian",
        (c."recordWasteBom" - s."mean") / s."stdDev" as "zScore"
      FROM curr c
      JOIN stats s
        ON s."outletId" = c."outletId" AND s."itemId" = c."itemId"
      WHERE c."recordWasteBom" IS NOT NULL
        AND s."stdDev" > 0
        AND s.n >= ${minWeeks}
    )
    SELECT "outletId", "itemId", "akunPenyesuaian",
      CASE WHEN "zScore" > ${zHigh} THEN 1 ELSE 0 END as "f_waste_spike"
    FROM z
    WHERE (CASE WHEN "zScore" > ${zHigh} THEN 1 ELSE 0 END) > 0
    ORDER BY "outletId", "itemId"
  `);

  const WASTE_RULE_MAP: Array<{ col: 'f_waste_spike'; code: string; severity: string; priority: number }> = [
    { col: 'f_waste_spike', code: 'WASTE_SPIKE_2SIGMA', severity: 'ABNORMAL', priority: 74 },
  ];

  return expandRuleFlags(rows, WASTE_RULE_MAP, 'WASTE');
}
