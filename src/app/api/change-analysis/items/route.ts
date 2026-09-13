// ============================================================
//  /api/change-analysis/items — item attribution (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  "Item apa yang buat resto ini menyimpang?" — decomposes ONE
//  outlet's current deviation move per item (Ide 1: swing share /
//  kontribusi), flags items moving ≥ threshold × their own average
//  move (Ide 2: badge ANOMALI vs kebiasaan item sendiri), and marks
//  items whose move OPPOSES the outlet's net move (Ide 3: the
//  cancellers hidden behind a small net number).
//  GET: ?month=Y&week=Z&kelompok=K&outletCode=C (outletCode required).
//  Read-only; route-level cache 5 min + in-flight dedup; mutations
//  invalidate via the 'change-analysis-items' prefix.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import {
  queryOutletChangeItems,
  resolveChangeAnalysisContext,
  type ChangeAnalysisItemsResult,
} from '@/lib/queries/outlets/change-analysis';
import { validateQuery, changeAnalysisItemsQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';
import { getRuntimeThresholds } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CHANGE_ANALYSIS_ITEMS_CACHE_TTL = 5 * 60 * 1000;

/** `?kelompok=all` means "no kelompok filter" — normalize to null. */
function normalizeKelompok(raw: string | null): string | null {
  return raw && raw !== 'all' ? raw : null;
}

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`change-analysis-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const validation = validateQuery(changeAnalysisItemsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const weekParam = url.searchParams.get('week');
    const kelompok = normalizeKelompok(url.searchParams.get('kelompok'));
    const outletCode = url.searchParams.get('outletCode');

    if (!month) {
      return NextResponse.json({ success: false, error: 'month required' }, { status: 400 });
    }
    if (!outletCode) {
      return NextResponse.json({ success: false, error: 'outletCode required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    const cacheKey = buildCacheKey({
      route: 'change-analysis-items',
      month,
      week: weekParam,
      kelompok,
      outletCode,
    });

    const { data, cached, stale } = await withCacheAndDedup<ChangeAnalysisItemsResult>(
      cacheKey,
      CHANGE_ANALYSIS_ITEMS_CACHE_TTL,
      async () => {
        const { week, currentMonthKey } = await resolveChangeAnalysisContext(month!, weekParam);
        const thresholds = await getRuntimeThresholds();
        if (!week || !currentMonthKey) {
          return { month: month!, week: week ?? '', outlet: null, items: [] };
        }
        return queryOutletChangeItems({
          month: month!,
          week,
          currentMonthKey,
          outletCode: outletCode!,
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
    logger.error('[change-analysis/items] error:', { error: e });
    return errorResponse(e, 'change-analysis-items');
  }
}
