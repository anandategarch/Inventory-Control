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
  detectPatterns,
} from '@/engine/analysis/analysis';
import { getRuntimeThresholds } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { computeNominalDeviationGrowth, projectTrend, calcZScoreFromStats, computeHealthScore, computeDevBomAggregate, computeResidualPctAggregate, computeLossToSales, type AggregateInput, type HealthScoreWeights, type HealthScoreThresholds } from '@/lib/metrics';
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
  queryOutletHealthRanking,
  queryVarianceAnalysis,
  queryHistoricalCriticalItems,
  queryParetoByDevBom,
} from '@/lib/queries';
import { queryGrowthDrivers } from '@/lib/queries/growth-drivers';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
// FIX (BUG-PERF-4): use shared kelompok resolver instead of inline fetch-all + JS filter
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { buildCacheKey, getCached, setCached, getInflight, setInflight } from '@/lib/aggregation-cache';
import { validateQuery, analysisQuerySchema } from '@/lib/validation';
// Phase 3: ExecutiveSummary type no longer needed here — buildExecSummaryFromSql
// moved to ./services/exec-summary.ts which imports it directly.
// Phase 3: extracted services
import { buildExecSummaryFromSql } from './services/exec-summary';
import { computeDeviationDrivers } from './services/deviation-drivers';
import { buildTrend, buildMultiPeriodComparison, buildNetCostTrend } from './services/trend-builder';
import { evaluateRulesSql, evaluateHistoricalRulesJs, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // FIX: 60→120 — heavy queries with outlet filter can take 40-60s

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
  // FIX (DEEP-AUDIT-ZEROS): declare outside try so catch block can access it.
  // If the computation throws, we reject the in-flight Promise so concurrent
  // requests don't hang forever.
  let rejectComputation: ((e: unknown) => void) | undefined;
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
    const kelompok = url.searchParams.get('kelompok');
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
    // FIX (BUG-KELOMPOK-CACHE): kelompok is now part of the cache key — without it,
    // requests with different kelompok filters would share a cache entry (cache poisoning).
    const cacheKey = buildCacheKey({
      route: 'analysis',
      month, week,
      compareWeek: compareWeek ?? compareMonthExplicit,
      compareMonth: compareMonthExplicit,
      area, kelompok, outletCode, itemName, pic,
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
    // FIX (DEEP-AUDIT-ZEROS): also capture reject — if the computation throws,
    // the in-flight Promise must reject so concurrent requests don't hang forever
    // (previously only resolve was captured, so errors left the Promise pending
    // indefinitely → concurrent requests waited forever → dashboard stuck/0s).
    let resolveComputation!: (v: unknown) => void;
    const computationPromise = new Promise<unknown>((resolve, reject) => {
      resolveComputation = resolve;
      rejectComputation = reject;
    });
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
    // FIX (BUG-KELOMPOK-EMPTY): add kelompok filter so currSlim (rule evaluation)
    // also respects the kelompok dropdown. Without this, rule flags (NORMAL/WARNING/
    // ABNORMAL) and health ranking counts would include ALL outlets, contradicting
    // the SQL aggregates (which DO filter by kelompok via buildSqlFilters).
    const buildWhere = (wk: string, mLabel: string): Prisma.InventoryRecordWhereInput => {
      const w: Prisma.InventoryRecordWhereInput = { monthLabel: mLabel, weekLabel: wk };
      if (area && area !== 'all') w.area = area;
      if (itemName) w.item = { name: { contains: itemName, mode: 'insensitive' } };
      // Kelompok: filter outlet by code prefix (last dot-segment, first 3 chars).
      // Prisma startsWith on 'code' won't work (kelompok is in the middle/end),
      // so we resolve kelompok → list of outlet codes first via a sub-query.
      // Cheaper: use Prisma's relation filter with a startsWith on the LAST segment.
      // Since Prisma can't easily express "LEFT(SUBSTRING(code, '[^.]+$'),3) = X",
      // we resolve outlet codes here.
      // FIX: deferred resolution — we compute kelompokOutletIds once below (after
      // this function definition) and reference via closure. See kelompokOutletIds.
      // FIX (BUG-BE-9): removed dead `kelompokOutletCodes !== null` check — it's
      // always an array (never null). The empty-array check below handles the
      // "no outlets match" case.
      if (kelompok && kelompok !== 'all') {
        if (kelompokOutletCodes.length === 0) {
          // kelompok selected but no outlets match — sentinel to return 0 rows
          w.outlet = { code: { in: ['__NO_MATCH__'] } };
        } else {
          // Intersect with PIC/outletCode filters if both set
          if (picOutletCodes !== null) {
            const picCodes = picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'];
            const intersect = kelompokOutletCodes.filter((c: string) => picCodes.includes(c));
            w.outlet = { code: { in: intersect.length > 0 ? intersect : ['__NO_MATCH__'] } };
          } else if (outletCode && outletCode !== 'all') {
            w.outlet = { code: kelompokOutletCodes.includes(outletCode) ? outletCode : '__NO_MATCH__' };
          } else {
            w.outlet = { code: { in: kelompokOutletCodes } };
          }
        }
      } else if (picOutletCodes !== null) {
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

    // FIX (BUG-KELOMPOK-EMPTY): resolve kelompok → outlet codes ONCE for buildWhere.
    // The raw SQL path (buildSqlFilters) uses an inline sub-select, but Prisma's
    // WhereInput can't easily express LEFT(SUBSTRING(code, '[^.]+$'),3) = X.
    //
    // FIX (BUG-PERF-4 / BUG-BE-2): Replaced inline "fetch ALL outlets + JS filter"
    // with the shared resolveKelompokOutletCodes helper, which does a single DB-level
    // SQL filter (same LEFT(SUBSTRING(...)) expression as buildSqlFilters). This is
    // ~5x faster (1 SQL query vs fetch-all + JS loop) and deduplicates the logic
    // that was copy-pasted in export-report/route.ts.
    const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);

    // Shared filter options for SQL aggregate queries
    // FIX FILTER-2: apply sentinel for empty PIC list (buildSqlFilters skips empty arrays)
    const filterOpts = {
      area,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode,
      itemName,
      picOutletCodes: picOutletCodes !== null
        ? (picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'])
        : null,
    };

    // ============================================================
    //  P1 fix: HISTORICAL STATS + SLIM CURRENT RECS — ALL PARALLEL
    //  --------------------------------------------------------
    //  SQL-OPTIMIZE: Eliminated the 35K-record load (currentRecs +
    //  prevRecs were each ~25 columns × 35K rows = ~3MB JSON each).
    //  Now fetching only:
    //    1. currSlim — 5 columns × 35K rows (~700KB) for
    //       evaluateHistoricalRulesJs (zScore-based rules still need
    //       per-record nominalLossSurplus + pctQtyDeviasiToBom).
    //    2. historicalByOutletItem — Map of {mean, stdDev, n} per
    //       outlet+item (already a SQL aggregate, ~5K rows).
    //
    //  The heavy per-record computations are pushed to SQL:
    //    - queryOutletHealthRanking (per-outlet aggregate)
    //    - queryVarianceAnalysis (curr+prev JOIN)
    //    - queryGrowthDrivers (per-metric aggregation)
    //    - queryHistoricalCriticalItems (per-record fields for
    //      items flagged by HISTORICAL_* rules)
    //  These run in parallel with the existing 15 SQL aggregate queries.
    //
    //  FIX: Historical periods now filter by SAME weekLabel only.
    //  Weeks are cumulative (W1=1-7, W2=1-14, W4=1-25). Z-Score baseline
    //  must compare W4 vs W4 (prev months), NOT W4 vs W1+W2+W4 (mixed).
    //  Mixed weeks inflate mean (W1 is smaller) → false positive Z-Score.
    //
    //  PERF-OPT (verified): historicalByOutletItem is ALREADY in a
    //  Promise.all with currSlim — they run fully parallel. It CANNOT
    //  be merged into the main Promise.all below because:
    //    (a) the 404 check at line ~380 needs currSlim first, and
    //    (b) moving it after the 404 check would serialize it
    //        (currSlim → 404 check → big Promise.all), losing the
    //        currSlim ∥ historicalByOutletItem overlap.
    //  Current structure: max(currSlim, historicalByOutletItem) → 404
    //  check → big Promise.all. This is the optimal parallel shape.
    // ============================================================
    const historicalPeriods = allPeriods.filter(
      (p) => p.weekLabel === week && p.monthLabel !== month
    ).filter((p) => {
      const current = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week);
      return !current || p.sortKey < current.sortKey;
    });

    const [currSlim, historicalByOutletItem] = await Promise.all([
      // SQL-OPTIMIZE: 5-column slim projection (was 25-column full select).
      // evaluateHistoricalRulesJs is the only consumer — it reads just
      // (outletId, itemId, akunPenyesuaian, nominalLossSurplus,
      // pctQtyDeviasiToBom) per record.
      db.inventoryRecord.findMany({
        where: buildWhere(week!, month!),
        select: {
          outletId: true, itemId: true, akunPenyesuaian: true,
          nominalLossSurplus: true, pctQtyDeviasiToBom: true,
        },
      }),
      historicalPeriods.length > 0
        ? queryHistoricalStats(historicalPeriods, filterOpts)
        : Promise.resolve(new Map<string, { mean: number; stdDev: number; n: number }>()),
    ]);

    if (currSlim.length === 0) {
      // FIX (BUG-PERF-1): MUST reject the in-flight computation Promise before
      // returning 404. Without this, the computationPromise (registered via
      // setInflight at the top of the handler) is never settled → stays in the
      // inflightPromises Map forever → concurrent requests for the same cache
      // key call getInflight() → see pending Promise → await hangs forever.
      // This caused memory leak + concurrent request hangs when kelompok had
      // no matching data (e.g., kelompok=ZZZ).
      rejectComputation?.(new Error(`No records found for ${month} / ${week} with given filters.`));
      return NextResponse.json({
        success: false,
        message: `No records found for ${month} / ${week} with given filters.`,
      }, { status: 404 });
    }

    // thresholds already loaded in parallel block above

    // ============================================================
    //  RULE EVALUATION + SQL AGGREGATES — ALL PARALLEL (Sprint 3 + SQL-OPTIMIZE)
    //  --------------------------------------------------------
    //  Old: 35K-record JS loop calling evaluateRules() per record
    //  New: SQL flags (12 rules) + JS hist flags (5 zScore rules)
    //       + queryOutletHealthRanking + queryVarianceAnalysis +
    //       queryGrowthDrivers — all running in parallel with the
    //       existing 15 SQL aggregate queries.
    // ============================================================

    // Fire these 4 promises early — they'll be awaited in the Promise.all below.
    const sqlFlagsPromise = evaluateRulesSql(week!, month!, prevWeek, prevMonth, filterOpts, thresholds);
    const healthRankingSqlPromise = queryOutletHealthRanking(week!, month!, filterOpts);
    const varianceAnalysisPromise = queryVarianceAnalysis(week!, month!, prevWeek, prevMonth, filterOpts);
    const growthDriversPromise = queryGrowthDrivers(week!, month!, prevWeek, prevMonth, filterOpts);

    // ============================================================
    //  SQL AGGREGATE QUERIES (Phase 1b/2/4 + SQL-OPTIMIZE) — PARALLEL (P0 fix)
    //  All independent queries run via Promise.all for ~50% speedup.
    //  Sprint 3: sqlFlagsPromise runs in parallel with these queries.
    //  SQL-OPTIMIZE: healthRankingSqlPromise + varianceAnalysisPromise +
    //    growthDriversPromise also run in parallel here.
    // ============================================================

    // Group 1: Exec summary (curr + prev) — independent, parallel
    const [currSummary, prevSummary, sqlFlags] = await Promise.all([
      queryExecSummary(week!, month!, filterOpts),
      prevWeek && prevMonth ? queryExecSummary(prevWeek, prevMonth, filterOpts) : Promise.resolve(null),
      sqlFlagsPromise,
    ]);
    const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month!, week!, prevWeek);

    // Group 2: All top items + breakdown + area + outlets + trend + cost + consistency + health + variance + growth
    // P2 fix: use thresholds.TOP_N_ITEMS / TOP_N_OUTLETS instead of hardcoded 10
    // SQL-OPTIMIZE: healthRankingSqlPromise + varianceAnalysisPromise + growthDriversPromise
    //   were fired above; they're awaited here in serial batches.
    //
    // FIX (DEEP-AUDIT-SERIAL): Split the single 20-query Promise.all into 4 serial
    // batches of ~5 queries each. Supabase free plan PgBouncer caps concurrent
    // connections at ~10 (practical). Firing 20 queries in parallel causes pool
    // exhaustion → 30-60s queue + "Unable to start a transaction" errors.
    // Serial batches keep each batch within the pool cap → faster overall
    // (no queue wait) and no timeout errors.
    //   Batch 1 (5 queries): top items by nominal + devBom + 3 category (waste/susut/trial)
    //   Batch 2 (5 queries): lossSurplus category + area + 2 top outlets + deviation breakdown
    //   Batch 3 (5 queries): loss vs surplus + trend agg + cost impact + item consistency + DQ issues
    //   Batch 4 (5 queries): deviasi rank + deviation drivers + area trend + health ranking + variance + growth
    const topNItems = thresholds.TOP_N_ITEMS || 10;
    const topNOutlets = thresholds.TOP_N_OUTLETS || 10;

    // Batch 1: top items (nominal, devBom, waste, susut, trial)
    const [topNominal, topDevBom, topWasteRows, topSusutRows, topTrialRows] = await Promise.all([
      queryTopItemsByNominal(week!, month!, filterOpts, topNItems),
      queryTopItemsByDevBom(week!, month!, filterOpts, topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'waste', topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'susut', topNItems),
      queryTopItemsByCategory(week!, month!, filterOpts, 'trial', topNItems),
    ]);

    // Batch 2: lossSurplus category + area analysis + top outlets + breakdown + Pareto DevBom
    // FIX (BUG6-1+BUG6-POOL): paretoDevBom back in Promise.all with .catch() wrapper.
    const safeParetoDevBom = queryParetoByDevBom(week!, month!, filterOpts, 20, 0.50).catch((e: unknown) => {
      logger.error('[analysis] queryParetoByDevBom failed (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
      return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: 0, thresholdPct: 0.50 };
    });
    const [topLossSurplusRows, areaAnalysisRaw, topOutletsRaw, topOutletsSalesRaw, breakdown, paretoDevBom] = await Promise.all([
      queryTopItemsByCategory(week!, month!, filterOpts, 'lossSurplus', topNItems),
      queryAreaAnalysis(week!, month!, filterOpts),
      queryTopOutlets(week!, month!, filterOpts, topNOutlets),
      queryTopOutletsBySales(week!, month!, filterOpts, topNOutlets),
      queryDeviationBreakdown(week!, month!, filterOpts),
      safeParetoDevBom,
    ]);

    // Batch 3: loss vs surplus + trend + cost + consistency + DQ issues
    const [lvs, trendAggRows, costImpactSql, consistencyItems, dqIssuesRaw] = await Promise.all([
      queryLossVsSurplus(week!, month!, filterOpts),
      queryTrendAgg({ ...filterOpts, weekLabel: week }),
      queryCostImpact(week!, month!, execSummary.sales.current, filterOpts),
      queryItemConsistency(week!, month!, filterOpts),
      db.dQIssue.groupBy({
        by: ['severity'],
        where: { sourceFile: { monthLabel: month! } },
        _count: { _all: true },
      }),
    ]);

    // Batch 4: deviasi rank + deviation drivers + area trend + health ranking + variance + growth
    const [topDeviasiRank, deviationDriverRows, areaTrendRows, healthRankingRows, varianceAnalysis, growthDrivers] = await Promise.all([
      queryTopItemsByDeviasiRank(week!, month!, filterOpts, 50),
      queryDeviationBreakdownDrivers(week!, month!, filterOpts),
      // NEW: area trend for AreaTrendChart (Dev/BOM% per area × period)
      queryTrendByArea({ ...filterOpts, weekLabel: week }),
      // SQL-OPTIMIZE: pushed from JS (was: computeOutletHealthRanking loop over 35K records)
      healthRankingSqlPromise,
      // SQL-OPTIMIZE: pushed from JS (was: computeVarianceAnalysis loop over 35K records)
      varianceAnalysisPromise,
      // SQL-OPTIMIZE: pushed from JS (was: computeGrowthDrivers loop over 35K×2 records)
      growthDriversPromise,
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
    //  POST-PROCESS RULE FLAGS (Sprint 3 + SQL-OPTIMIZE)
    //  --------------------------------------------------------
    //  1. Evaluate 5 zScore-based rules in JS (uses currSlim — 5 cols × 35K rows)
    //  2. Merge SQL + JS flags → topFlagByKey (key → highest-priority flag)
    //  3. Compute per-outlet + global severity counts from topFlagByKey +
    //     healthRankingRows (zeroDev / nonZeroDev counts per outlet)
    //  4. Build outletHealthRanking from SQL aggregate + JS severity counts
    //     + Metric Engine health score (computeHealthScore)
    // ============================================================
    const histFlags = evaluateHistoricalRulesJs(
      currSlim,
      historicalByOutletItem,
      thresholds,
    );

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

    // varianceAnalysis: computed by SQL in the Promise.all above (was: JS
    // computeVarianceAnalysis loop over 35K currentRecs + prevByOutletItem map).
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

    // Build outletHealthRanking from SQL aggregate (healthRankingRows) +
    // JS severity counts (topFlagByKey). Health score uses Metric Engine
    // (computeHealthScore / computeDevBomAggregate / etc.) — same as the
    // old computeOutletHealthRanking JS function.
    const outletHealthRanking = healthRankingRows.map(row => {
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

    // ============================================================
    //  Historical Analysis (SQL-OPTIMIZE)
    //  --------------------------------------------------------
    //  Old: computeHistoricalAnalysis iterated over recsWithFlags (35K)
    //       + filtered for HISTORICAL_* flags + looked up stats map.
    //  New: filter topFlagByKey for HISTORICAL_* flags (small — ~50-200
    //       entries), run queryHistoricalCriticalItems SQL to fetch the
    //       per-record fields (itemName, outletCode, area, pctQtyDeviasiToBom,
    //       absNominalDeviasi) for those flagged records only, then compute
    //       zScore + sort + slice top 50 in JS.
    // ============================================================
    const histCriticalKeys = [...topFlagByKey.values()]
      .filter((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_WARNING')
      .map(f => ({ outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian }));
    const histCriticalRows = await queryHistoricalCriticalItems(week!, month!, filterOpts, histCriticalKeys);
    const histCriticalItems = histCriticalRows.map(row => {
      const key = `${row.outletId}|${row.itemId}`;
      const stats = historicalByOutletItem.get(key);
      if (!stats || stats.stdDev <= 0) return null;
      const zScore = calcZScoreFromStats(row.pctQtyDeviasiToBom ?? 0, stats.mean, stats.stdDev);
      return {
        itemName: row.itemName,
        outletCode: row.outletCode,
        area: row.area,
        currentDevBom: row.pctQtyDeviasiToBom ?? 0,
        historicalAvg: stats.mean,
        zScore: zScore ?? 0,
        absNominal: row.absNominalDeviasi ?? 0,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
    histCriticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    // FIX: return top 50 (was 10) — HistoricalZScoreCard displays a sortable table.
    // 50 is manageable payload (~5KB) and gives users enough data to explore.
    const historicalAnalysis = { criticalItems: histCriticalItems.slice(0, 50) };
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
    //  SQL-OPTIMIZE: pushed to SQL (was: computeGrowthDrivers loop over
    //  35K currentRecs + 35K prevRecs in JS).
    // ============================================================
    // growthDrivers — awaited above (from Promise.all with the other 17 SQL queries)

    // ============================================================
    //  Deviation Drivers — Pareto 80% per deviation category
    //  Phase 3: extracted to services/deviation-drivers.ts
    // ============================================================
    const deviationDrivers = computeDeviationDrivers(deviationDriverRows);

    const result = {
      success: true,
      period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      // FIX (BUG-KELOMPOK-EMPTY): include kelompok in the response filters object
      // so the frontend can display the active filter state consistently.
      // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
      filters: { area, kelompok, outletCode, itemName, pic },
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
      // FIX (BUG6-POOL): paretoDevBom in response
      paretoDevBom,
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
        // FIX (BUG-BE-10): include kelompok + pic in audit log for traceability
        detail: `${month}/${week} vs ${prevWeek} | area=${area || 'ALL'} kelompok=${kelompok || 'ALL'} outlet=${outletCode || 'ALL'} pic=${pic || 'ALL'} | ${currSlim.length} records`,
        duration: Date.now() - startedAt,
      },
    }).catch((e) => {
      logger.error("Audit log write failed (non-blocking)", { error: e instanceof Error ? e.message : String(e) });
    });

    return NextResponse.json(result);
  } catch (e: unknown) {
    // FIX (DEEP-AUDIT-ZEROS): reject the in-flight Promise so concurrent
    // requests awaiting it don't hang forever. Previously only resolve was
    // called (on success), so errors left the Promise pending indefinitely.
    rejectComputation?.(e);
    logger.error('Analysis error', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
