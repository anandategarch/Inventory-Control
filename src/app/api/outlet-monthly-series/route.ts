// ============================================================
//  /api/outlet-monthly-series — Deret Bulanan (DEEP-RESTO-1)
//  Multi-month SAME-weekLabel series for ONE outlet: sales (MODE)
//  + MoM, ΣABS qtyBom, signed Σ nominalDeviasi, Dev/BOM, Total
//  Loss/Surplus (Excel convention), Net Cost Ratio, and a
//  recurrence-style abnormal flag (same thresholds as
//  /api/recommendations history — devBom > FALLBACK_TOLERANCE_PCT
//  OR loss > HIGH_LOSS_NOMINAL_THRESHOLD).
//  GET: ?outletCode=X&month=Y&week=Z
//  Window: most recent 12 same-week months ending at the running
//  month (inclusive).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryOutletMonthlySeries } from '@/lib/queries';
import { validateQuery, outletMonthlySeriesQuerySchema } from '@/lib/validation';
import { getRuntimeThresholds } from '@/lib/settings';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the peer-comparison family (P3-HYG-3):
// 5-min DB-level cache + in-flight dedup. Mutations clear it via
// invalidateAnalysisCache (routes list includes 'outlet-monthly-series').
const SERIES_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`outlet-monthly-series:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as peer-comparison).
    const validation = validateQuery(outletMonthlySeriesQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');

    if (!outletCode || !month || !week) {
      return NextResponse.json({ success: false, error: 'outletCode, month and week required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Cache key covers every response-affecting param — outlet/month/week.
    // The window derives deterministically from (month, week), so it needs
    // no separate key part.
    const cacheKey = buildCacheKey({
      route: 'outlet-monthly-series',
      month,
      week,
      outletCode,
    });

    type SeriesData = Awaited<ReturnType<typeof queryOutletMonthlySeries>>;
    const { data: seriesData, cached, stale } = await withCacheAndDedup<SeriesData>(
      cacheKey,
      SERIES_CACHE_TTL,
      async () => {
        // Same currentMonthKey derivation as /api/recommendations —
        // window upper bound (inclusive of the running month).
        const currentSourceFile = await db.sourceFile.findFirst({
          where: { monthLabel: month },
          select: { monthKey: true },
        });
        const currentMonthKey = currentSourceFile?.monthKey ?? null;
        const thresholds = await getRuntimeThresholds();
        return queryOutletMonthlySeries(outletCode, week, currentMonthKey, thresholds.FALLBACK_TOLERANCE_PCT, thresholds.HIGH_LOSS_NOMINAL_THRESHOLD);
      },
    );

    return NextResponse.json({
      success: true,
      outletCode,
      week,
      months: seriesData.rows,
      total: seriesData.total,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[outlet-monthly-series] error:', { error: e });
    return errorResponse(e, 'outlet-monthly-series');
  }
}
