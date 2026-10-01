// ============================================================
//  /api/waste-series — Waste network series (DEEP-WASTE-1)
//  Multi-month SAME-weekLabel waste view for the scoped filter
//  set (area/kelompok/pic — the global dashboard scope), or ONE
//  outlet when outletCode is provided (the Resto tab's Profil
//  Waste card): per (outlet, month) waste/susut/trial/residual/
//  loss aggregates + sales (MODE) + waste/sales + the 4 network
//  detectors (spike 2σ, zero-waste-big-loss, under-recording,
//  residual-dominant), per-outlet profile rows (rank on
//  waste/sales) + network KPIs.
//  GET: ?month=Y&week=Z&area=&kelompok=&pic=&outletCode=
//  Window: most recent 12 same-week months ending at the running
//  month (inclusive).
//
//  W2 (Kronis vs Episodik) — ADDITIVE response fields: per-outlet
//  persistenceClass/activeMonths/monthsAboveMedian/… + top-level
//  `persistence` block (transition matrix 2×2, persistence ratio,
//  Fisher exact p, class distribution, per-month medians). The
//  route only RESHAPES the query result into explicit keys, so the
//  new block is forwarded here; nothing existing was renamed or
//  removed (old clients keep working).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { buildWastePersistence, queryWasteNetwork } from '@/lib/queries';
import { validateQuery, wasteSeriesQuerySchema } from '@/lib/validation';
import { getRuntimeThresholds } from '@/lib/settings';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the peer-comparison family (P3-HYG-3):
// 5-min DB-level cache + in-flight dedup. Mutations clear it via
// invalidateAnalysisCache (routes list includes 'waste-series').
const WASTE_SERIES_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`waste-series:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as pareto/change-analysis).
    const validation = validateQuery(wasteSeriesQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const pic = url.searchParams.get('pic');
    // outletCode is OPTIONAL here — absent = the whole scoped network
    // (Waste tab), present = that outlet only (Resto tab Profil Waste).
    const outletCode = url.searchParams.get('outletCode');
    // FIX (BUG-2-b / BUG-1-c #3) pattern: normalize 'all' (case-insensitive)
    // → null ONCE, then use the normalized value for BOTH the cache key AND
    // the query (raw 'all' would match 0 outlets and poison the cache).
    const kelompok = url.searchParams.get('kelompok');
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Resolve PIC → outletCodes (shared logic — same as /api/pareto).
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      // W2: keep the success shape consistent across ALL success paths —
      // the empty persistence block is built by the SAME pure builder
      // (single source of truth, zeroed summary + null statistics).
      const emptyPersistence = buildWastePersistence([]);
      return NextResponse.json({
        success: true,
        months: [],
        monthly: [],
        outlets: [],
        kpis: { outlets: 0, months: 0, sales: 0, waste: 0, susut: 0, trial: 0, residual: 0, totalLoss: 0, totalSurplus: 0, wasteToSales: 0, zeroWasteBigLossOutlets: 0, underRecordingOutlets: 0, residualDominantOutlets: 0, spikeCells: 0 },
        persistence: { summary: emptyPersistence.summary, medians: emptyPersistence.medians },
      });
    }

    // Same currentMonthKey derivation as /api/recommendations — window
    // upper bound (inclusive of the running month).
    // BUGHUNT-R1 FIX 11: a format-valid but unresolvable month label (e.g.
    // "Bulan 2030" — passes the zod regex, resolves to NO SourceFile row)
    // used to leave currentMonthKey null → NO upper bound → the FULL
    // history window was returned with 200 as if the month were valid.
    // Now it 400s with the standard error shape; the resolveMonthLabel
    // case-fallback for format-invalid input is unchanged (that path
    // still returns the label for a case-insensitive re-lookup).
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

    // Cache key covers every response-affecting param (route/month/week via
    // the standard set + the full filter scope incl. the optional outlet).
    const cacheKey = buildCacheKey({
      route: 'waste-series',
      month,
      week,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompokParam,
      pic,
      outletCode,
    });

    type WasteSeriesData = Awaited<ReturnType<typeof queryWasteNetwork>>;
    const { data: wasteData, cached, stale } = await withCacheAndDedup<WasteSeriesData>(
      cacheKey,
      WASTE_SERIES_CACHE_TTL,
      async () => {
        const thresholds = await getRuntimeThresholds();
        return queryWasteNetwork(week, currentMonthKey, {
          area: area && area !== 'all' ? area : null,
          kelompok: kelompokParam,
          outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
          picOutletCodes,
        }, thresholds.HIGH_LOSS_NOMINAL_THRESHOLD);
      },
    );

    return NextResponse.json({
      success: true,
      week,
      months: wasteData.months,
      monthly: wasteData.monthly,
      outlets: wasteData.outlets,
      kpis: wasteData.kpis,
      // W2 (Kronis vs Episodik) — additive block: network transition
      // matrix + persistence ratio + Fisher p + class distribution +
      // per-month medians (outlet rows above already carry the
      // per-outlet persistence fields).
      persistence: wasteData.persistence,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[waste-series] error:', { error: e });
    return errorResponse(e, 'waste-series');
  }
}
