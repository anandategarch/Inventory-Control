// ============================================================
//  /api/waste-peer-zscore — Waste z-score vs peer band (DEEP-WASTE-2)
//  Per-month waste/sales + rank (1 = highest) + z-score of ONE
//  outlet inside its DYNAMIC ±10% sales band (band membership
//  recomputed per month, matching /api/peer-comparison +
//  /api/peer-track-record). The in-app version of the offline
//  report's "TJPPLU Fokus" sheet (z-score vs 8 peer per bulan +
//  the sales-growth-while-waste-extreme paradox flag).
//  GET: ?outletCode=X&month=Y&week=Z&kelompok=W
//  kelompok scopes the PEER set only — the focus outlet is
//  always included (same semantics as peer-comparison.ts).
//  Window: most recent 12 same-week months ending at the running
//  month (inclusive). Months without a band (target has no sales
//  that month) are absent from the response.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryWastePeerZScore } from '@/lib/queries';
import { validateQuery, wastePeerZScoreQuerySchema } from '@/lib/validation';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the peer-comparison family (P3-HYG-3).
// Mutations clear it via invalidateAnalysisCache (routes list includes
// 'waste-peer-zscore').
const WASTE_PEER_ZSCORE_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`waste-peer-zscore:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as peer-track-record).
    const validation = validateQuery(wastePeerZScoreQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    // FIX (BUG-2-b / BUG-1-c #3) pattern: normalize 'all' (case-insensitive)
    // → null ONCE, then use kelompokParam for BOTH the cache key AND the
    // query (raw 'all' would match 0 outlets and poison the cache).
    const kelompok = url.searchParams.get('kelompok');
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;

    if (!outletCode || !month || !week) {
      return NextResponse.json({ success: false, error: 'outletCode, month and week required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Cache key covers every response-affecting param — outlet/month/week
    // via the standard set, kelompok as the peer-set scope.
    const cacheKey = buildCacheKey({
      route: 'waste-peer-zscore',
      month,
      week,
      outletCode,
      kelompok: kelompokParam,
    });

    type WastePeerZScoreData = Awaited<ReturnType<typeof queryWastePeerZScore>>;
    const { data: zScoreData, cached, stale } = await withCacheAndDedup<WastePeerZScoreData>(
      cacheKey,
      WASTE_PEER_ZSCORE_CACHE_TTL,
      async () => {
        // Same currentMonthKey derivation as /api/recommendations.
        const currentSourceFile = await db.sourceFile.findFirst({
          where: { monthLabel: month },
          select: { monthKey: true },
        });
        const currentMonthKey = currentSourceFile?.monthKey ?? null;
        return queryWastePeerZScore(outletCode, week, currentMonthKey, kelompokParam);
      },
    );

    return NextResponse.json({
      success: true,
      outletCode,
      week,
      records: zScoreData.rows,
      summary: zScoreData.summary,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[waste-peer-zscore] error:', { error: e });
    return errorResponse(e, 'waste-peer-zscore');
  }
}
