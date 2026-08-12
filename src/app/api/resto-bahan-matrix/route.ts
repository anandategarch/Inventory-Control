// ============================================================
//  /api/resto-bahan-matrix — Top worst outlet+item combos
//  Query: ?month=&week=&area=&limit=50&priority=P1
//
//  Returns cross-tabulation of outlet × item with:
//  Dev/BOM, Historical trend, Area benchmark, Residual, Priority
//  Sorted by priority (P1 first) then by absNominalLossSurplus DESC
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`resto-matrix:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const priorityFilter = url.searchParams.get('priority'); // P1, P2, P3, or null for all
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // Build area filter
    const areaFilter = area && area !== 'all' ? `AND ir.area = '${area.replace(/'/g, "''")}'` : '';

    // Get all outlet+item combos with deviation for this period
    // Use raw SQL for performance — join Outlet, Item, InventoryRecord
    const rows = await db.$queryRaw<Array<{
      outletCode: string; outletName: string; area: string;
      itemName: string; satuan: string | null;
      qtyBom: number | null; qtyDeviasi: number | null;
      pctQtyDeviasiToBom: number | null;
      nominalLossSurplus: number | null; absNominalLossSurplus: number | null;
      direction: string | null;
      qtyWaste: number | null; qtySusut: number | null; qtyTrial: number | null;
      residualRatio: number | null;
      tolerancePct: number | null;
      isOverExplained: boolean | null;
    }>>`
      SELECT
        o.code as "outletCode", o.name as "outletName", ir.area,
        i.name as "itemName", i.satuan,
        ir."qtyBom", ir."qtyDeviasi",
        ir."pctQtyDeviasiToBom",
        ir."nominalLossSurplus", ir."absNominalLossSurplus",
        ir.direction,
        ir."qtyWaste", ir."qtySusut", ir."qtyTrial",
        ir."residualRatio",
        ir."tolerancePct"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
        AND ir."absNominalLossSurplus" IS NOT NULL
        AND ir."absNominalLossSurplus" > 0
        ${area ? Prisma.raw(areaFilter) : Prisma.empty}
      ORDER BY ir."absNominalLossSurplus" DESC
      LIMIT ${limit * 3}
    `;

    // Get area avg devBom per item for benchmark
    const itemAreaBench = await db.$queryRaw<Array<{
      itemName: string; avgDevBom: number; outletCount: number;
    }>>`
      SELECT i.name as "itemName",
        COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
        COUNT(DISTINCT ir."outletId")::int as "outletCount"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
      GROUP BY i.name
    `;
    const benchMap = new Map(itemAreaBench.map(b => [b.itemName, { avgDevBom: Number(b.avgDevBom), outletCount: b.outletCount }]));

    // Get previous period for historical trend
    const weeksRaw = await db.week.findMany({
      select: { weekLabel: true, monthKey: true },
      distinct: ['monthKey', 'weekLabel'],
    });
    const fileMonthKeys = await db.sourceFile.findMany({ select: { monthLabel: true, monthKey: true } });
    const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));
    const allPeriods = weeksRaw.map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    const currentIdx = allPeriods.findIndex(p => p.monthLabel === month && p.weekLabel === week);
    const prevPeriod = currentIdx > 0 ? allPeriods[currentIdx - 1] : null;

    // Get previous period devBom per outlet+item
    let prevDevBomMap = new Map<string, number | null>();
    if (prevPeriod) {
      const prevRows = await db.$queryRaw<Array<{ outletCode: string; itemName: string; pctDevBom: number | null }>>`
        SELECT o.code as "outletCode", i.name as "itemName",
          ir."pctQtyDeviasiToBom" as "pctDevBom"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE ir."monthLabel" = ${prevPeriod.monthLabel}
          AND ir."weekLabel" = ${prevPeriod.weekLabel}
      `;
      prevDevBomMap = new Map(prevRows.map(r => [`${r.outletCode}|${r.itemName}`, r.pctDevBom ? Number(r.pctDevBom) : null]));
    }

    const toNum = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };

    // Build matrix rows with priority + historical + benchmark
    const matrix = rows.map(r => {
      const devBom = toNum(r.pctQtyDeviasiToBom);
      const absNominal = toNum(r.absNominalLossSurplus) ?? 0;
      const residualRatio = toNum(r.residualRatio);
      const bench = benchMap.get(r.itemName);
      const areaAvgDevBom = bench?.avgDevBom ?? 0;
      const areaOutletCount = bench?.outletCount ?? 0;
      const areaMultiplier = areaAvgDevBom > 0 && devBom != null ? Math.abs(devBom) / areaAvgDevBom : null;

      // Historical trend
      const prevDevBom = prevDevBomMap.get(`${r.outletCode}|${r.itemName}`) ?? null;
      const historicalTrend = (devBom != null && prevDevBom != null)
        ? Math.abs(devBom) > Math.abs(prevDevBom) * 1.1 ? '↑'
        : Math.abs(devBom) < Math.abs(prevDevBom) * 0.9 ? '↓' : '→'
        : '?';

      // Priority
      const isHighNominal = absNominal > 1_000_000;
      const isHighDevBom = devBom != null && Math.abs(devBom) > 0.10;
      const isHighResidual = residualRatio != null && residualRatio > 0.50;
      const isOverExplained = (() => {
        const explained = Math.abs((toNum(r.qtyWaste) ?? 0) + (toNum(r.qtySusut) ?? 0) + (toNum(r.qtyTrial) ?? 0));
        const absDev = Math.abs(toNum(r.qtyDeviasi) ?? 0);
        return absDev > 0 && explained > absDev;
      })();
      const priority: 'P1' | 'P2' | 'P3' =
        (isHighNominal && (isHighDevBom || isHighResidual || isOverExplained)) ? 'P1' :
        (isHighDevBom || isHighResidual || isOverExplained) ? 'P2' : 'P3';

      return {
        outletCode: r.outletCode,
        outletName: r.outletName,
        area: r.area,
        itemName: r.itemName,
        satuan: r.satuan,
        qtyBom: Math.abs(toNum(r.qtyBom) ?? 0),
        qtyDeviasi: toNum(r.qtyDeviasi),
        devBom: devBom,
        nominalLossSurplus: toNum(r.nominalLossSurplus),
        absNominalLossSurplus: absNominal,
        direction: r.direction || 'NEUTRAL',
        qtyWaste: Math.abs(toNum(r.qtyWaste) ?? 0),
        qtySusut: Math.abs(toNum(r.qtySusut) ?? 0),
        qtyTrial: Math.abs(toNum(r.qtyTrial) ?? 0),
        residualRatio: residualRatio,
        tolerancePct: toNum(r.tolerancePct),
        isOverExplained: isOverExplained,
        // Benchmark
        areaAvgDevBom: areaAvgDevBom,
        areaMultiplier: areaMultiplier,
        areaOutletCount: areaOutletCount,
        // Historical
        prevDevBom: prevDevBom,
        historicalTrend: historicalTrend as '↑' | '↓' | '→' | '?',
        // Priority
        priority,
      };
    });

    // Filter by priority if requested
    const filtered = priorityFilter
      ? matrix.filter(m => m.priority === priorityFilter)
      : matrix;

    // Sort: P1 first, then by absNominal DESC
    const priorityOrder = { P1: 0, P2: 1, P3: 2 };
    filtered.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || b.absNominalLossSurplus - a.absNominalLossSurplus);

    // Limit
    const result = filtered.slice(0, limit);

    // Summary stats
    const stats = {
      total: matrix.length,
      P1: matrix.filter(m => m.priority === 'P1').length,
      P2: matrix.filter(m => m.priority === 'P2').length,
      P3: matrix.filter(m => m.priority === 'P3').length,
      outlets: new Set(matrix.map(m => m.outletCode)).size,
      items: new Set(matrix.map(m => m.itemName)).size,
    };

    return NextResponse.json({
      success: true,
      period: { month, week, prevWeek: prevPeriod?.weekLabel || null, prevMonth: prevPeriod?.monthLabel || null },
      matrix: result,
      stats,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: any) {
    console.error('[resto-bahan-matrix] error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
