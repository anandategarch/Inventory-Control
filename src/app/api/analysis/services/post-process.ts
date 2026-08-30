// ============================================================
//  post-process — Stage 4 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:549-905).
//
//  This module is split into focused sub-functions so each is a
//  testable unit (< 150 lines). The main `postProcess()` is a thin
//  orchestrator that calls them in order:
//
//    1. evaluateAndMergeFlags   — JS hist rules + merge with SQL flags
//    2. buildGrowthMetrics      — growth metrics + DQ counts + trend
//    3. buildOutletHealthRanking — Metric Engine health score per outlet
//    4. buildHistoricalAnalysis — zScore-ranked critical items (top 50)
//    5. buildTrendProjection    — linear projection of next period
//    6. buildPatterns           — systemic/area/network classification
//    7. mapTopOutlets           — top outlets (deviasi) + bySales
//
//  Awaits 2 promises:
//    - sqlFlagsPromise (fired in stage 3, usually resolved by now)
//    - queryHistoricalCriticalItems (fresh SQL for HISTORICAL_* items)
// ============================================================
import { Prisma } from '@prisma/client';
import {
  computeNominalDeviationGrowth,
  projectTrend,
  calcZScoreFromStats,
  computeHealthScore,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeLossToSales,
  type AggregateInput,
  type HealthScoreWeights,
  type HealthScoreThresholds,
} from '@/lib/metrics';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '@/lib/queries/shared';
import { detectPatterns } from '@/engine/analysis/analysis';
import type { AnalysisOutlet, AnalysisArea } from '@/engine/analysis';
import { queryHistoricalCriticalItems } from '@/lib/queries';
import { evaluateHistoricalRulesJs, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import { buildTrend, buildMultiPeriodComparison, buildNetCostTrend } from './trend-builder';
import { computeDeviationDrivers } from './deviation-drivers';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { ResolvedParams } from './validate-and-resolve';

// ============================================================
//  BOM Correlation Findings — per-record rule fire details
//  --------------------------------------------------------
//  FIX-BOM-UI (CONFIG-02): BomCorrelationCard previously read ONLY
//  aggregate growth from `executiveSummary` and computed alignment
//  inline with hardcoded thresholds. It never saw the per-record
//  rule engine results (sqlFlags where category === 'BOM').
//
//  We now extract ALL BOM rule fires from `sqlFlags` (NOT the
//  topFlagByKey — that's de-duped to highest-priority flag per
//  record and would hide secondary BOM warnings), and join each
//  flag to its underlying record's growth values via a fresh SQL
//  fetch (curr + prev period LATERAL JOIN, same shape as the
//  rule-evaluation CTE but only for the flagged tuples — bounded
//  to ~50 rows by the slice).
//
//  `deviationBomRatio` = qtyDeviasiGrowth / bomGrowth (when bomGrowth > 0).
//  Used by BOM_DEVIATION_DISPROPORTIONATE to show how many times
//  faster deviation grew vs BOM.
// ============================================================

export interface BomCorrelationFinding {
  outletId: number;
  outletName: string;
  itemId: number;
  itemName: string;
  akunPenyesuaian: string | null;
  ruleCode: string;
  rulePriority: number;
  severity: string;
  bomGrowth: number | null;
  /** Growth of the metric relevant to the rule (waste/susut/trial/qtyDeviasi). */
  metricGrowth: number | null;
  /** qtyDeviasiGrowth / bomGrowth (only meaningful when bomGrowth > 0). */
  deviationBomRatio: number | null;
}

export interface BomCorrelationCounts {
  WASTE_BOM_MISMATCH: number;
  SUSUT_BOM_MISMATCH: number;
  TRIAL_BOM_MISMATCH: number;
  BOM_DEVIATION_DISPROPORTIONATE: number;
  BOM_DEVIATION_MISMATCH: number;
  BOM_DOWN_DEV_UP: number;
}

interface BomDetailRow {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
  outletName: string;
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

// Stage-4 output — everything needed by assemble-response.
export interface ProcessedData {
  normal: number;
  warning: number;
  abnormal: number;
  ruleBreakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
  topFlagByKey: Map<string, SqlRuleFlag>;
  growthMetrics: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison: Array<Record<string, unknown>>;
  };
  growthComparisonWithHist: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison: Array<Record<string, unknown>>;
    historicalAnalysis: { criticalItems: Array<Record<string, unknown>> };
  };
  trend: ReturnType<typeof buildTrend>;
  netCostTrend: ReturnType<typeof buildNetCostTrend>;
  trendProjection: ReturnType<typeof projectTrend>;
  patterns: ReturnType<typeof detectPatterns>;
  dqSeverityCounts: Map<string, number>;
  areaAnalysis: Array<Record<string, unknown>>;
  topOut: Array<Record<string, unknown>>;
  topOutletsSales: Array<Record<string, unknown>>;
  outletHealthRanking: Array<AnalysisOutlet & { nominalDeviasi: number; residualPct: number; lossToSales: number | null }>;
  costImpact: Record<string, unknown>;
  itemConsistencyAnalysis: Record<string, unknown>;
  deviationDrivers: ReturnType<typeof computeDeviationDrivers>;
  // FIX-BOM-UI (CONFIG-02): per-record BOM rule findings (top 50 by priority)
  // + per-rule counts. Consumed by BomCorrelationCard's primary section.
  bomCorrelationFindings: BomCorrelationFinding[];
  bomCorrelationCounts: BomCorrelationCounts;
}

