// ============================================================
//  /api/analysis — main dashboard data endpoint
//  Query: ?month=&week=&compareWeek=&area=&outlet=&item=
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  buildExecutiveSummary,
  topItemsByNominal,
  topItemsByDevBom,
  topOutlets,
  topOutletsBySales,
  topItemsByWaste,
  topItemsBySusut,
  topItemsByTrial,
  topItemsByLossSurplus,
  deviationBreakdown,
  lossVsSurplus,
  buildWorklistFromFlags,
  buildTrend,
  computePrioritiesFromFlags,
  buildRuleContext,
  computeAreaAnalysis,
  computeVarianceAnalysis,
  computeOutletHealthRanking,
  computePareto,
  computeCostImpact,
  computeItemConsistencyAnalysis,
  computeNetCostTrend,
  computeHistoricalAnalysis,
} from '@/engine/analysis/analysis';
import { evaluateRules } from '@/engine/rules/evaluator';
import { generateNarrative, buildRecommendations } from '@/engine/narrative/narrative';
import { analysisCache } from '@/lib/cache';
import { getRuntimeThresholds } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';

export const dynamic = 'force-dynamic';

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

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
    const thresholdsVersion = await db.setting.count();
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

    // ===== BUG FIX #2: build chronological global week list (cross-month) =====
    // Get ALL (monthLabel, weekLabel) combinations in DB, sorted chronologically
    // by monthKey then weekLabel.
    const allPeriodsRaw = await db.inventoryRecord.findMany({
      select: { monthLabel: true, weekLabel: true },
      distinct: ['monthLabel', 'weekLabel'],
    });
    // Join with SourceFile to get monthKey for sorting
    const fileMonthKeys = await db.sourceFile.findMany({
      select: { monthLabel: true, monthKey: true },
    });
    const monthKeyByLabel = new Map(fileMonthKeys.map((f) => [f.monthLabel, f.monthKey]));
    const allPeriods = allPeriodsRaw
      .map((p) => ({
        monthLabel: p.monthLabel,
        weekLabel: p.weekLabel,
        monthKey: monthKeyByLabel.get(p.monthLabel) || '0000-00',
        sortKey: `${monthKeyByLabel.get(p.monthLabel) || '0000-00'}|${p.weekLabel}`,
      }))
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
      // User explicitly chose a compareWeek
      if (compareMonthExplicit) {
        // Cross-month compare via "WEEK|||Month" format
        prevMonth = compareMonthExplicit;
      } else {
        // Same-week-label could exist in multiple months — prefer current month, else first match
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
    // If PIC filter is set, resolve to list of outlet codes assigned to that PIC
    let picOutletCodes: string[] | null = null;
    if (pic) {
      try {
        const picOutlets = await db.outletPIC.findMany({ where: { pic }, select: { outletCode: true } });
        picOutletCodes = picOutlets.map((p) => p.outletCode);
      } catch (e) {
        // Bug 6 fix: log error instead of silent swallow
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

    // ===== OPTIMIZATION: Only select fields we actually need (not full include) =====
    // This dramatically reduces memory usage for large datasets (50k+ rows per week)
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

    // Build previous-by-outlet-item map
    const prevByOutletItem = new Map<string, RecWithRels>();
    for (const r of prevRecs) {
      prevByOutletItem.set(`${r.outletId}|${r.itemId}`, r);
    }

    // ===== BUG FIX #7: Historical = all periods chronologically BEFORE current (cross-month) =====
    const historicalByOutletItem = new Map<string, number[]>();
    const currentPeriodIdx = allPeriods.findIndex(
      (p) => p.monthLabel === month && p.weekLabel === week
    );
    const historicalPeriods = currentPeriodIdx >= 0 ? allPeriods.slice(0, currentPeriodIdx) : [];

    if (historicalPeriods.length > 0) {
      // Build OR conditions for each (month, week) pair
      const orConds = historicalPeriods.map((p) => ({
        monthLabel: p.monthLabel,
        weekLabel: p.weekLabel,
      }));
      const baseWhere: any = { OR: orConds };
      if (area) baseWhere.area = area;
      if (outletCode) baseWhere.outlet = { code: outletCode };
      if (itemName) baseWhere.item = { name: { contains: itemName } };

      const histRecs = await db.inventoryRecord.findMany({
        where: baseWhere,
        select: { outletId: true, itemId: true, pctQtyDeviasiToBom: true, qtyBom: true, monthLabel: true, weekLabel: true },
      });
      // Sort by chronological order to keep history meaningful
      const periodOrder = new Map(historicalPeriods.map((p, i) => [`${p.monthLabel}|${p.weekLabel}`, i]));
      const grouped = new Map<string, Array<{ val: number; ord: number }>>();
      for (const r of histRecs) {
        if (r.pctQtyDeviasiToBom == null || r.qtyBom === 0) continue;
        const k = `${r.outletId}|${r.itemId}`;
        const ord = periodOrder.get(`${r.monthLabel}|${r.weekLabel}`) ?? 0;
        const arr = grouped.get(k) ?? [];
        arr.push({ val: r.pctQtyDeviasiToBom, ord });
        grouped.set(k, arr);
      }
      for (const [k, arr] of grouped) {
        arr.sort((a, b) => a.ord - b.ord);
        historicalByOutletItem.set(k, arr.map((x) => x.val));
      }
    }

    // Compute analysis
    const execSummary = buildExecutiveSummary(currentRecs, prevRecs, month!, week!, prevWeek);

    // ===== Load runtime thresholds from DB (user-configurable via Settings) =====
    const thresholds = await getRuntimeThresholds();

    // ===== OPTIMIZATION: Evaluate rules ONCE per record, reuse for health/worklist/priorities =====
    // Also skip records with zero/null deviation (no point evaluating rules on zero deviation)
    let normal = 0, warning = 0, abnormal = 0;
    const ruleCategoryCounts = new Map<string, number>();
    const ruleCodeCounts = new Map<string, number>();
    const topAnomaliesForNarrative: Array<{
      itemName: string; outletCode: string; area: string;
      issue: string; absNominal: number; devBom: number | null; direction: string;
    }> = [];

    // Pre-compute rule evaluation results for ALL records (single pass)
    interface RecWithFlags {
      curr: RecWithRels;
      flags: ReturnType<typeof evaluateRules>;
    }
    const recsWithFlags: RecWithFlags[] = [];
    let zeroDevCount = 0;
    // Track zero-deviation records per outlet (for outlet health ranking)
    const zeroDevByOutlet = new Map<number, number>();

    for (const curr of currentRecs) {
      // Skip records with zero/null deviation — they're "normal" by definition
      if (curr.qtyDeviasi === null || curr.qtyDeviasi === 0 || curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0) {
        normal++;
        zeroDevCount++;
        zeroDevByOutlet.set(curr.outletId, (zeroDevByOutlet.get(curr.outletId) ?? 0) + 1);
        continue;
      }

      const key = `${curr.outletId}|${curr.itemId}`;
      const prev = prevByOutletItem.get(key) ?? null;
      const historical = historicalByOutletItem.get(key) ?? [];
      const ctx = buildRuleContext(curr, prev, historical, thresholds);
      const flags = evaluateRules(ctx);

      recsWithFlags.push({ curr, flags });

      if (flags.length === 0) {
        normal++;
      } else {
        const top = flags[0];
        if (top.severity === 'ABNORMAL') abnormal++;
        else if (top.severity === 'WARNING') warning++;
        else normal++;

        // Track rule category breakdown for Health & Alert panel
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

    // Build health breakdown object
    const ruleBreakdown = {
      byCategory: Object.fromEntries(ruleCategoryCounts) as Record<string, number>,
      byRule: Object.fromEntries(ruleCodeCounts) as Record<string, number>,
    };

    // Top items
    const topNominal = topItemsByNominal(currentRecs, 10);
    const topDevBom = topItemsByDevBom(currentRecs, 10);
    const topOut = topOutlets(currentRecs, 10);

    // ===== Card drill-down data: top 10 by each metric =====
    const topOutletsSales = topOutletsBySales(currentRecs, 10);
    const topWaste = topItemsByWaste(currentRecs, 10);
    const topSusut = topItemsBySusut(currentRecs, 10);
    const topTrial = topItemsByTrial(currentRecs, 10);
    const topLossSurplus = topItemsByLossSurplus(currentRecs, 10);

    // Deviation breakdown
    const breakdown = deviationBreakdown(currentRecs);

    // Loss vs Surplus
    const lvs = lossVsSurplus(currentRecs);

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

    // Trend — use lightweight aggregation query
    // BUG FIX #001: Sales must be deduplicated per outlet (not summed across item rows)
    // BUG FIX #002: DevBom must use sum of ABSOLUTE pctQtyDeviasiToBom, not abs(sum)
    //   because LOSS (+) and SURPLUS (-) cancel out when summed, making devBom look smaller
    const trendWhere: any = {};
    if (area) trendWhere.area = area;
    if (outletCode) trendWhere.outlet = { code: outletCode };
    if (itemName) trendWhere.item = { name: { contains: itemName } };

    // Fetch records for trend (only needed fields, lightweight)
    // We need per-outlet dedup for sales, and per-record abs for devBom
    // Also fetch signed nominalDeviasi for net cost trend (LOSS - SURPLUS)
    const trendRecs = await db.inventoryRecord.findMany({
      where: trendWhere,
      select: {
        monthLabel: true, weekLabel: true,
        nominalSales: true, absNominalDeviasi: true,
        pctQtyDeviasiToBom: true, qtyBom: true,
        nominalDeviasi: true,
        outletId: true,
      },
    });

    // Group by (monthLabel, weekLabel) and compute metrics
    const trendByPeriod = new Map<string, {
      monthLabel: string; weekLabel: string; sortKey: string;
      salesByOutlet: Map<number, number>; // dedup sales per outlet
      nominal: number; devBomSum: number; devBomCount: number;
    }>();

    for (const r of trendRecs) {
      const k = `${r.monthLabel}|${r.weekLabel}`;
      const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
      const sortKey = `${mk}|${r.weekLabel}`;
      let period = trendByPeriod.get(k);
      if (!period) {
        period = {
          monthLabel: r.monthLabel, weekLabel: r.weekLabel, sortKey,
          salesByOutlet: new Map(), nominal: 0, devBomSum: 0, devBomCount: 0,
        };
        trendByPeriod.set(k, period);
      }
      // Sales: take MAX per outlet (not first non-null, not sum)
      if (r.nominalSales != null && r.nominalSales > 0) {
        const existing = period.salesByOutlet.get(r.outletId) ?? 0;
        if (r.nominalSales > existing) period.salesByOutlet.set(r.outletId, r.nominalSales);
      }
      period.nominal += r.absNominalDeviasi ?? 0;
      // BUG FIX #002: Use ABSOLUTE value of pctQtyDeviasiToBom for averaging
      if (r.pctQtyDeviasiToBom != null && r.qtyBom !== 0) {
        period.devBomSum += Math.abs(r.pctQtyDeviasiToBom);
        period.devBomCount++;
      }
    }

    const trend = [...trendByPeriod.values()]
      .map((p) => {
        // Sum deduplicated sales
        let sales = 0;
        for (const v of p.salesByOutlet.values()) sales += v;
        return {
          weekLabel: `${p.weekLabel} ${p.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: p.sortKey,
          devBom: p.devBomCount > 0 ? p.devBomSum / p.devBomCount : 0,
          sales,
          nominal: p.nominal,
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

    // ===== Extended analytics (Task 5): area, variance, outlet health, pareto, cost, consistency, net cost trend, historical =====
    const areaAnalysis = computeAreaAnalysis(currentRecs);
    const varianceAnalysis = computeVarianceAnalysis(currentRecs, prevByOutletItem);
    const outletHealthRanking = computeOutletHealthRanking(recsWithFlags, zeroDevByOutlet);
    const pareto = computePareto(currentRecs);
    const costImpact = computeCostImpact(currentRecs, execSummary.sales.current);
    const itemConsistencyAnalysis = computeItemConsistencyAnalysis(
      currentRecs, historicalByOutletItem, historicalPeriods.length
    );
    const netCostTrend = computeNetCostTrend(trendRecs, monthKeyByLabel);
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
