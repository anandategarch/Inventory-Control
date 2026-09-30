// ============================================================
//  /api/peer-track-record — Track-Record Rank Peer (DEEP-RESTO-1)
//  Per-month rank of ONE outlet inside its DYNAMIC ±10% sales
//  band (band membership recomputed per month, matching
//  /api/peer-comparison): rank net deviation (1 = most negative
//  = TERBURUK), rank total loss (1 = largest), band size, and
//  the band's median loss.
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
import { queryPeerTrackRecord } from '@/lib/queries';
import { validateQuery, peerTrackRecordQuerySchema } from '@/lib/validation';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the peer-comparison family (P3-HYG-3).
// Mutations clear it via invalidateAnalysisCache (routes list includes
// 'peer-track-record').
const TRACK_RECORD_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-track-record:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as peer-comparison).
    const validation = validateQuery(peerTrackRecordQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
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

    // Same currentMonthKey derivation as /api/recommendations.
    // BUGHUNT-R1 FIX 11: a format-valid but unresolvable month label (e.g.
    // "Bulan 2030") used to leave currentMonthKey null → NO upper bound →
    // the FULL history window was returned with 200 as if valid. Now it
    // 400s with the standard error shape (the resolveMonthLabel
    // case-fallback for format-invalid input is unchanged).
    const currentSourceFile = await db.sourceFile.findFirst({
      where: { monthLabel: month },
      select: { monthKey: true },
    });
    const currentMonthKey = currentSourceFile?.monthKey ?? null;
    if (!currentMonthKey) {
      return NextResponse.json(
        { success: false, error: `Bulan "${month}" tidak ditemukan dalam data` },
        { status: 400 },
      );
    }

    // Cache key covers every response-affecting param — outlet/month/week
    // via the standard set, kelompok as the peer-set scope.
    const cacheKey = buildCacheKey({
      route: 'peer-track-record',
      month,
      week,
      outletCode,
      kelompok: kelompokParam,
    });

    type TrackRecordData = Awaited<ReturnType<typeof queryPeerTrackRecord>>;
    const { data: trackData, cached, stale } = await withCacheAndDedup<TrackRecordData>(
      cacheKey,
      TRACK_RECORD_CACHE_TTL,
      async () => {
        return queryPeerTrackRecord(outletCode, week, currentMonthKey, kelompokParam);
      },
    );

    return NextResponse.json({
      success: true,
      outletCode,
      week,
      records: trackData.rows,
      summary: trackData.summary,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[peer-track-record] error:', { error: e });
    return errorResponse(e, 'peer-track-record');
  }
}
