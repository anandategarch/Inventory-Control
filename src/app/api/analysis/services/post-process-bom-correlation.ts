// ============================================================
//  post-process-bom-correlation — Sub-steps 1b + 1c
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    1b. fetchBomCorrelationDetails — fresh SQL fetch of per-record growth
//        values for the (outletId, itemId, akunPenyesuaian) tuples that
//        fired any BOM rule. Bounded to ~50 rows by the slice.
//    1c. buildBomCorrelationFindings — orchestrator that filters sqlFlags
//        for BOM category, slices top 50 by priority, joins each flag to
//        its detail row (if any), and computes per-rule counts.
//
//  Mirrors the rule-evaluation.ts CTE shape: curr LEFT JOIN LATERAL prev,
//  with ABS() growth magnitude and div-by-zero guards.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '@/lib/queries/shared';
import type { SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { BomCorrelationFinding, BomCorrelationCounts } from './post-process-types';

interface BomDetailRow {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
  outletName: string;
  // NAVLINK-1 (B1): outlet code for the drill-down link (o.code).
  outletCode: string | null;
  itemName: string;
  bomGrowth: number | null;
  wasteGrowth: number | null;
  susutGrowth: number | null;
  trialGrowth: number | null;
  qtyDeviasiGrowth: number | null;
}

/**
 * Helper — pick the relevant per-metric growth for a given BOM rule.
 * - WASTE_BOM_MISMATCH       → wasteGrowth
 * - SUSUT_BOM_MISMATCH       → susutGrowth
 * - TRIAL_BOM_MISMATCH       → trialGrowth
 * - BOM_DEVIATION_DISPROPORTIONATE → qtyDeviasiGrowth
 * - BOM_DEVIATION_MISMATCH   → qtyDeviasiGrowth
 * - BOM_DOWN_DEV_UP          → qtyDeviasiGrowth
 */
function getMetricGrowthForRule(ruleCode: string, detail: BomDetailRow | undefined): number | null {
  if (!detail) return null;
  switch (ruleCode) {
    case 'WASTE_BOM_MISMATCH': return detail.wasteGrowth;
    case 'SUSUT_BOM_MISMATCH': return detail.susutGrowth;
    case 'TRIAL_BOM_MISMATCH': return detail.trialGrowth;
    case 'BOM_DEVIATION_DISPROPORTIONATE':
    case 'BOM_DEVIATION_MISMATCH':
    case 'BOM_DOWN_DEV_UP':
      return detail.qtyDeviasiGrowth;
    default: return null;
  }
}

/**
 * Sub-step 1b — fetch per-record growth values for the (outletId, itemId,
 * akunPenyesuaian) tuples that fired any BOM rule. Bounded to the unique
 * tuple set (typically ≤ 200 rows even for 35K-record periods).
 *
 * Mirrors the rule-evaluation.ts CTE shape: curr LEFT JOIN LATERAL prev,
 * with ABS() growth magnitude and div-by-zero guards. Returns a Map keyed
 * by `${outletId}|${itemId}|${akunPenyesuaian ?? ''}` for O(1) lookup.
 */
export async function fetchBomCorrelationDetails(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
  keys: Array<{ outletId: number; itemId: number; akunPenyesuaian: string | null }>,
): Promise<Map<string, BomDetailRow>> {
  const result = new Map<string, BomDetailRow>();
  if (keys.length === 0) return result;
  if (!prevWeek || !prevMonth) {
    // No comparison period — every growth field is null. Still return the
    // rows so we have outlet/item names for display.
  }
  const f = buildSqlFilters(filters, 'c');
  const tupleValues = keys.map((k) =>
    Prisma.sql`(${k.outletId}, ${k.itemId}, ${k.akunPenyesuaian})`,
  );
  const tuples = Prisma.join(tupleValues, ', ');
  // prevFilter — if no compare period, sentinel 1=0 (matches nothing → all growth NULL).
  const prevFilter = prevWeek && prevMonth
    ? Prisma.sql`AND p."monthLabel" = ${prevMonth} AND p."weekLabel" = ${prevWeek}`
    : Prisma.sql`AND 1=0`;
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<BomDetailRow[]>`
    SELECT
      c."outletId", c."itemId", c."akunPenyesuaian",
      o.name AS "outletName",
      o.code AS "outletCode",
      i.name AS "itemName",
      CASE WHEN p."prevQtyBom" IS NOT NULL AND p."prevQtyBom" != 0
        THEN (ABS(c."qtyBom") - ABS(p."prevQtyBom")) / ABS(p."prevQtyBom")
        ELSE NULL END AS "bomGrowth",
      CASE WHEN p."prevQtyWaste" IS NOT NULL AND p."prevQtyWaste" != 0
        THEN (ABS(c."qtyWaste") - ABS(p."prevQtyWaste")) / ABS(p."prevQtyWaste")
        ELSE NULL END AS "wasteGrowth",
      CASE WHEN p."prevQtySusut" IS NOT NULL AND p."prevQtySusut" != 0
        THEN (ABS(c."qtySusut") - ABS(p."prevQtySusut")) / ABS(p."prevQtySusut")
        ELSE NULL END AS "susutGrowth",
      CASE WHEN p."prevQtyTrial" IS NOT NULL AND p."prevQtyTrial" != 0
        THEN (ABS(c."qtyTrial") - ABS(p."prevQtyTrial")) / ABS(p."prevQtyTrial")
        ELSE NULL END AS "trialGrowth",
      CASE WHEN p."prevQtyDeviasi" IS NOT NULL AND p."prevQtyDeviasi" != 0
        THEN (ABS(c."qtyDeviasi") - ABS(p."prevQtyDeviasi")) / ABS(p."prevQtyDeviasi")
        ELSE NULL END AS "qtyDeviasiGrowth"
    FROM "InventoryRecord" c
    JOIN "Item" i ON c."itemId" = i.id
    JOIN "Outlet" o ON c."outletId" = o.id
    JOIN (VALUES ${tuples}) AS v(outletId, itemId, akunPenyesuaian)
      ON c."outletId" = v.outletId
      AND c."itemId" = v.itemId
      AND c."akunPenyesuaian" IS NOT DISTINCT FROM v.akunPenyesuaian
    LEFT JOIN LATERAL (
      SELECT p."qtyBom" AS "prevQtyBom", p."qtyDeviasi" AS "prevQtyDeviasi",
             p."qtyWaste" AS "prevQtyWaste", p."qtySusut" AS "prevQtySusut",
             p."qtyTrial" AS "prevQtyTrial"
      FROM "InventoryRecord" p
      WHERE p."outletId" = c."outletId" AND p."itemId" = c."itemId"
        AND p."akunPenyesuaian" IS NOT DISTINCT FROM c."akunPenyesuaian"
        ${prevFilter}
      LIMIT 1
    ) p ON true
    WHERE c."monthLabel" = ${month} AND c."weekLabel" = ${week}
      ${f}
  `);
  for (const r of rows) {
    const key = `${r.outletId}|${r.itemId}|${r.akunPenyesuaian ?? ''}`;
    result.set(key, {
      outletId: Number(r.outletId),
      itemId: Number(r.itemId),
      akunPenyesuaian: r.akunPenyesuaian,
      outletName: r.outletName,
      outletCode: r.outletCode,
      itemName: r.itemName,
      bomGrowth: r.bomGrowth == null ? null : Number(r.bomGrowth),
      wasteGrowth: r.wasteGrowth == null ? null : Number(r.wasteGrowth),
      susutGrowth: r.susutGrowth == null ? null : Number(r.susutGrowth),
      trialGrowth: r.trialGrowth == null ? null : Number(r.trialGrowth),
      qtyDeviasiGrowth: r.qtyDeviasiGrowth == null ? null : Number(r.qtyDeviasiGrowth),
    });
  }
  return result;
}

