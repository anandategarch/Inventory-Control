// ============================================================
//  /api/item-peer-comparison — Peer outlets for ONE item
//  --------------------------------------------------------
//  GET: ?item=&month=&week=&outletCode?=&area?=&kelompok?=&pic?
//
//  Returns the target outlet + peer outlets (other restos that
//  carry the same item AND have ABS(qtyBom) within ±50% of the
//  target's ABS(qtyBom)) for a single period (month + week).
//  When outletCode is omitted, the worst outlet (highest
//  ABS(nominalDeviasi)) is auto-selected as the target.
//
//  Response shape (per task spec):
//    {
//      success: true,
//      item: { itemName: "..." },
//      period: { month: "...", week: "..." },
//      target: ItemPeerRow | null,
//      peers:  ItemPeerRow[],
//      peerAverages: { ... },
//      autoSelected: boolean,
//      durationMs: number
//    }
//
//  Pattern (per CONVENTIONS.md §1 + §3.1 + item-trend precedent):
//    - `force-dynamic` + maxDuration=30 (single SQL query — light route)
//    - Rate limiting (30 req/min per IP — interactive UI control)
//    - Zod validation (inline schema — validation.ts not modified)
//    - DB cache via withCacheAndDedup (5-min TTL, same as item-trend)
//    - Cache key includes month + week + outletCode (or 'AUTO') +
//      item + area + kelompok + pic
//    - Resolve month BEFORE cache key (so "Agustus 2026" + "agustus 2026"
//      share one entry)
//    - Parallel resolve kelompok + PIC inside computeFn
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
  queryItemPeerComparison,
  type ItemPeerRow,
  type ItemPeerAverages,
} from '@/lib/queries/items/item-peer-comparison';
import { validateQuery, noControlChars } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ITEM_PEER_COMPARISON_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches item-trend

// Zod schema for /api/item-peer-comparison query params.
// Defined inline (validation.ts not modified per task constraint).
// `item`, `month`, `week` are REQUIRED; the rest are optional.
// FIX (BUGHUNT-A2): control-char gate on every string field — see the note
// in flip-ranking/route.ts (cache-key poisoning via sanitizeKeyPart).
const itemPeerComparisonQuerySchema = z.object({
  item: z.string().min(1).max(200).refine(noControlChars),
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/).refine(noControlChars),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i).refine(noControlChars),
  outletCode: z.string().min(1).max(50).refine(noControlChars).optional(),
  area: z.string().min(1).max(50).refine(noControlChars).optional(),
  kelompok: z.string().min(1).max(50).refine(noControlChars).optional(),
  pic: z.string().min(1).max(100).refine(noControlChars).optional(),
}).strict();

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min, same as item-trend
    const ip = getClientIP(req);
    const rl = rateLimit(`item-peer-comparison:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(itemPeerComparisonQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const item = params.item;
    const rawMonth = params.month;
    const rawWeek = params.week;
    const outletCode = params.outletCode ?? null;
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const pic = params.pic ?? null;

    // PERF-HEATMAP pattern (same as item-trend): resolve month BEFORE cache
    // key so "Agustus 2026" and "agustus 2026" share one cache entry.
    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    // 3. DB cache check — cache key includes ALL response-affecting params.
    // outletCode: outletCode || 'AUTO' distinguishes explicit-target calls
    // from auto-select calls (different cache entries — auto-select target
    // depends on the worst outlet which can change with data mutations).
    const cacheKey = buildCacheKey({
      route: 'item-peer-comparison',
      month,
      week,
      outletCode: outletCode || 'AUTO',
      itemName: item,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<{
      target: ItemPeerRow | null;
      peers: ItemPeerRow[];
      peerAverages: ItemPeerAverages;
      autoSelected: boolean;
    }>(cacheKey, ITEM_PEER_COMPARISON_CACHE_TTL, async () => {
      // Parallel resolve kelompok + PIC → combined outletCodes
      const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
        kelompok && kelompok !== 'all' ? kelompok : null,
        pic,
      );

      // Sentinel / empty-intersection: return empty result early.
      // Same shape as a successful query with no peers — frontend renders
      // "no peers found" without distinguishing causes.
      if (noMatch) {
        return {
          target: null,
          peers: [],
          peerAverages: {
            qtyBom: 0,
            absQtyDeviasi: 0,
            absNominalDeviasi: 0,
            devBom: 0,
            qtyWaste: 0,
            qtySusut: 0,
            qtyTrial: 0,
            qtyLossSurplus: 0,
            lossOutlets: 0,
            surplusOutlets: 0,
          },
          autoSelected: !outletCode,
        };
      }

      const filters = {
        area: area && area !== 'all' ? area : null,
        kelompok: null, // already resolved to outletCodes above
        outletCode: null, // target outlet, not a filter
        itemName: null, // exact match applied in query function
        picOutletCodes: outletCodes,
      };

      const result = await queryItemPeerComparison({
        item,
        month,
        week,
        outletCode,
        filters,
      });

      return {
        target: result.target,
        peers: result.peers,
        peerAverages: result.peerAverages,
        autoSelected: result.autoSelected,
      };
    });

    // 5. Response with cache flags (CONVENTIONS §2).
    const responsePayload = {
      success: true,
      item: { itemName: item },
      period: { month, week },
      target: cachedOrFresh.target,
      peers: cachedOrFresh.peers,
      peerAverages: cachedOrFresh.peerAverages,
      autoSelected: cachedOrFresh.autoSelected,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[item-peer-comparison] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
