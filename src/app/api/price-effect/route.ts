// ============================================================
//  /api/price-effect — AVG Price Effect analysis
//  GET: ?month=&week=&compareMonth=&compareWeek=&area=&kelompok=&outlet=&pic=
//
//  Decomposes the change in Σ|nominalDeviasi| (current period vs
//  compare period) into a PRICE effect and a QUANTITY effect
//  (Bennet decomposition — exact, no interaction residual) per item
//  plus aggregates. Implements Master Context (business doc) §22
//  AVG PRICE + §55 "Nominal effect = Quantity effect + Price effect":
//  a nominal rise must not be read as an operational deviation rise
//  until the price effect is separated.
//
//  compareMonth/compareWeek are OPTIONAL — without them the route
//  returns hasCompare:false + empty items (the card shows a hint to
//  pick a compare period).
//
//  Pattern (per CONVENTIONS.md — flip-ranking precedent):
//    - force-dynamic + maxDuration=60 (2 CTE aggregations + 1 join)
//    - Rate limiting (30 req/min per IP)
//    - Zod validation (inline schema, strict)
//    - DB cache via withCacheAndDedup (5-min TTL) — REGISTERED in
//      invalidateAnalysisCache (aggregation-cache.ts), so ingest/
//      settings/pic/delete mutations never serve stale decompositions
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { queryPriceEffect, type PriceEffectResult } from '@/lib/queries/price-effect';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PRICE_EFFECT_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches analysis routes

// Zod schema — month + week REQUIRED, compare month/week + filters optional.
// Same regexes as the flip-ranking family.
const priceEffectQuerySchema = z.object({
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i),
  compareMonth: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/).optional(),
  compareWeek: z.string().regex(/^WEEK\s+[0-9]+$/i).optional(),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
}).strict();

/**
 * Resolve kelompok + PIC filters into a single combined outletCodes array.
 * Same pattern as /api/peer-comparison (resolveOutletCodeFilters).
 */
async function resolveOutletCodeFilters(
  kelompok: string | null,
  pic: string | null,
): Promise<{ codes: string[] | null; noMatch: boolean }> {
  const [kelompokCodes, picCodes] = await Promise.all([
    kelompok ? resolveKelompokOutletCodes(kelompok) : Promise.resolve<string[]>([]),
    resolvePICOutletCodes(pic),
  ]);

  const k = kelompokCodes && kelompokCodes.length > 0 ? kelompokCodes : null;
  const p = picCodes && picCodes.length > 0 ? picCodes : null;

  if (k && k.length === 1 && k[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }
  if (p && p.length === 1 && p[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }

  if (k && p) {
    const pSet = new Set(p);
    const intersection = k.filter((c) => pSet.has(c));
    if (intersection.length === 0) {
      return { codes: null, noMatch: true };
    }
    return { codes: intersection, noMatch: false };
  }

  if (k) return { codes: k, noMatch: false };
  if (p) return { codes: p, noMatch: false };

  return { codes: null, noMatch: false };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min
    const ip = getClientIP(req);
    const rl = rateLimit(`price-effect:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(priceEffectQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const month = params.month;
    const week = params.week;
    const compareMonth = params.compareMonth ?? null;
    const compareWeek = params.compareWeek ?? null;
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // 3. DB cache key — includes ALL response-affecting params (compare too!)
    const cacheKey = buildCacheKey({
      route: 'price-effect',
      month,
      week,
      compareMonth,
      compareWeek,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: result, cached, stale } = await withCacheAndDedup<PriceEffectResult>(
      cacheKey,
      PRICE_EFFECT_CACHE_TTL,
      async () => {
        const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
          kelompok && kelompok !== 'all' ? kelompok : null,
          pic,
        );
        if (noMatch) {
          // Filters matched zero outlets — empty but well-formed result
          return queryPriceEffect(week, month, null, null, {
            area: null, kelompok: null, outletCode: null,
            itemName: null, picOutletCodes: null,
          });
        }

        return queryPriceEffect(
          week,
          month,
          compareWeek,
          compareMonth,
          {
            area: area && area !== 'all' ? area : null,
            kelompok: null, // already resolved to outletCodes above
            outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
            itemName: null, // cross-item analysis — never item-filtered
            picOutletCodes: outletCodes,
          },
        );
      },
    );

    // 5. Response with cache flags (CONVENTIONS §2)
    const responsePayload = {
      success: true,
      ...result,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[price-effect] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'price-effect', 500);
  }
}