// Internal: severity-count maps derived from topFlagByKey + healthRankingRows.
interface SeverityMaps {
  warningByOutlet: Map<number, number>;
  abnormalByOutlet: Map<number, number>;
  recordsWithFlagsByOutlet: Map<number, number>;
}

/**
 * Sub-step 1 — evaluate JS historical rules + merge with SQL flags.
 * Returns topFlagByKey + per-outlet severity counts + global normal/warning/abnormal.
 */
export async function evaluateAndMergeFlags(
  currSlim: FetchedRecords['currSlim'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
  thresholds: FetchedRecords['thresholds'],
  sqlFlagsPromise: Promise<SqlRuleFlag[]>,
  healthRankingRows: QueryResults['healthRankingRows'],
): Promise<{
  topFlagByKey: Map<string, SqlRuleFlag>;
  severityMaps: SeverityMaps;
  normal: number;
  warning: number;
  abnormal: number;
  ruleBreakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
}> {
  // ============================================================
  //  POST-PROCESS RULE FLAGS (Sprint 3 + SQL-OPTIMIZE)
  //  --------------------------------------------------------
  //  1. Evaluate 5 zScore-based rules in JS (uses currSlim — 5 cols × 35K rows)
  //  2. Merge SQL + JS flags → topFlagByKey (key → highest-priority flag)
  //  3. Compute per-outlet + global severity counts from topFlagByKey +
  //     healthRankingRows (zeroDev / nonZeroDev counts per outlet)
  // ============================================================
  const histFlags = evaluateHistoricalRulesJs(currSlim, historicalByOutletItem, thresholds);

  // PERF-FASE2-BE03: Await sqlFlagsPromise here (not in Group 1) — by now
  // Batches 1-4 have finished, and evaluateRulesSql has been running in
  // parallel the whole time. If it's already resolved, this await is ~0ms.
  const sqlFlags = await sqlFlagsPromise;

  // topFlagByKey — one entry per (outletId, itemId, akunPenyesuaian) record
  // that fired at least one rule. Keeps the highest-priority flag.
  const allFlags = [...sqlFlags, ...histFlags];
  const topFlagByKey = new Map<string, SqlRuleFlag>();
  for (const flag of allFlags) {
    const key = `${flag.outletId}|${flag.itemId}|${flag.akunPenyesuaian ?? ''}`;
    const existing = topFlagByKey.get(key);
    if (!existing || flag.priority > existing.priority) {
      topFlagByKey.set(key, flag);
    }
  }

  // Per-outlet severity counts derived from topFlagByKey (small map —
  // ~5K-10K entries, one per flagged record). Much smaller than iterating
  // 35K currentRecs as the old JS code did.
  const warningByOutlet = new Map<number, number>();
  const abnormalByOutlet = new Map<number, number>();
  const recordsWithFlagsByOutlet = new Map<number, number>();
  const ruleCategoryCounts = new Map<string, number>();
  const ruleCodeCounts = new Map<string, number>();
  for (const [, flag] of topFlagByKey) {
    recordsWithFlagsByOutlet.set(flag.outletId, (recordsWithFlagsByOutlet.get(flag.outletId) ?? 0) + 1);
    if (flag.severity === 'ABNORMAL') {
      abnormalByOutlet.set(flag.outletId, (abnormalByOutlet.get(flag.outletId) ?? 0) + 1);
    } else if (flag.severity === 'WARNING') {
      warningByOutlet.set(flag.outletId, (warningByOutlet.get(flag.outletId) ?? 0) + 1);
    }
    ruleCategoryCounts.set(flag.category, (ruleCategoryCounts.get(flag.category) || 0) + 1);
    ruleCodeCounts.set(flag.ruleCode, (ruleCodeCounts.get(flag.ruleCode) || 0) + 1);
  }

  // Global normal/warning/abnormal counts (matches the old JS loop exactly):
  //   normal   = (nonZeroDevCount - recordsWithFlags) + zeroDevCount
  //   warning  = records with top-flag WARNING
  //   abnormal = records with top-flag ABNORMAL
  let normal = 0, warning = 0, abnormal = 0;
  for (const row of healthRankingRows) {
    const recWithFlags = recordsWithFlagsByOutlet.get(row.outletId) ?? 0;
    const w = warningByOutlet.get(row.outletId) ?? 0;
    const ab = abnormalByOutlet.get(row.outletId) ?? 0;
    const n = Math.max(0, row.nonZeroDevCount - recWithFlags) + row.zeroDevCount;
    normal += n;
    warning += w;
    abnormal += ab;
  }

  const ruleBreakdown = {
    byCategory: Object.fromEntries(ruleCategoryCounts) as Record<string, number>,
    byRule: Object.fromEntries(ruleCodeCounts) as Record<string, number>,
  };

  return {
    topFlagByKey,
    severityMaps: { warningByOutlet, abnormalByOutlet, recordsWithFlagsByOutlet },
    normal, warning, abnormal,
    ruleBreakdown,
  };
}

/**
 * Sub-step 2 — build growth metrics + DQ severity counts + trend artifacts.
 */
export function buildGrowthMetrics(
  execSummary: QueryResults['execSummary'],
  trendAggRows: QueryResults['trendAggRows'],
  monthKeyByLabel: FetchedRecords['monthKeyByLabel'],
  dqIssuesRaw: QueryResults['dqIssuesRaw'],
): {
  growthMetrics: ProcessedData['growthMetrics'];
  multiPeriodComparison: ReturnType<typeof buildMultiPeriodComparison>;
  trend: ReturnType<typeof buildTrend>;
  netCostTrend: ReturnType<typeof buildNetCostTrend>;
  dqSeverityCounts: Map<string, number>;
} {
  // FIX (audit issue #11): Use computeNominalDeviationGrowth (magnitude) for
  // nominalDeviasi — signed calcGrowth is misleading when sign flips.
  // For -10M → -20M: signed gives -100% (decreasing), magnitude gives +100% (worsening).
  const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(
    execSummary.nominalDeviasi.current,
    execSummary.nominalDeviasi.previous ?? null,
  );

  const growthMetrics = {
    salesGrowth: execSummary.sales.growth,
    bomGrowth: execSummary.qtyBom.growth,
    qtyDeviasiGrowth: execSummary.qtyDeviasi.growth,
    nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
    deviationToSalesRatio: execSummary.sales.current > 0
      ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
    deviationToBomRatio: execSummary.deviationToBom,
    multiPeriodComparison: [] as Array<Record<string, unknown>>,
  };

  // OPTIMIZE-ANALYSIS: DQ groupBy changed from `by: ['code','severity','message']`
  // (one row per unique issue text → potentially many rows) to `by: ['severity']`
  // (≤3 rows: ERROR/WARNING/INFO). Frontend only reads `dqStatus.errors` and
  // `dqStatus.warnings` (ExecutiveSummary.tsx:308,312) — the per-issue `code`/
  // `message` breakdown and the `ok`/`issues` response fields were unused.
  const dqSeverityCounts = new Map<string, number>();
  for (const d of dqIssuesRaw) {
    dqSeverityCounts.set(d.severity, (dqSeverityCounts.get(d.severity) ?? 0) + d._count._all);
  }

  // ============================================================
  //  Trend — from parallel queryTrendAgg result above
  //  Phase 3: extracted to services/trend-builder.ts
  // ============================================================
  const trend = buildTrend(trendAggRows, monthKeyByLabel);
  const multiPeriodComparison = buildMultiPeriodComparison(trendAggRows, monthKeyByLabel);
  growthMetrics.multiPeriodComparison = multiPeriodComparison as unknown as Array<Record<string, unknown>>;
  const netCostTrend = buildNetCostTrend(trendAggRows, monthKeyByLabel);

  return { growthMetrics, multiPeriodComparison, trend, netCostTrend, dqSeverityCounts };
}

/**
 * Sub-step 3 — build outlet health ranking with Metric Engine health score.
 * Combines SQL aggregate (healthRankingRows) + JS severity counts (topFlagByKey).
 *
 * Returns a superset of AnalysisOutlet — extra fields (nominalDeviasi,
 * residualPct, lossToSales) are kept because assemble-response spreads the
 * array directly into the JSON response (frontend reads them).
 */
export function buildOutletHealthRanking(
  healthRankingRows: QueryResults['healthRankingRows'],
  severityMaps: SeverityMaps,
  thresholds: FetchedRecords['thresholds'],
): Array<AnalysisOutlet & { nominalDeviasi: number; residualPct: number; lossToSales: number | null }> {
  // FIX (audit issue #6, P2 #10): Pass runtime health score weights + thresholds from Settings
  const healthScoreWeights = {
    devBom: thresholds.HEALTH_WEIGHT_DEV_BOM,
    residual: thresholds.HEALTH_WEIGHT_RESIDUAL,
    lossToSales: thresholds.HEALTH_WEIGHT_LOSS_TO_SALES,
    abnormal: thresholds.HEALTH_WEIGHT_ABNORMAL,
  };
  const healthScoreThresholds = {
    devBom: { good: thresholds.HEALTH_THRESH_DEV_BOM_GOOD, bad: thresholds.HEALTH_THRESH_DEV_BOM_BAD },
    residual: { good: thresholds.HEALTH_THRESH_RESIDUAL_GOOD, bad: thresholds.HEALTH_THRESH_RESIDUAL_BAD },
    lossToSales: { good: thresholds.HEALTH_THRESH_LOSS_TO_SALES_GOOD, bad: thresholds.HEALTH_THRESH_LOSS_TO_SALES_BAD },
    abnormal: { good: thresholds.HEALTH_THRESH_ABNORMAL_GOOD, bad: thresholds.HEALTH_THRESH_ABNORMAL_BAD },
  };

  const { warningByOutlet, abnormalByOutlet, recordsWithFlagsByOutlet } = severityMaps;
  return healthRankingRows.map(row => {
    const recWithFlags = recordsWithFlagsByOutlet.get(row.outletId) ?? 0;
    const w = warningByOutlet.get(row.outletId) ?? 0;
    const ab = abnormalByOutlet.get(row.outletId) ?? 0;
    const n = Math.max(0, row.nonZeroDevCount - recWithFlags) + row.zeroDevCount;
    const aggregateInput: AggregateInput = {
      totalQtyDeviasi: row.totalQtyDeviasi,
      totalQtyBom: row.totalQtyBom,
      totalQtyWaste: row.totalQtyWaste,
      totalQtySusut: row.totalQtySusut,
      totalQtyTrial: row.totalQtyTrial,
      totalResidualQty: row.totalResidualQty,
      totalLossNominal: row.lossNominal,
      totalSales: row.sales,
      normalCount: n,
      warningCount: w,
      abnormalCount: ab,
    };
    const devBom = computeDevBomAggregate(aggregateInput);
    const residualPct = computeResidualPctAggregate(aggregateInput);
    const lossToSales = computeLossToSales(aggregateInput);
    const healthScore = computeHealthScore(aggregateInput, healthScoreWeights as HealthScoreWeights, healthScoreThresholds as HealthScoreThresholds);
    return {
      outletCode: row.outletCode,
      outletName: row.outletName,
      area: row.area,
      healthScore,
      normal: n,
      warning: w,
      abnormal: ab,
      absNominal: row.absNominal,
      nominalDeviasi: row.nominalDeviasi,
      residualPct,
      lossToSales,
      devBom,
      sales: row.sales,
    };
  }).sort((a, b) => a.healthScore - b.healthScore || b.abnormal - a.abnormal);
}

/**
 * Sub-step 4 — build historical critical-items analysis.
 * Filters topFlagByKey for HISTORICAL_* flags, fetches per-record fields via SQL,
 * computes zScore + sorts + slices top 50.
 */
export async function buildHistoricalAnalysis(
  topFlagByKey: Map<string, SqlRuleFlag>,
  week: string,
  month: string,
  filterOpts: FetchedRecords['filterOpts'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
): Promise<{ criticalItems: Array<Record<string, unknown>> }> {
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
    .filter((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_WARNING')
    .map(f => ({ outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian }));
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
  // FIX: return top 200 (was 50) — Phase B-4: increased limit for pagination.
  // HistoricalZScoreCard shows 20 initially with "load more" button.
  return { criticalItems: histCriticalItems.slice(0, 200) };
}

/**
 * Sub-step 5 — linear projection of next period's |nominalDeviasi|.
 * Reuses trendAggRows (already fetched) — no extra DB query.
 * Sign convention: input uses signed nominal (LOSS = negative); projectTrend takes ABS internally.
 */
export function buildTrendProjection(
  trendAggRows: QueryResults['trendAggRows'],
  monthKeyByLabel: FetchedRecords['monthKeyByLabel'],
): ReturnType<typeof projectTrend> {
  // FIX FORECAST-1: sort trendAggRows chronologically before projecting
  // (DB returns rows in arbitrary order; projectTrend needs chronological W1→W4)
  return projectTrend(
    trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, "")) || 0).padStart(2, "0")}`,
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          nominalDeviasi: r.nominal,
          devBom: r.devBom,
          sales: r.sales,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey)),
  );
}

/**
 * Sub-step 6 — pattern detection (systemic/area-level/network-wide).
 * No extra DB query — runs entirely on already-computed in-memory data.
 */
export function buildPatterns(
  outletHealthRanking: AnalysisOutlet[],
  itemConsistencyAnalysis: { items: Array<Record<string, unknown>> },
  areaAnalysis: AnalysisArea[],
): ReturnType<typeof detectPatterns> {
  // ============================================================
  //  Pattern Detection (ANALYZE-BACKEND-2 — Feature 5)
  //  --------------------------------------------------------
  //  totalOutlets = outletHealthRanking.length (universe of outlets
  //  with at least one evaluated item this period). Slight under-count
  //  for outlets where ALL items are zero-dev, but those are rare and
  //  irrelevant for systemic-pattern detection.
  // ============================================================
  const items = itemConsistencyAnalysis.items ?? [];
  return detectPatterns({
    outletHealthRanking,
    itemConsistency: items.map((i) => ({
      itemName: i.itemName as string,
      outletCount: i.outletCount as number,
      totalAbsNominal: i.totalAbsNominal as number,
      avgDevBom: i.avgDevBom as number,
      consistency: i.consistency as 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED' | undefined,
    })),
    areaAnalysis,
    totalOutlets: outletHealthRanking.length,
  });
}

/**
 * Sub-step 7 — map top outlet SQL rows to response shape, including areaAvg.
 */
export function mapTopOutlets(
  topOutletsRaw: QueryResults['topOutletsRaw'],
  topOutletsSalesRaw: QueryResults['topOutletsSalesRaw'],
  areaAnalysisRaw: QueryResults['areaAnalysisRaw'],
): { topOut: Array<Record<string, unknown>>; topOutletsSales: Array<Record<string, unknown>> } {
  const areaAvgMap = new Map<string, number>(areaAnalysisRaw.map(a => [a.area, a.avgDevBom ?? 0]));
  const topOut = topOutletsRaw.map(o => ({
    outletCode: o.outletCode, outletName: o.outletName, area: o.area,
    absNominal: o.absNominal, nominalDeviasi: o.nominalDeviasi ?? 0,
    devBom: o.devBom, areaAvg: areaAvgMap.get(o.area) ?? 0,
    sales: o.sales, lossAmount: o.lossAmount, surplusAmount: o.surplusAmount, direction: o.direction,
  }));
  const topOutletsSales = topOutletsSalesRaw.map(o => ({
    outletCode: o.outletCode, outletName: o.outletName, area: o.area,
    sales: o.sales, absNominal: o.absNominal, nominalDeviasi: o.nominalDeviasi ?? 0,
    devToSalesRatio: o.sales > 0 ? o.absNominal / o.sales : null,
  }));
  return { topOut, topOutletsSales };
}

/**
 * Stage 4 — post-process raw query results into response-ready shapes.
 *
 * Thin orchestrator — delegates to 7 sub-functions (each < 150 lines).
 */
export async function postProcess(params: ResolvedParams, records: FetchedRecords, queries: QueryResults): Promise<ProcessedData> {
  const { week, month, prevWeek, prevMonth } = params;
  const { currSlim, historicalByOutletItem, thresholds, monthKeyByLabel, filterOpts } = records;
  const {
    earlyPromises,
    execSummary,
    areaAnalysisRaw,
    topOutletsRaw,
    topOutletsSalesRaw,
    costImpactSql,
    lvs,
    consistencyItems,
    trendAggRows,
    healthRankingRows,
    deviationDriverRows,
    dqIssuesRaw,
  } = queries;
  // NOTE: varianceAnalysis is NOT destructured here — post-process doesn't
  // transform it. assemble-response reads it directly from `queries.varianceAnalysis`.

  // Sub-step 1: rule flag evaluation + merge (also awaits sqlFlagsPromise internally).
  const { topFlagByKey, severityMaps, normal, warning, abnormal, ruleBreakdown } = await evaluateAndMergeFlags(
    currSlim, historicalByOutletItem, thresholds, earlyPromises.sqlFlagsPromise, healthRankingRows,
  );

  // PERF-API-04 (Task PERF-API): run Sub-step 1b (BOM correlation findings) and
  // Sub-step 4 (historical critical-items) IN PARALLEL via Promise.all. Both are
  // independent SQL queries (fetchBomCorrelationDetails + queryHistoricalCriticalItems)
  // that depend only on the now-resolved topFlagByKey + sqlFlags. Previously they
  // ran sequentially: ~50ms (BOM) + ~100ms (historical) = ~150ms total.
  // Parallel: max(50, 100) = ~100ms total. Saves ~50ms on cold cache path.
  // Sync sub-steps (2, 3, 5, 6, 7) are computed WHILE the SQL queries run — no
  // additional latency since they don't await.
  const sqlFlags = await earlyPromises.sqlFlagsPromise;
  const [bomCorrelationResult, historicalAnalysis] = await Promise.all([
    buildBomCorrelationFindings(week, month, prevWeek, prevMonth, filterOpts, sqlFlags),
    buildHistoricalAnalysis(topFlagByKey, week, month, filterOpts, historicalByOutletItem),
  ]);
  const { findings: bomCorrelationFindings, counts: bomCorrelationCounts } = bomCorrelationResult;

  // Sub-step 2: growth metrics + trend
  const { growthMetrics, trend, netCostTrend, dqSeverityCounts } = buildGrowthMetrics(
    execSummary, trendAggRows, monthKeyByLabel, dqIssuesRaw,
  );

  // Sub-step 3: outlet health ranking
  const outletHealthRanking = buildOutletHealthRanking(healthRankingRows, severityMaps, thresholds);

  const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };

  // Sub-step 5: trend projection
  const trendProjection = buildTrendProjection(trendAggRows, monthKeyByLabel);

  // Extended analytics: area mapping
  const areaAnalysis = areaAnalysisRaw.map(a => ({
    area: a.area,
    outletCount: a.outletCount,
    totalSales: a.totalSales,
    totalAbsNominal: a.totalAbsNominal,
    avgDevBom: a.avgDevBom,
    lossToSales: a.lossToSales,
  }));

  // Cost Impact — only the 4 fields consumed by InsightsPanel + CostImpact type.
  // (wasteCost/susutCost/trialCost/residualCost and their *ToSales ratios were
  // only read by the now-removed CostAccounting tab — dropped to slim the
  // response payload. queryCostImpact still runs because totalCost is needed.)
  const costImpact = {
    totalCost: costImpactSql.totalCost,
    pctOfSales: execSummary.sales.current > 0 ? costImpactSql.totalCost / execSummary.sales.current : null,
    lossNominal: lvs.lossNominal,
    surplusNominal: lvs.surplusNominal,
  };

  // Item Consistency — from parallel query result above
  const systemic = consistencyItems
    .filter(i => i.consistency === 'SYSTEMIC')
    .map(i => ({
      itemName: i.itemName, outletCode: '', area: '',
      occurrences: i.outletCount, avgDevBom: i.avgDevBom, absNominal: i.totalAbsNominal,
    }));
  const episodic = consistencyItems
    .filter(i => i.consistency !== 'SYSTEMIC')
    .map(i => ({
      itemName: i.itemName, outletCode: '', area: '',
      absNominal: i.totalAbsNominal, devBom: i.avgDevBom,
    }));
  const itemConsistencyAnalysis = {
    systemic,
    episodic,
    items: consistencyItems.map(i => ({
      itemName: i.itemName,
      satuan: '', // not used by frontend table; would need separate fetch
      outletCount: i.outletCount,
      lossOutlets: i.lossOutlets,
      surplusOutlets: i.surplusOutlets,
      totalAbsNominal: i.totalAbsNominal,
      avgDevBom: i.avgDevBom,
      consistency: i.consistency,
    })),
  };

  // Sub-step 6: pattern detection
  const patterns = buildPatterns(outletHealthRanking, itemConsistencyAnalysis, areaAnalysis);

  // Sub-step 7: top outlets mapping
  const { topOut, topOutletsSales } = mapTopOutlets(topOutletsRaw, topOutletsSalesRaw, areaAnalysisRaw);

  // Deviation Drivers — Phase 3 service
  const deviationDrivers = computeDeviationDrivers(deviationDriverRows);

  return {
    normal, warning, abnormal, ruleBreakdown, topFlagByKey,
    growthMetrics, growthComparisonWithHist,
    trend, netCostTrend, trendProjection, patterns,
    dqSeverityCounts, areaAnalysis, topOut, topOutletsSales,
    outletHealthRanking, costImpact, itemConsistencyAnalysis, deviationDrivers,
    bomCorrelationFindings, bomCorrelationCounts,
  };
}
