// ============================================================
//  /api/item-history — Historical timeline per outlet+item
//  Query: ?outletCode=&itemName=&month=&week=
//
//  Phase 3: Menggunakan Metric Engine (src/lib/metrics) sebagai
//  single source of truth untuk Z-Score, deterioration, priority.
//
//  Returns:
//  1. Timeline: all periods for this outlet+item (qtyBom, qtyDeviasi, devBom, direction, nominal, W/S/T, residual)
//  2. Benchmark per period: area avg devBom for this item, network avg devBom for this item
//  3. Summary: deterioration/improvement, zScore, priority
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getRuntimeThresholds } from '@/lib/settings';
import {
  computeZScore,
  computeDeterioration,
  computePriority,
  type HistoricalInput,
  type PriorityInput,
} from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

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

    // ============================================================
    //  Load runtime thresholds (Settings-driven)
    // ============================================================
    const thresholds = await getRuntimeThresholds();

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
    //  BUG 6.6 fix: NO silent fallback to last available period.
    //  If user-specified period is not in timeline, return 404 with
    //  the list of available periods — do NOT substitute the last period.
    // ============================================================
    const currentPeriod = timeline.find(t => t.isCurrent);
    if (!currentPeriod) {
      const available = timeline.map(t => `${t.weekLabel} ${t.monthLabel}`).join(', ');
      return NextResponse.json({
        success: false,
        error: `No record for ${itemName} at ${outletCode} in ${currentMonth || '?'} ${currentWeek || '?'}. Available periods: ${available}`,
        availablePeriods: timeline.map(t => ({ monthLabel: t.monthLabel, weekLabel: t.weekLabel })),
      }, { status: 404 });
    }
    const currentDevBom = currentPeriod.devBom;

    // ============================================================
    //  Benchmark: area + network avg devBom for THIS ITEM per period
    //  NOTE: This is AVG(ABS(pctQtyDeviasiToBom)) — the AVERAGE OF PER-ROW
    //  Dev/BOM ratios across outlets for the same item. This is CORRECT for
    //  item-level benchmarking (each outlet = 1 equal observation for the same
    //  item). This is DIFFERENT from DevBomAggregate (SUM/SUM) used for
    //  outlet-level Dev/BOM. Do not confuse the two.
    //  Field name "avgDevBom" = avgRowDevBom (per-row ratio average).
    // ============================================================
    const [areaBench, networkBench] = await Promise.all([
      db.$queryRaw<Array<{ avgDevBom: number; outletCount: number }>>`
        SELECT
          COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
          CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE i.name = ${itemName}
          AND ir.area = ${outlet.area}
          AND ir."monthLabel" = ${currentPeriod.monthLabel}
          AND ir."weekLabel" = ${currentPeriod.weekLabel}
      `,
      db.$queryRaw<Array<{ avgDevBom: number; outletCount: number; bestDevBom: number | null }>>`
        SELECT
          COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
          CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
          MIN(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL) as "bestDevBom"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE i.name = ${itemName}
          AND ir."monthLabel" = ${currentPeriod.monthLabel}
          AND ir."weekLabel" = ${currentPeriod.weekLabel}
      `,
    ]);

    // ============================================================
    //  Historical stats (Z-Score) via Metric Engine
    //  Phase 3: use computeZScore — handles ABS, sample variance,
    //  exclude current (caller passes historicalValues WITHOUT current),
    //  min weeks guard, trend, benchmarkFlag, warningLevel.
    //  BUG 6.7 fix: exclude current period from historical baseline.
    // ============================================================
    const historicalValues = timeline
      .filter(t => t.devBom != null && !t.isCurrent)
      .map(t => t.devBom as number);

    const historicalInput: HistoricalInput = {
      currentValue: currentDevBom,
      historicalValues,
      thresholds: {
        HISTORICAL_MIN_WEEKS: thresholds.HISTORICAL_MIN_WEEKS,
        HISTORICAL_ZSCORE_WARN: thresholds.HISTORICAL_ZSCORE_WARN,
        HISTORICAL_ZSCORE_HIGH: thresholds.HISTORICAL_ZSCORE_HIGH,
      },
    };
    const historicalResult = computeZScore(historicalInput);

    // Trend: compare current vs earliest via Metric Engine
    const earliestDevBom = timeline[0]?.devBom ?? null;
    const deterioration = computeDeterioration(currentDevBom, earliestDevBom);
    const trend = deterioration != null
      ? deterioration > 0.02 ? 'DETERIORATING' : deterioration < -0.02 ? 'IMPROVING' : 'STABLE'
      : historicalResult.trend === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA'
      : 'STABLE';

    // Metric Engine: priority (Settings-driven, no hardcoded 1M/0.10/0.50/2.0)
    const priorityThresholds: PriorityInput['thresholds'] = {
      HIGH_LOSS_NOMINAL_THRESHOLD: thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
      P2_NOMINAL_THRESHOLD: thresholds.P2_NOMINAL_THRESHOLD,
      STD_DEVIASI_BOM_PCT: thresholds.STD_DEVIASI_BOM_PCT,
      RESIDUAL_LOSS_WARN_PCT: thresholds.RESIDUAL_LOSS_WARN_PCT,
      RESIDUAL_LOSS_HIGH_PCT: thresholds.RESIDUAL_LOSS_HIGH_PCT,
      HISTORICAL_ZSCORE_HIGH: thresholds.HISTORICAL_ZSCORE_HIGH,
    };
    const priority = computePriority({
      absNominalLossSurplus: currentPeriod.absNominalLossSurplus,
      devBom: currentDevBom,
      residualRatio: currentPeriod.residualRatio,
      zScore: historicalResult.zScore,
      isOverExplained: (() => {
        const explained = currentPeriod.qtyWaste + currentPeriod.qtySusut + currentPeriod.qtyTrial;
        const absDev = Math.abs(currentPeriod.qtyDeviasi ?? 0);
        return absDev > 0 && explained > absDev;
      })(),
      thresholds: priorityThresholds,
    });

    // Area/network multiplier (item-level: simple ratio)
    const areaAvgDevBom = toNum(areaBench[0]?.avgDevBom) ?? 0;
    const networkAvgDevBom = toNum(networkBench[0]?.avgDevBom) ?? 0;
    const areaOutletCount = toNum(areaBench[0]?.outletCount) ?? 0;
    const networkOutletCount = toNum(networkBench[0]?.outletCount) ?? 0;
    const bestDevBom = toNum(networkBench[0]?.bestDevBom);
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
        bestDevBom,
        areaMultiplier,
        networkMultiplier,
        areaOutletCount,
        networkOutletCount,
      },
      historical: {
        mean: historicalResult.mean,
        stdDev: historicalResult.stdDev,
        zScore: historicalResult.zScore,
        sampleSize: historicalResult.sampleSize,
        earliestDevBom,
        currentDevBom,
        deterioration,
        trend,
        warningLevel: historicalResult.warningLevel,
        benchmarkFlag: historicalResult.benchmarkFlag,
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
