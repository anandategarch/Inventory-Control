// ============================================================
//  /api/pareto — Pareto 80/20 analysis across dimensions
//  GET: ?month=&week=&area=&pic=
//  Returns: Pareto by Item, Outlet, Area, PIC + nested Item→Outlet
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { validateQuery, paretoQuerySchema } from '@/lib/validation';
import { queryParetoByItem, queryParetoByOutlet, queryParetoByArea, queryParetoByKelompok, queryParetoByPIC, queryParetoNestedItemOutlet, queryParetoNested, queryParetoHistorical, mergeHistoricalIntoPareto, type ParetoDimension } from '@/lib/queries/pareto';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, getCached, setCached } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`pareto:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // FIX (AUDIT7-BE-4): Zod input validation — was reading raw searchParams.
    // Matches the pattern used by /api/analysis + /api/recommendations.
    // Rejects malformed month/week/area/kelompok/pic with 400 (was silently
    // producing empty results). parentDim/childDim validated against strict
    // enum — ready for the multi-nesting feature (AUDIT7-BE-1).
    const validation = validateQuery(paretoQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month') || '';
    const week = url.searchParams.get('week') || '';
    const area = url.searchParams.get('area');
    const pic = url.searchParams.get('pic');

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    const monthResolver = await getMonthResolver();
    month = resolveMonthLabel(month, monthResolver) || month;

    // Resolve PIC → outletCodes (shared logic)
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({ success: true, byItem: { drivers: [] }, byOutlet: { drivers: [] }, byArea: { drivers: [] }, byKelompok: { drivers: [] }, byPIC: { drivers: [] }, nested: { items: [] }, durationMs: Date.now() - startedAt });
    }

    const kelompok = url.searchParams.get('kelompok');
    // FIX (RESTORE-BACKEND-2): read parentDim + childDim URL params. When BOTH
    // are provided (and different), call the generalized `queryParetoNested`
    // and include the result as `nestedGeneralized` in the response. The
    // existing `nested` (Item→Outlet) is always returned for backward compat.
    // The paretoQuerySchema already validates these as enum values.
    const parentDim = url.searchParams.get('parentDim') as ParetoDimension | null;
    const childDim = url.searchParams.get('childDim') as ParetoDimension | null;
    const useGeneralizedNested =
      !!parentDim && !!childDim && parentDim !== childDim;

    const filters = {
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: null,
      picOutletCodes,
    };

    // DP-14: DB-level AggregationCache — prevents full recompute on warm calls.
    // Cache key includes all filter params + parentDim/childDim.
    const cacheKey = buildCacheKey({
      route: 'pareto', month, week, area: filters.area, kelompok: filters.kelompok, pic,
    });
    const PARETO_CACHE_TTL = 5 * 60 * 1000; // 5 min
    const cached = await getCached<unknown>(cacheKey, PARETO_CACHE_TTL);
    if (cached && typeof cached === 'object' && 'success' in cached) {
      const cachedResult = cached as Record<string, unknown>;
      cachedResult.cached = true;
      cachedResult.durationMs = Date.now() - startedAt;
      return NextResponse.json(cachedResult, { headers: CACHE_ANALYSIS });
    }

    // Run all 6 Pareto queries in parallel
    // DESIGN NOTE (BUG-BE-3): byKelompok + histKelompok intentionally OMIT the
    // kelompok filter from their filterOpts — the byKelompok card shows ALL
    // kelompok for comparison context (so the user can see how the selected
    // kelompok ranks against others). All OTHER dimensions (byItem, byOutlet,
    // byArea, byPIC, nested) correctly include kelompok in their filters.
    // Do NOT "fix" by adding kelompok to byKelompok/histKelompok — it would
    // break the comparison feature.
    //
    // FIX (RESTORE-BACKEND-2): when parentDim + childDim both provided,
    // run the generalized `queryParetoNested` in parallel with the other 6
    // queries and include its result as `nestedGeneralized` in the response.
    // PERF-03: Fold currentSourceFile into first Promise.all (8th entry — independent of the other 7)
    const [byItem, byOutlet, byArea, byKelompok, byPIC, nested, nestedGeneralized, currentSourceFile] = await Promise.all([
      queryParetoByItem(week, month, filters),
      queryParetoByOutlet(week, month, { area: filters.area, kelompok: filters.kelompok, picOutletCodes }),
      queryParetoByArea(week, month, { kelompok: filters.kelompok, picOutletCodes }),
      queryParetoByKelompok(week, month, { area: filters.area, picOutletCodes }), // intentional: no kelompok filter
      queryParetoByPIC(week, month, { area: filters.area, kelompok: filters.kelompok, picOutletCodes }),
      queryParetoNestedItemOutlet(week, month, filters, 10),
      useGeneralizedNested
        ? queryParetoNested(week, month, filters, parentDim!, childDim!, 10)
        : Promise.resolve(null),
      // PERF-03: was sequential await after the first Promise.all — now parallel
      db.sourceFile.findFirst({ where: { monthLabel: month }, select: { monthKey: true } }),
    ]);

    // FIX (BUG2-PARETO-1): resolve currentMonthKey to filter out future months
    const currentMonthKey = currentSourceFile?.monthKey ?? undefined;

    // Fetch historical stats for each dimension (same weekLabel, different monthLabel)
    // + merge histAvg + zScore into Pareto results
    // FIX (BUG2-PARETO-1): pass currentMonthKey to exclude future months
    const [histItem, histOutlet, histArea, histKelompok, histPIC] = await Promise.all([
      queryParetoHistorical(week, month, 'item', filters, currentMonthKey),
      queryParetoHistorical(week, month, 'outlet', { area: filters.area, kelompok: filters.kelompok, picOutletCodes }, currentMonthKey),
      queryParetoHistorical(week, month, 'area', { kelompok: filters.kelompok, picOutletCodes }, currentMonthKey),
      queryParetoHistorical(week, month, 'kelompok', { area: filters.area, picOutletCodes }, currentMonthKey), // intentional: no kelompok filter
      queryParetoHistorical(week, month, 'pic', { area: filters.area, kelompok: filters.kelompok, picOutletCodes }, currentMonthKey),
    ]);

    const byItemMerged = mergeHistoricalIntoPareto(byItem, histItem);
    const byOutletMerged = mergeHistoricalIntoPareto(byOutlet, histOutlet);
    const byAreaMerged = mergeHistoricalIntoPareto(byArea, histArea);
    const byKelompokMerged = mergeHistoricalIntoPareto(byKelompok, histKelompok);
    const byPICMerged = mergeHistoricalIntoPareto(byPIC, histPIC);

    const result = {
      success: true,
      period: { month, week },
      filters: { area: area || null, kelompok: kelompok || null, pic: pic || null },
      byItem: byItemMerged,
      byOutlet: byOutletMerged,
      byArea: byAreaMerged,
      byKelompok: byKelompokMerged,
      byPIC: byPICMerged,
      nested,
      ...(nestedGeneralized
        ? { nestedGeneralized, parentDim: nestedGeneralized.parentDim, childDim: nestedGeneralized.childDim }
        : {}),
      durationMs: Date.now() - startedAt,
    };

    // DP-14: Cache the result for 5 min
    await setCached(cacheKey, result, true);

    return NextResponse.json(result, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[pareto] error:', { error: e instanceof Error ? e.message : String(e) });
    return errorResponse(e, "pareto");
  }
}
