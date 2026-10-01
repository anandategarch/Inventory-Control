// ============================================================
//  /api/waste-rate-league — W1 "Liga Waste-Rate" (waste ÷ BOM)
//  Top-N Pareto items (by ΣABS nominalWaste over the multi-month
//  SAME-week window) with each item's per-outlet league ranked by
//  the normalized rate Σ|qtyWaste| / Σ|qtyBom| — median + MAD +
//  robust-z within the item (outlier-resistant; see
//  src/lib/queries/waste/rate-league.ts for the full methodology
//  header). GET: ?month=Y&week=Z&area=&kelompok=&pic=&outletCode=
//  &limit=&item=
//    - limit is clamped 1..50 (default 20) BEFORE the cache key —
//      bogus values must not poison the cache (same style as
//      /api/waste-top-items);
//    - item (OPTIONAL, exact item name) pins the response to ONE
//      item's full league regardless of its Pareto rank; it rides
//      the cache key's dedicated itemName slot; an EMPTY value
//      (`?item=`) is normalized to "absent" at the zod gate
//      (FIX AUDIT-D F3) so '' behaves like the default top-N slice;
//    - scope follows the active filters (national default;
//      area/kelompok/pic-scoped when active) — the documented
//      deferral of the pending PEER-AREA median-scope decision to
//      the user's filter (rate-league.ts header).
//  QoS pattern copied verbatim from /api/waste-top-items: zod
//  validation (schema INLINE in this file — the flip-ranking
//  family precedent, because src/lib/validation/waste.ts is a
//  sibling-owned file this task may not touch), month-resolvability
//  400 (BUGHUNT-R1 FIX 11), 5-min AggregationCache + dedup with a
//  complete cache key, rate-limit, standard error shape.
//  NOTE (documented gap for the wiring agent): invalidateAnalysis-
//  Cache()'s route list (src/lib/aggregation-cache/invalidate.ts)
//  is a sibling-owned file this task may not extend — add
//  'waste-rate-league' there when wiring so mutations kill these
//  rows like the waste-series/waste-top-items siblings; until then
//  the 5-min TTL is the only staleness bound.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import {
  queryWasteRateLeague,
  clampRateLeagueLimit,
  WASTE_RATE_LEAGUE_DEFAULT_LIMIT,
  buildRateLeague,
} from '@/lib/queries';
import {
  validateQuery,
  monthLabelSchema,
  weekLabelSchema,
  areaSchema,
  kelompokSchema,
  picSchema,
  outletCodeSchema,
  itemNameSchema,
} from '@/lib/validation';
import { db } from '@/lib/db';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { errorResponse } from '@/lib/error-response';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Same AggregationCache pattern as the waste family (P3-HYG-3).
const WASTE_RATE_LEAGUE_CACHE_TTL = 5 * 60 * 1000;

