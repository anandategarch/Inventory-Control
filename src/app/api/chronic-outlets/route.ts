// ============================================================
//  /api/chronic-outlets — "Kronis vs Sekali-Timu" lens
//  GET: ?month=&area=&kelompok=&outlet=&pic=
//
//  NO `week` param — month-grain BY DESIGN (the question "does
//  this outlet deviate EVERY week?" needs all weeks of the
//  month; see queries/chronic-outlets.ts). The FE therefore
//  keys this query on month only — switching weeks does not
//  refetch it.
//
//  Pattern (per CONVENTIONS.md — compliance / flip-ranking
//  precedent):
//    - force-dynamic + maxDuration=60 (single month scan)
//    - Rate limiting (30 req/min per IP)
//    - Zod validation (inline schema, strict)
//    - DB cache via withCacheAndDedup (5-min TTL; handleRefresh
//      invalidates the FE ['chronic-outlets'] queryKey, ingest
//      TTL expiry covers server-side freshness)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import {
  queryChronicOutlets,
  type ChronicOutletsResult,
} from '@/lib/queries/chronic-outlets';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CHRONIC_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches compliance / analysis routes

// Zod schema — month REQUIRED (month-grain analysis, no week),
// area/kelompok/outlet/pic optional filters. Same regexes as the
// compliance / analysis family.
const chronicQuerySchema = z.object({
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
}).strict();

/**
 * Resolve kelompok + PIC filters into a single combined outletCodes array.
 * Same pattern as /api/compliance (resolveOutletCodeFilters):
 *   - { codes: null, noMatch: false } when no filter applied
 *   - { codes: string[], noMatch: false } when filters resolve
 *   - { codes: null, noMatch: true } when a filter matches zero outlets
 *     (sentinel ['__NO_MATCH__']) or the kelompok∩PIC intersection is empty
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

/** Empty result with the full response shape (filters matched no outlets). */
function emptyChronicResult(): ChronicOutletsResult {
  return { outlets: [], nWeeksMax: 0, chronicCount: 0, spikeCount: 0, worseningCount: 0 };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min
    const ip = getClientIP(req);
    const rl = rateLimit(`chronic-outlets:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params,
    //    including a stray `week`: this lens is month-grain)
    const validation = validateQuery(chronicQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const month = params.month;
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // 3. DB cache key — includes ALL response-affecting params
    //    (deliberately NO week: month-grain lens)
    const cacheKey = buildCacheKey({
      route: 'chronic-outlets',
      month,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: result, cached, stale } = await withCacheAndDedup<ChronicOutletsResult>(
      cacheKey,
      CHRONIC_CACHE_TTL,
      async () => {
        // Parallel resolve kelompok + PIC → combined outletCodes
        const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
          kelompok && kelompok !== 'all' ? kelompok : null,
          pic,
        );
        if (noMatch) {
          return emptyChronicResult();
        }

        return queryChronicOutlets(
          month,
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
    logger.error('[chronic-outlets] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'chronic-outlets', 500);
  }
}
