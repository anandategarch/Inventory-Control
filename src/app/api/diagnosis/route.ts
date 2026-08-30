// ============================================================
//  /api/diagnosis — Bayesian Causal Inference Engine
//  GET: ?month=&week=&area=&kelompok=&outlet=&pic=
//
//  Diagnoses WHY deviations happen at each outlet by computing
//  posterior probabilities for 7 cause types:
//    MISSING_BOM, SHRINKAGE, FRAUD, PORTIONING, SUPPLIER,
//    SALES_MIX, SEASONAL
//
//  Each outlet returns its top 3 causes (by confidence) with:
//    - causeLabel + confidence (normalised posterior)
//    - evidence array (which signals fired + their weights)
//    - autoAction (recommended next step)
//    - impactEstimate (estimated Rp impact)
//
//  Cross-outlet stats: `causeDistribution` counts how many outlets
//  have each cause as their TOP cause + average confidence.
//
//  Pattern (per CONVENTIONS.md §1 + §3.1):
//    - `force-dynamic` + maxDuration=60 (heavy route — 4 SQL queries
//      + evaluateRulesSql, ~3-5s cold)
//    - Rate limiting (30 req/min per IP — interactive Diagnosis tab)
//    - Zod validation (diagnosisQuerySchema — strict mode rejects
//      unknown params)
//    - DB cache via withCacheAndDedup (5-min TTL) + SWR
//    - Cache key includes month+week+filters (all response-affecting
//      params). prevWeek/prevMonth are auto-resolved deterministically
//      from (week, month) — NOT in cache key (would be redundant).
//    - Resolve month BEFORE cache key (so "Agustus 2026" + "agustus
//      2026" share one entry)
//    - Parallel resolve PIC inside computeFn
//    - `startedAt` timing + `durationMs` in response
//    - Generic error message on failure (no DB schema/SQL leakage)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { resolvePreviousPeriod } from '@/lib/period-resolver';
import { getRuntimeThresholds } from '@/lib/settings';
import { validateQuery, diagnosisQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { queryDiagnosisEvidence } from '@/lib/queries/diagnosis';
import {
  computeCausalDiagnosis,
  computeCauseDistribution,
  type CausalResult,
  type CauseId,
} from '@/lib/metrics/causal-engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DIAGNOSIS_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches other analysis routes

// Stable order for the causeDistribution keys (UI consumers can rely on it).
const CAUSE_ORDER: CauseId[] = [
  'MISSING_BOM', 'SHRINKAGE', 'FRAUD', 'PORTIONING',
  'SUPPLIER', 'SALES_MIX', 'SEASONAL',
];

interface DiagnosisResponse {
  success: boolean;
  period: { month: string; week: string };
  outlets: CausalResult[];
  causeDistribution: Record<CauseId, { count: number; avgConfidence: number }>;
  durationMs: number;
  cached?: boolean;
  stale?: boolean;
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace)
    const ip = getClientIP(req);
    const rl = rateLimit(`diagnosis:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(diagnosisQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const rawMonth = params.month;
    const rawWeek = params.week ?? '';
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    if (!rawMonth || !rawWeek) {
      return NextResponse.json(
        { success: false, error: 'month and week required' },
        { status: 400 },
      );
    }

    // PERF-HEATMAP pattern: resolve month BEFORE cache key so "Agustus 2026"
    // and "agustus 2026" share one cache entry. Previously rawMonth was used
    // in the key → case mismatch = cache miss.
    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    // 3. DB cache check — cache key includes ALL response-affecting params.
    // prevWeek/prevMonth are auto-resolved deterministically from (week, month)
    // so they're NOT in the cache key (would be redundant — same week+month →
    // same prev period).
    const cacheKey = buildCacheKey({
      route: 'diagnosis',
      month,
      week,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<DiagnosisResponse>(
      cacheKey,
      DIAGNOSIS_CACHE_TTL,
      async () => {
        // Parallel resolve PIC + thresholds + auto-previous period.
        // CAUSAL-BE-01 (perf): these 3 awaits are independent — batching
        // saves ~50-100ms on cold path (3 sequential ~30ms awaits → 1 batch).
        const [picOutletCodes, thresholds, prevPeriod] = await Promise.all([
          resolvePICOutletCodes(pic),
          getRuntimeThresholds(),
          resolvePreviousPeriod(week, month),
        ]);

        // Sentinel handling: PIC exists but has 0 outlets → return empty.
        if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
          const emptyDist = {} as Record<CauseId, { count: number; avgConfidence: number }>;
          for (const c of CAUSE_ORDER) emptyDist[c] = { count: 0, avgConfidence: 0 };
          return {
            success: true,
            period: { month, week },
            outlets: [],
            causeDistribution: emptyDist,
            durationMs: Date.now() - startedAt,
          };
        }

        // Build filterOpts (kelompok passed as string — buildSqlFilters handles
        // the SQL sub-select via LEFT(SUBSTRING(code, '[^.]+$'), 3) = UPPER(...)).
        const filterOpts = {
          area: area && area !== 'all' ? area : null,
          kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
          outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
          itemName: null,
          picOutletCodes,
        };

        // Query evidence per outlet (4 SQL queries in parallel + evaluateRulesSql).
        const evidences = await queryDiagnosisEvidence(
          week,
          month,
          prevPeriod.prevWeek,
          prevPeriod.prevMonth,
          filterOpts,
          thresholds,
        );

        // Run the Bayesian inference engine.
        const outletResults = computeCausalDiagnosis(evidences);
        const causeDistribution = computeCauseDistribution(outletResults);

        // Re-order causeDistribution keys for stable client-side iteration.
        const orderedDist = {} as Record<CauseId, { count: number; avgConfidence: number }>;
        for (const c of CAUSE_ORDER) {
          orderedDist[c] = causeDistribution[c];
        }

        return {
          success: true,
          period: { month, week },
          outlets: outletResults,
          causeDistribution: orderedDist,
          durationMs: Date.now() - startedAt,
        };
      },
    );

    // 5. Response with cache flags (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07 pattern: Don't leak internal error details to client.
    logger.error('[diagnosis] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
