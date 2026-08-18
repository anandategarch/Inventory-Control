// ============================================================
//  /api/peer-comparison/trend — Multi-Week Trend Comparison
//  For each week in the month, returns Dev/BOM % for the target
//  outlet and the peer average (outlets within ±10% sales range).
//
//  GET: ?outletCode=X&month=Y&peers=A,B,C
//
//  Returns: {
//    targetOutlet, weeks: [{ weekLabel, devBomTarget, devBomPeerAvg, salesTarget }]
//  }
//
//  NOTE: peers param is optional. If omitted, peer set is auto-
//  computed per-week based on that week's sales ±10% band.
//  For simplicity + consistency with the table, we use the
//  auto-computed peer set per week.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison-trend:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const peersParam = url.searchParams.get('peers'); // optional comma-separated outlet codes

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Allow caller to restrict peer set (for stable trend across weeks).
    // If not provided, peer set is auto-computed per-week from ±10% sales band.
    const explicitPeerCodes: string[] | null = peersParam
      ? peersParam.split(',').map(s => s.trim()).filter(Boolean)
      : null;

    // Get all weeks for the month (sorted by weekLabel natural order)
    const weeks = await db.$queryRaw<{ weekLabel: string }[]>`
      SELECT DISTINCT ir."weekLabel"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month}
      ORDER BY ir."weekLabel" ASC
    `;

    if (weeks.length === 0) {
      return NextResponse.json({
        success: true,
        targetOutlet: outletCode,
        weeks: [],
      });
    }

    // For each week, compute:
    //   - target sales (mode) + target Dev/BOM
    //   - peer set (±10% of target sales, or explicit list)
    //   - peer average Dev/BOM
    // We do it in one SQL pass per week — simpler than a single CTE.

    // FIX (PEER-AUDIT-BACKEND BUG-1): Removed peerListClause — it was injected
    // twice, causing the target outlet to be excluded from results when explicit
    // peer codes were provided. The WHERE clause at line 130-134 already handles
    // the peer filtering correctly.

    const weekResults: any[] = [];

    for (const w of weeks) {
      const weekLabel = w.weekLabel;

      // Single query: get target's sales, target's Dev/BOM, and all peer Dev/BOMs
      // in the ±10% sales band. We aggregate the peer avg in SQL too.
      const rows = await db.$queryRaw<any[]>`
        WITH sales_counts AS (
          SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
          FROM "InventoryRecord" ir
          WHERE ir."monthLabel" = ${month}
            AND ir."weekLabel" = ${weekLabel}
            AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
          GROUP BY ir."outletId", ir."nominalSales"
        ),
        ranked_sales AS (
          SELECT "outletId", "nominalSales",
            ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
          FROM sales_counts
        ),
        sales_mode AS (
          SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
        ),
        target AS (
          SELECT sm.sales, o.id as "outletId"
          FROM sales_mode sm
          JOIN "Outlet" o ON sm."outletId" = o.id
          WHERE o.code = ${outletCode}
        ),
        outlet_aggs AS (
          SELECT
            ir."outletId",
            CASE WHEN SUM(ABS(ir."qtyBom")) > 0
              THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
              ELSE 0 END as "devBom"
          FROM "InventoryRecord" ir
          WHERE ir."monthLabel" = ${month}
            AND ir."weekLabel" = ${weekLabel}
          GROUP BY ir."outletId"
        )
        SELECT
          o.code as "outletCode",
          CASE WHEN o.code = ${outletCode} THEN true ELSE false END as "isTarget",
          COALESCE(sm.sales, 0) as sales,
          COALESCE(oa."devBom", 0) as "devBom"
        FROM "Outlet" o
        JOIN sales_mode sm ON o.id = sm."outletId"
        LEFT JOIN outlet_aggs oa ON o.id = oa."outletId"
        CROSS JOIN target t
        WHERE COALESCE(sm.sales, 0) > 0
          AND (
            ${explicitPeerCodes && explicitPeerCodes.length > 0
              ? Prisma.sql`o.code IN (${Prisma.join([outletCode, ...explicitPeerCodes])})`
              : Prisma.sql`ABS(COALESCE(sm.sales, 0) - t.sales) <= t.sales * 0.1`}
          )
      `;

      const targetRow = rows.find((r: any) => r.isTarget);
      const otherPeers = rows.filter((r: any) => !r.isTarget && r.devBom != null);
      const peerAvgDevBom = otherPeers.length > 0
        ? otherPeers.reduce((s: number, r: any) => s + Number(r.devBom), 0) / otherPeers.length
        : 0;

      weekResults.push({
        weekLabel,
        devBomTarget: targetRow ? Number(targetRow.devBom) : 0,
        devBomPeerAvg: peerAvgDevBom,
        salesTarget: targetRow ? Number(targetRow.sales) : 0,
        peerCount: otherPeers.length,
      });
    }

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      month,
      weeks: weekResults,
    });
  } catch (e: any) {
    console.error('[peer-comparison-trend] error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
