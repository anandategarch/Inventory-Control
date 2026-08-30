// ============================================================
//  /api/item-trend — per-item QTY fluctuation timeline (ALL periods)
//  GET: ?itemName=&metric=&month=&week=&area=&kelompok=&outlet=&pic=
//
//  Returns the per-period trend for a given item across ALL available
//  periods (monthLabel × weekLabel) with:
//    - QTY aggregates (ABS magnitude + SIGNED qtyDeviasi for direction)
//    - outletCount + recordCount per period
//    - Z-Score (signed) per period using the SAME-week baseline
//      (cumulative weeks pattern: W4 Juli vs [W4 Mei, W4 Juni])
//    - Historical baseline (mean + sample std dev + sample size)
//
//  TREND-BACKEND: This is the API surface for the NEW "Trend Item" tab.
//  Frontend agent will add the tab UI; this route supplies the data.
//
//  Pattern (per CONVENTIONS.md §1 + §3.1):
//    - `force-dynamic` + maxDuration=30 (light route — single SQL query)
//    - Rate limiting (30 req/min per IP — interactive UI control)
//    - Zod validation (itemTrendQuerySchema — strict mode rejects unknown params)
//    - DB cache via withCacheAndDedup (5-min TTL) + SWR (stale-while-revalidate)
//    - Cache key includes month+week+itemName+metric+filters (all response-affecting params)
//    - Resolve month BEFORE cache key (so "Agustus 2026" + "agustus 2026" share one entry)
//    - Parallel resolve kelompok + PIC inside computeFn (saves 50-100ms on cold path)
//    - `startedAt` timing + `durationMs` in response
//    - Generic error message on failure (no DB schema/SQL leakage)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { queryItemTrendTimeline, type ItemTrendMetric } from '@/lib/queries/item-trend';
import { validateQuery, itemTrendQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ITEM_TREND_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches other analysis routes

const VALID_METRICS: ItemTrendMetric[] = ['qtyDeviasi', 'qtyWaste', 'qtySusut', 'qtyTrial'];

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace)
    const ip = getClientIP(req);
    const rl = rateLimit(`item-trend:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(itemTrendQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const params = validation.data;

    // Extract validated params (validation guarantees types/shapes)
    const rawMonth = params.month ?? '';
    const rawWeek = params.week ?? '';
    const itemName = params.itemName;
    const metricParam = params.metric ?? 'qtyDeviasi';
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // Validate metric enum (defense-in-depth — Zod already enforces this,
    // but the default value bypasses the enum check)
    const metric: ItemTrendMetric = (VALID_METRICS.includes(metricParam as ItemTrendMetric)
      ? metricParam
      : 'qtyDeviasi') as ItemTrendMetric;

    // PERF-HEATMAP pattern: resolve month BEFORE cache key so "Agustus 2026" and
    // "agustus 2026" share one cache entry. Previously rawMonth was used in the
    // key → case mismatch = cache miss.
    const resolver = await getMonthResolver();
    const month = rawMonth ? (resolveMonthLabel(rawMonth, resolver) || rawMonth) : '';
    const week = rawWeek;

    // 3. DB cache check — cache key includes ALL response-affecting params.
    // TREND-DATA-02 FIX: month/week NOT in cache key — query returns ALL periods
    // regardless of selected month/week. Including them caused 8x cache fragmentation.
    const cacheKey = buildCacheKey({
      route: 'item-trend',
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName,
      pic,
      // PERF-CACHE: route-specific params appended as sorted key=value pairs.
      extra: { metric },
    });

    // 4. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<Record<string, unknown>>(
      cacheKey,
      ITEM_TREND_CACHE_TTL,
      async () => {
        // TREND-BE-01 FIX: removed resolveKelompokOutletCodes — kelompok is already
        // handled by buildSqlFilters via the kelompok string in filterOpts.
        // Only resolve PIC (which returns outlet codes, not a kelompok prefix).
        const picOutletCodes = await resolvePICOutletCodes(pic);

        // Sentinel handling: if PIC matches no outlets, return empty periods.
        if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
          return {
            success: true,
            period: { month, week },
            itemName,
            metric,
            periods: [],
            durationMs: Date.now() - startedAt,
          };
        }

        // Build filter opts (same pattern as heatmap route).
        // NOTE: itemName is NOT passed through filters — queryItemTrendTimeline
        // applies an EXACT match (`i.name = ${itemName}`) in its WHERE clause
        // instead of buildSqlFilters' LIKE (which would over-match).
        const filterOpts = {
          area: area && area !== 'all' ? area : null,
          kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
          outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
          itemName: null,
          picOutletCodes,
        };

        const result = await queryItemTrendTimeline(itemName, filterOpts, metric);

        return {
          success: true,
          period: { month, week },
          itemName,
          metric,
          periods: result.periods,
          durationMs: Date.now() - startedAt,
        };
      },
    );

    // 5. Response with cache flags (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07 pattern: Don't leak internal error details to client.
    logger.error('[item-trend] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
