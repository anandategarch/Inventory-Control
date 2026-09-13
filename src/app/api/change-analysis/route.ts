// ============================================================
//  /api/change-analysis — "Rata-rata Perubahan" (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  Outlet ranking for the dashboard lens "Perubahan": how far the
//  CURRENT period-over-period deviation move strays from the outlet's
//  OWN average move (same-week chain, magnitude semantics).
//  GET: ?month=Y&week=Z&kelompok=K
//    - week optional: falls back to the month's LATEST week
//      (cumulative-week MAX — same as benchmark-opportunity).
//    - kelompok optional: scopes the outlet set ('all' → null).
//  Read-only. Route-level cache (5 min TTL + in-flight dedup, same
//  pattern as the peer-comparison family); mutations invalidate via
//  invalidateAnalysisCache's 'change-analysis' prefix — a Settings
//  change clears the entry, so thresholds need no cache fingerprint.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import {
  queryOutletChangeAnalysis,
  resolveChangeAnalysisContext,
  type ChangeAnalysisResult,
} from '@/lib/queries/outlets/change-analysis';
import { validateQuery, changeAnalysisQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';
import { getRuntimeThresholds } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same DB-level cache TTL as the peer-comparison family (P3-HYG-3).
const CHANGE_ANALYSIS_CACHE_TTL = 5 * 60 * 1000;

/** `?kelompok=all` means "no kelompok filter" — normalize to null. */
function normalizeKelompok(raw: string | null): string | null {
  return raw && raw !== 'all' ? raw : null;
}

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`change-analysis:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const validation = validateQuery(changeAnalysisQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const weekParam = url.searchParams.get('week');
    const kelompok = normalizeKelompok(url.searchParams.get('kelompok'));

    if (!month) {
      return NextResponse.json({ success: false, error: 'month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    const cacheKey = buildCacheKey({
      route: 'change-analysis',
      month,
      week: weekParam,
      kelompok,
    });

    // Resolution (week fallback + monthKey + runtime thresholds) happens
    // INSIDE the cached compute — warm hits skip every await.
    const { data, cached, stale } = await withCacheAndDedup<ChangeAnalysisResult>(
      cacheKey,
      CHANGE_ANALYSIS_CACHE_TTL,
      async () => {
        const { week, currentMonthKey } = await resolveChangeAnalysisContext(month!, weekParam);
        const thresholds = await getRuntimeThresholds();
        if (!week || !currentMonthKey) {
          // No records / no SourceFile for the month → empty ranking (200 —
          // the lens renders its friendly no-data state).
          return {
            month: month!,
            week: week ?? '',
            currentMonthKey: currentMonthKey ?? '',
            thresholds: {
              ratioThreshold: thresholds.CHANGE_ANOMALY_RATIO,
              minPairs: thresholds.CHANGE_MIN_PAIRS,
              minNominal: thresholds.CHANGE_MIN_NOMINAL,
            },
            counts: { ranked: 0, anomali: 0, baruBergerak: 0, dataKurang: 0 },
            outlets: [],
          };
        }
        return queryOutletChangeAnalysis({
          month: month!,
          week,
          currentMonthKey,
          filters: { kelompok },
          thresholds: {
            ratioThreshold: thresholds.CHANGE_ANOMALY_RATIO,
            minPairs: thresholds.CHANGE_MIN_PAIRS,
            minNominal: thresholds.CHANGE_MIN_NOMINAL,
          },
        });
      },
    );

    return NextResponse.json({
      success: true,
      period: { month, week: data.week || null },
      ...data,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[change-analysis] error:', { error: e });
    return errorResponse(e, 'change-analysis');
  }
}
