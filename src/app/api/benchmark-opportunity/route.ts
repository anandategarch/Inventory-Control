// ============================================================
//  /api/benchmark-opportunity — "Peluang Perbaikan (Rp)" vs median area
//  --------------------------------------------------------
//  ANA-1-E (roadmap "Benchmark Opportunity"): measured Rp number
//  for the PEER tab — total Rp suppressible if every outlet's
//  loss dropped to its AREA MEDIAN loss.
//  GET: ?month=Y&week=Z&kelompok=K
//    - week optional: falls back to the month's LATEST week
//      (cumulative-week MAX fix, same as peer-comparison).
//    - kelompok optional: scopes the outlet set (same filter as
//      the peer-comparison family).
//  Read-only — no POST/mutation on this route.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryBenchmarkOpportunity } from '@/lib/queries/outlets/benchmark-opportunity';
import { validateQuery, benchmarkOpportunityQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same DB-level cache TTL as the peer-comparison family (P3-HYG-3):
// 5 min + in-flight dedup via the shared AggregationCache pattern.
const BENCHMARK_OPPORTUNITY_CACHE_TTL = 5 * 60 * 1000;

/** `?kelompok=all` means "no kelompok filter" — normalize to null. */
function normalizeKelompok(raw: string | null): string | null {
  return raw && raw !== 'all' ? raw : null;
}

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`benchmark-opportunity:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1 pattern: Zod input validation (same as peer-comparison).
    const validation = validateQuery(benchmarkOpportunityQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    // FIX (BUG-KELOMPOK-CACHE convention): normalize 'all' → null so
    // `?kelompok=all` and no kelompok param share one cache entry.
    const kelompok = normalizeKelompok(url.searchParams.get('kelompok'));

    if (!month) {
      return NextResponse.json({ success: false, error: 'month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Cache key covers every response-affecting param: month/week/kelompok
    // via the standard filter set. No outletCode — the metric is network-wide
    // per area, so it is intentionally shared across focus-outlet switches.
    const cacheKey = buildCacheKey({
      route: 'benchmark-opportunity',
      month,
      week,
      kelompok,
    });

    type BenchmarkOpportunityData = Awaited<ReturnType<typeof queryBenchmarkOpportunity>>;
    const { data: opportunityData, cached, stale } = await withCacheAndDedup<BenchmarkOpportunityData>(
      cacheKey,
      BENCHMARK_OPPORTUNITY_CACHE_TTL,
      async () => queryBenchmarkOpportunity(month, week, { kelompok }),
    );

    return NextResponse.json({
      success: true,
      period: { month, week },
      totalOpportunityRp: opportunityData.totalOpportunityRp,
      areaCount: opportunityData.areaCount,
      topOutlets: opportunityData.topOutlets,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[benchmark-opportunity] error:', { error: e });
    return errorResponse(e, 'benchmark-opportunity');
  }
}
