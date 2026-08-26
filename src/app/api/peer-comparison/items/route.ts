// ============================================================
//  /api/peer-comparison/items — Item-Level Peer Comparison
//  Returns top N items from target outlet, with the same items'
//  metrics aggregated across all peer outlets (±10% sales range).
//
//  GET: ?outletCode=X&month=Y&week=Z&mode=week|month&topItems=5
//
//  Returns: {
//    targetOutlet, items: [{
//      itemName, target: {qtyDeviasi, devBom, nominal},
//      peerAvg: {...}, peerBest: {...}, gap: {...}
//    }]
//  }
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { buildSqlFilters } from '@/lib/queries/shared';
import { validateQuery, peerComparisonItemsQuerySchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // FIX: 30→60 — item comparison can be slow with many items

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`peer-comparison-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(peerComparisonItemsQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    let outletCode = url.searchParams.get('outletCode');
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const mode = (url.searchParams.get('mode') || 'week') as 'week' | 'month';
    const topItems = Math.min(parseInt(url.searchParams.get('topItems') || '5', 10) || 5, 20);
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only —
    // the focus outlet's top-items CTE is queried by outletCode regardless.
    const kelompok = url.searchParams.get('kelompok');

    if (!outletCode || !month) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    month = resolveMonthLabel(month, resolver) || month;

    // Same week filter logic as queryPeerComparison (outlets.ts)
    const weekFilter = mode === 'week' && week
      ? Prisma.sql`AND ir."weekLabel" = ${week}`
      : Prisma.sql`AND ir."weekLabel" = (
          SELECT MAX(ir2."weekLabel") FROM "InventoryRecord" ir2
          WHERE ir2."monthLabel" = ${month}
        )`;

    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok filter scopes the PEER set
    // only (peer_outlets CTE). The focus outlet is ALWAYS included via
    // `o.code = ${outletCode}` so it is never dropped from the result set
    // (e.g. if focus outlet is outside the selected kelompok). Pattern
    // matches shared.ts:buildSqlFilters kelompok clause — extract last
    // dot-segment, compare first 3 chars (works for both "1030.BDGSET" and
    // "B.1001.MLGPAR").
    const peerKelompokFilter = kelompok
      ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
      : Prisma.sql``;

    // 1. Find target outlet's sales (mode) within the ±10% peer set.
    //    Reuse the same sales_mode logic from queryPeerComparison.
    // 2. For top N items by absNominalDeviasi in the target outlet, pull
    //    the same items across all peer outlets in the sales ±10% band.
    //
    // The query below joins: target items × peer outlets × item metrics.
    const rows = await db.$queryRaw<any[]>`
      WITH sales_counts AS (
        SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month}
          AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
          ${weekFilter}
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
      peer_outlets AS (
        SELECT o.id as "outletId", o.code as "outletCode", o.name as "outletName",
               COALESCE(sm.sales, 0) as sales,
               CASE WHEN o.code = ${outletCode} THEN true ELSE false END as "isTarget"
        FROM "Outlet" o
        JOIN sales_mode sm ON o.id = sm."outletId"
        CROSS JOIN target t
        WHERE COALESCE(sm.sales, 0) > 0
          AND ABS(COALESCE(sm.sales, 0) - t.sales) <= t.sales * 0.1
          ${peerKelompokFilter}
      ),
      target_top_items AS (
        SELECT i.id as "itemId", i.name as "itemName",
          SUM(ABS(ir."qtyDeviasi")) as "targetQtyDeviasi",
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "targetDevBom",
          SUM(ABS(ir."nominalDeviasi")) as "targetNominal"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${month}
          ${weekFilter}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        GROUP BY i.id, i.name
        ORDER BY SUM(ir."absNominalDeviasi") DESC
        LIMIT ${topItems}
      )
      SELECT
        tti."itemId",
        tti."itemName",
        tti."targetQtyDeviasi",
        tti."targetDevBom",
        tti."targetNominal",
        po."outletCode",
        po."outletName",
        po."isTarget",
        SUM(ABS(ir."qtyDeviasi")) as "peerQtyDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "peerDevBom",
        SUM(ABS(ir."nominalDeviasi")) as "peerNominal"
      FROM target_top_items tti
      CROSS JOIN peer_outlets po
      LEFT JOIN "InventoryRecord" ir
        ON ir."itemId" = tti."itemId"
        AND ir."outletId" = po."outletId"
        AND ir."monthLabel" = ${month}
        ${weekFilter}
      GROUP BY tti."itemId", tti."itemName", tti."targetQtyDeviasi",
               tti."targetDevBom", tti."targetNominal",
               po."outletId", po."outletCode", po."outletName", po."isTarget"
      ORDER BY tti."targetNominal" DESC, po."outletCode"
    `;

    // Group rows by itemId → { itemName, target, peers: [{outletCode, outletName, isTarget, qtyDeviasi, devBom, nominal}] }
    const itemMap = new Map<number, any>();
    for (const r of rows) {
      const itemId = Number(r.itemId);
      if (!itemMap.has(itemId)) {
        itemMap.set(itemId, {
          itemId,
          itemName: r.itemName,
          target: {
            qtyDeviasi: Number(r.targetQtyDeviasi) || 0,
            devBom: Number(r.targetDevBom) || 0,
            nominal: Number(r.targetNominal) || 0,
          },
          peers: [],
        });
      }
      const item = itemMap.get(itemId);
      // Skip NULL rows (item not in that peer outlet's inventory)
      if (r.peerQtyDeviasi === null || r.peerNominal === null) {
        item.peers.push({
          outletCode: r.outletCode,
          outletName: r.outletName,
          isTarget: Boolean(r.isTarget),
          qtyDeviasi: 0,
          devBom: 0,
          nominal: 0,
          missing: true,
        });
      } else {
        item.peers.push({
          outletCode: r.outletCode,
          outletName: r.outletName,
          isTarget: Boolean(r.isTarget),
          qtyDeviasi: Number(r.peerQtyDeviasi) || 0,
          devBom: Number(r.peerDevBom) || 0,
          nominal: Number(r.peerNominal) || 0,
          missing: false,
        });
      }
    }

    // Compute peer avg / peer best / gap per item (exclude target row from peer stats)
    const items = Array.from(itemMap.values()).map((item: any) => {
      const otherPeers = item.peers.filter((p: any) => !p.isTarget && !p.missing);
      const n = otherPeers.length;
      const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
      const peerAvg = {
        qtyDeviasi: n > 0 ? otherPeers.reduce((s: number, p: any) => s + p.qtyDeviasi, 0) / n : 0,
        devBom: n > 0 ? otherPeers.reduce((s: number, p: any) => s + p.devBom, 0) / n : 0,
        nominal: n > 0 ? otherPeers.reduce((s: number, p: any) => s + p.nominal, 0) / n : 0,
      };
      // Peer best: lowest is best for these bad metrics
      const peerBest = {
        qtyDeviasi: n > 0 ? Math.min(...otherPeers.map((p: any) => p.qtyDeviasi)) : 0,
        devBom: n > 0 ? Math.min(...otherPeers.map((p: any) => p.devBom)) : 0,
        nominal: n > 0 ? Math.min(...otherPeers.map((p: any) => p.nominal)) : 0,
      };
      const gap = {
        qtyDeviasi: item.target.qtyDeviasi - peerBest.qtyDeviasi,
        devBom: item.target.devBom - peerBest.devBom,
        nominal: item.target.nominal - peerBest.nominal,
        nominalPctAboveBest: safeDiv(item.target.nominal - peerBest.nominal, peerBest.nominal),
      };
      return { ...item, peerAvg, peerBest, gap, peerCount: n };
    });

    return NextResponse.json({
      success: true,
      targetOutlet: outletCode,
      mode,
      topItems,
      items,
    });
  } catch (e: unknown) {
    logger.error("[peer-comparison-items] error:", { error: e });
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
