// ============================================================
//  /api/analysis — main dashboard data endpoint
//  Query: ?month=&week=&compareWeek=&area=&outlet=&item=
//
//  Phase 1-4 egress optimization (Task 15):
//  - Raw record fetching kept ONLY for rule evaluation (currentRecs + prevRecs)
//  - All aggregation pushed to SQL via /lib/queries.ts (PostgreSQL)
//  - Historical stats computed via SQL GROUP BY (avoids 540K row fetch)
//  - Trend, exec summary, top items/outlets, pareto, etc. all SQL-aggregated
//  - Rule evaluation loop, worklist, priorities, health ranking, historical
//    analysis, variance analysis still use raw records (per-record logic)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  buildWorklistFromFlags,
  computePrioritiesFromFlags,
  buildRuleContext,
  computeVarianceAnalysis,
  computeOutletHealthRanking,
  computeHistoricalAnalysis,
} from '@/engine/analysis/analysis';
import { evaluateRules } from '@/engine/rules/evaluator';
import { generateNarrative, buildRecommendations } from '@/engine/narrative/narrative';
import { analysisCache } from '@/lib/cache';
import { getRuntimeThresholds, getThresholdsVersion } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { calcGrowth } from '@/engine/calculations/growth';
import {
  queryTrendAgg,
  queryExecSummary,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByCategory,
  queryTopOutlets,
  queryTopOutletsBySales,
  queryDeviationBreakdown,
  queryLossVsSurplus,
  queryAreaAnalysis,
  queryCostImpact,
  queryPareto,
  queryItemConsistency,
  queryHistoricalStats,
} from '@/lib/queries';
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';
import type { ExecutiveSummary } from '@/types/inventory';

export const dynamic = 'force-dynamic';

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

