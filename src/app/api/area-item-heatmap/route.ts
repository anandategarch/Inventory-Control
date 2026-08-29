// ============================================================
//  /api/area-item-heatmap
//  GET: ?month=&week=&metric=&itemLimit=&area=&kelompok=&outlet=&pic=
//  Returns Area × Item matrix for heatmap visualization.
//
//  Metrics: absNominalDeviasi (default), nominalWaste, nominalSusut,
//           pctQtyDeviasiToBom, recordCount
//  itemLimit: 5-109 (default 20, recommended 15-25 for readability)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { queryAreaItemHeatmap, type HeatmapMetric, type ItemSelectMode } from '@/lib/queries/heatmap';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_METRICS: HeatmapMetric[] = [
  'absNominalDeviasi',
  'nominalWaste',
  'nominalSusut',
  'pctQtyDeviasiToBom',
  'recordCount',
];

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`heatmap:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const rawMonth = url.searchParams.get('month') || '';
    const rawWeek = url.searchParams.get('week') || '';
    const metricParam = url.searchParams.get('metric') || 'absNominalDeviasi';
    const itemLimitParam = parseInt(url.searchParams.get('itemLimit') || '20', 10);
    const modeParam = url.searchParams.get('mode') || 'pareto80';
    const area = url.searchParams.get('area') || null;
    const kelompok = url.searchParams.get('kelompok') || null;
    const outletCode = url.searchParams.get('outlet') || null;
    const itemName = url.searchParams.get('item') || null;
    const pic = url.searchParams.get('pic') || null;

    if (!rawMonth || !rawWeek) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // Validate metric
    const metric = (VALID_METRICS.includes(metricParam as HeatmapMetric)
      ? metricParam
      : 'absNominalDeviasi') as HeatmapMetric;

    // Validate itemLimit (5-100 range — BUG-A-05: was 109 typo)
    const itemLimit = Math.max(5, Math.min(100, isNaN(itemLimitParam) ? 20 : itemLimitParam));

    // Validate mode
    const mode: ItemSelectMode = modeParam === 'top' ? 'top' : 'pareto80';

    // Resolve month label
    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    // Resolve kelompok → outlet codes
    const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);
    if (kelompokOutletCodes && kelompokOutletCodes.length === 1 && kelompokOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({
        success: true,
        areas: [],
        items: [],
        cells: [],
        metric,
        maxValue: 0,
      }, { headers: CACHE_ANALYSIS });
    }

    // Resolve PIC → outlet codes
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({
        success: true,
        areas: [],
        items: [],
        cells: [],
        metric,
        maxValue: 0,
      }, { headers: CACHE_ANALYSIS });
    }

    // Build filter opts (same pattern as other query modules)
    const filterOpts = {
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: itemName || null,
      picOutletCodes,
    };

    // Note: queryAreaItemHeatmap uses buildSqlFilters internally,
    // so we don't need to build a Prisma WhereInput here.

    const result = await queryAreaItemHeatmap(week, month, filterOpts, metric, itemLimit, mode);

    return NextResponse.json({
      success: true,
      period: { month, week },
      ...result,
      durationMs: Date.now() - startedAt,
    }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // BUG-A-07: Don't leak internal error details to client
    logger.error('[area-item-heatmap] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
