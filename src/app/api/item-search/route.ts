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
import { queryGlobalItemSearch, queryItemAutocomplete, queryItemTrend } from '@/lib/queries/items/global-search';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
// FIX (AUDIT-NEWFEATURES C4): use shared schemas instead of inline regex
import { monthLabelSchema, weekLabelSchema } from '@/lib/validation';
import { CACHE_INTERACTIVE } from '@/lib/cache-headers';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX: 30→60 — cross-outlet + trend queries scan full table

const itemSearchQuerySchema = z.object({
  mode: z.enum(['autocomplete', 'cross-outlet', 'trend']).default('autocomplete'),
  q: z.string().min(1).max(200).optional(),
  item: z.string().min(1).max(200).optional(),
  month: monthLabelSchema,
  week: weekLabelSchema,
  area: z.string().max(100).optional(),
  kelompok: z.string().max(50).optional(),
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
    const { mode, q, item, month: monthRaw, week, area, kelompok, pic } = parse.data;

    // Resolve month label case (DB may have "AGUSTUS 2026" vs "Agustus 2026")
    // Only resolve if monthRaw is provided (trend mode doesn't need month)
    const monthResolver = await getMonthResolver();
    const month = monthRaw ? (resolveMonthLabel(monthRaw, monthResolver) || monthRaw) : undefined;

    if (mode === 'autocomplete') {
      if (!q) {
        return NextResponse.json({ success: false, error: 'q is required for autocomplete mode' }, { status: 400 });
      }
      if (!month || !week) {
        return NextResponse.json({ success: false, error: 'month and week required for autocomplete mode' }, { status: 400 });
      }
      const results = await queryItemAutocomplete(week, month, q, 10);
      return NextResponse.json({
        success: true,
        mode: 'autocomplete',
        q,
        results,
        durationMs: Date.now() - startedAt,
      }, { headers: CACHE_INTERACTIVE });
    }

    // mode === 'cross-outlet' OR 'trend' — both need `item` param
    if (!item) {
      return NextResponse.json({ success: false, error: 'item is required for cross-outlet/trend mode' }, { status: 400 });
    }

    // Resolve PIC → outletCodes (shared logic) — used by cross-outlet + trend
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({
        success: true,
        mode,
        item,
        results: [],
        durationMs: Date.now() - startedAt,
      }, { headers: CACHE_INTERACTIVE });
    }

    // mode === 'trend' — return per-(period, outlet) data across ALL periods
    if (mode === 'trend') {
      const results = await queryItemTrend(item, {
        area: area || null,
        kelompok: kelompok || null,
        picOutletCodes,
      }, 500);
      return NextResponse.json({
        success: true,
        mode: 'trend',
        item,
        filters: { area: area || null, kelompok: kelompok || null, pic: pic || null },
        results,
        durationMs: Date.now() - startedAt,
      }, { headers: CACHE_INTERACTIVE });
    }

    // mode === 'cross-outlet' — needs month + week (already resolved above)
    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required for cross-outlet mode' }, { status: 400 });
    }

    const results = await queryGlobalItemSearch(week, month, item, {
      area: area || null,
      kelompok: kelompok || null,
      picOutletCodes,
    }, 100);

    return NextResponse.json({
      success: true,
      mode: 'cross-outlet',
      item,
      period: { month, week },
      filters: { area: area || null, kelompok: kelompok || null, pic: pic || null },
      results,
      durationMs: Date.now() - startedAt,
    }, { headers: CACHE_INTERACTIVE });
  } catch (e: unknown) {
    logger.error('[item-search] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
