import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryRestoRecommendations, queryOutletRecurrence, type OutletRecurrenceHistory } from '@/lib/queries';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { validateQuery, recommendationsQuerySchema } from '@/lib/validation';
import { getRuntimeThresholds } from '@/lib/settings';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

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
    //
    // PERF-CACHE-02: cache key now includes `limit` (was missing → two requests
    //   with different `?limit=N` values shared one cache entry → wrong response).
    // PERF-CACHE-06: withCacheAndDedup adds in-flight Promise dedup for concurrent
    //   identical requests (was missing — only /api/analysis had it).
    const earlyCacheKey = buildCacheKey({
      route: 'recommendations', month, week, compareWeek: prevWeek, compareMonth: prevMonth,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
      // v: 3 (BUG-2-c) — payload shape changed: top-level `priorityCount` added
      // (outlets with priorityLevel TINGGI/SEDANG, pre-slice — replaces the
      // display-limit hero count). v: 2 (H-13) was the signals rename. The route
      // prefix in invalidateAnalysisCache() is unchanged, so mutations still
      // clear rows of ALL shapes.
      extra: { limit, v: 3 },
    });
    const REC_CACHE_TTL = 5 * 60 * 1000; // 5 min

    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<{ success: boolean; recommendations: unknown[]; priorityCount?: number; cached?: boolean }>(earlyCacheKey, REC_CACHE_TTL, async () => {
      const resolver = await getMonthResolver();
      let resolvedMonth = resolveMonthLabel(month!, resolver) || month!;
      let resolvedPrevMonth = prevMonth;
      if (resolvedPrevMonth) resolvedPrevMonth = resolveMonthLabel(resolvedPrevMonth, resolver) || resolvedPrevMonth;

      // FIX FLOW-2: Auto-compute prevWeek/prevMonth when not provided (matches /api/analysis pattern)
      // Without this, 3 of 15 priority signals (Deviasi Growth, Direction Flip, Trend Memburuk —
      // total weight 26%) are ALWAYS zero unless user manually selects a compare period.
      let resolvedPrevWeek = prevWeek;
      if (!resolvedPrevWeek || !resolvedPrevMonth) {
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
            (p) => p.monthLabel === resolvedMonth && p.weekLabel === week,
          );
          if (currentIdx > 0) {
            // Auto-compare: same weekLabel in a previous month ONLY.
            // FIX (AUDIT-BUG-2): weeks are CUMULATIVE — cross-week comparison
            // (e.g. W2 vs W1 same month) produces false ~-50% growth. No
            // fallback: no same-week prior period → no comparison (leave
            // resolvedPrevWeek/resolvedPrevMonth unchanged; they stay null and
            // queryRestoRecommendations takes its no-comparison path).
            const sameWeekInPrevMonth = allPeriods
              .slice(0, currentIdx)
              .reverse()
              .find((p) => p.weekLabel === week);
            if (sameWeekInPrevMonth) {
              if (!resolvedPrevWeek) resolvedPrevWeek = sameWeekInPrevMonth.weekLabel;
              if (!resolvedPrevMonth) resolvedPrevMonth = sameWeekInPrevMonth.monthLabel;
            }
          }
        } catch {
          // Week table may not exist — skip auto-compute
        }
      }

      // PERF-API-05 (Task PERF-API): parallelize 3 independent awaits that were
      // previously sequential — db.sourceFile.findFirst, getRuntimeThresholds,
      // resolvePICOutletCodes. All depend on resolvedMonth (computed above) but
      // NOT on each other. Saves ~50-100ms on cold cache path (3 sequential
      // ~30ms awaits → 1 parallel batch).
      const [currentSourceFile, thresholds, picOutletCodes] = await Promise.all([
        db.sourceFile.findFirst({
          where: { monthLabel: resolvedMonth },
          select: { monthKey: true },
        }),
        getRuntimeThresholds(),
        resolvePICOutletCodes(pic),
      ]);
      const currentMonthKey = currentSourceFile?.monthKey ?? null;

      // FIX (BUG-HUNT-RECENT): early-return if PIC has no outlets — cached as
      // empty result so subsequent identical requests skip PIC resolution.
      // FIX (BUG-2-c): priorityCount included on the empty path too (0 — no
      // outlets evaluated, so no priority outlets).
      if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
        return { success: true, recommendations: [], priorityCount: 0 };
      }

      const filters = {
        area: area && area !== 'all' ? area : null,
        kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
        outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
        picOutletCodes,
      };

      // ANA-1-D (recurrence/persistence): additive per-outlet `history` field —
      // same-weekLabel months BEFORE the current period (max 12). Runs in
      // PARALLEL with the (unchanged) scoring query; merged AFTER scoring so
      // priorityScore/weights/signals are byte-identical. "Periode bermasalah"
      // = devBom > thresholds.FALLBACK_TOLERANCE_PCT (canonical tolerance
      // fallback, default 0.05) OR lossNominal > thresholds.
      // HIGH_LOSS_NOMINAL_THRESHOLD (P1 nominal, default 50jt) — both existing
      // runtime Settings, no new numbers.
      // Non-fatal on failure: the field is optional, so the card simply hides
      // the chip (logged, recommendations still returned).
      // FIX (BUG-2-c): queryRestoRecommendations now returns an envelope
      // { recommendations, priorityCount } — destructure both; only the
      // array flows into the recurrence merge below.
      const [{ recommendations, priorityCount }, recurrenceMap] = await Promise.all([
        queryRestoRecommendations(
          resolvedMonth,
          week!,
          resolvedPrevWeek,
          resolvedPrevMonth,
          filters,
          limit,
          currentMonthKey,
          thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
        ),
        queryOutletRecurrence(
          resolvedMonth,
          week,
          currentMonthKey,
          filters,
          thresholds.FALLBACK_TOLERANCE_PCT,
          thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
        ).catch((e: unknown) => {
          logger.error('[recommendations] outlet recurrence history failed (history omitted)', {
            error: e instanceof Error ? e.message : String(e),
          });
          return new Map<string, OutletRecurrenceHistory>();
        }),
      ]);

      // Merge: spread keeps every existing field untouched; `history` is only
      // ADDED when the outlet has same-week historical months (otherwise the
      // key stays absent — old-cache payloads without it remain type-valid).
      // FIX (BUG-2-c): `priorityCount` (pre-slice TINGGI+SEDANG outlet total)
      // rides at the TOP LEVEL next to `recommendations` — it is a scalar, so
      // it deliberately does NOT take part in the recommendations.map below.
      return {
        success: true,
        priorityCount,
        recommendations: recommendations.map((r) => {
          const history = recurrenceMap.get(r.outletCode);
          return history ? { ...r, history } : r;
        }),
      };
    });

    // PERF-CACHE-06: add `cached: true` flag when served from cache (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): also surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error("[recommendations] error", { error: e });
    return errorResponse(e, "recommendations");
  }
}
