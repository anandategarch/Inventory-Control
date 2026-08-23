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

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    const { targetSales, peers } = await queryPeerComparison(outletCode, month, week, mode, limit);

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      targetSales,
      mode,
      peers,
    });
  } catch (e: unknown) {
    logger.error("[peer-comparison] error:", { error: e });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
