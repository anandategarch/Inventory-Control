// ============================================================
//  /api/item-trend-rank — per-item national rank timeline (ALL periods)
//  GET: ?item=&month?=&week?=&area?=&kelompok?=&outlet?=&pic?=
//
//  Returns the national rank of a specific item for EACH period
//  (monthLabel × weekLabel). Rank is computed by ABS(nominalDeviasi)
//  DESC across ALL items in the same period (1 = highest deviasi
//  magnitude). Also returns totalItems so the UI can show
//  "rank 5 of 153".
//
//  This powers the "Rank Trend" compact chart in the Trend Item Tab —
//  visualizes how an item's national standing fluctuates across
//  periods (e.g. rank 5 → rank 1 → rank 12).
//
//  NOTE on month + week params:
//    The rank query returns periods for the item (rank is computed
//    per-period across ALL items).
//    - `week` is RESPECTED as a filter: when set (e.g. "WEEK 4"), only
//      that weekLabel across all months is returned (W4 of Januari,
//      Februari, Maret...). When null, ALL weeks are returned.
//    - `month` is for cache-key context only (rank covers ALL months
//      for the selected week — month selection doesn't filter the rank
//      timeline, it just distinguishes dashboard selections that might
//      carry different filter combinations).
//
//  Pattern (per CONVENTIONS.md §1 + §3.1 + item-peer-comparison precedent):
//    - `force-dynamic` + maxDuration=30 (single SQL query — light route)
//    - Rate limiting (30 req/min per IP — interactive UI control)
//    - Zod validation (inline schema — validation.ts not modified)
//    - DB cache via withCacheAndDedup (5-min TTL, same as item-trend)
//    - Cache key includes month + week + itemName + filters
//    - Resolve month BEFORE cache key (so "Agustus 2026" + "agustus 2026"
//      share one entry)
//    - Parallel resolve kelompok + PIC inside computeFn (saves 50-100ms
//      on cold path) + intersect when both present
//    - `startedAt` timing + `durationMs` in response
//    - Generic error message on failure (no DB schema/SQL leakage)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { resolveOutletCodeFilters } from '@/lib/outlet-code-filters';
import {
  queryItemTrendRank,
  type ItemTrendRankPeriod,
} from '@/lib/queries/items/item-trend-rank';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ITEM_TREND_RANK_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches item-trend

// Zod schema for /api/item-trend-rank query params.
// Defined inline (validation.ts not modified per task constraint).
// `item` is REQUIRED; `month` + `week` are OPTIONAL (used for cache-key
// context only — rank covers ALL periods, same as /api/item-trend).
// Uses the same regexes as monthLabelSchema + weekLabelSchema in validation.ts.
const itemTrendRankQuerySchema = z.object({
  item: z.string().min(1).max(200),
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/).optional(),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i).optional(),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
}).strict();

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min, same as item-trend
    const ip = getClientIP(req);
    const rl = rateLimit(`item-trend-rank:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(itemTrendRankQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const item = params.item;
    // FIX (BUG2-RANK-01): rawMonth removed — month is accepted by Zod but
    // ignored by the rank query (rank covers ALL months for selected week).
    const rawWeek = params.week ?? '';
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // FIX (BUG2-RANK-01): removed dead month resolver — month is NOT in the
    // cache key (BUG-3-06 fix) nor passed to queryItemTrendRank. The
    // getMonthResolver + resolveMonthLabel calls were wasted work.
    const week = rawWeek;

    // 3. DB cache check — cache key includes ALL response-affecting params.
    // FIX (BUG-3-06): month is NOT in the cache key — the rank query ignores
    // month (returns ALL months for the selected week). Including month would
    // cause duplicate cache entries for the same data.
    // week IS in the cache key because it filters the result (when set, only
    // that weekLabel across all months is returned).
    const cacheKey = buildCacheKey({
      route: 'item-trend-rank',
      month: 'ALL',
      week: week || 'ALL',
      itemName: item,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<{
      periods: ItemTrendRankPeriod[];
    }>(cacheKey, ITEM_TREND_RANK_CACHE_TTL, async () => {
      // Parallel resolve kelompok + PIC → combined outletCodes
      const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
        kelompok && kelompok !== 'all' ? kelompok : null,
        pic,
      );

      // Sentinel / empty-intersection: return empty periods early.
      // Same shape as a successful query with no periods — frontend
      // renders "no rank data" without distinguishing causes.
      if (noMatch) {
        return {
          periods: [],
        };
      }

      // Build filter opts (same pattern as item-peer-comparison route).
      // NOTE: itemName is NOT passed through filters — queryItemTrendRank
      // applies an EXACT match (`i.name = ${itemName}`) in its WHERE clause
      // instead of buildSqlFilters' LIKE (which would over-match).
      // kelompok is set to null because it's already been resolved to
      // outletCodes above (avoiding double-filtering).
      const filterOpts = {
        area: area && area !== 'all' ? area : null,
        kelompok: null,
        outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
        itemName: null,
        picOutletCodes: outletCodes,
      };

      const result = await queryItemTrendRank(item, filterOpts, week || null);

      return {
        periods: result.periods,
      };
    });

    // 5. Response with cache flags (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = {
      success: true,
      item: { itemName: item },
      periods: cachedOrFresh.periods,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07 pattern: Don't leak internal error details to client.
    logger.error('[item-trend-rank] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'item-trend-rank', 500);
  }
}
