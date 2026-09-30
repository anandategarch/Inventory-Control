// ============================================================
//  /api/waste-top-items — Waste item Pareto (DEEP-WASTE-1)
//  Top-N items by ΣABS nominalWaste over the multi-month SAME-week
//  window (most recent 12 months, incl. running month) for the
//  scoped filter set: waste qty + satuan, sistematik columns
//  (#outlet aktif / #bulan aktif), share + cumulative share of the
//  network total, last/prev month waste, and the per-outlet
//  breakdown (top 8 per item — the Item×Outlet matrix).
//  GET: ?month=Y&week=Z&area=&kelompok=&pic=&limit=
//  limit is clamped 1..50 (default 20) BEFORE the cache key — bogus
//  values must not poison the cache (same style as the items route's
//  topItems / peer-comparison/top-items).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryWasteTopItems, WASTE_TOP_ITEMS_DEFAULT_LIMIT, WASTE_TOP_ITEMS_MAX_LIMIT } from '@/lib/queries';
import { validateQuery, wasteTopItemsQuerySchema } from '@/lib/validation';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the peer-comparison family (P3-HYG-3).
// Mutations clear it via invalidateAnalysisCache (routes list includes
// 'waste-top-items').
const WASTE_TOP_ITEMS_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`waste-top-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as waste-series).
    const validation = validateQuery(wasteTopItemsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const pic = url.searchParams.get('pic');
    // outletCode is OPTIONAL — absent = network-wide Pareto (Waste tab),
    // present = scoped to ONE outlet (global outlet filter parity).
    const outletCode = url.searchParams.get('outletCode');
    const kelompok = url.searchParams.get('kelompok');
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // limit: parsed + clamped manually (bogus values fall back to the
    // default BEFORE the cache key — never enter the key).
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), WASTE_TOP_ITEMS_MAX_LIMIT)
      : WASTE_TOP_ITEMS_DEFAULT_LIMIT;

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Resolve PIC → outletCodes (shared logic — same as /api/pareto).
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({ success: true, items: [], populationTotal: 0, lastMonthKey: null, prevMonthKey: null });
    }

    const cacheKey = buildCacheKey({
      route: 'waste-top-items',
      month,
      week,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompokParam,
      pic,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      extra: { limit },
    });

    type WasteTopItemsData = Awaited<ReturnType<typeof queryWasteTopItems>>;
    const { data: topItemsData, cached, stale } = await withCacheAndDedup<WasteTopItemsData>(
      cacheKey,
      WASTE_TOP_ITEMS_CACHE_TTL,
      async () => {
        const currentSourceFile = await db.sourceFile.findFirst({
          where: { monthLabel: month },
          select: { monthKey: true },
        });
        const currentMonthKey = currentSourceFile?.monthKey ?? null;
        return queryWasteTopItems(week, currentMonthKey, {
          area: area && area !== 'all' ? area : null,
          kelompok: kelompokParam,
          outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
          picOutletCodes,
        }, limit);
      },
    );

    return NextResponse.json({
      success: true,
      week,
      limit,
      items: topItemsData.items,
      populationTotal: topItemsData.populationTotal,
      lastMonthKey: topItemsData.lastMonthKey,
      prevMonthKey: topItemsData.prevMonthKey,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[waste-top-items] error:', { error: e });
    return errorResponse(e, 'waste-top-items');
  }
}
