// ============================================================
//  /api/flip-ranking/drilldown — per-outlet breakdown for ONE flip pair
//  --------------------------------------------------------
//  GET: ?item=&week=&month1=&month2=&area?=&kelompok?=&outlet?=&pic?
//
//  Companion to /api/flip-ranking. When the user clicks a flip
//  pair in the Flip Ranking widget, this route returns the
//  per-outlet SIGNED QTY + nominal + direction breakdown for
//  BOTH periods (P1 + P2). Answers "flip terjadi di resto mana
//  saja?" — surfaces the individual outlets whose signed QTY
//  deviasi aggregated to the item-level flip pattern.
//
//  Response shape:
//    {
//      success: true,
//      item: { itemName: "..." },
//      weekLabel: "WEEK 4",
//      period1: { monthLabel: "Juli 2026", outlets: FlipDrillOutlet[] },
//      period2: { monthLabel: "Agustus 2026", outlets: FlipDrillOutlet[] },
//      durationMs: number,
//      cached?: true,
//      stale?: true
//    }
//
//  Month param matching:
//    - `month1`/`month2` can be EITHER a full month label ("Juli 2026")
//      OR a short prefix ("Jul"). The query function uses
//      `(ir."monthLabel" = ${month} OR ir."monthLabel" ILIKE ${month + '%'})`
//      so both forms work. The frontend sends the short prefix extracted
//      from FlipPair.period1Label (e.g. "Jul W4" → "Jul").
//
//  Pattern (per CONVENTIONS.md §1 + §3.1 + flip-ranking precedent):
//    - `force-dynamic` + maxDuration=30 (two parallel single-SQL queries)
//    - Rate limiting (30 req/min per IP — interactive UI control)
//    - Zod validation (inline schema — validation.ts not modified)
//    - DB cache via withCacheAndDedup (5-min TTL, same as flip-ranking)
//    - Cache key includes item + week + month1 + month2 + filters
//    - Parallel resolve kelompok + PIC inside computeFn (saves 50-100ms)
//      + intersect when both present
//    - `startedAt` timing + `durationMs` in response
//    - Generic error message on failure (no DB schema/SQL leakage)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import {
  queryFlipDrilldown,
  type FlipDrillOutlet,
  type FlipDrillPeriod,
} from '@/lib/queries/items/flip-drilldown';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const FLIP_DRILLDOWN_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches flip-ranking

// Zod schema for /api/flip-ranking/drilldown query params.
// Defined inline (validation.ts not modified per task constraint).
// `item`, `week`, `month1`, `month2` are REQUIRED; the rest are optional
// filters. `month1`/`month2` accept either a full label ("Juli 2026") or
// a short 3-char prefix ("Jul") — the query function matches via ILIKE.
const flipDrilldownQuerySchema = z.object({
  item: z.string().min(1).max(200),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i),
  month1: z.string().min(1).max(50),
  month2: z.string().min(1).max(50),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
}).strict();

/**
 * Resolve kelompok + PIC filters into a single combined outletCodes array.
 * Returns:
 *   - { codes: null, noMatch: false } when no filter is applied.
 *   - { codes: string[], noMatch: false } when one or both filters resolve.
 *   - { codes: null, noMatch: true } when a filter matches no outlets OR
 *     the intersection of kelompok + PIC is empty.
 *
 * Sentinel handling: both resolvers use ['__NO_MATCH__'] to signal that
 * the requested filter exists in the DB but maps to zero outlets. We treat
 * that as "noMatch: true" so the route returns an empty result early
 * instead of running a query that returns 0 rows.
 *
 * Same pattern as /api/flip-ranking (resolveOutletCodeFilters).
 */