// ============================================================
//  Build ExecutiveSummary from SQL aggregate rows
//  (replaces JS buildExecutiveSummary that looped 35K records)
// ============================================================
function buildExecSummaryFromSql(
  curr: {
    sales: number; nominalDeviasi: number; qtyBom: number; qtyDeviasi: number;
    qtyWaste: number; qtySusut: number; qtyTrial: number; qtyLossSurplus: number;
    totalLoss: number; totalSurplus: number; residualLossQty: number; residualLossNominal: number;
  } | null,
  prev: {
    sales: number; nominalDeviasi: number; qtyBom: number; qtyDeviasi: number;
    qtyWaste: number; qtySusut: number; qtyTrial: number; qtyLossSurplus: number;
    totalLoss: number; totalSurplus: number; residualLossQty: number; residualLossNominal: number;
  } | null,
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null,
): ExecutiveSummary {
  const c = curr ?? {
    sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0,
    qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0,
    residualLossQty: 0, residualLossNominal: 0,
  };
  const salesPrev = prev?.sales ?? null;
  const nominalDeviasiPrev = prev?.nominalDeviasi ?? null;
  const qtyBomPrev = prev?.qtyBom ?? null;
  const qtyDeviasiPrev = prev?.qtyDeviasi ?? null;
  const qtyWastePrev = prev?.qtyWaste ?? null;
  const qtySusutPrev = prev?.qtySusut ?? null;
  const qtyTrialPrev = prev?.qtyTrial ?? null;
  const qtyLossSurplusPrev = prev?.qtyLossSurplus ?? null;

  return {
    period: { monthLabel, weekLabel, comparisonWeek: prevWeekLabel },
    sales: { current: c.sales, previous: salesPrev, growth: calcGrowth(c.sales, salesPrev) },
    nominalDeviasi: { current: c.nominalDeviasi, previous: nominalDeviasiPrev, growth: calcGrowth(c.nominalDeviasi, nominalDeviasiPrev) },
    qtyBom: { current: c.qtyBom, previous: qtyBomPrev, growth: calcGrowth(c.qtyBom, qtyBomPrev) },
    qtyDeviasi: { current: c.qtyDeviasi, previous: qtyDeviasiPrev, growth: calcGrowth(c.qtyDeviasi, qtyDeviasiPrev) },
    qtyWaste: { current: c.qtyWaste, previous: qtyWastePrev, growth: calcGrowth(c.qtyWaste, qtyWastePrev) },
    qtySusut: { current: c.qtySusut, previous: qtySusutPrev, growth: calcGrowth(c.qtySusut, qtySusutPrev) },
    qtyTrial: { current: c.qtyTrial, previous: qtyTrialPrev, growth: calcGrowth(c.qtyTrial, qtyTrialPrev) },
    qtyLossSurplus: { current: c.qtyLossSurplus, previous: qtyLossSurplusPrev, growth: calcGrowth(c.qtyLossSurplus, qtyLossSurplusPrev) },
    totalLoss: c.totalLoss,
    totalSurplus: c.totalSurplus,
    lossToSales: c.sales > 0 ? c.totalLoss / c.sales : null,
    surplusToSales: c.sales > 0 ? c.totalSurplus / c.sales : null,
    deviationToBom: c.qtyBom > 0 ? c.qtyDeviasi / c.qtyBom : null,
    residualLossQty: c.residualLossQty,
    residualLossPct: c.qtyDeviasi > 0 ? c.residualLossQty / c.qtyDeviasi : null,
  };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // Bug #10 fix: Rate limiting
    const ip = getClientIP(req);
    const rl = rateLimit(`analysis:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Coba lagi dalam beberapa detik.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    const url = new URL(req.url);
    const monthLabel = url.searchParams.get('month');
    const currentWeek = url.searchParams.get('week');
    const compareWeekRaw = url.searchParams.get('compareWeek');
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outlet');
    const itemName = url.searchParams.get('item');
    const pic = url.searchParams.get('pic');

    // ===== BUG FIX #1/#2: Parse cross-month compare format "WEEK X|||MonthLabel" =====
    let compareWeek: string | null = null;
    let compareMonthExplicit: string | null = null;
    if (compareWeekRaw && compareWeekRaw.includes('|||')) {
      const [wk, ml] = compareWeekRaw.split('|||');
      compareWeek = wk;
      compareMonthExplicit = ml;
    } else if (compareWeekRaw) {
      compareWeek = compareWeekRaw;
    }

    // Cache key — include all filter dimensions + thresholds version
    // (thresholds version changes when user updates settings, invalidating cache)
    const thresholdsVersion = await getThresholdsVersion(); // Phase 3: cached (1 min TTL)
    const cacheKey = `analysis|${monthLabel}|${currentWeek}|${compareWeek}|${compareMonthExplicit}|${area}|${outletCode}|${itemName}|${pic}|tv${thresholdsVersion}`;
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ ...cached as object, cached: true, durationMs: Date.now() - startedAt });
    }

    // Determine available months/weeks if not specified
    let month = monthLabel;
    let week = currentWeek;
    if (!month || !week) {
      const latest = await db.inventoryRecord.findFirst({
        orderBy: { id: 'desc' },
        select: { monthLabel: true, weekLabel: true },
      });
      if (!latest) {
        return NextResponse.json({
          success: false,
          message: 'No data ingested yet. Please run /api/ingest first.',
        }, { status: 404 });
      }
      month = month || latest.monthLabel;
      week = week || latest.weekLabel;
    }

    // ===== Phase 1a fix: Query Week table (3 rows) instead of scanning 540K InventoryRecord =====
    const weeksRaw = await db.week.findMany({
      select: { weekLabel: true, monthKey: true },
      distinct: ['monthKey', 'weekLabel'],
    });
    const fileMonthKeys = await db.sourceFile.findMany({
      select: { monthLabel: true, monthKey: true },
    });
    const monthKeyByLabel = new Map(fileMonthKeys.map((f) => [f.monthLabel, f.monthKey]));
    const monthLabelByKey = new Map(fileMonthKeys.map((f) => [f.monthKey, f.monthLabel]));
    const allPeriods = weeksRaw
      .map((w) => {
        const ml = monthLabelByKey.get(w.monthKey) || 'Unknown';
        return {
          monthLabel: ml,
          weekLabel: w.weekLabel,
          monthKey: w.monthKey,
          sortKey: `${w.monthKey}|${w.weekLabel}`,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // ===== BUG FIX #2: Auto-previous = chronologically previous period (cross-month) =====
    let prevWeek = compareWeek;
    let prevMonth: string | null = null;
    if (!prevWeek) {
      const currentPeriodIdx = allPeriods.findIndex(
        (p) => p.monthLabel === month && p.weekLabel === week
      );
      if (currentPeriodIdx > 0) {
        const prev = allPeriods[currentPeriodIdx - 1];
        prevWeek = prev.weekLabel;
        prevMonth = prev.monthLabel;
      }
    } else {
      if (compareMonthExplicit) {
        prevMonth = compareMonthExplicit;
      } else {
        const match = allPeriods.find((p) => p.weekLabel === prevWeek && p.monthLabel === month);
        if (match) {
          prevMonth = month;
        } else {
          const anyMatch = allPeriods.find((p) => p.weekLabel === prevWeek);
          prevMonth = anyMatch?.monthLabel || month;
        }
      }
    }

    // ===== BUG FIX #4: buildWhere accepts monthLabel parameter (for cross-month) =====
    let picOutletCodes: string[] | null = null;
    if (pic) {
      try {
        const picOutlets = await db.outletPIC.findMany({ where: { pic }, select: { outletCode: true } });
        picOutletCodes = picOutlets.map((p) => p.outletCode);
      } catch (e) {
        console.error('[analysis] OutletPIC query failed (table may not exist):', e instanceof Error ? e.message : String(e));
      }
    }
    const buildWhere = (wk: string, mLabel: string) => {
      const w: any = { monthLabel: mLabel, weekLabel: wk };
      if (area) w.area = area;
      if (outletCode) w.outlet = { code: outletCode };
      if (itemName) w.item = { name: { contains: itemName } };
      if (picOutletCodes && picOutletCodes.length > 0) {
        w.outlet = { ...(w.outlet || {}), code: { in: picOutletCodes } };
      }
      return w;
    };

    // Shared filter options for SQL aggregate queries
    const filterOpts = { area, outletCode, itemName, picOutletCodes };

    // ============================================================
    //  RAW RECORD FETCH — kept for rule evaluation only
    //  (buildRuleContext, evaluateRules, worklist, priorities,
    //   outletHealthRanking, historicalAnalysis, varianceAnalysis)
    //  Select only fields needed by rule engine + UI drilldown.
    // ============================================================
    const currentRecs = await db.inventoryRecord.findMany({
      where: buildWhere(week!, month!),
      include: { outlet: { select: { code: true, name: true, area: true } }, item: { select: { name: true } } },
    }) as RecWithRels[];

    let prevRecs: RecWithRels[] = [];
    if (prevWeek && prevMonth) {
      prevRecs = await db.inventoryRecord.findMany({
        where: buildWhere(prevWeek, prevMonth),
        include: { outlet: { select: { code: true, name: true, area: true } }, item: { select: { name: true } } },
      }) as RecWithRels[];
    }

    if (currentRecs.length === 0) {
      return NextResponse.json({
        success: false,
        message: `No records found for ${month} / ${week} with given filters.`,
      }, { status: 404 });
    }

    // Build previous-by-outlet-item map (for rule context + variance analysis)
    const prevByOutletItem = new Map<string, RecWithRels>();
    for (const r of prevRecs) {
      prevByOutletItem.set(`${r.outletId}|${r.itemId}`, r);
    }

    // ============================================================
    //  HISTORICAL STATS — Phase 4: SQL aggregate (was 540K raw records)
    //  queryHistoricalStats returns Map<outletId|itemId, {mean, stdDev, n}>
    //  Used by buildRuleContext for z-score calculation
    // ============================================================
    const currentPeriodIdx = allPeriods.findIndex(
      (p) => p.monthLabel === month && p.weekLabel === week
    );
    const historicalPeriods = currentPeriodIdx >= 0 ? allPeriods.slice(0, currentPeriodIdx) : [];
    const historicalByOutletItem = historicalPeriods.length > 0
      ? await queryHistoricalStats(historicalPeriods, filterOpts)
      : new Map<string, { mean: number; stdDev: number; n: number }>();

    // ===== Load runtime thresholds from DB (user-configurable via Settings) =====
    const thresholds = await getRuntimeThresholds();

    // ============================================================
    //  RULE EVALUATION LOOP (per-record, single pass)
    //  Still needs raw records — flags drive worklist, priorities,
    //  health ranking, historical analysis. Cannot be SQL-aggregated.
    // ============================================================
    let normal = 0, warning = 0, abnormal = 0;
    const ruleCategoryCounts = new Map<string, number>();
    const ruleCodeCounts = new Map<string, number>();
    const topAnomaliesForNarrative: Array<{
      itemName: string; outletCode: string; area: string;
      issue: string; absNominal: number; devBom: number | null; direction: string;
    }> = [];

    interface RecWithFlags {
      curr: RecWithRels;
      flags: ReturnType<typeof evaluateRules>;
    }
    const recsWithFlags: RecWithFlags[] = [];
    let zeroDevCount = 0;
    const zeroDevByOutlet = new Map<number, number>();

    for (const curr of currentRecs) {
      if (curr.qtyDeviasi === null || curr.qtyDeviasi === 0 || curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0) {
        normal++;
        zeroDevCount++;
        zeroDevByOutlet.set(curr.outletId, (zeroDevByOutlet.get(curr.outletId) ?? 0) + 1);
        continue;
      }

      const key = `${curr.outletId}|${curr.itemId}`;
      const prev = prevByOutletItem.get(key) ?? null;
      // Phase 4: historicalByOutletItem now contains precomputed stats (mean + stdDev)
      const historicalStats = historicalByOutletItem.get(key) ?? null;
      const ctx = buildRuleContext(curr, prev, historicalStats, thresholds);
      const flags = evaluateRules(ctx);

      recsWithFlags.push({ curr, flags });

      if (flags.length === 0) {
        normal++;
      } else {
        const top = flags[0];
        if (top.severity === 'ABNORMAL') abnormal++;
        else if (top.severity === 'WARNING') warning++;
        else normal++;

        ruleCategoryCounts.set(top.category, (ruleCategoryCounts.get(top.category) || 0) + 1);
        ruleCodeCounts.set(top.ruleCode, (ruleCodeCounts.get(top.ruleCode) || 0) + 1);

        if (topAnomaliesForNarrative.length < 5 && top.severity !== 'NORMAL') {
          topAnomaliesForNarrative.push({
            itemName: curr.item.name,
            outletCode: curr.outlet.code,
            area: curr.area,
            issue: top.ruleName,
            absNominal: curr.absNominalDeviasi ?? 0,
            devBom: curr.pctQtyDeviasiToBom,
            direction: curr.direction || 'NEUTRAL',
          });
        }
      }
    }

    const ruleBreakdown = {
      byCategory: Object.fromEntries(ruleCategoryCounts) as Record<string, number>,
      byRule: Object.fromEntries(ruleCodeCounts) as Record<string, number>,
    };

    // ============================================================
    //  SQL AGGREGATE QUERIES (Phase 1b/2/4)
    //  Each query replaces a JS loop over 35K+ records.
    //  All run in PostgreSQL — only minimal rows returned.
    // ============================================================

    // Executive Summary — 1 row each for current + previous period
    const currSummary = await queryExecSummary(week!, month!, filterOpts);
    const prevSummary = prevWeek && prevMonth
      ? await queryExecSummary(prevWeek, prevMonth, filterOpts)
      : null;
    const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month!, week!, prevWeek);

    // Top items by various metrics (N rows each)
    const topNominal = await queryTopItemsByNominal(week!, month!, filterOpts, 10);
    const topDevBom = await queryTopItemsByDevBom(week!, month!, filterOpts, 10);
    const topWasteRows = await queryTopItemsByCategory(week!, month!, filterOpts, 'waste', 10);
    const topWaste = topWasteRows.map(r => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyWaste: r.qty,
      nominalWaste: r.nominal,
    }));
    const topSusutRows = await queryTopItemsByCategory(week!, month!, filterOpts, 'susut', 10);
    const topSusut = topSusutRows.map(r => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtySusut: r.qty,
      nominalSusut: r.nominal,
    }));
    const topTrialRows = await queryTopItemsByCategory(week!, month!, filterOpts, 'trial', 10);
    const topTrial = topTrialRows.map(r => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyTrial: r.qty,
      nominalTrial: r.nominal,
    }));
    const topLossSurplusRows = await queryTopItemsByCategory(week!, month!, filterOpts, 'lossSurplus', 10);
    const topLossSurplus = topLossSurplusRows.map(r => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyLossSurplus: r.qty,
      nominalLossSurplus: r.nominal,
      direction: r.direction,
    }));

    // Top outlets (GROUP BY outlet) — needs areaAvg from areaAnalysis
    const areaAnalysisRaw = await queryAreaAnalysis(week!, month!, filterOpts);
    const areaAvgMap = new Map<string, number>(
      areaAnalysisRaw.map(a => [a.area, a.avgDevBom ?? 0])
    );
    const topOutletsRaw = await queryTopOutlets(week!, month!, filterOpts, 10);
    const topOut = topOutletsRaw.map(o => ({
      outletCode: o.outletCode,
      outletName: o.outletName,
      area: o.area,
      absNominal: o.absNominal,
      devBom: o.devBom,
      areaAvg: areaAvgMap.get(o.area) ?? 0,
      sales: o.sales,
      lossAmount: o.lossAmount,
      surplusAmount: o.surplusAmount,
      direction: o.direction,
    }));

    // Top outlets by sales — compute devToSalesRatio in JS (sales already dedup'd in SQL)
    const topOutletsSalesRaw = await queryTopOutletsBySales(week!, month!, filterOpts, 10);
    const topOutletsSales = topOutletsSalesRaw.map(o => ({
      outletCode: o.outletCode,
      outletName: o.outletName,
      area: o.area,
      sales: o.sales,
      absNominal: o.absNominal,
      devToSalesRatio: o.sales > 0 ? o.absNominal / o.sales : null,
    }));

    // Deviation Breakdown (single row)
    const breakdown = await queryDeviationBreakdown(week!, month!, filterOpts);

    // Loss vs Surplus (single row)
    const lvs = await queryLossVsSurplus(week!, month!, filterOpts);

    // Investigation worklist — use pre-computed flags (no re-evaluation)
    const worklist = buildWorklistFromFlags(recsWithFlags, thresholds);

    // ===== BUG FIX #5: Compute aggregate priceGrowth from total nominal/qty =====
    const currAvgPrice = execSummary.nominalDeviasi.current > 0 && execSummary.qtyDeviasi.current > 0
      ? execSummary.nominalDeviasi.current / execSummary.qtyDeviasi.current : null;
    const prevAvgPrice = execSummary.nominalDeviasi.previous != null && execSummary.qtyDeviasi.previous != null && execSummary.qtyDeviasi.previous > 0
      ? execSummary.nominalDeviasi.previous / execSummary.qtyDeviasi.previous : null;
    const priceGrowth = currAvgPrice != null && prevAvgPrice != null && prevAvgPrice !== 0
      ? (currAvgPrice - prevAvgPrice) / Math.abs(prevAvgPrice) : null;

    const growthMetrics = {
      salesGrowth: execSummary.sales.growth,
      bomGrowth: execSummary.qtyBom.growth,
      qtyDeviasiGrowth: execSummary.qtyDeviasi.growth,
      nominalDeviasiGrowth: execSummary.nominalDeviasi.growth,
      priceGrowth,
      deviationToSalesRatio: execSummary.sales.current > 0
        ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
      deviationToBomRatio: execSummary.deviationToBom,
    };

    // ===== BUG FIX #6: Stable DQ groupBy (no ambiguous orderBy) =====
    const dqIssuesRaw = await db.dQIssue.groupBy({
      by: ['code', 'severity', 'message'],
      where: { sourceFile: { monthLabel: month! } },
      _count: { _all: true },
    });
    const dqSummary = dqIssuesRaw
      .map((d) => ({
        code: d.code,
        severity: d.severity as 'ERROR' | 'WARNING' | 'INFO',
        message: d.message,
        count: d._count._all,
      }))
      .sort((a, b) => {
        const sevOrder = { ERROR: 0, WARNING: 1, INFO: 2 };
        return sevOrder[a.severity] - sevOrder[b.severity] || b.count - a.count;
      })
      .slice(0, 20);

    // ============================================================
    //  Trend — SQL aggregate (~18 rows), then JS sort by monthKey
    //  Replaces 540K-row raw fetch + JS groupBy
    // ============================================================
    const trendAggRows = await queryTrendAgg(filterOpts);
    const trend = trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: `${mk}|${r.weekLabel}`,
          devBom: r.devBom,
          sales: r.sales,
          nominal: r.nominal,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey, ...rest }) => rest);

    // Net Cost Trend — built from same queryTrendAgg result (no extra query)
    const netCostTrend = trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: `${mk}|${r.weekLabel}`,
          netCostRatio: r.sales > 0 ? (r.lossNominal - r.surplusNominal) / r.sales : 0,
          lossNominal: r.lossNominal,
          surplusNominal: r.surplusNominal,
          sales: r.sales,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey, ...rest }) => rest);

    // Narrative (LLM)
    const narrativeInput = {
      period: { monthLabel: month!, weekLabel: week!, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      executiveSummary: execSummary,
      growthMetrics,
      healthStatus: { normal, warning, abnormal },
      topAnomalies: topAnomaliesForNarrative,
      deviationBreakdown: breakdown,
      investigationCount: worklist.length,
    };
    const { narrative, source: narrativeSource } = await generateNarrative(narrativeInput);

    // Recommendations
    const recommendations = buildRecommendations(worklist);

    // Priorities (top 20) — use pre-computed flags
    const priorities = computePrioritiesFromFlags(recsWithFlags, thresholds).slice(0, 20);

    // ============================================================
    //  Extended analytics (SQL aggregate)
    // ============================================================
    const areaAnalysis = areaAnalysisRaw.map(a => ({
      area: a.area,
      outletCount: a.outletCount,
      totalSales: a.totalSales,
      totalAbsNominal: a.totalAbsNominal,
      avgDevBom: a.avgDevBom,
      lossToSales: a.lossToSales,
    }));

    const varianceAnalysis = computeVarianceAnalysis(currentRecs, prevByOutletItem);
    const outletHealthRanking = computeOutletHealthRanking(recsWithFlags, zeroDevByOutlet);

    // Pareto — SQL window function (Phase 4)
    const paretoSql = await queryPareto(week!, month!, filterOpts, 50);
    // Remap items to JS shape (cumPct decimal 0-1, drop rank/cumulative)
    const paretoItems = paretoSql.items.map(it => ({
      itemName: it.itemName,
      outletCode: it.outletCode,
      absNominal: it.absNominal,
      cumPct: it.cumulativePct / 100, // SQL returns 0-100, JS expects 0-1
    }));
    // Use full class A stats from SQL (computed across ALL items, not capped by LIMIT)
    const pareto = {
      classACount: paretoSql.classACountFull,
      classAPctOfCost: paretoSql.classAPctFull,
      totalItems: paretoSql.totalItems,
      totalAbsNominal: paretoSql.totalAbsNominal,
      items: paretoItems.slice(0, 20),
    };

    // Cost Impact — SQL aggregate + JS-style lossNominal/surplusNominal from lvs
    const costImpactSql = await queryCostImpact(week!, month!, execSummary.sales.current, filterOpts);
    const costImpact = {
      totalCost: costImpactSql.totalCost,
      pctOfSales: execSummary.sales.current > 0 ? costImpactSql.totalCost / execSummary.sales.current : null,
      lossNominal: lvs.lossNominal,
      surplusNominal: lvs.surplusNominal,
      // Detailed breakdown (additional fields, not used by current frontend but available)
      wasteCost: costImpactSql.wasteCost,
      susutCost: costImpactSql.susutCost,
      trialCost: costImpactSql.trialCost,
      residualCost: costImpactSql.residualCost,
      wasteToSales: costImpactSql.wasteToSales,
      susutToSales: costImpactSql.susutToSales,
      trialToSales: costImpactSql.trialToSales,
      residualToSales: costImpactSql.residualToSales,
    };

    // Item Consistency — SQL GROUP BY itemName with outlet count
    const consistencyItems = await queryItemConsistency(week!, month!, filterOpts);
    const systemic = consistencyItems
      .filter(i => i.consistency === 'SYSTEMIC')
      .map(i => ({
        itemName: i.itemName,
        outletCode: '',
        area: '',
        occurrences: i.outletCount,
        avgDevBom: i.avgDevBom,
        absNominal: i.totalAbsNominal,
      }));
    const episodic = consistencyItems
      .filter(i => i.consistency !== 'SYSTEMIC')
      .map(i => ({
        itemName: i.itemName,
        outletCode: '',
        area: '',
        absNominal: i.totalAbsNominal,
        devBom: i.avgDevBom,
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

    // Historical Analysis — uses recsWithFlags + historicalByOutletItem map
    const historicalAnalysis = computeHistoricalAnalysis(recsWithFlags, historicalByOutletItem);
    const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };

    const result = {
      success: true,
      period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      filters: { area, outletCode, itemName },
      executiveSummary: execSummary,
      healthStatus: { normal, warning, abnormal, breakdown: ruleBreakdown },
      dqStatus: {
        ok: dqSummary.filter((d) => d.severity === 'INFO').length,
        warnings: dqSummary.filter((d) => d.severity === 'WARNING').length,
        errors: dqSummary.filter((d) => d.severity === 'ERROR').length,
        issues: dqSummary,
      },
      growthComparison: growthComparisonWithHist,
      topItemsByNominal: topNominal,
      topItemsByDevBom: topDevBom,
      topOutlets: topOut,
      topOutletsBySales: topOutletsSales,
      topItemsByWaste: topWaste,
      topItemsBySusut: topSusut,
      topItemsByTrial: topTrial,
      topItemsByLossSurplus: topLossSurplus,
      deviationBreakdown: breakdown,
      lossVsSurplus: lvs,
      investigationWorklist: worklist,
      narrative,
      narrativeSource,
      recommendation: recommendations,
      trend,
      priorities,
      // Extended analytics (Task 5)
      areaAnalysis,
      varianceAnalysis,
      outletHealthRanking,
      pareto,
      costImpact,
      itemConsistencyAnalysis,
      netCostTrend,
      durationMs: Date.now() - startedAt,
    };

    analysisCache.set(cacheKey, result);

    await db.auditLog.create({
      data: {
        action: 'ANALYSIS',
        detail: `${month}/${week} vs ${prevWeek} | area=${area || 'ALL'} outlet=${outletCode || 'ALL'} | ${currentRecs.length} records`,
        duration: Date.now() - startedAt,
      },
    });

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('Analysis error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e), stack: e?.stack }, { status: 500 });
  }
}
