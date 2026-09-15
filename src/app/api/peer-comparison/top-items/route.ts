// ============================================================
//  /api/peer-comparison/top-items — PEERTOP-1
//  "Top item di tiap peer": each peer outlet's own top-N items
//  (aggregate per item — SUM(absNominalDeviasi)) plus the
//  cross-peer union (shared vs local problems, blind spots).
//
//  GET: ?outletCode=X&month=Y&week=Z&mode=week|month&topN=5&limit=50&kelompok=K
//
//  `limit` must match the /api/peer-comparison `limit` param so the
//  peer band (ORDER BY sales proximity, LIMIT limit+1) is IDENTICAL
//  to the Peer Table's row set — perPeer entries map 1:1 onto rows.
//
//  Thin parsing + cache/dedup shell (same shape as the sibling
//  /api/peer-comparison routes — the SQL lives in
//  queryPeerTopItems, src/lib/queries/outlets/peer-top-items.ts).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { validateQuery, peerTopItemsQuerySchema } from '@/lib/validation';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';
import { queryPeerTopItems } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // all-items × band-outlets scan — same budget family as the siblings

// P3-HYG-3: DB-level cache (5 min) + in-flight dedup — same pattern as
// /api/peer-comparison and /items (the Peer tab refires this on every
// outlet/period/kelompok change).
const PEER_TOP_ITEMS_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison-top-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(peerTopItemsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    // Normalize mode (BUG-H style): unknown values fall back to 'week' and
    // must not poison the cache key.
    const mode: 'week' | 'month' = url.searchParams.get('mode') === 'month' ? 'month' : 'week';
    // topN (per-outlet top count) clamped 1..10 — Math.max lower bound like
    // the items route's topItems fix (a negative LIMIT is a Postgres 500).
    const topN = Math.min(Math.max(1, parseInt(url.searchParams.get('topN') || '5', 10) || 5), 10);
    // limit (peer band cap) clamped 1..100 — mirrors the main route's clamp.
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50), 100);
    // FIX (BUG-2-b / BUG-1-c #3): normalize 'all' (case-insensitive) → null
    // ONCE, then use kelompokParam for BOTH the cache key AND the query.
    const kelompok = url.searchParams.get('kelompok');
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Cache key covers every response-affecting param: the standard filter
    // set (month/week/outletCode/kelompok) + mode/topN/limit as extras
    // (each changes the result grain).
    // PEERTOP-R2: +sv — the union row shape changed (peerTopNames →
    // topDiNames; "Top di" now shows the TOP-3 resto names by |nominal|,
    // target included). NOTE: sv was also missing for PEERTOP-R1's shape
    // change — sv:2 flushes any stale pre-R2/pre-R1 row the unbounded SWR
    // store would otherwise keep serving under the unchanged key (same
    // stale-PDF incident class as export-report's rv).
    // PEERTOP-R3 (user: "ada bug di rangking. misal resto target 11/11
    // tapi juga muncul di top di"): topDiNames basis CHANGED — kini
    // RANK() yang sama dengan kolom Rangking (outlet itemRank ≤ 3 di
    // antara SEMUA outlet yang mencatat item; target muncul persis
    // ketika itemRank ≤ 3). sv 2 → 3 flushes the stale pre-R3 rows.
    const cacheKey = buildCacheKey({
      route: 'peer-comparison-top-items',
      month,
      week,
      outletCode,
      kelompok: kelompokParam,
      extra: { mode, topN, limit, sv: 3 },
    });

    type PeerTopItemsData = Awaited<ReturnType<typeof queryPeerTopItems>>;
    const { data: resultData, cached, stale } = await withCacheAndDedup<PeerTopItemsData>(
      cacheKey,
      PEER_TOP_ITEMS_CACHE_TTL,
      () => queryPeerTopItems(outletCode, month, week, mode, topN, limit, kelompokParam),
    );

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      mode,
      topN,
      // NOTE: no peerCount here on purpose — the peer band equals the
      // /api/peer-comparison peer set for the same params; callers derive
      // the denominator from that response's peers[] (non-target count).
      items: resultData.items,
      perPeer: resultData.perPeer,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    });
  } catch (e: unknown) {
    logger.error('[peer-comparison-top-items] error:', { error: e });
    // Gated errorResponse — internal DB/SQL details must not leak.
    return errorResponse(e, 'peer-comparison-top-items');
  }
}
