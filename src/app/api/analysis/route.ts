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
import { getRuntimeThresholds } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { calcGrowth, computePriceEffect, computeNominalDeviationGrowth } from '@/lib/metrics';
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
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
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
    qtyDeviasiLoss: number;
  } | null,
  prev: {
    sales: number; nominalDeviasi: number; qtyBom: number; qtyDeviasi: number;
    qtyWaste: number; qtySusut: number; qtyTrial: number; qtyLossSurplus: number;
    totalLoss: number; totalSurplus: number; residualLossQty: number; residualLossNominal: number;
    qtyDeviasiLoss: number;
  } | null,
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null,
): ExecutiveSummary {
  const c = curr ?? {
    sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0,
    qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0,
    residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0,
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
    nominalDeviasi: { current: c.nominalDeviasi, previous: nominalDeviasiPrev, growth: computeNominalDeviationGrowth(c.nominalDeviasi, nominalDeviasiPrev) },
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
    deviationToBom: c.qtyBom !== 0 ? c.qtyDeviasi / Math.abs(c.qtyBom) : null,
    residualLossQty: c.residualLossQty,
    // Bug 6 fix: use qtyDeviasiLoss (LOSS items only) as denominator, not
    // qtyDeviasi (ALL items incl SURPLUS). Previously, surplus items inflated
    // the denominator, making residual loss % appear smaller (healthier) than
    // reality. Now: residualLossPct = residualLossQty / qtyDeviasiLoss.
    residualLossPct: c.qtyDeviasiLoss > 0 ? c.residualLossQty / c.qtyDeviasiLoss : null,
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

    // Cache disabled — no need for thresholdsVersion in cache key
    // Client-side TanStack Query (staleTime 60s) provides sufficient caching

    // Determine available months/weeks if not specified
    let month = monthLabel;
    let week = currentWeek;
    if (!month || !week) {
      // FIX-A-5 (BUG-5-2): Order by Week.monthKey (YYYY-MM, chronologically sortable)
      // and Week.periodEnd (cumulative day-end: 7 < 14 < 21 < 25), NOT by
      // InventoryRecord.monthLabel which sorts Indonesian month names alphabetically
      // (SEPTEMBER > OKTOBER > NOVEMBER > MEI > ...). The old sort returned the
      // wrong "latest" period (e.g., September instead of December) when no query
      // params were supplied — dashboard showed stale month by default.
      const latest = await db.inventoryRecord.findFirst({
        orderBy: [
          { week: { monthKey: 'desc' } },
          { week: { periodEnd: 'desc' } },
        ],
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

    // ===== P1 fix: Pre-SQL metadata queries — ALL PARALLEL =====
    // weeks + sourceFiles + picOutlets (if pic) + thresholds — all independent
    const [weeksRaw, fileMonthKeys, picOutletCodesRaw, thresholds] = await Promise.all([
      db.week.findMany({
        select: { weekLabel: true, monthKey: true },
        distinct: ['monthKey', 'weekLabel'],
      }),
      db.sourceFile.findMany({
        select: { monthLabel: true, monthKey: true },
      }),
      pic
        ? db.outletPIC.findMany({ where: { pic }, select: { outletCode: true } })
            .then((r) => r.map((p) => p.outletCode))
            .catch((e) => {
              console.error('[analysis] OutletPIC query failed (table may not exist):', e instanceof Error ? e.message : String(e));
              return null;
            })
        : Promise.resolve(null),
      getRuntimeThresholds(),
    ]);
    const picOutletCodes = picOutletCodesRaw;
    const monthKeyByLabel = new Map(fileMonthKeys.map((f) => [f.monthLabel, f.monthKey]));
    const monthLabelByKey = new Map(fileMonthKeys.map((f) => [f.monthKey, f.monthLabel]));
    // BUG FIX (BUG-NORECORDS-4/5 / FIX-DEEP-1): Case-insensitive monthLabel resolution
    // via shared util `@/lib/month-resolver`. DB may have "AGUSTUS 2026" (from
    // upload-data.ts) or "Agustus 2026" (from dashboard import). User sends whichever
    // case the status API returned. Resolve to actual DB label to avoid
    // "No records found" due to case mismatch.
    const monthResolver = await getMonthResolver();
    // Resolve current + compare month labels to actual DB case
    month = resolveMonthLabel(month, monthResolver) || month;
    if (compareMonthExplicit) compareMonthExplicit = resolveMonthLabel(compareMonthExplicit, monthResolver) || compareMonthExplicit;
    // Note: prevMonth is computed later from allPeriods (which uses DB case) — no resolution needed.
    const allPeriods = weeksRaw
      .map((w) => {
        const ml = monthLabelByKey.get(w.monthKey) || 'Unknown';
        return {
          monthLabel: ml,
          weekLabel: w.weekLabel,
          monthKey: w.monthKey,
          sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // ===== FIX: Auto-previous = SAME weekLabel in chronologically previous month =====
    // Weeks are CUMULATIVE (W1=1-7, W2=1-14, W4=1-25). Comparing W4 vs W2 is NOT
    // apples-to-apples (25 days vs 14 days → always positive growth). Must compare
    // same weekLabel: W4 Juli vs W4 Juni, W2 Juli vs W2 Juni, etc.
    let prevWeek = compareWeek;
    let prevMonth: string | null = null;
    if (!prevWeek) {
      // Auto-compare: find same weekLabel in the most recent month BEFORE current
      prevWeek = week; // SAME week as current — compare W4 vs W4 (prev month)
      const currentPeriodIdx = allPeriods.findIndex(
        (p) => p.monthLabel === month && p.weekLabel === week
      );
      // Search backwards from current period for same weekLabel in a different month
      let foundMonth: string | null = null;
      const startIdx = currentPeriodIdx >= 0 ? currentPeriodIdx - 1 : allPeriods.length - 1;
      for (let i = startIdx; i >= 0; i--) {
        if (allPeriods[i].weekLabel === week && allPeriods[i].monthLabel !== month) {
          foundMonth = allPeriods[i].monthLabel;
          break;
        }
      }
      prevMonth = foundMonth;
      if (!prevMonth) {
        // No previous month with same week — fall back to chronological previous period
        if (currentPeriodIdx > 0) {
          const prev = allPeriods[currentPeriodIdx - 1];
          prevWeek = prev.weekLabel;
          prevMonth = prev.monthLabel;
        }
      }
    } else {
      // Manual compare — user specified a weekLabel
      if (compareMonthExplicit) {
        prevMonth = compareMonthExplicit;
      } else {
        // FIX (BUG 2): Find same weekLabel in most recent month BEFORE current
        // (exclude same month — was missing, caused W4 vs W2 same-month comparison)
        const currentIdx = allPeriods.findIndex(
          (p) => p.monthLabel === month && p.weekLabel === week
        );
        let foundMonth: string | null = null;
        const startIdx = currentIdx >= 0 ? currentIdx - 1 : allPeriods.length - 1;
        for (let i = startIdx; i >= 0; i--) {
          if (allPeriods[i].weekLabel === prevWeek && allPeriods[i].monthLabel !== month) {
            foundMonth = allPeriods[i].monthLabel;
            break;
          }
        }
        if (!foundMonth) {
          for (let i = (currentIdx >= 0 ? currentIdx + 1 : 0); i < allPeriods.length; i++) {
            if (allPeriods[i].weekLabel === prevWeek && allPeriods[i].monthLabel !== month) {
              foundMonth = allPeriods[i].monthLabel;
              break;
            }
          }
        }
        prevMonth = foundMonth || month;
      }
    }

    // ===== BUG FIX #4: buildWhere accepts monthLabel parameter (for cross-month) =====
    // BUG FIX (BUG-NORECORDS-1): add area/outletCode 'all' guards (was missing — caused
    // "No records found" if frontend sent 'all' as literal string).
    // BUG FIX (BUG-NORECORDS-2): case-insensitive itemName filter (mode: 'insensitive').
    const buildWhere = (wk: string, mLabel: string) => {
      const w: any = { monthLabel: mLabel, weekLabel: wk };
      if (area && area !== 'all') w.area = area;
      if (outletCode && outletCode !== 'all') w.outlet = { code: outletCode };
      if (itemName) w.item = { name: { contains: itemName, mode: 'insensitive' as any } };
      if (picOutletCodes && picOutletCodes.length > 0) {
        w.outlet = { ...(w.outlet || {}), code: { in: picOutletCodes } };
      }
      return w;
    };

    // Shared filter options for SQL aggregate queries
    const filterOpts = { area, outletCode, itemName, picOutletCodes };

    // ============================================================
    //  P1 fix: RAW RECORD FETCH + HISTORICAL STATS — ALL PARALLEL
    //  currentRecs + prevRecs + historicalByOutletItem are independent.
    //  Select only fields needed by rule engine + UI drilldown.
    //
    //  FIX: Historical periods now filter by SAME weekLabel only.
    //  Weeks are cumulative (W1=1-7, W2=1-14, W4=1-25). Z-Score baseline
    //  must compare W4 vs W4 (prev months), NOT W4 vs W1+W2+W4 (mixed).
    //  Mixed weeks inflate mean (W1 is smaller) → false positive Z-Score.
    // ============================================================
    const historicalPeriods = allPeriods.filter(
      (p) => p.weekLabel === week && p.monthLabel !== month
    ).filter((p) => {
      const current = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week);
      return !current || p.sortKey < current.sortKey;
    });

    const [currentRecs, prevRecs, historicalByOutletItem] = await Promise.all([
      db.inventoryRecord.findMany({
        where: buildWhere(week!, month!),
        include: { outlet: { select: { code: true, name: true, area: true } }, item: { select: { name: true } } },
      }) as Promise<RecWithRels[]>,
      prevWeek && prevMonth
        ? db.inventoryRecord.findMany({
            where: buildWhere(prevWeek, prevMonth),
            include: { outlet: { select: { code: true, name: true, area: true } }, item: { select: { name: true } } },
          }) as Promise<RecWithRels[]>
        : Promise.resolve([] as RecWithRels[]),
      historicalPeriods.length > 0
        ? queryHistoricalStats(historicalPeriods, filterOpts)
        : Promise.resolve(new Map<string, { mean: number; stdDev: number; n: number }>()),
    ]);

    if (currentRecs.length === 0) {
      return NextResponse.json({
        success: false,
        message: `No records found for ${month} / ${week} with given filters.`,
      }, { status: 404 });
    }

    // Build previous-by-outlet-item-akun map (for rule context + variance analysis)
    // FIX (BUG 4): Include akunPenyesuaian in key — schema natural key is
    // (weekId, outletId, itemId, akunPenyesuaian). Without akun, multi-akun items
    // get wrong prev record → wrong growth + false rule flags.
    const prevByOutletItem = new Map<string, RecWithRels>();
    for (const r of prevRecs) {
      prevByOutletItem.set(`${r.outletId}|${r.itemId}|${r.akunPenyesuaian ?? ''}`, r);
    }

    // thresholds already loaded in parallel block above

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
      // Bug fix: use && (AND) instead of || (OR) so items with price-only variance
      // (qtyDeviasi=0 but absNominalDeviasi>0) are NOT skipped as "normal".
      // Previously: if ANY field was 0/null, item was skipped → price anomalies missed.
      // Now: only skip if BOTH qty AND nominal are 0/null (truly no deviation).
      if ((curr.qtyDeviasi === null || curr.qtyDeviasi === 0) && (curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0)) {
        normal++;
        zeroDevCount++;
        zeroDevByOutlet.set(curr.outletId, (zeroDevByOutlet.get(curr.outletId) ?? 0) + 1);
        continue;
      }

      const key = `${curr.outletId}|${curr.itemId}|${curr.akunPenyesuaian ?? ''}`;
      const prev = prevByOutletItem.get(key) ?? null;
      // Phase 4: historicalByOutletItem now contains precomputed stats (mean + stdDev)
      // FIX: historicalByOutletItem map key is outletId|itemId (NOT outletId|itemId|akun
      // — historical stats are per outlet+item, not per akun). Previous code used the
      // same key as prevByOutletItem (which includes akun), causing lookup to ALWAYS
      // return null → zScore always null → all HISTORICAL_* rules never fired.
      const historicalStats = historicalByOutletItem.get(`${curr.outletId}|${curr.itemId}`) ?? null;
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
    //  SQL AGGREGATE QUERIES (Phase 1b/2/4) — PARALLEL (P0 fix)
    //  All independent queries run via Promise.all for ~50% speedup
    // ============================================================

    // Group 1: Exec summary (curr + prev) — independent, parallel
    const [currSummary, prevSummary] = await Promise.all([
      queryExecSummary(week!, month!, filterOpts),
      prevWeek && prevMonth ? queryExecSummary(prevWeek, prevMonth, filterOpts) : Promise.resolve(null),
    ]);
    const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month!, week!, prevWeek);

    // Group 2: All top items + breakdown + area + outlets + trend + pareto + cost + consistency — ALL independent
    // P2 fix: use thresholds.TOP_N_ITEMS / TOP_N_OUTLETS instead of hardcoded 10
    const topNItems = thresholds.TOP_N_ITEMS || 10;
    const topNOutlets = thresholds.TOP_N_OUTLETS || 10;
    const [
      topNominal, topDevBom,
      topWasteRows, topSusutRows, topTrialRows, topLossSurplusRows,
      areaAnalysisRaw, topOutletsRaw, topOutletsSalesRaw,
      breakdown, lvs,
      trendAggRows,
      paretoSql,
      costImpactSql,
      consistencyItems,
      dqIssuesRaw,
    ] = await Promise.all([
      queryTopItemsByNominal(week!, month!, filterOpts, topNItems),
      queryTopItemsByDevBom(week!, month!, filterOpts, topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'waste', topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'susut', topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'trial', topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'lossSurplus', topNItems),
      queryAreaAnalysis(week!, month!, filterOpts),
      queryTopOutlets(week!, month!, filterOpts, topNOutlets),
      queryTopOutletsBySales(week!, month!, filterOpts, topNOutlets),
      queryDeviationBreakdown(week!, month!, filterOpts),
      queryLossVsSurplus(week!, month!, filterOpts),
      queryTrendAgg({ ...filterOpts, weekLabel: week }),
      queryPareto(week!, month!, filterOpts, 50),
      queryCostImpact(week!, month!, execSummary.sales.current, filterOpts),
      queryItemConsistency(week!, month!, filterOpts),
      db.dQIssue.groupBy({
        by: ['code', 'severity', 'message'],
        where: { sourceFile: { monthLabel: month! } },
        _count: { _all: true },
      }),
    ]);

    // Map results (same as before, just from parallel results)
    const topWaste = topWasteRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyWaste: r.qty, nominalWaste: r.nominal }));
    const topSusut = topSusutRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtySusut: r.qty, nominalSusut: r.nominal }));
    const topTrial = topTrialRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyTrial: r.qty, nominalTrial: r.nominal }));
    const topLossSurplus = topLossSurplusRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction }));

    // Bug 5 fix: enrich deviationBreakdown with three-layer metrics
    // Master context #11: Gross / Explained (W+S+T) / Net (residual)
    const explainedTotal = (breakdown.waste ?? 0) + (breakdown.susut ?? 0) + (breakdown.trial ?? 0);
    const breakdownEnriched = {
      ...breakdown,
      explained: explainedTotal, // Layer 2: Waste + Susut + Trial
      explainedPct: breakdown.total > 0 ? explainedTotal / breakdown.total : null, // % of gross explained
      netPct: breakdown.total > 0 ? (breakdown.residual ?? 0) / breakdown.total : null, // % of gross that is net
    };

    const areaAvgMap = new Map<string, number>(areaAnalysisRaw.map(a => [a.area, a.avgDevBom ?? 0]));
    const topOut = topOutletsRaw.map(o => ({
      outletCode: o.outletCode, outletName: o.outletName, area: o.area,
      absNominal: o.absNominal, devBom: o.devBom, areaAvg: areaAvgMap.get(o.area) ?? 0,
      sales: o.sales, lossAmount: o.lossAmount, surplusAmount: o.surplusAmount, direction: o.direction,
    }));
    const topOutletsSales = topOutletsSalesRaw.map(o => ({
      outletCode: o.outletCode, outletName: o.outletName, area: o.area,
      sales: o.sales, absNominal: o.absNominal,
      devToSalesRatio: o.sales > 0 ? o.absNominal / o.sales : null,
    }));

    // Investigation worklist — use pre-computed flags (no re-evaluation)
    const worklist = buildWorklistFromFlags(recsWithFlags, thresholds);

    // ===== BUG FIX #5: Compute aggregate priceGrowth from total nominal/qty =====
    // Bug fix: previously checked `nominalDeviasi.current > 0` which caused null priceGrowth
    // when outlet has aggregate loss (negative nominal). Now only guard against qty=0 (division).
    const currAvgPrice = execSummary.qtyDeviasi.current != null && Math.abs(execSummary.qtyDeviasi.current) > 0
      ? execSummary.nominalDeviasi.current / execSummary.qtyDeviasi.current : null;
    // FIX (BUG 7): Guard against prev nominal being null — use null not 0.
    // Previously: (null ?? 0) / prevQtyDev = 0, which nullified priceEffect
    // via calcGrowth(currPrice, 0) = null. Now: null when prev nominal is null.
    const prevQtyDev = execSummary.qtyDeviasi.previous;
    const prevAvgPrice = (prevQtyDev != null && Math.abs(prevQtyDev) > 0 && execSummary.nominalDeviasi.previous != null)
      ? execSummary.nominalDeviasi.previous / prevQtyDev : null;

    // FIX (audit issue #11): Use computeNominalDeviationGrowth (magnitude) for
    // nominalDeviasi — signed calcGrowth is misleading when sign flips.
    // For -10M → -20M: signed gives -100% (decreasing), magnitude gives +100% (worsening).
    const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(
      execSummary.nominalDeviasi.current,
      execSummary.nominalDeviasi.previous ?? null,
    );

    // Phase 4: Use Metric Engine computePriceEffect for trend decomposition
    // FIX (audit issue #12): Multiplicative decomposition (exact, not additive)
    const priceEffectResult = computePriceEffect(
      nominalDeviasiGrowthMagnitude,    // nominalDeviasiGrowth (magnitude)
      execSummary.qtyBom.growth,        // bomGrowth (volume effect)
      currAvgPrice,                      // current average price
      prevAvgPrice,                      // previous average price
    );

    const growthMetrics = {
      salesGrowth: execSummary.sales.growth,
      bomGrowth: execSummary.qtyBom.growth,
      qtyDeviasiGrowth: execSummary.qtyDeviasi.growth,
      nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
      priceGrowth: priceEffectResult.priceGrowth,
      deviationToSalesRatio: execSummary.sales.current > 0
        ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
      deviationToBomRatio: execSummary.deviationToBom,
      // ===== Trend Decomposition (3-effect) — via Metric Engine computePriceEffect =====
      // Volume Effect = bomGrowth (how much volume changed)
      // Price Effect = priceGrowth (how much price changed)
      // Operational Effect = nominalDeviasiGrowth - volumeEffect - priceEffect (residual)
      volumeEffect: priceEffectResult.volumeEffect,
      priceEffect: priceEffectResult.priceEffect,
      operationalEffect: priceEffectResult.operationalEffect,
      // ===== Multi-Period Comparison =====
      // Built from trendAggRows (computed below, injected into growthComparison after)
      multiPeriodComparison: [] as Array<Record<string, unknown>>,
    };

    // DQ Summary (from parallel query result above)
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
    //  Trend — from parallel queryTrendAgg result above
    // ============================================================
    const trend = trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, "")) || 0).padStart(2, "0")}`,
          devBom: r.devBom,
          sales: r.sales,
          nominal: r.nominal,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey, ...rest }) => rest);

    // ===== Multi-Period Comparison — built from trendAggRows =====
    const multiPeriodComparison = trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          period: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, "")) || 0).padStart(2, "0")}`,
          sales: r.sales,
          bom: null, // BUG 2.7 fix: was `r.sales / r.devBom` which is dimensionally wrong
          deviation: r.nominal,
          absDeviation: r.nominal,
          devBomRatio: r.devBom,
          growthPct: null as number | null,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map((row, i, arr) => {
        // Calculate growth vs previous period (magnitude — handles negative deviation)
        if (i > 0) {
          row.growthPct = computeNominalDeviationGrowth(row.deviation, arr[i - 1].deviation);
        }
        const { sortKey, ...rest } = row;
        return rest;
      });
    // Inject into growthMetrics
    (growthMetrics as any).multiPeriodComparison = multiPeriodComparison;

    // Net Cost Trend — built from same queryTrendAgg result (no extra query)
    const netCostTrend = trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, "")) || 0).padStart(2, "0")}`,
          netCostRatio: r.sales > 0 ? (r.lossNominal - r.surplusNominal) / r.sales : 0,
          lossNominal: r.lossNominal,
          surplusNominal: r.surplusNominal,
          sales: r.sales,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey, ...rest }) => rest);

    // ============================================================
    //  P2 fix: Start LLM narrative EARLY (no await) — runs in background
    //  while CPU computations below execute on the event loop.
    //  narrativeInput only needs: execSummary, growthMetrics, healthStatus,
    //  topAnomalies, breakdown, worklist — all available now.
    //  Saves 2-5s by overlapping LLM network I/O with CPU work.
    // ============================================================
    const narrativeInput = {
      period: { monthLabel: month!, weekLabel: week!, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      executiveSummary: execSummary,
      growthMetrics,
      healthStatus: { normal, warning, abnormal },
      topAnomalies: topAnomaliesForNarrative,
      deviationBreakdown: breakdownEnriched,
      investigationCount: worklist.length,
    };
    const narrativePromise = generateNarrative(narrativeInput);

    // ============================================================
    //  P2 fix: CPU computations run WHILE LLM generates (parallel overlap)
    //  These are synchronous but don't block the in-flight LLM network call.
    //  Ordered heaviest-first to maximize overlap with LLM latency.
    // ============================================================
    const recommendations = buildRecommendations(worklist);
    const priorities = computePrioritiesFromFlags(recsWithFlags, thresholds).slice(0, 20);

    // ============================================================
    //  Extended analytics (SQL aggregate result mapping + CPU)
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
    const outletHealthRanking = computeOutletHealthRanking(recsWithFlags, zeroDevByOutlet, healthScoreWeights, healthScoreThresholds);

    // Pareto — from parallel query result above
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

    // Cost Impact — from parallel query result above
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

    // Item Consistency — from parallel query result above
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

    // ============================================================
    //  P2 fix: Await narrative AFTER all CPU work is done.
    //  By now LLM has been generating in the background for the entire
    //  duration of the CPU computations above — likely already resolved.
    // ============================================================
    const { narrative, source: narrativeSource } = await narrativePromise;

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
      deviationBreakdown: breakdownEnriched,
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

    // DISABLED: analysisCache.set — in-memory cache unreliable in serverless
    // Client-side TanStack Query handles caching (staleTime 60s)

    // ============================================================
    //  P2 fix: Fire-and-forget audit log — don't block response on DB write.
    //  Response is already assembled; audit log is non-critical telemetry.
    //  Saves ~50-100ms (DB round-trip) per request.
    // ============================================================
    db.auditLog.create({
      data: {
        action: 'ANALYSIS',
        detail: `${month}/${week} vs ${prevWeek} | area=${area || 'ALL'} outlet=${outletCode || 'ALL'} | ${currentRecs.length} records`,
        duration: Date.now() - startedAt,
      },
    }).catch((e) => {
      console.error('[analysis] Audit log write failed (non-blocking):', e instanceof Error ? e.message : String(e));
    });

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('Analysis error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
