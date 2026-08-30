import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryRestoRecommendations } from '@/lib/queries';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { validateQuery, recommendationsQuerySchema } from '@/lib/validation';
import { getRuntimeThresholds } from '@/lib/settings';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, getCached, setCached } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX: 30→60 — queryRestoRecommendations is heavy (3 parallel CTEs)

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`recommendations:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(recommendationsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    let prevWeek = url.searchParams.get('prevWeek');
    let prevMonth = url.searchParams.get('prevMonth');
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '5') || 5), 50);
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outletCode');
    const pic = url.searchParams.get('pic');
    // FIX (BUG-KELOMPOK-GLOBAL): read kelompok param so RestoRecommendationCard
    // respects the global kelompok filter (was missing → recommendations showed
    // outlets from ALL kelompok even when user filtered to one).
    const kelompok = url.searchParams.get('kelompok');

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // PERF-01 FIX: Check DB cache BEFORE expensive setup awaits (month resolver,
    // prevWeek auto-compute, sourceFile, thresholds, PIC resolution).
    // On cache HIT (~warm calls), we skip all 5 awaits → ~200-400ms saved.
    // Cache key uses raw URL params (prevWeek/prevMonth may be null → auto-computed
    // deterministically, so null is a valid cache key component).
    const earlyCacheKey = buildCacheKey({
      route: 'recommendations', month, week, compareWeek: prevWeek, compareMonth: prevMonth,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });
    const REC_CACHE_TTL = 5 * 60 * 1000; // 5 min
    const earlyCached = await getCached<unknown>(earlyCacheKey, REC_CACHE_TTL);
    if (earlyCached && typeof earlyCached === 'object' && 'success' in earlyCached) {
      return NextResponse.json(earlyCached, { headers: CACHE_ANALYSIS });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;
    if (prevMonth) prevMonth = resolveMonthLabel(prevMonth, resolver) || prevMonth;

    // FIX FLOW-2: Auto-compute prevWeek/prevMonth when not provided (matches /api/analysis pattern)
    // Without this, 3 of 15 priority signals (Deviasi Growth, Direction Flip, Trend Memburuk —
    // total weight 26%) are ALWAYS zero unless user manually selects a compare period.
    if (!prevWeek || !prevMonth) {
      try {
        const periods = await db.week.findMany({
          select: { weekLabel: true, monthKey: true, sourceFile: { select: { monthLabel: true } } },
          distinct: ['monthKey', 'weekLabel'],
        });
        const allPeriods = periods
          .map((w) => ({
            monthLabel: w.sourceFile.monthLabel,
            weekLabel: w.weekLabel,
            monthKey: w.monthKey,
            sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
          }))
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

        const currentIdx = allPeriods.findIndex(
          (p) => p.monthLabel === month && p.weekLabel === week,
        );
        if (currentIdx > 0) {
          // Auto-compare: same weekLabel in previous month (if exists), else previous period
          const sameWeekInPrevMonth = allPeriods
            .slice(0, currentIdx)
            .reverse()
            .find((p) => p.weekLabel === week);
          const prevPeriod = sameWeekInPrevMonth || allPeriods[currentIdx - 1];
          if (!prevWeek) prevWeek = prevPeriod.weekLabel;
          if (!prevMonth) prevMonth = prevPeriod.monthLabel;
        }
      } catch {
        // Week table may not exist — skip auto-compute
      }
    }

    // FIX (AUDIT7-CALC-8): resolve currentMonthKey via SourceFile so the
    // historical-baseline CTE in queryRestoRecommendations can filter out
    // FUTURE months (matches the pattern used by /api/pareto per BUG2-PARETO-1).
    // Without this, `histAvgNominalDeviasi` + `histPeriodCount` for Signal 2
    // (Deviasi Growth Historical, 10% weight) + Signal 7 (Trend Memburuk, 8%
    // weight) include future-month data → inflates baseline + corrupts priority.
    const currentSourceFile = await db.sourceFile.findFirst({
      where: { monthLabel: month },
      select: { monthKey: true },
    });
    const currentMonthKey = currentSourceFile?.monthKey ?? null;

    // FIX (AUDIT7-CALC-11): fetch runtime thresholds so Signal 11 uses the
    // configured HIGH_LOSS_NOMINAL_THRESHOLD (default 50jt, configurable via
    // Settings UI) instead of the old hardcoded 10jt. Settings changes now
    // propagate to the priority score (5% weight on Signal 11).
    const thresholds = await getRuntimeThresholds();

    // Resolve PIC → outletCodes (shared logic)
    const picOutletCodes = await resolvePICOutletCodes(pic);
    // FIX (BUG-HUNT-RECENT): early-return if PIC has no outlets (sibling routes have this)
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({ success: true, recommendations: [] });
    }

    const filters = {
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      picOutletCodes,
    };

    // DP-14: Cache check already done above (PERF-01) — using earlyCacheKey.
    const recommendations = await queryRestoRecommendations(
      month,
      week,
      prevWeek,
      prevMonth,
      filters,
      limit,
      currentMonthKey,
      thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
    );

    const result = { success: true, recommendations };
    await setCached(earlyCacheKey, result, true);
    return NextResponse.json(result, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error("[recommendations] error", { error: e });
    return errorResponse(e, "recommendations");
  }
}
