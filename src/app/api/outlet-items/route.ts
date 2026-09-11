// ============================================================
//  /api/outlet-items — Resto Analysis (Level 3+4)
//  Query: ?outletCode=&month=&week=&compareWeek=&compareMonth=
//
//  Phase 3: Menggunakan Metric Engine (src/lib/metrics) sebagai
//  single source of truth untuk semua perhitungan metric.
//
//  Returns:
//  1. Resto Profile (6 sections: Performance, Behavior, Historical, Benchmark, TopRisk, Investigation)
//  2. Bahan Analysis (3 rankings: Financial, Operational, Unexplained)
//  3. Per-item breakdown: BOM, Deviasi, Dev/BOM, Nominal, Direction, W/S/T, Residual
//
//  REFACTOR (Task 4-d): the original 673-line god function has been split
//  into 5 named service functions under ./services/. The GET handler below
//  is now a thin coordinator (~90 lines) — see each service file for the
//  per-section rationale and inline "FIX (XXX)" comments preserved from
//  the original monolith.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { validateQuery, outletItemsQuerySchema } from '@/lib/validation';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { EarlyHttpResponse } from './services/types';
import { resolveOutletAndPeriod } from './services/resolve-period';
import { fetchRecords } from './services/fetch-records';
import { buildRestoProfile } from './services/build-resto-profile';
import { buildItemBreakdown } from './services/build-item-breakdown';
import { buildRankings } from './services/build-rankings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`outlet-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(outletItemsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const outletCode = url.searchParams.get('outletCode');
    const month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const compareWeek = url.searchParams.get('compareWeek');
    const compareMonthRaw = url.searchParams.get('compareMonth');

    if (!outletCode || !month || !week) {
      return NextResponse.json({ success: false, error: 'outletCode, month, week required' }, { status: 400 });
    }

    // PERF-API-01 (Task PERF-API): DB-level AggregationCache for /api/outlet-items.
    // Before: every request re-ran 6 heavy SQL queries (currentRecs + prevRecs +
    // areaBench + networkBench + outletPIC + topDeviasiRank). Benchmark:
    // cold 1.06s → warm 0.94s (almost no improvement — no DB cache).
    // After: cache the full response payload (5-min TTL) keyed by outletCode +
    // month + week + compareWeek + compareMonth. Cache hit returns in ~50ms.
    // Mutations (ingest/settings/pic/data) clear this via invalidateAnalysisCache.
    const OUTLET_ITEMS_CACHE_TTL = 5 * 60 * 1000; // 5 min
    // PERF (TAHAP-2 / P2-11): resolve month + compareMonth to actual DB case
    // BEFORE building the cache key (getMonthResolver is process-cached ~0ms).
    // Previously "juli 2026" vs "Juli 2026" built two cache rows for the same
    // data. The computeFn re-resolves internally — idempotent no-op on the
    // already-resolved value.
    const monthResolverEarly = await getMonthResolver();
    const resolvedMonth = month ? (resolveMonthLabel(month, monthResolverEarly) || month) : month;
    const resolvedCompareMonth = compareMonthRaw
      ? (resolveMonthLabel(compareMonthRaw, monthResolverEarly) || compareMonthRaw)
      : compareMonthRaw;
    const cacheKey = buildCacheKey({
      route: 'outlet-items',
      month: resolvedMonth, week,
      outletCode,
      compareWeek,
      compareMonth: resolvedCompareMonth,
    });

    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<Record<string, unknown>>(
      cacheKey,
      OUTLET_ITEMS_CACHE_TTL,
      async () => {
        // Stage 1 — resolve month label + lookup outlet + determine prev period.
        // Throws EarlyHttpResponse on 404 (propagates via withCacheAndDedup).
        const resolved = await resolveOutletAndPeriod({
          outletCode,
          month,
          week,
          compareWeek,
          compareMonthRaw,
        });
        const { month: resolvedMonth, thresholds, outlet, prevWeek, prevMonth } = resolved;

        // Stage 2 — parallel SQL queries (currentRecs + prevRecs + area/network
        // benchmark + outletPIC + topDeviasiRank promise).
        const records = await fetchRecords({
          outlet, outletCode, month: resolvedMonth, week, prevWeek, prevMonth, thresholds,
        });
        const { currentRecs, prevRecs, areaBench, networkBench, outletPIC, topDeviasiRankPromise } = records;

        // Stage 3 — build restoProfile (6 sections) + prevByItemId map.
        const { restoProfile, prevByItemId } = buildRestoProfile({
          outlet, currentRecs, prevRecs, areaBench, networkBench, thresholds,
        });

        // Stage 4 — per-item breakdown (priority + historical growth + benchmark).
        const itemBreakdown = buildItemBreakdown({
          currentRecs, prevByItemId, areaBench, networkBench, thresholds,
        });

        // Stage 5 — 3 ranked slices (financial / operational / unexplained).
        const rankings = buildRankings(itemBreakdown);

        // Await the top deviasi rank (fired in parallel with the main
        // Promise.all inside fetchRecords — powers RankingNasionalCard).
        const topDeviasiRank = await topDeviasiRankPromise;

        // PERF-API-01: return a plain object (NOT NextResponse) so
        // withCacheAndDedup can JSON-serialize + store it. The outer code
        // wraps it with NextResponse.json + adds the `cached: true` flag on
        // cache hits (CONVENTIONS §2).
        return {
          success: true,
          outlet: {
            code: outlet.code,
            name: outlet.name,
            area: outlet.area,
            pic: outletPIC?.pic ?? null,
          },
          period: { month: resolvedMonth, week, prevWeek, prevMonth },
          restoProfile,
          rankings,
          allItems: itemBreakdown,
          topDeviasiRank,
          itemCount: currentRecs.length,
          durationMs: Date.now() - startedAt,
        } as Record<string, unknown>;
      }, // end withCacheAndDedup computeFn
    );

    // PERF-API-01: rebuild NextResponse from cached/fresh payload + add cached flag.
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // PERF-API-01: handle EarlyHttpResponse thrown from inside withCacheAndDedup's
    // computeFn (404 Outlet not found short-circuit). Return the embedded response
    // directly — don't run it through errorResponse (which would 500 the 404).
    if (e instanceof EarlyHttpResponse) {
      return e.response;
    }
    logger.error("[outlet-items] error:", { error: e });
    return errorResponse(e, "outlet-items");
  }
}
