// ============================================================
//  /api/analysis — main dashboard data endpoint
//  Query: ?month=&week=&compareWeek=&area=&outlet=&item=
//
//  Phase 1-4 egress optimization (Task 15):
//  - Raw record fetching kept ONLY for rule evaluation (currentRecs + prevRecs)
//  - All aggregation pushed to SQL via /lib/queries.ts (PostgreSQL)
//  - Historical stats computed via SQL GROUP BY (avoids 540K row fetch)
//  - Trend, exec summary, top items/outlets, etc. all SQL-aggregated
//  - Rule evaluation loop, worklist, priorities, health ranking, historical
//    analysis, variance analysis still use raw records (per-record logic)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { logger } from '@/lib/logger';
import { db } from '@/lib/db';
import {
  buildWorklistFromFlags,
  computeVarianceAnalysis,
  computeOutletHealthRanking,
  computeHistoricalAnalysis,
  detectPatterns,
} from '@/engine/analysis/analysis';
import type { AnomalyFlagResult } from '@/types/inventory';
import { getRuntimeThresholds } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { computeNominalDeviationGrowth, projectTrend } from '@/lib/metrics';
import {
  queryTrendAgg,
  queryExecSummary,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByCategory,
  queryTopItemsByDeviasiRank,
  queryTopOutlets,
  queryTopOutletsBySales,
  queryDeviationBreakdown,
  queryDeviationBreakdownDrivers,
  queryLossVsSurplus,
  queryAreaAnalysis,
  queryTrendByArea,
  type AreaTrendRow,
  queryCostImpact,
  queryItemConsistency,
  queryHistoricalStats,
} from '@/lib/queries';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { buildCacheKey, getCached, setCached, getInflight, setInflight } from '@/lib/aggregation-cache';
import { validateQuery, analysisQuerySchema } from '@/lib/validation';
// Phase 3: ExecutiveSummary type no longer needed here — buildExecSummaryFromSql
// moved to ./services/exec-summary.ts which imports it directly.
// Phase 3: extracted services
import { buildExecSummaryFromSql } from './services/exec-summary';
import { computeGrowthDrivers } from './services/growth-drivers';
import { computeDeviationDrivers } from './services/deviation-drivers';
import { buildTrend, buildMultiPeriodComparison, buildNetCostTrend } from './services/trend-builder';
import { evaluateRulesSql, evaluateHistoricalRulesJs, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX MIG-3/FUNC-1: heaviest route, needs >10s on Vercel Hobby

// FIX Medium #1: DB-level caching via AggregationCache table.
// TTL 5 minutes. Cache hit skips all 16 parallel SQL queries (~7s → <100ms).
// Cache invalidated on: ingest, settings change, direction migration (see those routes).
const ANALYSIS_CACHE_TTL_MS = 5 * 60 * 1000;

// OPTIMIZE-ANALYSIS: RecWithRels is the slim record shape declared in
// src/engine/analysis/types.ts. Both findMany queries below use `select`
// (not `include`) so Prisma only transfers the columns the engine reads —
// ~10 fewer columns × ~35K rows = meaningful payload + memory reduction.
type RecWithRels = import('@/engine/analysis/types').RecWithRels;

// Phase 3: buildExecSummaryFromSql moved to ./services/exec-summary.ts

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

    // Sprint 1: Zod input validation
    const validation = validateQuery(analysisQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

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

    // DB-level AggregationCache is checked below (FIX Medium #1).
    // No thresholdsVersion needed in cache key — settings invalidation clears all entries.

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

    // FIX M4 (AUDIT-5): Resolve month case BEFORE building cache key.
    // Previously, cache key was built with raw user input (e.g., "AGUSTUS 2026"),
    // then month was resolved to DB case (e.g., "Agustus 2026"). This caused
    // different cache keys for the same logical data → cache miss.
    // Now resolve first, then build key. getMonthResolver() is cached (~1ms).
    const monthResolverEarly = await getMonthResolver();
    if (month) month = resolveMonthLabel(month, monthResolverEarly) || month;
    if (compareMonthExplicit) compareMonthExplicit = resolveMonthLabel(compareMonthExplicit, monthResolverEarly) || compareMonthExplicit;

    // FIX Medium #1: DB-level cache check.
    // Try to read cached result BEFORE running the 16 parallel SQL queries.
    // Cache hit: <100ms response (vs 6-8s cold). TTL 5 min.
    const cacheKey = buildCacheKey({
      route: 'analysis',
      month, week,
      compareWeek: compareWeek ?? compareMonthExplicit,
      compareMonth: compareMonthExplicit,
      area, outletCode, itemName, pic,
    });

    // FIX M3 (AUDIT-5): Check in-flight Promise map (prevents cache stampede).
    // If another request for the same key is already computing, await its result.
    const inflight = getInflight<unknown>(cacheKey);
    if (inflight) {
      const inflightResult = await inflight;
      if (inflightResult && typeof inflightResult === 'object' && 'success' in inflightResult) {
        const r = inflightResult as Record<string, unknown>;
        r.cached = true;
        r.durationMs = Date.now() - startedAt;
        return NextResponse.json(r);
      }
    }

    const cached = await getCached<unknown>(cacheKey, ANALYSIS_CACHE_TTL_MS);
    if (cached && typeof cached === 'object' && 'success' in cached) {
      // Cache hit — return immediately with cached flag
      const cachedResult = cached as Record<string, unknown>;
      cachedResult.cached = true;
      cachedResult.durationMs = Date.now() - startedAt;
      return NextResponse.json(cachedResult);
    }

    // FIX M3 (AUDIT-5): Register in-flight Promise to prevent cache stampede.
    // Concurrent requests for the same key will await this Promise (checked
    // at the top of the handler via getInflight) instead of computing in parallel.
    let resolveComputation!: (v: unknown) => void;
    const computationPromise = new Promise<unknown>((resolve) => { resolveComputation = resolve; });
    setInflight(cacheKey, computationPromise);

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
        ? db.$queryRaw<Array<{ outletCode: string }>>`SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})`
            .then((r) => r.map((p) => p.outletCode))
            .catch((e) => {
              logger.error("OutletPIC query failed (table may not exist)", { error: e instanceof Error ? e.message : String(e) });
              return null;
            })
        : Promise.resolve(null),
      getRuntimeThresholds(),
    ]);
    const picOutletCodes = picOutletCodesRaw;
    const monthKeyByLabel = new Map(fileMonthKeys.map((f) => [f.monthLabel, f.monthKey]));
    const monthLabelByKey = new Map(fileMonthKeys.map((f) => [f.monthKey, f.monthLabel]));
    // BUG FIX (BUG-NORECORDS-4/5 / FIX-DEEP-1): Case-insensitive monthLabel resolution
    // NOTE: month resolution already done above (FIX M4) before cache key construction.
    // The call below is idempotent (re-resolving an already-resolved label is a no-op).
    const monthResolver = await getMonthResolver();
    // Resolve current + compare month labels to actual DB case (idempotent — already done above)
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
    const buildWhere = (wk: string, mLabel: string): Prisma.InventoryRecordWhereInput => {
      const w: Prisma.InventoryRecordWhereInput = { monthLabel: mLabel, weekLabel: wk };
      if (area && area !== 'all') w.area = area;
      if (itemName) w.item = { name: { contains: itemName, mode: 'insensitive' } };
      // FIX FILTER-2: PIC filter — case-insensitive (done in raw SQL above) + sentinel for empty list.
      // Combine with outletCode: if both set, outlet must be in PIC list (intersection).
      if (picOutletCodes !== null) {
        // PIC selected — filter to PIC's outlets (or sentinel if empty → 0 rows)
        let codes = picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'];
        // If outletCode also selected, intersect (outletCode must be in PIC list)
        if (outletCode && outletCode !== 'all') {
          codes = codes.includes(outletCode) ? [outletCode] : ['__NO_MATCH__'];
        }
        w.outlet = { code: { in: codes } };
      } else if (outletCode && outletCode !== 'all') {
        // Only outletCode selected (no PIC)
        w.outlet = { code: outletCode };
      }
      return w;
    };

    // Shared filter options for SQL aggregate queries
    // FIX FILTER-2: apply sentinel for empty PIC list (buildSqlFilters skips empty arrays)
    const filterOpts = {
      area,
      outletCode,
      itemName,
      picOutletCodes: picOutletCodes !== null
        ? (picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'])
        : null,
    };

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
      // OPTIMIZE-ANALYSIS: `select` (not `include`) — only the columns the
      // rule engine + downstream computations read. Drops ~10 columns
      // (id, sourceFileId, weekId, status, satuan, qtyCom, nominalWaste/
      // Susut/Trial, avgPrice, toleranceRaw, pct*ToBom except
      // pctQtyDeviasiToBom, residualNominal, bulan, bulan2, weekLabel,
      // monthLabel, createdAt) per row across ~35K rows.
      db.inventoryRecord.findMany({
        where: buildWhere(week!, month!),
        select: {
          outletId: true, itemId: true, akunPenyesuaian: true,
          qtyBom: true, qtyDeviasi: true, qtyWaste: true, qtySusut: true,
          qtyTrial: true, qtyLossSurplus: true,
          nominalDeviasi: true, nominalLossSurplus: true, nominalSales: true,
          absNominalDeviasi: true, absQtyDeviasi: true,
          absNominalLossSurplus: true, absQtyLossSurplus: true,
          pctQtyDeviasiToBom: true, tolerancePct: true, direction: true,
          residualQty: true, residualRatio: true,
          area: true,
          outlet: { select: { code: true, name: true, area: true } },
          item: { select: { name: true } },
        },
      }) as Promise<RecWithRels[]>,
      prevWeek && prevMonth
        ? db.inventoryRecord.findMany({
            where: buildWhere(prevWeek, prevMonth),
            select: {
              outletId: true, itemId: true, akunPenyesuaian: true,
              qtyBom: true, qtyDeviasi: true, qtyWaste: true, qtySusut: true,
              qtyTrial: true, qtyLossSurplus: true,
              nominalDeviasi: true, nominalLossSurplus: true, nominalSales: true,
              absNominalDeviasi: true, absQtyDeviasi: true,
              absNominalLossSurplus: true, absQtyLossSurplus: true,
              pctQtyDeviasiToBom: true, tolerancePct: true, direction: true,
              residualQty: true, residualRatio: true,
              area: true,
              outlet: { select: { code: true, name: true, area: true } },
              item: { select: { name: true } },
            },
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
    //  RULE EVALUATION — SQL-based (Sprint 3)
    //  Old: JS loop over 35K records, calling evaluateRules() per record
    //  New: Single SQL query evaluates 12 rules + JS evaluates 5 zScore rules
    //  Runs in PARALLEL with SQL aggregate queries (below)
    // ============================================================

    // Build recsWithFlags from SQL flags (will be populated after parallel queries)
    // For now, prepare the structure — actual flags come from evaluateRulesSql
    let normal = 0, warning = 0, abnormal = 0;
    const ruleCategoryCounts = new Map<string, number>();
    const ruleCodeCounts = new Map<string, number>();

    interface RecWithFlags {
      curr: RecWithRels;
      flags: AnomalyFlagResult[];
    }
    const recsWithFlags: RecWithFlags[] = [];
    let zeroDevCount = 0;
    const zeroDevByOutlet = new Map<number, number>();

    // Count zero-dev records (still needed for health ranking)
    for (const curr of currentRecs) {
      if ((curr.qtyDeviasi === null || curr.qtyDeviasi === 0) && (curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0)) {
        zeroDevCount++;
        zeroDevByOutlet.set(curr.outletId, (zeroDevByOutlet.get(curr.outletId) ?? 0) + 1);
      }
    }

    // Fire SQL rule evaluation in parallel with aggregate queries
    const sqlFlagsPromise = evaluateRulesSql(week!, month!, prevWeek, prevMonth, filterOpts, thresholds);

    // ============================================================
    //  SQL AGGREGATE QUERIES (Phase 1b/2/4) — PARALLEL (P0 fix)
    //  All independent queries run via Promise.all for ~50% speedup
    //  Sprint 3: sqlFlagsPromise runs in parallel with these queries
    // ============================================================

    // Group 1: Exec summary (curr + prev) — independent, parallel
    const [currSummary, prevSummary, sqlFlags] = await Promise.all([
      queryExecSummary(week!, month!, filterOpts),
      prevWeek && prevMonth ? queryExecSummary(prevWeek, prevMonth, filterOpts) : Promise.resolve(null),
      sqlFlagsPromise,
    ]);
    const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month!, week!, prevWeek);

    // Group 2: All top items + breakdown + area + outlets + trend + cost + consistency — ALL independent
    // P2 fix: use thresholds.TOP_N_ITEMS / TOP_N_OUTLETS instead of hardcoded 10
    const topNItems = thresholds.TOP_N_ITEMS || 10;
    const topNOutlets = thresholds.TOP_N_OUTLETS || 10;
    const [
      topNominal, topDevBom,
      topWasteRows, topSusutRows, topTrialRows, topLossSurplusRows,
      areaAnalysisRaw, topOutletsRaw, topOutletsSalesRaw,
      breakdown, lvs,
      trendAggRows,
      costImpactSql,
      consistencyItems,
      dqIssuesRaw,
      topDeviasiRank,
      deviationDriverRows,
      areaTrendRows,
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
      queryCostImpact(week!, month!, execSummary.sales.current, filterOpts),
      queryItemConsistency(week!, month!, filterOpts),
      db.dQIssue.groupBy({
        by: ['severity'],
        where: { sourceFile: { monthLabel: month! } },
        _count: { _all: true },
      }),
      queryTopItemsByDeviasiRank(week!, month!, filterOpts, 50),
      queryDeviationBreakdownDrivers(week!, month!, filterOpts),
      // NEW: area trend for AreaTrendChart (Dev/BOM% per area × period)
      queryTrendByArea({ ...filterOpts, weekLabel: week }),
    ]);

    // Map results (same as before, just from parallel results)
    const topWaste = topWasteRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyWaste: r.qty, nominalWaste: r.nominal }));
    const topSusut = topSusutRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtySusut: r.qty, nominalSusut: r.nominal }));
    const topTrial = topTrialRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyTrial: r.qty, nominalTrial: r.nominal }));
    const topLossSurplus = topLossSurplusRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction }));

    // OPTIMIZE-ANALYSIS: deviationBreakdown response is just the SQL aggregate
    // row (waste/susut/trial/residual/total). The `explained`/`explainedPct`/
    // `netPct` enrichment used to live here but no frontend component reads those
    // fields (Charts.tsx DeviationBreakdownChart + InsightsPanel.tsx #3 only use
    // waste/susut/trial/residual/total). export-report computes its own
    // enrichment inline if needed.

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

    // ============================================================
    //  POST-PROCESS RULE FLAGS (Sprint 3)
    //  1. Evaluate 5 zScore-based rules in JS (needs historicalByOutletItem map)
    //  2. Merge SQL flags + JS flags into a Map keyed by outletId|itemId|akun
    //  3. Build recsWithFlags from currentRecs + merged flags
    //  4. Count normal/warning/abnormal + ruleBreakdown
    // ============================================================
    const histFlags = evaluateHistoricalRulesJs(
      currentRecs.map(r => ({
        outletId: r.outletId, itemId: r.itemId, akunPenyesuaian: r.akunPenyesuaian,
        nominalLossSurplus: r.nominalLossSurplus, pctQtyDeviasiToBom: r.pctQtyDeviasiToBom,
      })),
      historicalByOutletItem,
      thresholds,
    );

    // Merge SQL + JS flags into a Map: key → flags[]
    const allFlags = [...sqlFlags, ...histFlags];
    const flagsByKey = new Map<string, SqlRuleFlag[]>();
    for (const flag of allFlags) {
      const key = `${flag.outletId}|${flag.itemId}|${flag.akunPenyesuaian ?? ''}`;
      if (!flagsByKey.has(key)) flagsByKey.set(key, []);
      flagsByKey.get(key)!.push(flag);
    }

    // Build recsWithFlags from currentRecs (skip zero-dev records)
    for (const curr of currentRecs) {
      if ((curr.qtyDeviasi === null || curr.qtyDeviasi === 0) && (curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0)) {
        continue; // skip zero-dev (already counted above)
      }
      const key = `${curr.outletId}|${curr.itemId}|${curr.akunPenyesuaian ?? ''}`;
      const rawFlags = flagsByKey.get(key) ?? [];
      // Sort by priority desc (same as JS evaluator)
      rawFlags.sort((a, b) => b.priority - a.priority);
      // Map to AnomalyFlagResult shape (with minimal fields — evidence/narrative
      // are not needed downstream since worklist only reads ruleCode/severity)
      const flags = rawFlags.map(f => ({
        ruleCode: f.ruleCode,
        ruleName: f.ruleCode, // minimal — full name not needed for health ranking
        severity: f.severity as 'NORMAL' | 'WARNING' | 'ABNORMAL',
        category: f.category,
        priority: f.priority,
        evidence: {} as Record<string, unknown>,
        narrative: '',
      }));
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
      }
    }

    const ruleBreakdown = {
      byCategory: Object.fromEntries(ruleCategoryCounts) as Record<string, number>,
      byRule: Object.fromEntries(ruleCodeCounts) as Record<string, number>,
    };

    // Investigation worklist — use pre-computed flags (no re-evaluation)
    const worklist = buildWorklistFromFlags(recsWithFlags, thresholds);

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
      // ===== Multi-Period Comparison =====
      // Built from trendAggRows (computed below, injected into growthComparison after)
      multiPeriodComparison: [] as Array<Record<string, unknown>>,
      // Phase 3: actual type is MultiPeriodPoint[] from services/trend-builder.ts.
      // Using Record<string, unknown> for forward-compat with the growthMetrics object.
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

    // ===== Multi-Period Comparison — built from trendAggRows =====
    const multiPeriodComparison = buildMultiPeriodComparison(trendAggRows, monthKeyByLabel);
    // Inject into growthMetrics
    growthMetrics.multiPeriodComparison = multiPeriodComparison as unknown as Array<Record<string, unknown>>;

    // Net Cost Trend — built from same queryTrendAgg result (no extra query)
    const netCostTrend = buildNetCostTrend(trendAggRows, monthKeyByLabel);

    // ============================================================
    //  CPU computations (LLM narrative removed — Task REMOVE-AI).
    // ============================================================

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
    //  Trend Projection (ANALYZE-BACKEND-2 — Feature 4)
    //  --------------------------------------------------------
    //  Linear projection of next period's |nominalDeviasi| based on
    //  the historical weekly trend. Reuses trendAggRows (already fetched)
    //  — no extra DB query. Sign convention: input uses signed nominal
    //  (LOSS = negative); projectTrend takes ABS internally.
    // ============================================================
    // FIX FORECAST-1: sort trendAggRows chronologically before projecting
    // (DB returns rows in arbitrary order; projectTrend needs chronological W1→W4)
    const trendProjection = projectTrend(
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

    // ============================================================
    //  Pattern Detection (ANALYZE-BACKEND-2 — Feature 5)
    //  --------------------------------------------------------
    //  Classifies systemic vs isolated vs area-level vs network-wide
    //  deviation patterns from existing analysis artifacts. No extra
    //  DB query — runs entirely on already-computed in-memory data.
    //
    //  totalOutlets = outletHealthRanking.length (universe of outlets
    //  with at least one evaluated item this period). Slight under-count
    //  for outlets where ALL items are zero-dev, but those are rare and
    //  irrelevant for systemic-pattern detection.
    // ============================================================
    const patterns = detectPatterns({
      outletHealthRanking: outletHealthRanking.map((o) => ({
        outletCode: o.outletCode,
        outletName: o.outletName,
        area: o.area,
        healthScore: o.healthScore,
        normal: o.normal,
        warning: o.warning,
        abnormal: o.abnormal,
        absNominal: o.absNominal,
        nominalDeviasi: o.nominalDeviasi, // FIX: SIGNED sum for display
        devBom: o.devBom,
        sales: o.sales,
      })),
      itemConsistency: itemConsistencyAnalysis.items.map((i) => ({
        itemName: i.itemName,
        outletCount: i.outletCount,
        totalAbsNominal: i.totalAbsNominal,
        avgDevBom: i.avgDevBom,
        consistency: i.consistency,
      })),
      areaAnalysis: areaAnalysis.map((a) => ({
        area: a.area,
        outletCount: a.outletCount,
        totalSales: a.totalSales,
        totalAbsNominal: a.totalAbsNominal,
        avgDevBom: a.avgDevBom,
        lossToSales: a.lossToSales,
      })),
      totalOutlets: outletHealthRanking.length,
    });

    // ============================================================
    //  Growth Drivers — Pareto 80% analysis per metric
    //  Phase 3: extracted to services/growth-drivers.ts
    // ============================================================
    const growthDrivers = computeGrowthDrivers(currentRecs, prevRecs);

    // ============================================================
    //  Deviation Drivers — Pareto 80% per deviation category
    //  Phase 3: extracted to services/deviation-drivers.ts
    // ============================================================
    const deviationDrivers = computeDeviationDrivers(deviationDriverRows);

    const result = {
      success: true,
      period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      filters: { area, outletCode, itemName },
      executiveSummary: execSummary,
      healthStatus: { normal, warning, abnormal, breakdown: ruleBreakdown },
      // OPTIMIZE-ANALYSIS: only `errors` + `warnings` are read by the frontend
      // (ExecutiveSummary.tsx). `ok` and `issues` were dead — dropped.
      dqStatus: {
        errors: dqSeverityCounts.get('ERROR') ?? 0,
        warnings: dqSeverityCounts.get('WARNING') ?? 0,
      },
      growthComparison: growthComparisonWithHist,
      topItemsByNominal: topNominal,
      topItemsByDevBom: topDevBom,
      topOutlets: topOut,
      topOutletsBySales: topOutletsSales,
      growthDrivers, // FIX: Pareto 80% drivers per metric
      deviationDrivers, // NEW: 80% Pareto per deviation category (waste/susut/trial/residual)
      topItemsByWaste: topWaste,
      topItemsBySusut: topSusut,
      topItemsByTrial: topTrial,
      topItemsByLossSurplus: topLossSurplus,
      topDeviasiRank,
      deviationBreakdown: breakdown,
      lossVsSurplus: lvs,
      // FIX: removed investigationWorklist (56KB dead field — never consumed by frontend)
      // investigationWorklist: worklist,
      trend,
      // Extended analytics (Task 5)
      areaAnalysis,
      varianceAnalysis,
      outletHealthRanking,
      costImpact,
      itemConsistencyAnalysis,
      netCostTrend,
      // NEW: area trend for AreaTrendChart (Dev/BOM% per area × period)
      areaTrend: areaTrendRows as AreaTrendRow[],
      // ANALYZE-BACKEND-2: trend projection + cross-outlet pattern detection
      trendProjection,
      patterns,
      durationMs: Date.now() - startedAt,
    };

    // FIX Medium #1: DB-level AggregationCache is ENABLED (see getCached/setCached above).
    // In-memory analysisCache is disabled (unreliable in serverless).

    // FIX Medium #1: Store result in DB cache (fire-and-forget, non-blocking).
    // Next request with same filter params will hit cache (<100ms vs 6-8s).
    setCached(cacheKey, result);

    // FIX M3: Resolve the in-flight Promise so concurrent requests get the result.
    resolveComputation(result);

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
      logger.error("Audit log write failed (non-blocking)", { error: e instanceof Error ? e.message : String(e) });
    });

    return NextResponse.json(result);
  } catch (e: unknown) {
    logger.error('Analysis error', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
