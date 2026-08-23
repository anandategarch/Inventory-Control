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
import { queryPeerTrend, queryPeerComparison } from '@/lib/queries/outlets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison-trend:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const peersParam = url.searchParams.get('peers'); // optional comma-separated outlet codes

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Peer codes — explicit list preferred (frontend passes the main
    // query's peer set for a stable trend across weeks). If omitted,
    // auto-compute via queryPeerComparison so the ±10% sales band
    // matches the main peer table (single source of truth).
    let peerCodes: string[] = peersParam
      ? peersParam.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    if (peerCodes.length === 0) {
      // month mode → MAX(weekLabel) = whole-month aggregate (matches
      // the main table's peer band derivation; see outlets.ts:177-182).
      const { peers } = await queryPeerComparison(outletCode, month, null, 'month', 20);
      peerCodes = peers
        .filter(p => !p.isTarget)
        .map(p => p.outletCode)
        .slice(0, 20);
    }

    // Single GROUP BY query — replaces the previous N+1 loop.
    // queryPeerTrend aggregates ALL weeks × ALL peer outlets in one
    // SQL pass (see outlets.ts:458-501). Caps implicit via the peer
    // list (≤20 peers + target).
    const rows = await queryPeerTrend(outletCode, month, '', peerCodes);

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      month,
      weeks: rows.map(r => ({
        weekLabel: r.weekLabel,
        devBomTarget: r.targetDevBom,
        devBomPeerAvg: r.peerAvgDevBom,
      })),
    });
  } catch (e: unknown) {
    logger.error("[peer-comparison-trend] error:", { error: e });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
