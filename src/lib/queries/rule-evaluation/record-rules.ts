// ============================================================
//  GODSPLIT-W3-B: record-family rule evaluator — dipindah VERBATIM
//  dari rule-evaluation.ts (566 LOC; barrel: ./index.ts).
//  evaluateRulesSql: 19 rule record-grain (flags CTE + 2 LATERAL) +
//  RULE_MAP dengan priority ladder. Dua caveat audit GODSPLIT-A §3
//  ikut pindah BERSAMA kodenya:
//  1. Placeholder `hist` CTE ("WHERE 1=0") + komentar VERIFY-RULES —
//     tests/queries/rule-evaluation.test.ts ("uses prevFilter sentinel")
//     meng-assert teks literal "1=0" pada template strings query ini.
//  2. Komentar priority-ladder DEEP-WASTE-1-B (WASTE_ZERO_BIG_LOSS 81 >
//     HIGH_LOSS_NOMINAL 80; WASTE_RESIDUAL_DOMINANT 76 >
//     RESIDUAL_LOSS_HIGH 75) menempel pada entry RULE_MAP masing-masing.
//  Loop flag-expansion akhir fungsi diganti pemanggilan expandRuleFlags
//  (./shared.ts) — satu-satunya perubahan non-verbatim di file ini.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import type { RuntimeThresholds } from '@/lib/settings';
import { expandRuleFlags, type SqlRuleFlag } from './shared';

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
        ir."nominalWaste",
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
      THEN 1 ELSE 0 END as "f_bom_disproportionate",
      -- ===== DEEP-WASTE-1: 3 waste record rules (P2 of the offline deep
      -- waste analysis) =====
      -- WASTE_ZERO_BIG_LOSS: item rugi besar tapi waste ≈ 0 — waste tidak
      -- (belum) dicatat untuk kerugian sebesar itu.
      CASE WHEN ABS(COALESCE(c."nominalWaste", 0)) <= 1
        AND c."nominalLossSurplus" < -${thresholds.HIGH_LOSS_NOMINAL_THRESHOLD}
      THEN 1 ELSE 0 END as "f_waste_zero_big_loss",
      -- WASTE_SALES_UNDER_RECORD: item LOSS dengan waste < 0,1% dari sales
      -- record — indikasi under-recording waste.
      CASE WHEN c."nominalSales" > 0
        AND ABS(COALESCE(c."nominalWaste", 0)) < c."nominalSales" * 0.001
        AND c."nominalLossSurplus" < 0
      THEN 1 ELSE 0 END as "f_waste_under_record",
      -- WASTE_RESIDUAL_DOMINANT: residual tinggi DAN waste menjelaskan
      -- < 10% dari loss — "waste explains nothing" (beda dari
      -- RESIDUAL_LOSS_HIGH: menambah kondisi waste-share kecil).
      CASE WHEN c."nominalLossSurplus" < 0
        AND c."residualRatio" > ${thresholds.RESIDUAL_LOSS_HIGH_PCT}
        AND ABS(COALESCE(c."nominalWaste", 0)) < 0.1 * ABS(c."nominalLossSurplus")
      THEN 1 ELSE 0 END as "f_waste_residual_dominant"
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
      "f_waste_bom_mismatch", "f_susut_bom_mismatch", "f_trial_bom_mismatch", "f_bom_disproportionate",
      "f_waste_zero_big_loss", "f_waste_under_record", "f_waste_residual_dominant"
    FROM flags
    WHERE ("f_tol_breach_high" + "f_tol_breach" + "f_tol_not_set" + "f_over_explained"
      + "f_resid_high" + "f_resid_warn" + "f_high_loss" + "f_dir_flip"
      + "f_sales_mismatch" + "f_sales_decrease" + "f_bom_mismatch" + "f_bom_down_dev_up"
      + "f_waste_bom_mismatch" + "f_susut_bom_mismatch" + "f_trial_bom_mismatch"
      + "f_bom_disproportionate"
      + "f_waste_zero_big_loss" + "f_waste_under_record" + "f_waste_residual_dominant") > 0
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
    // DEEP-WASTE-1: the 3 waste record rules (rows without these columns —
    // e.g. older mocks — never fire: Number(undefined) = NaN ≠ 1).
    // DEEP-WASTE-1-B (priority fix): WASTE_ZERO_BIG_LOSS is a STRICT SUBSET of
    // HIGH_LOSS_NOMINAL (same |loss| > highLossNominalThreshold, plus waste ≈ 0),
    // so at its original 79 it could never win the top-flag race against
    // HIGH_LOSS_NOMINAL (80) — it fired but was invisible in byRule/byCategory
    // and per-record top flags. Bumped to 81: the SPECIFIC cause outranks the
    // generic one (same ladder convention as SALES_DEVIATION_MISMATCH 90 >
    // TOLERANCE_BREACH_HIGH 80). Same ABNORMAL severity → global severity
    // counts unchanged — pure re-bucketing out of HIGH_LOSS_NOMINAL.
    { col: 'f_waste_zero_big_loss', code: 'WASTE_ZERO_BIG_LOSS', severity: 'ABNORMAL', category: 'WASTE', priority: 81 },
    { col: 'f_waste_under_record', code: 'WASTE_SALES_UNDER_RECORD', severity: 'WARNING', category: 'WASTE', priority: 57 },
    // DEEP-WASTE-1-B (priority fix): strict subset of RESIDUAL_LOSS_HIGH
    // (75 / ABNORMAL — same loss<0 + residualRatio>high conditions, plus the
    // waste-share <10% clause), so at 59 it was always shadowed. 76 > 75
    // surfaces it; severity upgraded WARNING→ABNORMAL so the top-flag swap
    // never DOWNGRADES records that already counted abnormal via
    // RESIDUAL_LOSS_HIGH (severity totals preserved — pure re-bucketing).
    // Tie with OVER_EXPLAINED (76) is safe: the conditions are disjoint
    // (qty over-explanation vs nominal residual dominance) and both ABNORMAL.
    { col: 'f_waste_residual_dominant', code: 'WASTE_RESIDUAL_DOMINANT', severity: 'ABNORMAL', category: 'WASTE', priority: 76 },
  ];

  return expandRuleFlags(rows, RULE_MAP);
}
