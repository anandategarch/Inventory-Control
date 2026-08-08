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
  deviationBreakdown,
  lossVsSurplus,
  buildWorklistFromFlags,
  buildTrend,
  computePrioritiesFromFlags,
  buildRuleContext,
} from '@/engine/analysis/analysis';
import { evaluateRules } from '@/engine/rules/evaluator';
import { generateNarrative, buildRecommendations } from '@/engine/narrative/narrative';
import { analysisCache } from '@/lib/cache';
import { getRuntimeThresholds } from '@/lib/settings';
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';

export const dynamic = 'force-dynamic';

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const monthLabel = url.searchParams.get('month');
    const currentWeek = url.searchParams.get('week');
    const compareWeekRaw = url.searchParams.get('compareWeek');
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outlet');
    const itemName = url.searchParams.get('item');

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
    const cacheKey = `analysis|${monthLabel}|${currentWeek}|${compareWeek}|${compareMonthExplicit}|${area}|${outletCode}|${itemName}|tv${thresholdsVersion}`;
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
    const buildWhere = (wk: string, mLabel: string) => {
      const w: any = { monthLabel: mLabel, weekLabel: wk };
      if (area) w.area = area;
      if (outletCode) w.outlet = { code: outletCode };
      if (itemName) w.item = { name: { contains: itemName } };
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

    for (const curr of currentRecs) {
      // Skip records with zero/null deviation — they're "normal" by definition
      if (curr.qtyDeviasi === null || curr.qtyDeviasi === 0 || curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0) {
        normal++;
        zeroDevCount++;
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

    // Trend — use lightweight aggregation query instead of loading all records
    // OPTIMIZATION: Use Prisma groupBy to aggregate at DB level (much faster, less memory)
    const trendWhere: any = {};
    if (area) trendWhere.area = area;
    if (outletCode) trendWhere.outlet = { code: outletCode };
    if (itemName) trendWhere.item = { name: { contains: itemName } };
    const trendAgg = await db.inventoryRecord.groupBy({
      by: ['monthLabel', 'weekLabel'],
      where: trendWhere,
      _sum: {
        nominalSales: true,
        absNominalDeviasi: true,
        qtyBom: true,
        pctQtyDeviasiToBom: true,
      },
      _count: { _all: true },
    });
    const trend = trendAgg
      .map((t) => {
        const mk = monthKeyByLabel.get(t.monthLabel) || '0000-00';
        return {
          weekLabel: `${t.weekLabel} ${t.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: `${mk}|${t.weekLabel}`,
          devBom: t._count._all > 0 && t._sum.pctQtyDeviasiToBom != null
            ? Math.abs(t._sum.pctQtyDeviasiToBom) / t._count._all : 0,
          sales: t._sum.nominalSales ?? 0,
          nominal: t._sum.absNominalDeviasi ?? 0,
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
      growthComparison: growthMetrics,
      topItemsByNominal: topNominal,
      topItemsByDevBom: topDevBom,
      topOutlets: topOut,
      deviationBreakdown: breakdown,
      lossVsSurplus: lvs,
      investigationWorklist: worklist,
      narrative,
      narrativeSource,
      recommendation: recommendations,
      trend,
      priorities,
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
