// ============================================================
//  /api/item-anomali-outlets — per-outlet drill-down for the MINORITY direction
//  --------------------------------------------------------
//  GET: ?item=&month=&week=&direction=<LOSS|SURPLUS>&area?=&kelompok?=&outlet?=&pic?
//
//  Companion to the "Analisis Pola Item" widget
//  (AdvancedAnalysis.tsx → ItemConsistencyAnalysis). When the user clicks a
//  row, instead of opening DrillDownDrawer, the row expands inline showing
//  a mini-table of outlets that are "anomali" — i.e., outlets whose
//  direction (LOSS/SURPLUS) is the MINORITY (opposite of the majority
//  direction).
//
//  Example:
//    MINYAK MIE SHALLOT OIL has 187 LOSS + 1 SURPLUS → majority = LOSS
//    → anomali = the 1 SURPLUS outlet → this route returns that 1 outlet.
//
//  Response shape:
//    {
//      success: true,
//      item: { itemName: "..." },
//      direction: "SURPLUS",
//      outlets: Array<{
//        outletCode, outletName, area, pic,
//        qtyDeviasi, nominalDeviasi, direction
//      }>,
//      durationMs: number,
//      cached?: true,
//      stale?: true
//    }
//
//  Pattern (per CONVENTIONS.md §1 + §3.1 + flip-ranking precedent):
//    - `force-dynamic` + maxDuration=30 (single SQL query — light route)
//    - Rate limiting (30 req/min per IP — interactive UI control)
//    - Zod validation (inline schema — validation.ts not modified)
//    - DB cache via withCacheAndDedup (5-min TTL, same as flip-ranking)
//    - Cache key includes item + month + week + direction + filters
//    - Parallel resolve kelompok + PIC inside computeFn (saves 50-100ms
//      on cold path) + intersect when both present
//    - Month resolved via getMonthResolver + resolveMonthLabel (handles
//      case-mismatched labels between user input + DB)
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
  queryItemAnomaliOutlets,
  type AnomaliOutlet,
} from '@/lib/queries/items/item-anomali-outlets';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ITEM_ANOMALI_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches sibling item routes

// Zod schema for /api/item-anomali-outlets query params.
// Defined inline (validation.ts not modified per task constraint).
// `item`, `month`, `week`, `direction` are REQUIRED; the rest are optional
// filters. `direction` is constrained to the two literal values — anything
// else returns 400.
const itemAnomaliOutletsQuerySchema = z.object({
  item: z.string().min(1).max(200),
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i),
  direction: z.enum(['LOSS', 'SURPLUS']),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
}).strict();

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min, same as sibling item routes
    const ip = getClientIP(req);
    const rl = rateLimit(`item-anomali-outlets:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(itemAnomaliOutletsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const item = params.item;
    const rawMonth = params.month;
    const weekLabel = params.week;
    const direction = params.direction;
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // 3. Resolve month label to the actual DB case (handles "AGUSTUS 2026"
    //    vs "Agustus 2026" mismatch). Same pattern as /api/area-item-heatmap.
    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;

    // 4. DB cache check — cache key includes ALL response-affecting params.
    //    item + month + week + direction + filters all uniquely identify the
    //    anomali outlet set (different params → different entries). Without
    //    `direction` in the key, LOSS + SURPLUS requests for the same item
    //    would share one entry → cache poisoning.
    const cacheKey = buildCacheKey({
      route: 'item-anomali-outlets',
      month,
      week: weekLabel,
      itemName: item,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
      extra: { direction },
    });

    // 5. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<{
      outlets: AnomaliOutlet[];
    }>(cacheKey, ITEM_ANOMALI_CACHE_TTL, async () => {
      // Parallel resolve kelompok + PIC → combined outletCodes
      const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
        kelompok && kelompok !== 'all' ? kelompok : null,
        pic,
      );

      // Sentinel / empty-intersection: return empty outlets early.
      // Same shape as a successful query with no outlets — frontend
      // renders "no anomali outlets" without distinguishing causes.
      if (noMatch) {
        return { outlets: [] };
      }

      // Build filter opts (same pattern as sibling item routes).
      // NOTE: itemName is NOT passed through filters — queryItemAnomaliOutlets
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

      const result = await queryItemAnomaliOutlets({
        item,
        month,
        week: weekLabel,
        direction,
        filters: filterOpts,
      });

      return { outlets: result.outlets };
    });

    // 6. Response with cache flags (CONVENTIONS §2).
    //    PERF-CACHE-09 (SWR): surface `stale: true` when the cache entry was
    //    expired (client gets stale data immediately + background recompute runs).
    const responsePayload = {
      success: true,
      item: { itemName: item },
      direction,
      outlets: cachedOrFresh.outlets,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07 pattern: Don't leak internal error details to client.
    logger.error('[item-anomali-outlets] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'item-anomali-outlets', 500);
  }
}