/**
 * Sub-step 1c — build the bomCorrelationFindings array + per-rule counts.
 *
 * Filters `sqlFlags` for category === 'BOM' (NOT topFlagByKey — that's
 * de-duped per record). Sorts by priority DESC (most severe first) and
 * slices top 50. Joins each flag to its detail row (if any) to attach
 * growth values + names.
 */
export async function buildBomCorrelationFindings(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
  sqlFlags: SqlRuleFlag[],
): Promise<{ findings: BomCorrelationFinding[]; counts: BomCorrelationCounts }> {
  const bomFlags = sqlFlags.filter(f => f.category === 'BOM');
  // Per-rule counts (computed from the FULL bomFlags set, not the sliced top-50).
  const counts: BomCorrelationCounts = {
    WASTE_BOM_MISMATCH: bomFlags.filter(f => f.ruleCode === 'WASTE_BOM_MISMATCH').length,
    SUSUT_BOM_MISMATCH: bomFlags.filter(f => f.ruleCode === 'SUSUT_BOM_MISMATCH').length,
    TRIAL_BOM_MISMATCH: bomFlags.filter(f => f.ruleCode === 'TRIAL_BOM_MISMATCH').length,
    BOM_DEVIATION_DISPROPORTIONATE: bomFlags.filter(f => f.ruleCode === 'BOM_DEVIATION_DISPROPORTIONATE').length,
    BOM_DEVIATION_MISMATCH: bomFlags.filter(f => f.ruleCode === 'BOM_DEVIATION_MISMATCH').length,
    BOM_DOWN_DEV_UP: bomFlags.filter(f => f.ruleCode === 'BOM_DOWN_DEV_UP').length,
  };
  if (bomFlags.length === 0) {
    return { findings: [], counts };
  }
  // Sort most-severe first (priority is a number; higher = more severe).
  // Stable sort preserves insertion order (DB row order) for equal-priority ties.
  const sorted = [...bomFlags].sort((a, b) => b.priority - a.priority);
  // Fetch growth values only for the unique tuple set of the top-50 slice
  // (bounded — typically ≤ 50 distinct tuples since one record rarely fires
  // multiple BOM rules of different priorities).
  const top = sorted.slice(0, 50);
  const uniqueKeys = new Map<string, { outletId: number; itemId: number; akunPenyesuaian: string | null }>();
  for (const f of top) {
    const key = `${f.outletId}|${f.itemId}|${f.akunPenyesuaian ?? ''}`;
    if (!uniqueKeys.has(key)) {
      uniqueKeys.set(key, { outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian });
    }
  }
  const details = await fetchBomCorrelationDetails(
    week, month, prevWeek, prevMonth, filters, [...uniqueKeys.values()],
  );
  const findings: BomCorrelationFinding[] = top.map(flag => {
    const key = `${flag.outletId}|${flag.itemId}|${flag.akunPenyesuaian ?? ''}`;
    const detail = details.get(key);
    const qtyDeviasiGrowth = detail?.qtyDeviasiGrowth ?? null;
    const bomGrowth = detail?.bomGrowth ?? null;
    // deviationBomRatio only meaningful when bomGrowth > 0 (used by the
    // disproportionate rule, which requires bomGrowth > 0 to fire anyway).
    const deviationBomRatio = (bomGrowth != null && bomGrowth > 0 && qtyDeviasiGrowth != null)
      ? qtyDeviasiGrowth / bomGrowth
      : null;
    return {
      outletId: flag.outletId,
      outletName: detail?.outletName ?? String(flag.outletId),
      outletCode: detail?.outletCode ?? null,
      itemId: flag.itemId,
      itemName: detail?.itemName ?? String(flag.itemId),
      akunPenyesuaian: flag.akunPenyesuaian,
      ruleCode: flag.ruleCode,
      rulePriority: flag.priority,
      severity: flag.severity,
      bomGrowth,
      metricGrowth: getMetricGrowthForRule(flag.ruleCode, detail),
      deviationBomRatio,
    };
  });
  return { findings, counts };
}
