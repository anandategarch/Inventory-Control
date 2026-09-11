// ============================================================
//  /api/item-search — Item autocomplete for search bars
//  Query mode:
//    ?mode=autocomplete&q=cabai&month=...&week=...
//      → returns up to 10 item names matching `q` (for the search bar dropdown)
//
//  NOTE: cross-outlet + trend modes were removed (GlobalItemSearchModal deleted).
//  The autocomplete mode is still used by ItemTrendTab's search bar.
//
//  PERF (H-8 QUICK WIN 6a): DB-level AggregationCache via withCacheAndDedup
//  (60s TTL + in-flight dedup). The underlying query is a leading-wildcard
//  LIKE ('%q%') that cannot use any index — every keystroke used to scan the
//  period's ~13.5K records. Autocomplete tolerance for staleness is high, and
//  mutations clear this cache via invalidateAnalysisCache() (route list
//  includes 'item-search'), so a 60s TTL is safe.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryItemAutocomplete } from '@/lib/queries/items/global-search';
// FIX (AUDIT-NEWFEATURES C4): use shared schemas instead of inline regex
import { monthLabelSchema, weekLabelSchema } from '@/lib/validation';
import { CACHE_INTERACTIVE } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ITEM_SEARCH_CACHE_TTL = 60 * 1000; // 60s — autocomplete staleness tolerance is high

const itemSearchQuerySchema = z.object({
  mode: z.literal('autocomplete').default('autocomplete'),
  q: z.string().min(1).max(200),
  month: monthLabelSchema,
  week: weekLabelSchema,
});

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`item-search:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const params = Object.fromEntries(url.searchParams.entries());
    const parse = itemSearchQuerySchema.safeParse(params);
    if (!parse.success) {
      return NextResponse.json({ success: false, error: `Invalid params: ${parse.error.message}` }, { status: 400 });
    }
    const { q, month: monthRaw, week } = parse.data;

    // month + week are required for autocomplete (schema allows optional, enforce here)
    if (!monthRaw || !week) {
      return NextResponse.json({ success: false, error: 'month and week are required' }, { status: 400 });
    }

    // Resolve month label case (DB may have "AGUSTUS 2026" vs "Agustus 2026")
    // BEFORE building the cache key — same PERF-HEATMAP fix as the heatmap route,
    // so "Agustus 2026" and "agustus 2026" share one cache entry.
    const monthResolver = await getMonthResolver();
    const month = resolveMonthLabel(monthRaw, monthResolver) || monthRaw;

    // PERF (H-8-6a): sanitize the query term for the cache key — strip control
    // characters (incl. the \x1f delimiter used by buildCacheKey) so a crafted
    // `q` cannot collide with a different (month, week) cache key.
    const qKey = q.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);

    const cacheKey = buildCacheKey({
      route: 'item-search',
      month, week,
      extra: { q: qKey },
    });

    const { data: cachedOrFresh, cached } = await withCacheAndDedup<Record<string, unknown>>(cacheKey, ITEM_SEARCH_CACHE_TTL, async () => {
      const results = await queryItemAutocomplete(week, month, q, 10);
      return {
        success: true,
        mode: 'autocomplete',
        q,
        results,
        durationMs: Date.now() - startedAt,
      };
    });

    // CONVENTIONS §2: surface `cached: true` when served from cache.
    const responsePayload = cached ? { ...cachedOrFresh, cached: true } : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_INTERACTIVE });
  } catch (e: unknown) {
    logger.error('[item-search] error:', { error: e instanceof Error ? e.message : String(e) });
    return errorResponse(e, "item-search");
  }
}
