// ============================================================
//  /api/outlet-monthly-series — Deret Bulanan (DEEP-RESTO-1)
//  Multi-month SAME-weekLabel series for ONE outlet: sales (MODE)
//  + MoM, ΣABS qtyBom, signed Σ nominalDeviasi, Dev/BOM, Total
//  Loss/Surplus (Excel convention), Net Cost Ratio, and a
//  recurrence-style abnormal flag (same thresholds as
//  /api/recommendations history — devBom > FALLBACK_TOLERANCE_PCT
//  OR loss > HIGH_LOSS_NOMINAL_THRESHOLD).
//  GET: ?outletCode=X&month=Y&week=Z
//  Window: most recent 12 same-week months ending at the running
//  month (inclusive).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryOutletMonthlySeries } from '@/lib/queries';
import { validateQuery, outletMonthlySeriesQuerySchema } from '@/lib/validation';
import { getRuntimeThresholds } from '@/lib/settings';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the peer-comparison family (P3-HYG-3):
// 5-min DB-level cache + in-flight dedup. Mutations clear it via
// invalidateAnalysisCache (routes list includes 'outlet-monthly-series').
const SERIES_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`outlet-monthly-series:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as peer-comparison).
    const validation = validateQuery(outletMonthlySeriesQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');

    if (!outletCode || !month || !week) {
      return NextResponse.json({ success: false, error: 'outletCode, month and week required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Same currentMonthKey derivation as /api/recommendations — window
    // upper bound (inclusive of the running month).
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

    // BUGHUNT-R1 FIX 14: load the thresholds OUTSIDE the cache closure so
    // the EXACT runtime values used for the abnormal computation are
    // echoed on the response (additive `thresholds` object) — the card's
    // Dev/BOM cell + legend previously hardcoded 0.1 / "Rp 50 Jt" while
    // the abnormal flag follows these runtime-adjustable values.
    // getRuntimeThresholds() has its own 30s cache — no extra DB cost.
    const thresholds = await getRuntimeThresholds();

    // Cache key covers every response-affecting param — outlet/month/week.
    // The window derives deterministically from (month, week), so it needs
    // no separate key part.
    const cacheKey = buildCacheKey({
      route: 'outlet-monthly-series',
      month,
      week,
      outletCode,
    });

    type SeriesData = Awaited<ReturnType<typeof queryOutletMonthlySeries>>;
    const { data: seriesData, cached, stale } = await withCacheAndDedup<SeriesData>(
      cacheKey,
      SERIES_CACHE_TTL,
      async () => {
        return queryOutletMonthlySeries(outletCode, week, currentMonthKey, thresholds.FALLBACK_TOLERANCE_PCT, thresholds.HIGH_LOSS_NOMINAL_THRESHOLD);
      },
    );

    return NextResponse.json({
      success: true,
      outletCode,
      week,
      months: seriesData.rows,
      total: seriesData.total,
      // BUGHUNT-R1 FIX 14 (additive): the exact values the `abnormal` flag
      // was computed with this request.
      thresholds: {
        devBomTolerance: thresholds.FALLBACK_TOLERANCE_PCT,
        highLossNominal: thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
      },
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[outlet-monthly-series] error:', { error: e });
    return errorResponse(e, 'outlet-monthly-series');
  }
}