// Inline schema — same atoms as the waste-family schemas in
// src/lib/validation/waste.ts (this file cannot add to that
// sibling-owned module; the flip-ranking family set the
// define-inline precedent — see validation/shared.ts header).
// outletCode is accepted for parity with /api/waste-top-items
// (global outlet filter parity): a single-outlet scope degenerates
// every league onto the min-outlet guard, which the response then
// reports honestly per item.
// Exported for the route-level vitest coverage (schema gate +
// __NO_MATCH__ shape — tests/queries/waste-rate-league.test.ts).
export const wasteRateLeagueQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  pic: picSchema,
  outletCode: outletCodeSchema,
  // FIX (AUDIT-D F3): `?item=` (EMPTY string) used to die at the
  // zod gate — itemNameSchema's .min(1) rejects '' — with a 400,
  // contradicting both the route comment ("null/'' means the
  // default top-N Pareto slice") and the itemParam fallback
  // (`url.searchParams.get('item') || null`), which only handled an
  // ABSENT param. z.preprocess normalizes '' → undefined BEFORE the
  // atom, so an empty param behaves EXACTLY like an absent one;
  // the atom's other gates (max 200 chars, control chars) are
  // unchanged.
  item: z.preprocess((v) => (v === '' ? undefined : v), itemNameSchema),
});

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`waste-rate-league:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Zod input validation (same schema family as waste-series /
    // waste-top-items — control chars rejected at the door so they
    // can never reach the cache key).
    const validation = validateQuery(wasteRateLeagueQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const pic = url.searchParams.get('pic');
    const outletCode = url.searchParams.get('outletCode');
    const kelompok = url.searchParams.get('kelompok');
    const kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null;
    // item: OPTIONAL exact item name ("fetch one item's full
    // league") — null/'' means the default top-N Pareto slice.
    // FIX (AUDIT-D F3): the zod gate now normalizes '' to absent as
    // well, so this fallback and the gate agree on the contract.
    const itemParam = url.searchParams.get('item') || null;

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // limit: parsed + clamped manually BEFORE the cache key (bogus
    // values fall back to the default — never enter the key). The
    // clamp itself is the PURE clampRateLeagueLimit (unit-tested).
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? clampRateLeagueLimit(Math.floor(rawLimit))
      : WASTE_RATE_LEAGUE_DEFAULT_LIMIT;

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Resolve PIC → outletCodes (shared logic — same as /api/pareto).
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      // FIX (AUDIT-D F4): this early return used to collapse to
      // `meta: null` and drop the `item` echo, making it the ONLY
      // success path of this route without the disclosure block
      // (the query's own empty-window path has always carried it).
      // Shape now follows the waste-family conventions exactly:
      //   - `item` is echoed (waste-top-items echoes its `metric`
      //     selector param on this same path);
      //   - meta is built by the SAME pure builder as every other
      //     empty path (waste-series W2/W10 convention — single
      //     source of truth);
      //   - week/limit stay OFF — NO waste-family early-return
      //     echoes them (waste-top-items / waste-series omit both),
      //     so adding them here would deviate from the 4-route
      //     convention.
      return NextResponse.json({
        success: true,
        // FIX (AUDIT-D F3): '' normalizes to null — same as absent.
        item: itemParam,
        items: [],
        populationTotal: 0,
        lastMonthKey: null,
        windowMonths: 0,
        meta: buildRateLeague([], [], 0).meta,
      });
    }

    // Same currentMonthKey derivation as /api/waste-top-items —
    // window upper bound (inclusive of the running month).
    // BUGHUNT-R1 FIX 11: a format-valid but unresolvable month
    // label must 400 (standard error shape) instead of silently
    // returning the FULL history window with 200.
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

    // Complete cache key — every response-shaping param: the
    // standard filter set + limit (extra) + the optional item pin
    // (the dedicated itemName slot, so `?item=KULIT PANGSIT` never
    // shares a key with the un-pinned top-N slice).
    const cacheKey = buildCacheKey({
      route: 'waste-rate-league',
      month,
      week,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompokParam,
      pic,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: itemParam,
      extra: { limit },
    });

    type WasteRateLeagueData = Awaited<ReturnType<typeof queryWasteRateLeague>>;
    const { data: leagueData, cached, stale } = await withCacheAndDedup<WasteRateLeagueData>(
      cacheKey,
      WASTE_RATE_LEAGUE_CACHE_TTL,
      async () => {
        return queryWasteRateLeague(week, currentMonthKey, {
          area: area && area !== 'all' ? area : null,
          kelompok: kelompokParam,
          outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
          picOutletCodes,
        }, limit, itemParam);
      },
    );

    return NextResponse.json({
      success: true,
      week,
      limit,
      // Echo the item pin (null = the default top-N Pareto slice).
      item: itemParam,
      items: leagueData.items,
      populationTotal: leagueData.populationTotal,
      lastMonthKey: leagueData.lastMonthKey,
      // The ACTUAL window size behind the leagues (≤ the 12-month
      // cap; e.g. 9 live) — same additive disclosure convention as
      // /api/waste-top-items windowMonths (BUGHUNT-R1 FIX 2 family).
      windowMonths: leagueData.windowMonths,
      // Disclosure block: satuan rides per item; the BOM basis +
      // guards + zero-waste policy + epistemic label ride here so
      // the card renders the server's wording, never a hardcode.
      meta: leagueData.meta,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[waste-rate-league] error:', { error: e });
    return errorResponse(e, 'waste-rate-league');
  }
}
