// ============================================================
//  /api/peer-comparison/trend — Multi-Week Trend Comparison
//  For each week in the month, returns Dev/BOM % for the target
//  outlet and the peer average (outlets within ±10% sales range).
//
//  GET: ?outletCode=X&month=Y&peers=A,B,C
//
//  Returns: {
//    targetOutlet, weeks: [{ weekLabel, devBomTarget, devBomPeerAvg }]
//  }
//
//  P2 OPTIMIZATION (replaces N+1 trend queries):
//  Previously this route looped over weeks, executing 1 SQL query
//  per week (4 weeks = 4 DB round-trips). It now delegates to
//  `queryPeerTrend` (outlets.ts), which uses a single GROUP BY
//  weekLabel query — 1 DB round-trip regardless of week count.
//
//  Peer set handling:
//  - If `peers` query param is provided (comma-separated outlet
//    codes), that explicit list is used (stable across weeks).
//  - If omitted, the peer set is auto-computed once via
//    `queryPeerComparison` (MAX weekLabel = month aggregate) so
//    the ±10% sales band matches the main peer table.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryPeerTrend, queryPeerComparison } from '@/lib/queries/outlets/peer-comparison';
import { validateQuery, peerComparisonTrendQuerySchema } from '@/lib/validation';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX: 30→60 — trend across multiple weeks can be slow

// P3-HYG-3: DB-level cache (5 min) + in-flight dedup — same AggregationCache
// pattern as the main /api/peer-comparison route (see the comment there).
// Covers BOTH the explicit-peers path and the auto-computed peer set
// (queryPeerComparison call) — the peer resolution is part of the compute.
const PEER_TREND_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison-trend:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(peerComparisonTrendQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const peersParam = url.searchParams.get('peers'); // optional comma-separated outlet codes
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only —
    // passed to queryPeerComparison for the auto-compute peer set path.
    const kelompok = url.searchParams.get('kelompok');

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // P3-HYG-3: cache key — the explicit `peers` list (when provided) fully
    // determines the peer set, so it goes into `extra`; kelompok only
    // matters on the auto-compute path (peers omitted) but is included
    // unconditionally for simplicity — two entries at worst, never a wrong
    // cache hit (auto-compute with kelompok vs explicit peers produce the
    // same key ONLY if the explicit list equals kelompok's auto set → same
    // answer anyway).
    const cacheKey = buildCacheKey({
      route: 'peer-comparison-trend',
      month,
      outletCode,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      extra: { peers: peersParam },
    });

    const { data: trendData, cached, stale } = await withCacheAndDedup<{
      weeks: Array<{ weekLabel: string; devBomTarget: number; devBomPeerAvg: number }>;
    }>(cacheKey, PEER_TREND_CACHE_TTL, async () => {
      // Peer codes — explicit list preferred (frontend passes the main
      // query's peer set for a stable trend across weeks). If omitted,
      // auto-compute via queryPeerComparison so the ±10% sales band
      // matches the main peer table (single source of truth).
      let peerCodes: string[] = peersParam
        ? peersParam.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      if (peerCodes.length === 0) {
        // month mode → MAX(weekLabel) = whole-month aggregate (matches
        // the main table's peer band derivation; see outlets.ts:177-182).
        // Pass kelompok so the auto-computed peer set respects the global filter.
        const { peers } = await queryPeerComparison(outletCode, month, null, 'month', 20, kelompok);
        peerCodes = peers
          .filter((p) => !p.isTarget)
          .map((p) => p.outletCode)
          .slice(0, 20);
      }

      // Single GROUP BY query — replaces the previous N+1 loop.
      // queryPeerTrend aggregates ALL weeks × ALL peer outlets in one
      // SQL pass (see outlets.ts:458-501). Caps implicit via the peer
      // list (≤20 peers + target).
      const rows = await queryPeerTrend(outletCode, month, '', peerCodes);

      return {
        weeks: rows.map((r) => ({
          weekLabel: r.weekLabel,
          devBomTarget: r.targetDevBom,
          devBomPeerAvg: r.peerAvgDevBom,
        })),
      };
    });

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      month,
      weeks: trendData.weeks,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    });
  } catch (e: unknown) {
    logger.error("[peer-comparison-trend] error:", { error: e });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