async function resolveOutletCodeFilters(
  kelompok: string | null,
  pic: string | null,
): Promise<{ codes: string[] | null; noMatch: boolean }> {
  const [kelompokCodes, picCodes] = await Promise.all([
    kelompok ? resolveKelompokOutletCodes(kelompok) : Promise.resolve<string[]>([]),
    resolvePICOutletCodes(pic),
  ]);

  // Normalize: empty array → null (no filter)
  const k = kelompokCodes && kelompokCodes.length > 0 ? kelompokCodes : null;
  const p = picCodes && picCodes.length > 0 ? picCodes : null;

  // Sentinel: __NO_MATCH__ means the filter exists but matches 0 outlets.
  if (k && k.length === 1 && k[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }
  if (p && p.length === 1 && p[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }

  // Both present → intersect (an outlet must match BOTH filters)
  if (k && p) {
    const pSet = new Set(p);
    const intersection = k.filter((c) => pSet.has(c));
    if (intersection.length === 0) {
      return { codes: null, noMatch: true };
    }
    return { codes: intersection, noMatch: false };
  }

  // Only one present — use it directly
  if (k) return { codes: k, noMatch: false };
  if (p) return { codes: p, noMatch: false };

  return { codes: null, noMatch: false };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min, same as flip-ranking
    const ip = getClientIP(req);
    const rl = rateLimit(`flip-ranking-drilldown:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(flipDrilldownQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const item = params.item;
    const weekLabel = params.week;
    const month1Label = params.month1;
    const month2Label = params.month2;
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // 3. DB cache check — cache key includes ALL response-affecting params.
    // item + weekLabel + month1Label + month2Label + filters all uniquely
    // identify the drill-down response (different params → different entries).
    // Without month1/month2 in the key, clicking P1 (Jul→Agu) then P2 (Agu→Sep)
    // for the SAME item+week would share one entry → cache poisoning.
    const cacheKey = buildCacheKey({
      route: 'flip-ranking-drilldown',
      month: `${month1Label}|${month2Label}`,
      week: weekLabel,
      itemName: item,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<{
      period1: FlipDrillPeriod;
      period2: FlipDrillPeriod;
    }>(cacheKey, FLIP_DRILLDOWN_CACHE_TTL, async () => {
      // Parallel resolve kelompok + PIC → combined outletCodes
      const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
        kelompok && kelompok !== 'all' ? kelompok : null,
        pic,
      );

      // Sentinel / empty-intersection: return empty outlets for both periods.
      // Same shape as a successful query with no outlets — frontend renders
      // "no outlets" message without distinguishing causes.
      const emptyPeriod = (label: string): FlipDrillPeriod => ({
        monthLabel: label,
        outlets: [] as FlipDrillOutlet[],
      });
      if (noMatch) {
        return {
          period1: emptyPeriod(month1Label),
          period2: emptyPeriod(month2Label),
        };
      }

      // Build filter opts (same pattern as /api/flip-ranking route).
      // NOTE: itemName is NOT passed through filters — queryFlipDrilldown
      // applies an exact `i.name = ${item}` match. kelompok is set to null
      // because it's already been resolved to outletCodes above (avoiding
      // double-filtering).
      const filterOpts = {
        area: area && area !== 'all' ? area : null,
        kelompok: null,
        outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
        itemName: null,
        picOutletCodes: outletCodes,
      };

      const result = await queryFlipDrilldown({
        item,
        weekLabel,
        month1Label,
        month2Label,
        filters: filterOpts,
      });

      return {
        period1: result.period1,
        period2: result.period2,
      };
    });

    // 5. Response with cache flags (CONVENTIONS §2).
    // PERF-CACHE-09 (SWR): surface `stale: true` when the cache entry was
    // expired (client gets stale data immediately + background recompute runs).
    const responsePayload = {
      success: true,
      item: { itemName: item },
      weekLabel,
      period1: cachedOrFresh.period1,
      period2: cachedOrFresh.period2,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07 pattern: Don't leak internal error details to client.
    logger.error('[flip-ranking-drilldown] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'flip-ranking-drilldown', 500);
  }
}
