import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { queryRestoRecommendations } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`recommendations:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    let prevWeek = url.searchParams.get('prevWeek');
    let prevMonth = url.searchParams.get('prevMonth');
    const limit = parseInt(url.searchParams.get('limit') || '5');
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outletCode');
    const pic = url.searchParams.get('pic');

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;
    if (prevMonth) prevMonth = resolveMonthLabel(prevMonth, resolver) || prevMonth;

    let picOutletCodes: string[] | null = null;
    if (pic) {
      const pics = await (await import('@/lib/db')).db.outletPIC.findMany({ where: { pic }, select: { outletCode: true } }).catch(() => []);
      picOutletCodes = (pics as any[]).map(p => p.outletCode);
    }

    const filters = {
      area: area && area !== 'all' ? area : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      picOutletCodes,
    };

    const recommendations = await queryRestoRecommendations(month, week, prevWeek, prevMonth, filters, limit);

    return NextResponse.json({ success: true, recommendations });
  } catch (e: any) {
    console.error('[recommendations] error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
