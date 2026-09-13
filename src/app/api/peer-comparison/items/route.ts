// ============================================================
//  /api/peer-comparison/items — Item-Level Peer Comparison
//  Returns top N items from target outlet, with the same items'
//  metrics aggregated across all peer outlets (±10% sales range).
//
//  GET: ?outletCode=X&month=Y&week=Z&mode=week|month&topItems=5
//
//  Returns: {
//    targetOutlet, items: [{
//      itemName, target: {qtyDeviasi, devBom, nominal},
//      peerAvg: {...}, peerBest: {...}, gap: {...}
//    }]
//  }
//
//  MERGE-1-a (audit A1): the multi-CTE SQL pipeline moved VERBATIM to
//  queryPeerComparisonItems (src/lib/queries/outlets/peer-comparison-items.ts)
//  per the repo colocation convention — this route is now a thin
//  parsing + cache/dedup shell (same shape as /api/peer-comparison).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { validateQuery, peerComparisonItemsQuerySchema } from '@/lib/validation';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';
import { queryPeerComparisonItems } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX: 30→60 — item comparison can be slow with many items

// P3-HYG-3: DB-level cache (5 min) + in-flight dedup for the whole
// multi-CTE CROSS JOIN + grouping pipeline (same pattern as the main
// /api/peer-comparison route — see the comment there).
const PEER_ITEMS_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(peerComparisonItemsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const mode = (url.searchParams.get('mode') || 'week') as 'week' | 'month';
    const topItems = Math.min(parseInt(url.searchParams.get('topItems') || '5', 10) || 5, 20);
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only —
    // the focus outlet's top-items CTE is queried by outletCode regardless.
    const kelompok = url.searchParams.get('kelompok');
    // FIX (BUG-2-b / BUG-1-c #3): normalize 'all' (case-insensitive) → null
    // ONCE, then use kelompokParam for BOTH the cache key AND the query —
    // the raw value used to reach the peer_outlets CTE, where
    // UPPER('all') matched 0 outlets → an empty result cached under the
    // no-filter key (cache poisoning, 5-min TTL). Mirrors the
    // benchmark-opportunity route's normalizeKelompok pattern.
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // P3-HYG-3: cache key — outletCode/month/week/kelompok via the standard
    // filter set; mode + topItems as extras (both change the result grain).
    const cacheKey = buildCacheKey({
      route: 'peer-comparison-items',
      month,
      week,
      outletCode,
      kelompok: kelompokParam,
      extra: { mode, topItems },
    });

    type PeerComparisonItemsData = Awaited<ReturnType<typeof queryPeerComparisonItems>>;
    const { data: resultData, cached, stale } = await withCacheAndDedup<PeerComparisonItemsData>(
      cacheKey,
      PEER_ITEMS_CACHE_TTL,
      () => queryPeerComparisonItems(outletCode, month, week, mode, topItems, kelompokParam),
    );

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      mode,
      topItems,
      items: resultData.items,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    });
  } catch (e: unknown) {
    logger.error("[peer-comparison-items] error:", { error: e });
    // FIX (BUG-2-b / BUG-1-c #4): use the gated errorResponse helper (same as
    // the sibling routes) instead of echoing e.message raw — internal DB/SQL
    // error details must not leak to clients in production.
    return errorResponse(e, "peer-comparison-items");
  }
}
