// ============================================================
//  /api/item-history — Historical timeline per outlet+item
//  Query: ?outletCode=&itemName=&month=&week=
//
//  Returns:
//  1. Timeline: all periods for this outlet+item (qtyBom, qtyDeviasi, devBom, direction, nominal, W/S/T, residual)
//  2. Benchmark per period: area avg devBom for this item, network avg devBom for this item
//  3. Summary: deterioration/improvement, zScore, priority
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`item-history:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    const itemName = url.searchParams.get('itemName');
    const currentMonth = url.searchParams.get('month');
    const currentWeek = url.searchParams.get('week');

    if (!outletCode || !itemName) {
      return NextResponse.json({ success: false, error: 'outletCode and itemName required' }, { status: 400 });
    }

    // Resolve outlet
    const outlet = await db.outlet.findFirst({
      where: { code: outletCode },
      select: { id: true, code: true, name: true, area: true },
    });
    if (!outlet) {
      return NextResponse.json({ success: false, error: `Outlet ${outletCode} not found` }, { status: 404 });
    }

    // Get ALL periods for this outlet+item (across all months/weeks)
    const allRecs = await db.$queryRaw<Array<{
      monthLabel: string; weekLabel: string;
      qtyBom: number | null; qtyDeviasi: number | null; qtyCom: number | null;
      qtyWaste: number | null; qtySusut: number | null; qtyTrial: number | null;
      qtyLossSurplus: number | null;
      nominalDeviasi: number | null; nominalLossSurplus: number | null;
      pctQtyDeviasiToBom: number | null;
      direction: string | null;
      residualQty: number | null; residualRatio: number | null;
      absNominalLossSurplus: number | null;
      tolerancePct: number | null;
      monthKey: string | null;
    }>>`
      SELECT ir."monthLabel", ir."weekLabel",
        ir."qtyBom", ir."qtyDeviasi", ir."qtyCom",
        ir."qtyWaste", ir."qtySusut", ir."qtyTrial", ir."qtyLossSurplus",
        ir."nominalDeviasi", ir."nominalLossSurplus",
        ir."pctQtyDeviasiToBom", ir.direction,
        ir."residualQty", ir."residualRatio",
        ir."absNominalLossSurplus",
        ir."tolerancePct",
        sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "Item" i ON ir."itemId" = i.id
      LEFT JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE o.code = ${outletCode}
        AND i.name = ${itemName}
      ORDER BY COALESCE(sf."monthKey", '0000-00') ASC, ir."weekLabel" ASC
    `;

    if (allRecs.length === 0) {
      return NextResponse.json({ success: false, error: `No records found for ${itemName} at ${outletCode}` }, { status: 404 });
    }

    const toNum = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };

    // Build timeline with sortKey
    const timeline = allRecs.map(r => {
      const mk = r.monthKey || '0000-00';
      const wkNum = String(parseInt(r.weekLabel?.replace(/\D/g, '') || '0') || 0).padStart(2, '0');
      return {
        monthLabel: r.monthLabel,
        weekLabel: r.weekLabel,
        sortKey: `${mk}|${wkNum}`,
        qtyBom: Math.abs(toNum(r.qtyBom) ?? 0),
        qtyCom: toNum(r.qtyCom),
        qtyDeviasi: toNum(r.qtyDeviasi),
        qtyWaste: Math.abs(toNum(r.qtyWaste) ?? 0),
        qtySusut: Math.abs(toNum(r.qtySusut) ?? 0),
        qtyTrial: Math.abs(toNum(r.qtyTrial) ?? 0),
        qtyLossSurplus: toNum(r.qtyLossSurplus),
        nominalDeviasi: toNum(r.nominalDeviasi),
        nominalLossSurplus: toNum(r.nominalLossSurplus),
        absNominalLossSurplus: toNum(r.absNominalLossSurplus) ?? 0,
        devBom: toNum(r.pctQtyDeviasiToBom),
        direction: r.direction || 'NEUTRAL',
        residualQty: toNum(r.residualQty),
        residualRatio: toNum(r.residualRatio),
        tolerancePct: toNum(r.tolerancePct),
        isCurrent: r.monthLabel === currentMonth && r.weekLabel === currentWeek,
      };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // ============================================================
    //  Benchmark: area + network avg devBom for THIS ITEM per period
    // ============================================================
    const currentPeriod = timeline.find(t => t.isCurrent) || timeline[timeline.length - 1];
    if (!currentPeriod) {
      return NextResponse.json({ success: false, error: 'No current period found in timeline' }, { status: 404 });
    }
    const currentDevBom = currentPeriod.devBom;

    // Area benchmark for this item (current period)
    const areaBench = await db.$queryRaw<Array<{ avgDevBom: number; outletCount: number }>>`
      SELECT
        COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
        COUNT(DISTINCT ir."outletId")::int as "outletCount"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE i.name = ${itemName}
        AND ir.area = ${outlet.area}
        AND ir."monthLabel" = ${currentPeriod?.monthLabel || ''}
        AND ir."weekLabel" = ${currentPeriod?.weekLabel || ''}
    `;

    // Network benchmark for this item (current period)
    const networkBench = await db.$queryRaw<Array<{ avgDevBom: number; outletCount: number; bestDevBom: number | null }>>`
      SELECT
        COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
        COUNT(DISTINCT ir."outletId")::int as "outletCount",
        MIN(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL) as "bestDevBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE i.name = ${itemName}
        AND ir."monthLabel" = ${currentPeriod?.monthLabel || ''}
        AND ir."weekLabel" = ${currentPeriod?.weekLabel || ''}
    `;

    // Historical stats (zScore)
    const devBomValues = timeline
      .filter(t => t.devBom != null)
      .map(t => Math.abs(t.devBom!));
    const histMean = devBomValues.length > 0
      ? devBomValues.reduce((a, b) => a + b, 0) / devBomValues.length
      : 0;
    const histStdDev = devBomValues.length > 1
      ? Math.sqrt(devBomValues.reduce((a, b) => a + (b - histMean) ** 2, 0) / (devBomValues.length - 1))
      : 0;
    const zScore = currentDevBom != null && histStdDev > 0
      ? (Math.abs(currentDevBom) - histMean) / histStdDev
      : null;

    // Trend: compare current vs earliest
    const earliestDevBom = timeline[0]?.devBom;
    const deterioration = (currentDevBom != null && earliestDevBom != null)
      ? Math.abs(currentDevBom) - Math.abs(earliestDevBom)
      : null;

    // Priority
    const isHighNominal = (currentPeriod?.absNominalLossSurplus ?? 0) > 1_000_000;
    const isHighDevBom = currentDevBom != null && Math.abs(currentDevBom) > 0.10;
    const isHighResidual = currentPeriod?.residualRatio != null && currentPeriod.residualRatio > 0.50;
    const isHighZScore = zScore != null && zScore > 2;
    const priority: 'P1' | 'P2' | 'P3' =
      (isHighNominal && (isHighDevBom || isHighResidual || isHighZScore)) ? 'P1' :
      (isHighDevBom || isHighResidual || isHighZScore) ? 'P2' : 'P3';

    // Area multiplier
    const areaAvgDevBom = toNum(areaBench[0]?.avgDevBom) ?? 0;
    const networkAvgDevBom = toNum(networkBench[0]?.avgDevBom) ?? 0;
    const areaMultiplier = areaAvgDevBom > 0 && currentDevBom != null
      ? Math.abs(currentDevBom) / areaAvgDevBom
      : null;
    const networkMultiplier = networkAvgDevBom > 0 && currentDevBom != null
      ? Math.abs(currentDevBom) / networkAvgDevBom
      : null;

    return NextResponse.json({
      success: true,
      outlet: { code: outlet.code, name: outlet.name, area: outlet.area },
      itemName,
      timeline,
      benchmark: {
        outletDevBom: currentDevBom,
        areaAvgDevBom,
        networkAvgDevBom,
        bestDevBom: toNum(networkBench[0]?.bestDevBom),
        areaMultiplier,
        networkMultiplier,
        areaOutletCount: areaBench[0]?.outletCount ?? 0,
        networkOutletCount: networkBench[0]?.outletCount ?? 0,
      },
      historical: {
        mean: histMean,
        stdDev: histStdDev,
        zScore,
        sampleSize: devBomValues.length,
        earliestDevBom,
        currentDevBom,
        deterioration,
        trend: deterioration != null
          ? deterioration > 0.02 ? 'DETERIORATING' : deterioration < -0.02 ? 'IMPROVING' : 'STABLE'
          : 'UNKNOWN',
      },
      current: currentPeriod,
      priority,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: any) {
    console.error('[item-history] error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
