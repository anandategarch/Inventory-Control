// ============================================================
//  /api/area-item-heatmap/cell-detail
//  GET: ?month=&week=&area=&item=&kelompok=&outlet=&pic=
//  Returns per-outlet drill-down for a specific area × item cell.
//  Shows raw quantities (qtyBom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial)
//  and nominal values per outlet × akunPenyesuaian.
//
//  PERF (H-8 QUICK WIN 6b): DB-level AggregationCache via withCacheAndDedup
//  (5-min TTL + in-flight dedup) — mirrors the parent /api/area-item-heatmap
//  route (PERF-CACHE-08). Also parallelizes the kelompok + PIC resolver
//  lookups (was sequential — parent route already did this via Promise.all).
//  Added to invalidateAnalysisCache() route list ('heatmap-cell-detail') so
//  mutations (ingest, settings, pic, data delete, migrate-direction) clear it.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { queryHeatmapCellDetail } from '@/lib/queries/heatmap';
import { validateQuery, heatmapQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HEATMAP_CELL_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches the parent heatmap route

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`heatmap-cell:${ip}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // FIX API-06: Zod validation (was missing — no input validation at all)
    const validation = validateQuery(heatmapQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const rawMonth = url.searchParams.get('month') || '';
    const rawWeek = url.searchParams.get('week') || '';
    const areaName = url.searchParams.get('area') || '';
    const itemName = url.searchParams.get('item') || '';
    const kelompok = url.searchParams.get('kelompok') || null;
    const outletCode = url.searchParams.get('outlet') || null;
    const pic = url.searchParams.get('pic') || null;

    if (!rawMonth || !rawWeek || !areaName || !itemName) {
      return NextResponse.json(
        { success: false, error: 'month, week, area, and item are required' },
        { status: 400 },
      );
    }

    // PERF (H-8-6b): resolve month BEFORE the cache key (same fix as the
    // parent heatmap route) so case variants share one cache entry.
    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    const cacheKey = buildCacheKey({
      route: 'heatmap-cell-detail',
      month, week,
      area: areaName,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName,
      pic,
    });

    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<Record<string, unknown>>(cacheKey, HEATMAP_CELL_CACHE_TTL, async () => {
      // PERF (H-8-6b): parallel resolve kelompok + PIC (was sequential).
      const [kelompokOutletCodes, picOutletCodes] = await Promise.all([
        resolveKelompokOutletCodes(kelompok),
        resolvePICOutletCodes(pic),
      ]);
      if (kelompokOutletCodes && kelompokOutletCodes.length === 1 && kelompokOutletCodes[0] === '__NO_MATCH__') {
        return { success: true, rows: [] };
      }

      if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
        return { success: true, rows: [] };
      }

      const filterOpts = {
        area: null, // area is already applied via areaName param in the query
        kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
        outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
        itemName: null, // itemName is already applied via itemName param
        picOutletCodes,
      };

      const rows = await queryHeatmapCellDetail(week, month, filterOpts, areaName, itemName);

      return { success: true, rows, durationMs: Date.now() - startedAt };
    });

    // CONVENTIONS §2: surface `cached: true` when served from cache; `stale: true`
    // when the SWR path served an expired entry (background recompute is running).
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // FEAT-01 fix: don't leak internal error details to client
    logger.error('[area-item-heatmap/cell-detail] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
