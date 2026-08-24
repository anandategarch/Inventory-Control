// ============================================================
//  /api/item-search — Global item search (cross-outlet analysis)
//  Query modes:
//    ?mode=autocomplete&q=cabai&month=...&week=...
//      → returns up to 10 item names matching `q` (for the search bar dropdown)
//    ?mode=cross-outlet&item=CABAI%20FROZEN&month=...&week=...&area=...&pic=...
//      → returns that item's deviation across ALL outlets (cross-outlet view)
//
//  The cross-outlet mode intentionally does NOT filter by outletCode —
//  the whole point is to see ONE item in ALL outlets to detect systemic
//  patterns. Area + PIC filters are respected (narrow the outlet scope).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryGlobalItemSearch, queryItemAutocomplete } from '@/lib/queries/items';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const itemSearchQuerySchema = z.object({
  mode: z.enum(['autocomplete', 'cross-outlet']).default('autocomplete'),
  q: z.string().min(1).max(200).optional(),
  item: z.string().min(1).max(200).optional(),
  month: z.string().regex(/^[A-Z][a-z]+\s+20\d{2}$/),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i),
  area: z.string().max(100).optional(),
  pic: z.string().max(100).optional(),
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
    const { mode, q, item, month: monthRaw, week, area, pic } = parse.data;

    // Resolve month label case (DB may have "AGUSTUS 2026" vs "Agustus 2026")
    const monthResolver = await getMonthResolver();
    const month = resolveMonthLabel(monthRaw, monthResolver) || monthRaw;

    if (mode === 'autocomplete') {
      if (!q) {
        return NextResponse.json({ success: false, error: 'q is required for autocomplete mode' }, { status: 400 });
      }
      const results = await queryItemAutocomplete(week, month, q, 10);
      return NextResponse.json({
        success: true,
        mode: 'autocomplete',
        q,
        results,
        durationMs: Date.now() - startedAt,
      });
    }

    // mode === 'cross-outlet'
    if (!item) {
      return NextResponse.json({ success: false, error: 'item is required for cross-outlet mode' }, { status: 400 });
    }

    // Resolve PIC → outletCodes (if pic filter is set)
    let picOutletCodes: string[] | null = null;
    if (pic) {
      const picRows = await db.$queryRaw<Array<{ outletCode: string }>>`
        SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})
      `;
      picOutletCodes = picRows.map((r) => r.outletCode);
      if (picOutletCodes.length === 0) {
        // PIC has no outlets → return empty (matches analysis route behavior)
        return NextResponse.json({
          success: true,
          mode: 'cross-outlet',
          item,
          results: [],
          durationMs: Date.now() - startedAt,
        });
      }
    }

    const results = await queryGlobalItemSearch(week, month, item, {
      area: area || null,
      picOutletCodes,
    }, 100);

    return NextResponse.json({
      success: true,
      mode: 'cross-outlet',
      item,
      period: { month, week },
      filters: { area: area || null, pic: pic || null },
      results,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: unknown) {
    logger.error('[item-search] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
