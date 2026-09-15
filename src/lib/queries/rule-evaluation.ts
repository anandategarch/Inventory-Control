// ============================================================
//  SQL Rule Evaluation — pushes 16 rule checks to PostgreSQL.
//  Production total: 16 SQL + 3 zScore SQL = 19 rules.
//
//  Returns: array of { outletId, itemId, akunPenyesuaian, ruleCode,
//    severity, category, priority } — one row per fired rule per record.
//
//  The query uses:
//  - CTE for current records (filtered by month/week/area/outlet/item/PIC)
//  - LATERAL JOIN for prev period records (same outlet+item+akun)
//  - LATERAL JOIN for historical stats (mean, stddev, n)
//  - CASE WHEN for each of 16 SQL rules
//  - UNNEST(ARRAY[...]) to produce one row per fired rule
//
//  Performance: single query, ~2-3s (was 6-8s with 35K record load + JS loop)
//
//  FIX (AUDIT-PERF-3): only flagged rows transferred to Node (~10x less
//  egress). The main SELECT is wrapped in a `flags` CTE and the outer query
//  filters to rows where at least one of the 16 f_* columns is 1. Previously
//  ALL current-period rows (~10-35K × 19 columns) were shipped to Node and
//  the JS RULE_MAP loop skipped the zero-flag rows anyway — only flagged
//  rows drive worklist/priorities/health counts (verified consumers:
//  analysis post-process-flags.ts + export-report data-fetcher.ts/docx-
//  builder.ts — the normal/warning/abnormal denominators come from
//  queryOutletHealthRanking's zeroDevCount/nonZeroDevCount, NOT from these
//  rows), so the filter is semantics-preserving.
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';
import type { RuntimeThresholds } from '@/lib/settings';

export interface SqlRuleFlag {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
  ruleCode: string;
  severity: string;
  category: string;
  priority: number;
}

