// ============================================================
//  /api/pareto — Pareto 80/20 analysis across dimensions
//  GET: ?month=&week=&area=&pic=
//  Returns: Pareto by Item, Outlet, Area, PIC + nested Item→Outlet
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { queryParetoByItem, queryParetoByOutlet, queryParetoByArea, queryParetoByKelompok, queryParetoByPIC, queryParetoNestedItemOutlet, queryParetoHistorical, mergeHistoricalIntoPareto } from '@/lib/queries/pareto';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`pareto:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    let month = url.searchParams.get('month') || '';
    const week = url.searchParams.get('week') || '';
    const area = url.searchParams.get('area');
    const pic = url.searchParams.get('pic');

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    const monthResolver = await getMonthResolver();
    month = resolveMonthLabel(month, monthResolver) || month;

    // Resolve PIC → outletCodes (shared logic)
    const picOutletCodes = await resolvePICOutletCodes(pic);
    if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
      return NextResponse.json({ success: true, byItem: { drivers: [] }, byOutlet: { drivers: [] }, byArea: { drivers: [] }, byKelompok: { drivers: [] }, byPIC: { drivers: [] }, nested: { items: [] }, durationMs: Date.now() - startedAt });
    }

    const kelompok = url.searchParams.get('kelompok');
    const filters = {
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: null,
      picOutletCodes,
    };

    // Run all 6 Pareto queries in parallel
    const [byItem, byOutlet, byArea, byKelompok, byPIC, nested] = await Promise.all([
      queryParetoByItem(week, month, filters),
      queryParetoByOutlet(week, month, { area: filters.area, kelompok: filters.kelompok, picOutletCodes }),
      queryParetoByArea(week, month, { kelompok: filters.kelompok, picOutletCodes }),
      queryParetoByKelompok(week, month, { area: filters.area, picOutletCodes }),
      queryParetoByPIC(week, month, { area: filters.area, kelompok: filters.kelompok, picOutletCodes }),
      queryParetoNestedItemOutlet(week, month, filters, 10),
    ]);

    // Fetch historical stats for each dimension (same weekLabel, different monthLabel)
    // + merge histAvg + zScore into Pareto results
    const [histItem, histOutlet, histArea, histKelompok, histPIC] = await Promise.all([
      queryParetoHistorical(week, month, 'item', filters),
      queryParetoHistorical(week, month, 'outlet', { area: filters.area, kelompok: filters.kelompok, picOutletCodes }),
      queryParetoHistorical(week, month, 'area', { kelompok: filters.kelompok, picOutletCodes }),
      queryParetoHistorical(week, month, 'kelompok', { area: filters.area, picOutletCodes }),
      queryParetoHistorical(week, month, 'pic', { area: filters.area, kelompok: filters.kelompok, picOutletCodes }),
    ]);

    const byItemMerged = mergeHistoricalIntoPareto(byItem, histItem);
    const byOutletMerged = mergeHistoricalIntoPareto(byOutlet, histOutlet);
    const byAreaMerged = mergeHistoricalIntoPareto(byArea, histArea);
    const byKelompokMerged = mergeHistoricalIntoPareto(byKelompok, histKelompok);
    const byPICMerged = mergeHistoricalIntoPareto(byPIC, histPIC);

    return NextResponse.json({
      success: true,
      period: { month, week },
      filters: { area: area || null, kelompok: kelompok || null, pic: pic || null },
      byItem: byItemMerged,
      byOutlet: byOutletMerged,
      byArea: byAreaMerged,
      byKelompok: byKelompokMerged,
      byPIC: byPICMerged,
      nested,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: unknown) {
    logger.error('[pareto] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
