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
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '5') || 5), 50);
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outletCode');
    const pic = url.searchParams.get('pic');

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;
    if (prevMonth) prevMonth = resolveMonthLabel(prevMonth, resolver) || prevMonth;

    // FIX FLOW-2: Auto-compute prevWeek/prevMonth when not provided (matches /api/analysis pattern)
    // Without this, 3 of 15 priority signals (Deviasi Growth, Direction Flip, Trend Memburuk —
    // total weight 26%) are ALWAYS zero unless user manually selects a compare period.
    if (!prevWeek || !prevMonth) {
      const { db } = await import('@/lib/db');
      try {
        const periods = await db.week.findMany({
          select: { weekLabel: true, monthKey: true, sourceFile: { select: { monthLabel: true } } },
          distinct: ['monthKey', 'weekLabel'],
        });
        const allPeriods = periods
          .map((w) => ({
            monthLabel: w.sourceFile.monthLabel,
            weekLabel: w.weekLabel,
            monthKey: w.monthKey,
            sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
          }))
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

        const currentIdx = allPeriods.findIndex(
          (p) => p.monthLabel === month && p.weekLabel === week,
        );
        if (currentIdx > 0) {
          // Auto-compare: same weekLabel in previous month (if exists), else previous period
          const sameWeekInPrevMonth = allPeriods
            .slice(0, currentIdx)
            .reverse()
            .find((p) => p.weekLabel === week);
          const prevPeriod = sameWeekInPrevMonth || allPeriods[currentIdx - 1];
          if (!prevWeek) prevWeek = prevPeriod.weekLabel;
          if (!prevMonth) prevMonth = prevPeriod.monthLabel;
        }
      } catch {
        // Week table may not exist — skip auto-compute
      }
    }

    let picOutletCodes: string[] | null = null;
    if (pic) {
      const { db } = await import('@/lib/db');
      // Case-insensitive match — Prisma's `mode: 'insensitive'` is PostgreSQL-only.
      // Use raw SQL with LOWER() which works on BOTH PostgreSQL and SQLite.
      // This ensures 'BUDI' matches 'Budi'/'budi' regardless of DB provider.
      let pics: Array<{ outletCode: string }> = [];
      try {
        pics = await db.$queryRaw<Array<{ outletCode: string }>>`
          SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})
        `;
      } catch (e) {
        console.error('[recommendations] OutletPIC query failed:', e instanceof Error ? e.message : String(e));
        pics = [];
      }
      picOutletCodes = pics.map((p) => p.outletCode);
      // BUG FIX: if PIC is selected but has 0 outlets, buildSqlFilters treats []
      // as "no filter" → shows ALL outlets (wrong). Use sentinel '__NO_MATCH__'
      // so the IN clause returns 0 outlets (correct: PIC has no outlets).
      if (picOutletCodes.length === 0) {
        picOutletCodes = ['__NO_MATCH__'];
      }
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
