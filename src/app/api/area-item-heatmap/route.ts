// ============================================================
//  /api/area-item-heatmap
//  GET: ?month=&week=&metric=&itemLimit=&area=&kelompok=&outlet=&pic=
//  Returns Area × Item matrix for heatmap visualization.
//
//  Metrics: absNominalDeviasi (default), nominalWaste, nominalSusut,
//           pctQtyDeviasiToBom, recordCount
//  itemLimit: 5-109 (default 20, recommended 15-25 for readability)
//
//  PERF-CACHE-08: DB-level AggregationCache (5-min TTL) + in-flight dedup via
//  withCacheAndDedup. Heatmap runs a heavy SQL aggregation (Area × Item ×
//  metric) — caching skips the recompute on warm calls. Cache key includes
//  metric + itemLimit + mode (route-specific) in addition to the standard
//  filter set. Added to invalidateAnalysisCache() route list so mutations
//  (ingest, settings, pic, data delete, migrate-direction) clear it.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { queryAreaItemHeatmap, type HeatmapMetric, type ItemSelectMode } from '@/lib/queries/heatmap';
import { validateQuery, heatmapQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_METRICS: HeatmapMetric[] = [
  'absNominalDeviasi',
  'nominalWaste',
  'nominalSusut',
  'pctQtyDeviasiToBom',
  'recordCount',
];

const HEATMAP_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches other analysis routes

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`heatmap:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // FIX API-06: Zod validation (was missing — security gap)
    const validation = validateQuery(heatmapQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const rawMonth = url.searchParams.get('month') || '';
    const rawWeek = url.searchParams.get('week') || '';
    const metricParam = url.searchParams.get('metric') || 'absNominalDeviasi';
    const itemLimitParam = parseInt(url.searchParams.get('itemLimit') || '20', 10);
    const modeParam = url.searchParams.get('mode') || 'pareto80';
    const area = url.searchParams.get('area') || null;
    const kelompok = url.searchParams.get('kelompok') || null;
    const outletCode = url.searchParams.get('outlet') || null;
    const itemName = url.searchParams.get('item') || null;
    const pic = url.searchParams.get('pic') || null;

    if (!rawMonth || !rawWeek) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // Validate metric
    const metric = (VALID_METRICS.includes(metricParam as HeatmapMetric)
      ? metricParam
      : 'absNominalDeviasi') as HeatmapMetric;

    // Validate itemLimit (5-100 range — BUG-A-05: was 109 typo)
    const itemLimit = Math.max(5, Math.min(100, isNaN(itemLimitParam) ? 20 : itemLimitParam));

    // Validate mode
    const mode: ItemSelectMode = modeParam === 'top' ? 'top' : 'pareto80';

    // PERF-HEATMAP: resolve month BEFORE cache key so "Agustus 2026" and "agustus 2026"
    // share one cache entry. Previously rawMonth was used in the key → case mismatch = cache miss.
    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    // PERF-CACHE-08: cache key includes ALL params that affect the response:
    // metric, itemLimit, mode (route-specific) + standard filter set. Without
    // these, two requests with different metric/itemLimit/mode would share
    // one cache entry → wrong heatmap rendered.
    const cacheKey = buildCacheKey({
      route: 'heatmap',
      month, week,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: itemName || null,
      pic,
      // PERF-CACHE: route-specific params appended as sorted key=value pairs.
      extra: { metric, itemLimit, mode },
    });

    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<Record<string, unknown>>(cacheKey, HEATMAP_CACHE_TTL, async () => {
      // PERF-HEATMAP: parallel resolve kelompok + PIC (was sequential, saves 50-100ms on cold path)
      const [kelompokOutletCodes, picOutletCodes] = await Promise.all([
        resolveKelompokOutletCodes(kelompok),
        resolvePICOutletCodes(pic),
      ]);
      if (kelompokOutletCodes && kelompokOutletCodes.length === 1 && kelompokOutletCodes[0] === '__NO_MATCH__') {
        return {
          success: true,
          areas: [],
          items: [],
          cells: [],
          metric,
          maxValue: 0,
        };
      }

      if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
        return {
          success: true,
          areas: [],
          items: [],
          cells: [],
          metric,
          maxValue: 0,
        };
      }

      // Build filter opts (same pattern as other query modules)
      const filterOpts = {
        area: area && area !== 'all' ? area : null,
        kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
        outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
        itemName: itemName || null,
        picOutletCodes,
      };

      // Note: queryAreaItemHeatmap uses buildSqlFilters internally,
      // so we don't need to build a Prisma WhereInput here.
      const result = await queryAreaItemHeatmap(week, month, filterOpts, metric, itemLimit, mode);

      return {
        success: true,
        period: { month, week },
        ...result,
        durationMs: Date.now() - startedAt,
      };
    });

    // PERF-CACHE-08: add `cached: true` flag when served from cache (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): also surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07: Don't leak internal error details to client
    logger.error('[area-item-heatmap] error:', { error: e instanceof Error ? e.message : String(e) });
    // P23 D4: 'Internal server error' → ID ('Gagal …' convention, see ingest services).
    return NextResponse.json({ success: false, error: 'Gagal memproses permintaan' }, { status: 500 });
  }
}
