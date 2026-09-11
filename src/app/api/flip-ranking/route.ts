// ============================================================
//  /api/flip-ranking — top N items by flip pattern risk
//  GET: ?week=&area=&kelompok=&outlet=&pic=&limit=
//
//  Scans ALL items and ranks them by "flip pattern" — balanced
//  reversal of qtyDeviasiSigned between same-week periods across
//  different months. Returns the top N items with the most
//  "sempurna" flips (suspicious balanced reversals where signs
//  flip AND magnitudes nearly match).
//
//  Flip detection (same as frontend — see flip-ranking.ts):
//    For each item, group periods by weekLabel, sort by monthKey.
//    For each consecutive same-week pair (P1=earlier, P2=later):
//      isFlip = sign(P1) !== sign(P2) AND both non-zero
//      disparity = |P1 + P2| / MAX(|P1|, |P2|)
//    Categories: sempurna (<10%), dominan (10-40%), parsial (>=40%)
//
//  Item riskScore = min(100, sempurnaCount * 30 + flipCount * 10)
//  Item riskLevel = sempurnaCount > 0 ? 'high' :
//                   flipCount > 0 ? 'moderate' : 'low'
//
//  NOTE on month + week params:
//    - `week` is RESPECTED as a filter: when set (e.g. "WEEK 4"), only
//      that weekLabel across all months is scanned (W4 of Januari,
//      Februari, Maret, ...). When null, ALL weeks are scanned.
//    - There is NO `month` param — flip detection is inherently
//      cross-month (P1 vs P2 in different months), so filtering by a
//      single month would yield zero pairs.
//
//  Pattern (per CONVENTIONS.md §1 + §3.1 + item-trend-rank precedent):
//    - `force-dynamic` + maxDuration=30 (single SQL query — light route)
//    - Rate limiting (30 req/min per IP — interactive UI control)
//    - Zod validation (inline schema — validation.ts not modified)
//    - DB cache via withCacheAndDedup (5-min TTL, same as item-trend-rank)
//    - Cache key includes week + filters + limit
//    - Parallel resolve kelompok + PIC inside computeFn (saves 50-100ms
//      on cold path) + intersect when both present
//    - `startedAt` timing + `durationMs` in response
//    - Generic error message on failure (no DB schema/SQL leakage)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveOutletCodeFilters } from '@/lib/outlet-code-filters';
import {
  queryFlipRanking,
  type FlipRankItem,
} from '@/lib/queries/items/flip-ranking';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const FLIP_RANKING_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches item-trend-rank

// Zod schema for /api/flip-ranking query params.
// Defined inline (validation.ts not modified per task constraint).
// `week` is OPTIONAL (when set, only that week across all months is scanned).
// `month` is OPTIONAL (when set, only flip pairs involving that month are counted).
// `area`, `kelompok`, `outlet`, `pic` are all OPTIONAL filters.
// `limit` is OPTIONAL (default 20, max 50) — top N items to return.
const flipRankingQuerySchema = z.object({
  week: z.string().regex(/^WEEK\s+[0-9]+$/i).optional(),
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/).optional(),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min, same as item-trend-rank
    const ip = getClientIP(req);
    const rl = rateLimit(`flip-ranking:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(flipRankingQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const week = params.week ?? '';
    const month = params.month ?? '';
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;
    // Zod schema enforces 1..50 with default 20 — always a valid positive int.
    const limit = params.limit;

    // PERF (TAHAP-2 / P2-11): resolve month to actual DB case BEFORE the cache
    // key AND before handing it to queryFlipRanking. This route never resolved
    // month at all — a wrong-case month ("agustus 2026" vs DB "Agustus 2026")
    // both forked the cache key AND returned an empty result for the query.
    // getMonthResolver is process-cached (~0ms after first call).
    const monthResolverEarly = await getMonthResolver();
    const resolvedMonth = month ? (resolveMonthLabel(month, monthResolverEarly) || month) : month;

    // 3. DB cache check — cache key includes ALL response-affecting params.
    // FIX (USER-REQ): month IS now in the cache key — when set, only flip pairs
    // involving that month are counted (different month = different result).
    // week IS in the cache key because it filters the result.
    // limit IS in the cache key (via extra) — different limits produce
    // different responses (top 5 vs top 20 vs top 50), so without it two
    // requests with different limits would share one entry (cache poisoning).
    const cacheKey = buildCacheKey({
      route: 'flip-ranking',
      month: resolvedMonth || 'ALL',
      week: week || 'ALL',
      itemName: 'ALL',
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
      extra: { limit },
    });

    // 4. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<{
      items: FlipRankItem[];
      totalItemsScanned: number;
    }>(cacheKey, FLIP_RANKING_CACHE_TTL, async () => {
      // Parallel resolve kelompok + PIC → combined outletCodes
      const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
        kelompok && kelompok !== 'all' ? kelompok : null,
        pic,
      );

      // Sentinel / empty-intersection: return empty items early.
      // Same shape as a successful query with no items — frontend
      // renders "no flip data" without distinguishing causes.
      if (noMatch) {
        return {
          items: [],
          totalItemsScanned: 0,
        };
      }

      // Build filter opts (same pattern as item-trend-rank route).
      // NOTE: itemName is NOT passed through filters — queryFlipRanking
      // scans ALL items (not a single matched item). kelompok is set to
      // null because it's already been resolved to outletCodes above
      // (avoiding double-filtering).
      const filterOpts = {
        area: area && area !== 'all' ? area : null,
        kelompok: null,
        outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
        itemName: null,
        picOutletCodes: outletCodes,
      };

      const result = await queryFlipRanking(filterOpts, week || null, resolvedMonth || null, limit);

      return {
        items: result.items,
        totalItemsScanned: result.totalItemsScanned,
      };
    });

    // 5. Response with cache flags (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = {
      success: true,
      items: cachedOrFresh.items,
      totalItemsScanned: cachedOrFresh.totalItemsScanned,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07 pattern: Don't leak internal error details to client.
    logger.error('[flip-ranking] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'flip-ranking', 500);
  }
}
