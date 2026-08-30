// ============================================================
//  /api/area-item-heatmap/cell-detail
//  GET: ?month=&week=&area=&item=&kelompok=&outlet=&pic=
//  Returns per-outlet drill-down for a specific area × item cell.
//  Shows raw quantities (qtyBom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial)
//  and nominal values per outlet × akunPenyesuaian.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { queryHeatmapCellDetail } from '@/lib/queries/heatmap';
import { validateQuery, heatmapQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`heatmap-cell:${ip}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // FIX API-06: Zod validation (was missing — no input validation at all)
    const validation = validateQuery(heatmapQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const rawMonth = url.searchParams.get('month') || '';
    const rawWeek = url.searchParams.get('week') || '';
    const areaName = url.searchParams.get('area') || '';
    const itemName = url.searchParams.get('item') || '';
    const kelompok = url.searchParams.get('kelompok') || null;
    const outletCode = url.searchParams.get('outlet') || null;
    const pic = url.searchParams.get('pic') || null;

    if (!rawMonth || !rawWeek || !areaName || !itemName) {
      return NextResponse.json(
        { success: false, error: 'month, week, area, and item are required' },
        { status: 400 },
      );
    }

    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);
    if (kelompokOutletCodes && kelompokOutletCodes.length === 1 && kelompokOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({ success: true, rows: [] }, { headers: CACHE_ANALYSIS });
    }

    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({ success: true, rows: [] }, { headers: CACHE_ANALYSIS });
    }

    const filterOpts = {
      area: null, // area is already applied via areaName param in the query
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: null, // itemName is already applied via itemName param
      picOutletCodes,
    };

    const rows = await queryHeatmapCellDetail(week, month, filterOpts, areaName, itemName);

    return NextResponse.json({ success: true, rows, durationMs: Date.now() - startedAt }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // FEAT-01 fix: don't leak internal error details to client
    logger.error('[area-item-heatmap/cell-detail] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
