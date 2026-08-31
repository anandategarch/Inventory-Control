// ============================================================
//  /api/item-search — Item autocomplete for search bars
//  Query mode:
//    ?mode=autocomplete&q=cabai&month=...&week=...
//      → returns up to 10 item names matching `q` (for the search bar dropdown)
//
//  NOTE: cross-outlet + trend modes were removed (GlobalItemSearchModal deleted).
//  The autocomplete mode is still used by ItemTrendTab's search bar.
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

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
    const monthResolver = await getMonthResolver();
    const month = resolveMonthLabel(monthRaw, monthResolver) || monthRaw;

    const results = await queryItemAutocomplete(week, month, q, 10);
    return NextResponse.json({
      success: true,
      mode: 'autocomplete',
      q,
      results,
      durationMs: Date.now() - startedAt,
    }, { headers: CACHE_INTERACTIVE });
  } catch (e: unknown) {
    logger.error('[item-search] error:', { error: e instanceof Error ? e.message : String(e) });
    return errorResponse(e, "item-search");
  }
}