export async function evaluateRulesSql(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
  thresholds: RuntimeThresholds,
): Promise<SqlRuleFlag[]> {
  const f = buildSqlFilters(filters);
  const hasPrev = prevWeek && prevMonth;

  // Prev period filter (if no prev, use a sentinel that matches nothing)
  const prevFilter = hasPrev
    ? Prisma.sql`AND ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}`
    : Prisma.sql`AND 1=0`;

  // DEEP-AUDIT-BACKEND C4: wrap in withStatementTimeout — LATERAL joins on 35K rows.
  // FIX (AUDIT-PERF-3): wrap the row-returning SELECT in a `flags` CTE and filter
  // to rows with at least one fired rule (sum of the 16 INT 0/1 flag columns > 0).
  // Each flag column is a CASE WHEN ... THEN 1 ELSE 0 END — never NULL — so the
  // plain sum is safe. All flag expressions + LATERAL joins are preserved
  // verbatim inside the CTE; only rows with zero fired rules are dropped
  // (the JS RULE_MAP loop below never produced flags for those rows anyway).
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<SqlRuleFlag[]>`
    WITH curr AS (
      SELECT ir."outletId", ir."itemId", ir."akunPenyesuaian",
        ir."qtyBom", ir."qtyDeviasi", ir."qtyWaste", ir."qtySusut", ir."qtyTrial",
        ir."qtyLossSurplus", ir."nominalDeviasi", ir."nominalLossSurplus", ir."nominalSales",
        ir."absNominalDeviasi", ir."absQtyDeviasi",
        ir."absNominalLossSurplus", ir."absQtyLossSurplus",
        ir."pctQtyDeviasiToBom", ir."tolerancePct",
        ir."residualQty", ir."residualRatio",
        ir."direction"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
    ),
    prev AS (
      SELECT ir."outletId", ir."itemId", ir."akunPenyesuaian",
        ir."qtyBom", ir."qtyDeviasi", ir."nominalDeviasi", ir."nominalSales",
        ir."nominalLossSurplus", ir."qtyLossSurplus",
        ir."qtyWaste", ir."qtySusut", ir."qtyTrial"
      FROM "InventoryRecord" ir
      WHERE 1=1
        ${prevFilter}
        ${f}
    ),
    -- Historical stats per outlet+item (for zScore): NOT computed in this
    -- query — the 3 zScore rules (HISTORICAL_ABNORMAL / _SURPLUS / WARNING)
    -- are evaluated by evaluateHistoricalRulesSql below (SQL push-down since
    -- PERF TAHAP-2/P2-7, which replaced the old JS post-process loop over a
    -- pre-fetched historicalByOutletItem stats Map). The placeholder CTE
    -- below is a no-op (WHERE 1=0; never referenced by the flags CTE or the
    -- outer SELECT). NOTE (VERIFY-RULES audit): it is kept because
    -- tests/queries/rule-evaluation.test.ts ("uses prevFilter sentinel")
    -- asserts the literal "1=0" text in the template strings — the real
    -- prevFilter sentinel "AND 1=0" is a Prisma.sql VALUE that does not
    -- surface in that template-string join, so this placeholder is what the
    -- assertion actually matches. Removing it requires updating that test
    -- to inspect the interpolated values instead.
    hist AS (
      SELECT hs."outletId", hs."itemId", hs.mean, hs."stdDev", hs.n
      FROM (
        SELECT NULL::int as "outletId", NULL::int as "itemId",
               NULL::float as mean, NULL::float as "stdDev", 0 as n
        WHERE 1=0
      ) hs
    ),
    flags AS (
    SELECT
      c."outletId", c."itemId", c."akunPenyesuaian",
      -- Return all flag columns as booleans — JS post-processing builds the flag array
      CASE WHEN c."tolerancePct" IS NOT NULL AND ABS(c."pctQtyDeviasiToBom") > 2 * ABS(c."tolerancePct") THEN 1 ELSE 0 END as "f_tol_breach_high",
      CASE WHEN c."tolerancePct" IS NOT NULL AND ABS(c."pctQtyDeviasiToBom") > ABS(c."tolerancePct") THEN 1 ELSE 0 END as "f_tol_breach",
      CASE WHEN c."tolerancePct" IS NULL AND ABS(c."pctQtyDeviasiToBom") > ${thresholds.STD_DEVIASI_BOM_PCT} THEN 1 ELSE 0 END as "f_tol_not_set",
      CASE WHEN ABS(COALESCE(c."qtyWaste",0)) + ABS(COALESCE(c."qtySusut",0)) + ABS(COALESCE(c."qtyTrial",0)) > ABS(c."qtyDeviasi") AND ABS(c."qtyDeviasi") > 0 THEN 1 ELSE 0 END as "f_over_explained",
      CASE WHEN c."nominalLossSurplus" < 0 AND c."residualRatio" > ${thresholds.RESIDUAL_LOSS_HIGH_PCT} THEN 1 ELSE 0 END as "f_resid_high",
      CASE WHEN c."nominalLossSurplus" < 0 AND c."residualRatio" > ${thresholds.RESIDUAL_LOSS_WARN_PCT} AND c."residualRatio" <= ${thresholds.RESIDUAL_LOSS_HIGH_PCT} THEN 1 ELSE 0 END as "f_resid_warn",
      CASE WHEN c."nominalLossSurplus" < 0 AND ABS(c."nominalLossSurplus") > ${thresholds.HIGH_LOSS_NOMINAL_THRESHOLD} THEN 1 ELSE 0 END as "f_high_loss",
      -- FIX (BUG2-PARETO-9): DIRECTION_FLIP divergence between SQL and JS paths.
      -- Old SQL: only used nominalLossSurplus for direction → missed flips when
      -- nominalLossSurplus IS NULL but qtyDeviasi IS NOT NULL.
      -- JS path (ruleService.ts:68-86) falls back from nominalLossSurplus to qtyDeviasi.
      -- Fix: compute direction sign with COALESCE fallback, matching JS behavior.
      CASE
        WHEN
          -- Compute current direction sign: nominalLossSurplus first, fallback to qtyDeviasi
          COALESCE(
            CASE WHEN c."nominalLossSurplus" IS NOT NULL THEN SIGN(c."nominalLossSurplus") END,
            CASE WHEN c."qtyDeviasi" IS NOT NULL THEN SIGN(c."qtyDeviasi") END
          ) IS NOT NULL
          AND
          -- Compute previous direction sign: same fallback
          COALESCE(
            CASE WHEN p."prevNominalLossSurplus" IS NOT NULL THEN SIGN(p."prevNominalLossSurplus") END,
            CASE WHEN p."prevQtyDeviasi" IS NOT NULL THEN SIGN(p."prevQtyDeviasi") END
          ) IS NOT NULL
          AND
          -- Both must be non-zero (NEUTRAL = 0 → no flip)
          COALESCE(CASE WHEN c."nominalLossSurplus" IS NOT NULL THEN SIGN(c."nominalLossSurplus") END, CASE WHEN c."qtyDeviasi" IS NOT NULL THEN SIGN(c."qtyDeviasi") END) != 0
          AND
          COALESCE(CASE WHEN p."prevNominalLossSurplus" IS NOT NULL THEN SIGN(p."prevNominalLossSurplus") END, CASE WHEN p."prevQtyDeviasi" IS NOT NULL THEN SIGN(p."prevQtyDeviasi") END) != 0
          AND
          -- Signs must differ (one positive, one negative)
          COALESCE(CASE WHEN c."nominalLossSurplus" IS NOT NULL THEN SIGN(c."nominalLossSurplus") END, CASE WHEN c."qtyDeviasi" IS NOT NULL THEN SIGN(c."qtyDeviasi") END)
          !=
          COALESCE(CASE WHEN p."prevNominalLossSurplus" IS NOT NULL THEN SIGN(p."prevNominalLossSurplus") END, CASE WHEN p."prevQtyDeviasi" IS NOT NULL THEN SIGN(p."prevQtyDeviasi") END)
        THEN 1 ELSE 0 END as "f_dir_flip",
      CASE WHEN g."salesGrowth" IS NOT NULL AND g."salesGrowth" > 0 AND g."nominalDeviasiGrowth" IS NOT NULL AND g."nominalDeviasiGrowth" > g."salesGrowth" * ${thresholds.SALES_DEVIATION_FACTOR} THEN 1 ELSE 0 END as "f_sales_mismatch",
      CASE WHEN g."salesGrowth" IS NOT NULL AND g."salesGrowth" < 0 AND g."nominalDeviasiGrowth" IS NOT NULL AND g."nominalDeviasiGrowth" > 0 THEN 1 ELSE 0 END as "f_sales_decrease",
      CASE WHEN g."bomGrowth" IS NOT NULL AND g."bomGrowth" > 0 AND g."qtyDeviasiGrowth" IS NOT NULL AND g."qtyDeviasiGrowth" > g."bomGrowth" * ${thresholds.BOM_DEVIATION_FACTOR} THEN 1 ELSE 0 END as "f_bom_mismatch",
      CASE WHEN g."bomGrowth" IS NOT NULL AND g."bomGrowth" < 0 AND g."qtyDeviasiGrowth" IS NOT NULL AND g."qtyDeviasiGrowth" > 0 THEN 1 ELSE 0 END as "f_bom_down_dev_up",
      -- BOM Correlation rules
      CASE WHEN g."bomGrowth" IS NOT NULL AND g."wasteGrowth" IS NOT NULL AND
        ((g."bomGrowth" < 0 AND g."wasteGrowth" > 0) OR (g."bomGrowth" > 0 AND g."wasteGrowth" < 0))
      THEN 1 ELSE 0 END as "f_waste_bom_mismatch",
      CASE WHEN g."bomGrowth" IS NOT NULL AND g."susutGrowth" IS NOT NULL AND
        ((g."bomGrowth" < 0 AND g."susutGrowth" > 0) OR (g."bomGrowth" > 0 AND g."susutGrowth" < 0))
      THEN 1 ELSE 0 END as "f_susut_bom_mismatch",
      CASE WHEN g."bomGrowth" IS NOT NULL AND g."trialGrowth" IS NOT NULL AND
        ((g."bomGrowth" < 0 AND g."trialGrowth" > 0) OR (g."bomGrowth" > 0 AND g."trialGrowth" < 0))
      THEN 1 ELSE 0 END as "f_trial_bom_mismatch",
      CASE WHEN g."bomGrowth" IS NOT NULL AND g."bomGrowth" > 0 AND g."qtyDeviasiGrowth" IS NOT NULL AND g."qtyDeviasiGrowth" > 0
        AND g."qtyDeviasiGrowth" > g."bomGrowth" * ${thresholds.BOM_DISPROPORTIONATE_FACTOR}
      THEN 1 ELSE 0 END as "f_bom_disproportionate"
    FROM curr c
    LEFT JOIN LATERAL (
      SELECT p."qtyBom" as "prevQtyBom", p."qtyDeviasi" as "prevQtyDeviasi",
             p."nominalDeviasi" as "prevNominalDeviasi", p."nominalSales" as "prevNominalSales",
             p."nominalLossSurplus" as "prevNominalLossSurplus",
             p."qtyWaste" as "prevQtyWaste", p."qtySusut" as "prevQtySusut", p."qtyTrial" as "prevQtyTrial"
      FROM prev p
      WHERE p."outletId" = c."outletId" AND p."itemId" = c."itemId"
        AND p."akunPenyesuaian" IS NOT DISTINCT FROM c."akunPenyesuaian"
      LIMIT 1
    ) p ON true
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN p."prevNominalSales" IS NOT NULL AND p."prevNominalSales" != 0
          THEN (c."nominalSales" - p."prevNominalSales") / ABS(p."prevNominalSales")
          ELSE NULL END as "salesGrowth",
        CASE WHEN p."prevQtyBom" IS NOT NULL AND p."prevQtyBom" != 0
          THEN (ABS(c."qtyBom") - ABS(p."prevQtyBom")) / ABS(p."prevQtyBom")
          ELSE NULL END as "bomGrowth",
        CASE WHEN p."prevQtyDeviasi" IS NOT NULL AND p."prevQtyDeviasi" != 0
          THEN (ABS(c."qtyDeviasi") - ABS(p."prevQtyDeviasi")) / ABS(p."prevQtyDeviasi")
          ELSE NULL END as "qtyDeviasiGrowth",
        CASE WHEN p."prevNominalDeviasi" IS NOT NULL AND p."prevNominalDeviasi" != 0
          THEN (ABS(c."nominalDeviasi") - ABS(p."prevNominalDeviasi")) / ABS(p."prevNominalDeviasi")
          ELSE NULL END as "nominalDeviasiGrowth",
        -- BOM Correlation: growth of waste/susut/trial
        CASE WHEN p."prevQtyWaste" IS NOT NULL AND p."prevQtyWaste" != 0
          THEN (ABS(c."qtyWaste") - ABS(p."prevQtyWaste")) / ABS(p."prevQtyWaste")
          ELSE NULL END as "wasteGrowth",
        CASE WHEN p."prevQtySusut" IS NOT NULL AND p."prevQtySusut" != 0
          THEN (ABS(c."qtySusut") - ABS(p."prevQtySusut")) / ABS(p."prevQtySusut")
          ELSE NULL END as "susutGrowth",
        CASE WHEN p."prevQtyTrial" IS NOT NULL AND p."prevQtyTrial" != 0
          THEN (ABS(c."qtyTrial") - ABS(p."prevQtyTrial")) / ABS(p."prevQtyTrial")
          ELSE NULL END as "trialGrowth"
    ) g
    -- (ORDER BY moved to the outer query — it governs the final row order)
    )
    SELECT
      "outletId", "itemId", "akunPenyesuaian",
      "f_tol_breach_high", "f_tol_breach", "f_tol_not_set", "f_over_explained",
      "f_resid_high", "f_resid_warn", "f_high_loss", "f_dir_flip",
      "f_sales_mismatch", "f_sales_decrease", "f_bom_mismatch", "f_bom_down_dev_up",
      "f_waste_bom_mismatch", "f_susut_bom_mismatch", "f_trial_bom_mismatch", "f_bom_disproportionate"
    FROM flags
    WHERE ("f_tol_breach_high" + "f_tol_breach" + "f_tol_not_set" + "f_over_explained"
      + "f_resid_high" + "f_resid_warn" + "f_high_loss" + "f_dir_flip"
      + "f_sales_mismatch" + "f_sales_decrease" + "f_bom_mismatch" + "f_bom_down_dev_up"
      + "f_waste_bom_mismatch" + "f_susut_bom_mismatch" + "f_trial_bom_mismatch"
      + "f_bom_disproportionate") > 0
    ORDER BY "outletId", "itemId"
  `);

  // Convert boolean columns to SqlRuleFlag[]
  const RULE_MAP: Array<{ col: string; code: string; severity: string; category: string; priority: number }> = [
    { col: 'f_tol_breach_high', code: 'TOLERANCE_BREACH_HIGH', severity: 'ABNORMAL', category: 'TOLERANCE', priority: 80 },
    { col: 'f_tol_breach', code: 'TOLERANCE_BREACH', severity: 'WARNING', category: 'TOLERANCE', priority: 70 },
    { col: 'f_tol_not_set', code: 'TOLERANCE_NOT_SET_HIGH_DEV', severity: 'WARNING', category: 'TOLERANCE', priority: 65 },
    { col: 'f_over_explained', code: 'OVER_EXPLAINED', severity: 'ABNORMAL', category: 'RESIDUAL', priority: 76 },
    { col: 'f_resid_high', code: 'RESIDUAL_LOSS_HIGH', severity: 'ABNORMAL', category: 'RESIDUAL', priority: 75 },
    { col: 'f_resid_warn', code: 'RESIDUAL_LOSS_WARN', severity: 'WARNING', category: 'RESIDUAL', priority: 60 },
    { col: 'f_high_loss', code: 'HIGH_LOSS_NOMINAL', severity: 'ABNORMAL', category: 'DIRECTION', priority: 80 },
    { col: 'f_dir_flip', code: 'DIRECTION_FLIP', severity: 'WARNING', category: 'HISTORICAL', priority: 60 },
    { col: 'f_sales_mismatch', code: 'SALES_DEVIATION_MISMATCH', severity: 'ABNORMAL', category: 'SALES', priority: 90 },
    { col: 'f_sales_decrease', code: 'SALES_DEV_DECREASE', severity: 'ABNORMAL', category: 'SALES', priority: 85 },
    { col: 'f_bom_mismatch', code: 'BOM_DEVIATION_MISMATCH', severity: 'ABNORMAL', category: 'BOM', priority: 88 },
    { col: 'f_bom_down_dev_up', code: 'BOM_DOWN_DEV_UP', severity: 'ABNORMAL', category: 'BOM', priority: 82 },
    { col: 'f_waste_bom_mismatch', code: 'WASTE_BOM_MISMATCH', severity: 'WARNING', category: 'BOM', priority: 55 },
    { col: 'f_susut_bom_mismatch', code: 'SUSUT_BOM_MISMATCH', severity: 'WARNING', category: 'BOM', priority: 54 },
    { col: 'f_trial_bom_mismatch', code: 'TRIAL_BOM_MISMATCH', severity: 'WARNING', category: 'BOM', priority: 53 },
    { col: 'f_bom_disproportionate', code: 'BOM_DEVIATION_DISPROPORTIONATE', severity: 'WARNING', category: 'BOM', priority: 56 },
  ];

  const flags: SqlRuleFlag[] = [];
  for (const row of rows) {
    for (const rule of RULE_MAP) {
      if (Number(row[rule.col as keyof typeof row]) === 1) {
        flags.push({
          outletId: row.outletId,
          itemId: row.itemId,
          akunPenyesuaian: row.akunPenyesuaian,
          ruleCode: rule.code,
          severity: rule.severity,
          category: rule.category,
          priority: rule.priority,
        });
      }
    }
  }
  return flags;
}

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

  const flags: SqlRuleFlag[] = [];
  for (const row of rows) {
    for (const rule of HIST_RULE_MAP) {
      if (Number(row[rule.col]) === 1) {
        flags.push({
          outletId: row.outletId,
          itemId: row.itemId,
          akunPenyesuaian: row.akunPenyesuaian,
          ruleCode: rule.code,
          severity: rule.severity,
          category: 'HISTORICAL',
          priority: rule.priority,
        });
      }
    }
  }
  return flags;
}
