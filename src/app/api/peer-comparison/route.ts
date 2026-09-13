// ============================================================
//  /api/peer-comparison — Peer Comparison per outlet
//  Returns outlets with similar sales (±10%) for side-by-side comparison.
//  GET: ?outletCode=X&month=Y&week=Z&mode=week|month&limit=N
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryPeerComparison } from '@/lib/queries';
import { validateQuery, peerComparisonQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX: 30→60 — peer comparison CROSS JOIN can be slow

// P3-HYG-3: DB-level cache (5 min) + in-flight dedup — same AggregationCache
// pattern as the analysis/pareto family. Previously this route
// (and its /items + /trend siblings) re-ran the CROSS JOIN query on EVERY
// request — the Peer tab re-fires all 3 on every outlet/period/filter change.
const PEER_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(peerComparisonQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const mode = (url.searchParams.get('mode') || 'week') as 'week' | 'month';
    // FIX API2-1: cap limit to prevent abuse + NaN guard
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10), 100);
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only —
    // the focus outlet is still queried by outletCode regardless.
    const kelompok = url.searchParams.get('kelompok');
    // FIX (BUG-2-b / BUG-1-c #3): normalize 'all' (case-insensitive) → null
    // ONCE, then use kelompokParam for BOTH the cache key AND the query —
    // the raw value used to reach queryPeerComparison, where
    // UPPER('all') matched 0 outlets → an empty peer set got cached under
    // the no-filter key (cache poisoning, 5-min TTL). Mirrors the
    // benchmark-opportunity route's normalizeKelompok pattern.
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // P3-HYG-3: cache key covers every response-affecting param —
    // outletCode/month/week/kelompok via the standard filter set, plus
    // mode + limit as route-specific extras (mode=week vs month changes
    // the aggregation grain; limit caps the peer set).
    const cacheKey = buildCacheKey({
      route: 'peer-comparison',
      month,
      week,
      outletCode,
      kelompok: kelompokParam,
      extra: { mode, limit },
    });

    type PeerComparisonData = Awaited<ReturnType<typeof queryPeerComparison>>;
    const { data: peerData, cached, stale } = await withCacheAndDedup<PeerComparisonData>(
      cacheKey,
      PEER_CACHE_TTL,
      async () => queryPeerComparison(outletCode, month, week, mode, limit, kelompokParam),
    );

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      targetSales: peerData.targetSales,
      mode,
      peers: peerData.peers,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error("[peer-comparison] error:", { error: e });
    return errorResponse(e, "peer-comparison");
  }
}
