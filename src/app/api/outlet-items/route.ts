// ============================================================
//  /api/outlet-items — Resto Analysis (Level 3+4)
//  Query: ?outletCode=&month=&week=&compareWeek=&compareMonth=
//
//  Phase 3: Menggunakan Metric Engine (src/lib/metrics) sebagai
//  single source of truth untuk semua perhitungan metric.
//
//  Returns:
//  1. Resto Profile (6 sections: Performance, Behavior, Historical, Benchmark, TopRisk, Investigation)
//  2. Bahan Analysis (3 rankings: Financial, Operational, Unexplained)
//  3. Per-item breakdown: BOM, Deviasi, Dev/BOM, Nominal, Direction, W/S/T, Residual
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getRuntimeThresholds, type RuntimeThresholds } from '@/lib/settings';
import {
  computeSalesModePerOutlet,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeExplainedPctAggregate,
  computeLossToSales,
  computeHealthScore,
  computePriority,
  type AggregateInput,
  type PriorityInput,
} from '@/lib/metrics';
import {
  calcGrowth,
  calcGrowthAbs,
  computeGrowthResult,
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
    const rl = rateLimit(`outlet-items:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    const month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const compareWeek = url.searchParams.get('compareWeek');
    const compareMonth = url.searchParams.get('compareMonth');

    if (!outletCode || !month || !week) {
      return NextResponse.json({ success: false, error: 'outletCode, month, week required' }, { status: 400 });
    }

    // ============================================================
    //  Load runtime thresholds (Settings-driven, no hardcoding)
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

    // Determine previous period
    let prevWeek = compareWeek;
    let prevMonth = compareMonth || month;
    if (!prevWeek) {
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
      if (currentIdx > 0) {
        prevWeek = allPeriods[currentIdx - 1].weekLabel;
        prevMonth = allPeriods[currentIdx - 1].monthLabel;
      }
    }

    // ============================================================
    //  PARALLEL: current records + prev records + area/network benchmarks
    //  Phase 3: area/network benchmark uses SUM(ABS)/SUM(ABS) — same
    //  formula as computeDevBomAggregate, matching outletDevBom.
    //  (was: AVG(ABS(pctQtyDeviasiToBom)) — mathematically different)
    // ============================================================
    const [currentRecs, prevRecs, areaBench, networkBench, outletPIC] = await Promise.all([
      // Current period records for this outlet
      db.$queryRaw<Array<{
        itemId: number; itemName: string; satuan: string | null;
        qtyBom: number | null; qtyCom: number | null; qtyDeviasi: number | null;
        qtyWaste: number | null; qtySusut: number | null; qtyTrial: number | null;
        qtyLossSurplus: number | null;
        nominalDeviasi: number | null; nominalWaste: number | null; nominalSusut: number | null;
        nominalTrial: number | null; nominalLossSurplus: number | null; nominalSales: number | null;
        avgPrice: number | null; tolerancePct: number | null;
        pctQtyDeviasiToBom: number | null;
        direction: string | null;
        residualQty: number | null; residualNominal: number | null; residualRatio: number | null;
        absQtyDeviasi: number | null; absNominalDeviasi: number | null;
        absQtyLossSurplus: number | null; absNominalLossSurplus: number | null;
      }>>`
        SELECT ir."itemId", i.name as "itemName", i.satuan,
          ir."qtyBom", ir."qtyCom", ir."qtyDeviasi",
          ir."qtyWaste", ir."qtySusut", ir."qtyTrial", ir."qtyLossSurplus",
          ir."nominalDeviasi", ir."nominalWaste", ir."nominalSusut",
          ir."nominalTrial", ir."nominalLossSurplus", ir."nominalSales",
          ir."avgPrice", ir."tolerancePct",
          ir."pctQtyDeviasiToBom", ir.direction,
          ir."residualQty", ir."residualNominal", ir."residualRatio",
          ir."absQtyDeviasi", ir."absNominalDeviasi",
          ir."absQtyLossSurplus", ir."absNominalLossSurplus"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `,
      // Previous period records
      prevWeek ? db.$queryRaw<Array<{ itemId: number; qtyDeviasi: number | null; nominalDeviasi: number | null; qtyBom: number | null; pctQtyDeviasiToBom: number | null; nominalSales: number | null }>>`
        SELECT ir."itemId", ir."qtyDeviasi", ir."nominalDeviasi", ir."qtyBom", ir."pctQtyDeviasiToBom", ir."nominalSales"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${prevMonth}
          AND ir."weekLabel" = ${prevWeek}
      ` : Promise.resolve([]),
      // Area benchmark — Phase 3: SUM(ABS)/SUM(ABS) matching computeDevBomAggregate
      db.$queryRaw<Array<{ avgDevBom: number; lossToSales: number | null }>>`
        SELECT
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "avgDevBom",
          NULL as "lossToSales"
        FROM "InventoryRecord" ir
        WHERE ir.area = ${outlet.area}
          AND ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `,
      // Network benchmark — Phase 3: SUM(ABS)/SUM(ABS)
      db.$queryRaw<Array<{ avgDevBom: number }>>`
        SELECT
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "avgDevBom"
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `,
      // PIC
      db.outletPIC.findUnique({ where: { outletCode: outlet.code } }).catch(() => null),
    ]);

    // ============================================================
    //  RESTO PROFILE — 6 sections
    //  Phase 3: All metrics via Metric Engine
    // ============================================================

    // Sales via MODE (Metric Engine: computeSalesModePerOutlet)
    // Tie-break: smaller value wins (consistent SQL + JS)
    const currentSalesMap = computeSalesModePerOutlet(
      currentRecs.map(r => ({ outletId: outlet.id, nominalSales: toNum(r.nominalSales) }))
    );
    const bestSales = currentSalesMap.get(outlet.id) ?? 0;

    // Aggregate metrics — build AggregateInput for Metric Engine
    let totalQtyBom = 0, totalQtyDeviasi = 0, totalNominalDeviasi = 0;
    let totalQtyWaste = 0, totalQtySusut = 0, totalQtyTrial = 0;
    let totalQtyLossSurplus = 0, totalNominalLossSurplus = 0;
    let totalResidualQty = 0, totalAbsNominalLossSurplus = 0;
    let totalLossNominal = 0, totalSurplusNominal = 0;
    let normalCount = 0, warningCount = 0, abnormalCount = 0;

    for (const r of currentRecs) {
      const qb = toNum(r.qtyBom) ?? 0;
      const qd = toNum(r.qtyDeviasi) ?? 0;
      const nd = toNum(r.nominalDeviasi) ?? 0;
      const qls = toNum(r.qtyLossSurplus) ?? 0;
      const nls = toNum(r.nominalLossSurplus) ?? 0;
      const anls = toNum(r.absNominalLossSurplus) ?? 0;

      totalQtyBom += Math.abs(qb);
      totalQtyDeviasi += Math.abs(qd);
      totalNominalDeviasi += Math.abs(nd);
      totalQtyWaste += Math.abs(toNum(r.qtyWaste) ?? 0);
      totalQtySusut += Math.abs(toNum(r.qtySusut) ?? 0);
      totalQtyTrial += Math.abs(toNum(r.qtyTrial) ?? 0);
      totalQtyLossSurplus += Math.abs(qls);
      totalNominalLossSurplus += nls;
      totalAbsNominalLossSurplus += anls;
      totalResidualQty += Math.abs(toNum(r.residualQty) ?? 0);

      if (nls > 0) totalLossNominal += nls;
      else if (nls < 0) totalSurplusNominal += Math.abs(nls);

      // Count severity
      if (qd === 0 || Math.abs(qd) < 0.01) normalCount++;
      else if (Math.abs(toNum(r.pctQtyDeviasiToBom) ?? 0) > (toNum(r.tolerancePct) ?? thresholds.FALLBACK_TOLERANCE_PCT)) abnormalCount++;
      else warningCount++;
    }

    const aggregateInput: AggregateInput = {
      totalQtyDeviasi,
      totalQtyBom,
      totalQtyWaste,
      totalQtySusut,
      totalQtyTrial,
      totalResidualQty,
      totalLossNominal,
      totalSales: bestSales,
      normalCount,
      warningCount,
      abnormalCount,
    };

    // Previous period aggregates
    let prevQtyBom = 0, prevQtyDeviasi = 0, prevNominalDeviasi = 0;
    const prevByItemId = new Map<number, { qtyDeviasi: number; nominalDeviasi: number; qtyBom: number; pctDevBom: number | null }>();
    for (const r of prevRecs) {
      const qd = toNum(r.qtyDeviasi) ?? 0;
      const nd = toNum(r.nominalDeviasi) ?? 0;
      const qb = toNum(r.qtyBom) ?? 0;
      const pdb = toNum(r.pctQtyDeviasiToBom);
      prevQtyBom += Math.abs(qb);
      prevQtyDeviasi += Math.abs(qd);
      prevNominalDeviasi += Math.abs(nd);
      prevByItemId.set(r.itemId, { qtyDeviasi: qd, nominalDeviasi: nd, qtyBom: qb, pctDevBom: pdb });
    }
    // Previous sales via Metric Engine MODE
    const prevSalesMap = computeSalesModePerOutlet(
      prevRecs
        .filter((r): r is typeof r & { nominalSales: number | null } => true)
        .map(r => ({ outletId: outlet.id, nominalSales: toNum(r.nominalSales) }))
    );
    const prevBestSales = prevSalesMap.get(outlet.id) ?? 0;

    // Metric Engine: aggregate metrics
    const devBomAggregate = computeDevBomAggregate(aggregateInput);
    const residualPctAggregate = computeResidualPctAggregate(aggregateInput);
    const explainedPctAggregate = computeExplainedPctAggregate(aggregateInput);
    const lossToSales = computeLossToSales(aggregateInput);
    const healthScore = computeHealthScore(aggregateInput);

    // Metric Engine: growth
    const salesGrowth = calcGrowth(bestSales, prevBestSales);
    const qtyBomGrowth = calcGrowthAbs(totalQtyBom, prevQtyBom); // BOM is consumption, use abs growth
    const qtyDeviasiGrowth = calcGrowth(totalQtyDeviasi, prevQtyDeviasi);
    const nominalDeviasiGrowth = calcGrowth(totalNominalDeviasi, prevNominalDeviasi);

    // Metric Engine: growth result (with direction flip + trend)
    const devGrowthResult = computeGrowthResult(totalQtyDeviasi, prevQtyDeviasi, 0.1);

    const restoProfile = {
      // 1. Performance
      performance: {
        sales: bestSales,
        salesGrowth,
        qtyBom: totalQtyBom,
        qtyBomGrowth,
        qtyDeviasi: totalQtyDeviasi,
        qtyDeviasiGrowth,
        nominalDeviasi: totalNominalDeviasi,
        nominalDeviasiGrowth,
        nominalLossSurplus: totalNominalLossSurplus,
        devBom: devBomAggregate,
        lossToSales,
      },
      // 2. Behavior
      behavior: {
        lossNominal: totalLossNominal,
        surplusNominal: totalSurplusNominal,
        lossPct: totalAbsNominalLossSurplus > 0 ? totalLossNominal / totalAbsNominalLossSurplus : null,
        surplusPct: totalAbsNominalLossSurplus > 0 ? totalSurplusNominal / totalAbsNominalLossSurplus : null,
        qtyWaste: totalQtyWaste,
        qtySusut: totalQtySusut,
        qtyTrial: totalQtyTrial,
        qtyLossSurplus: totalQtyLossSurplus,
        residualQty: totalResidualQty,
        residualPct: residualPctAggregate,
        explainedPct: explainedPctAggregate,
      },
      // 3. Historical (current vs previous)
      historical: {
        prevQtyBom: prevQtyBom,
        prevQtyDeviasi: prevQtyDeviasi,
        prevNominalDeviasi: prevNominalDeviasi,
        bomGrowth: qtyBomGrowth,
        deviasiGrowth: qtyDeviasiGrowth,
        nominalGrowth: nominalDeviasiGrowth,
        trend: devGrowthResult.trend === 'INCREASING' ? 'DETERIORATING'
          : devGrowthResult.trend === 'DECREASING' ? 'IMPROVING'
          : devGrowthResult.trend === 'NEW' ? 'DETERIORATING'  // onset from zero base
          : devGrowthResult.trend === 'RESOLVED' ? 'IMPROVING'
          : 'STABLE',
      },
      // 4. Benchmark — Metric Engine: computeBenchmark
      //  Phase 3: outletDevBom and areaAvgDevBom both use SUM(ABS)/SUM(ABS)
      //  (was: outletDevBom = SUM/SUM, areaAvgDevBom = AVG(ABS) — mismatch)
      benchmark: (() => {
        const areaAvgDevBom = toNum(areaBench[0]?.avgDevBom) ?? 0;
        const networkAvgDevBom = toNum(networkBench[0]?.avgDevBom) ?? 0;
        // Map trend to "ABOVE_NETWORK" / "ABOVE_AREA" / "NORMAL" using Settings factors
        const areaMultiplier = areaAvgDevBom > 0 ? devBomAggregate / areaAvgDevBom : null;
        const networkMultiplier = networkAvgDevBom > 0 ? devBomAggregate / networkAvgDevBom : null;
        const isAboveNetwork = networkMultiplier != null && networkMultiplier > thresholds.BENCHMARK_NETWORK_FACTOR;
        const isAboveArea = !isAboveNetwork && areaMultiplier != null && areaMultiplier > thresholds.BENCHMARK_AREA_FACTOR;
        const status = isAboveNetwork ? 'ABOVE_NETWORK' : isAboveArea ? 'ABOVE_AREA' : 'NORMAL';
        return {
          areaAvgDevBom,
          networkAvgDevBom,
          outletDevBom: devBomAggregate,
          areaMultiplier,
          networkMultiplier,
          isAboveArea,
          isAboveNetwork,
          status,
        };
      })(),
      // 5. Top Risk (top 5 per category)
      topRisk: {
        byNominal: [...currentRecs]
          .sort((a, b) => (toNum(b.absNominalLossSurplus) ?? 0) - (toNum(a.absNominalLossSurplus) ?? 0))
          .slice(0, 5)
          .map(r => ({ itemName: r.itemName, value: toNum(r.absNominalLossSurplus) ?? 0, direction: r.direction || 'NEUTRAL' })),
        byDevBom: [...currentRecs]
          .sort((a, b) => Math.abs(toNum(b.pctQtyDeviasiToBom) ?? 0) - Math.abs(toNum(a.pctQtyDeviasiToBom) ?? 0))
          .slice(0, 5)
          .map(r => ({ itemName: r.itemName, value: toNum(r.pctQtyDeviasiToBom) ?? 0 })),
        byResidual: [...currentRecs]
          .sort((a, b) => (toNum(b.residualRatio) ?? 0) - (toNum(a.residualRatio) ?? 0))
          .slice(0, 5)
          .map(r => ({ itemName: r.itemName, value: toNum(r.residualRatio) ?? 0 })),
      },
      // 6. Investigation counts + health score (Metric Engine)
      investigation: {
        normal: normalCount,
        warning: warningCount,
        abnormal: abnormalCount,
        total: normalCount + warningCount + abnormalCount,
        healthScore,
      },
    };

    // ============================================================
    //  BAHAN ANALYSIS — 3 rankings + per-item breakdown
    //  Phase 3: Priority via Metric Engine (Settings-driven thresholds)
    // ============================================================
    const priorityThresholds: PriorityInput['thresholds'] = {
      HIGH_LOSS_NOMINAL_THRESHOLD: thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
      P2_NOMINAL_THRESHOLD: thresholds.P2_NOMINAL_THRESHOLD,
      STD_DEVIASI_BOM_PCT: thresholds.STD_DEVIASI_BOM_PCT,
      RESIDUAL_LOSS_WARN_PCT: thresholds.RESIDUAL_LOSS_WARN_PCT,
      RESIDUAL_LOSS_HIGH_PCT: thresholds.RESIDUAL_LOSS_HIGH_PCT,
      HISTORICAL_ZSCORE_HIGH: thresholds.HISTORICAL_ZSCORE_HIGH,
    };

    const itemBreakdown = currentRecs.map(r => {
      const itemId = r.itemId;
      const prev = prevByItemId.get(itemId);
      const qtyBom = toNum(r.qtyBom);
      const qtyDeviasi = toNum(r.qtyDeviasi);
      const pctDevBom = toNum(r.pctQtyDeviasiToBom);
      const nominalLS = toNum(r.nominalLossSurplus);
      const absNominalLS = toNum(r.absNominalLossSurplus) ?? 0;
      const residualRatio = toNum(r.residualRatio);
      const areaAvgDevBom = toNum(areaBench[0]?.avgDevBom) ?? 0;
      const networkAvgDevBom = toNum(networkBench[0]?.avgDevBom) ?? 0;

      // Over-explained check (inline; same logic as computeResidual)
      const isOverExplained = (() => {
        const explained = Math.abs((toNum(r.qtyWaste) ?? 0) + (toNum(r.qtySusut) ?? 0) + (toNum(r.qtyTrial) ?? 0));
        const absDev = Math.abs(toNum(r.qtyDeviasi) ?? 0);
        return absDev > 0 && explained > absDev;
      })();

      // Dev/BOM growth vs previous (Magnitude — use calcGrowthAbs)
      const prevPctDevBom = prev?.pctDevBom ?? null;
      const devBomGrowth = calcGrowthAbs(pctDevBom, prevPctDevBom);

      // Historical trend indicator
      const historicalTrend = devBomGrowth != null
        ? devBomGrowth > 0.1 ? '↑' : devBomGrowth < -0.1 ? '↓' : '→'
        : '?';

      // Area multiplier for this item (item-level: simple ratio of per-row devBom vs area avg)
      const areaMultiplier = areaAvgDevBom > 0 && pctDevBom != null
        ? Math.abs(pctDevBom) / areaAvgDevBom
        : null;

      // Metric Engine: priority (Settings-driven thresholds, no hardcoding)
      const priority = computePriority({
        absNominalLossSurplus: absNominalLS,
        devBom: pctDevBom,
        residualRatio,
        zScore: null, // zScore not computed at item level here (item-history route handles that)
        isOverExplained,
        thresholds: priorityThresholds,
      });

      return {
        itemId,
        itemName: r.itemName,
        satuan: r.satuan,
        qtyBom: Math.abs(qtyBom ?? 0),
        qtyCom: toNum(r.qtyCom),
        qtyDeviasi: qtyDeviasi,
        qtyWaste: Math.abs(toNum(r.qtyWaste) ?? 0),
        qtySusut: Math.abs(toNum(r.qtySusut) ?? 0),
        qtyTrial: Math.abs(toNum(r.qtyTrial) ?? 0),
        qtyLossSurplus: toNum(r.qtyLossSurplus),
        nominalDeviasi: toNum(r.nominalDeviasi),
        nominalLossSurplus: nominalLS,
        absNominalLossSurplus: absNominalLS,
        avgPrice: toNum(r.avgPrice),
        tolerancePct: toNum(r.tolerancePct),
        devBom: pctDevBom,
        direction: r.direction || 'NEUTRAL',
        residualQty: toNum(r.residualQty),
        residualRatio: residualRatio,
        isOverExplained,
        // Historical
        prevQtyDeviasi: prev?.qtyDeviasi ?? null,
        prevPctDevBom: prevPctDevBom,
        devBomGrowth: devBomGrowth,
        historicalTrend: historicalTrend as '↑' | '↓' | '→' | '?',
        // Benchmark
        areaAvgDevBom: areaAvgDevBom,
        networkAvgDevBom: networkAvgDevBom,
        areaMultiplier: areaMultiplier,
        // Priority
        priority,
      };
    });

    // 3 Rankings
    const rankings = {
      // A. Financial Impact
      financial: [...itemBreakdown]
        .sort((a, b) => b.absNominalLossSurplus - a.absNominalLossSurplus)
        .slice(0, 20)
        .map((r, i) => ({ rank: i + 1, ...r })),
      // B. Operational (Dev/BOM)
      operational: [...itemBreakdown]
        .sort((a, b) => Math.abs(b.devBom ?? 0) - Math.abs(a.devBom ?? 0))
        .slice(0, 20)
        .map((r, i) => ({ rank: i + 1, ...r })),
      // C. Unexplained (Residual Ratio)
      unexplained: [...itemBreakdown]
        .sort((a, b) => (b.residualRatio ?? 0) - (a.residualRatio ?? 0))
        .slice(0, 20)
        .map((r, i) => ({ rank: i + 1, ...r })),
    };

    return NextResponse.json({
      success: true,
      outlet: {
        code: outlet.code,
        name: outlet.name,
        area: outlet.area,
        pic: outletPIC?.pic ?? null,
      },
      period: { month, week, prevWeek, prevMonth },
      restoProfile,
      rankings,
      allItems: itemBreakdown,
      itemCount: currentRecs.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: any) {
    console.error('[outlet-items] error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
