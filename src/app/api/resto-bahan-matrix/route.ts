// ============================================================
//  /api/resto-bahan-matrix — Top worst outlet+item combos
//  Query: ?month=&week=&area=&limit=50&priority=P1
//
//  Phase 3: Menggunakan Metric Engine (src/lib/metrics) untuk
//  priority computation (Settings-driven thresholds).
//
//  Returns cross-tabulation of outlet × item with:
//  Dev/BOM, Historical trend, Area benchmark, Residual, Priority
//  Sorted by priority (P1 first) then by absNominalLossSurplus DESC
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getRuntimeThresholds } from '@/lib/settings';
import {
  computePriority,
  type PriorityInput,
} from '@/lib/metrics';
import { calcGrowthAbs } from '@/lib/metrics';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { withStatementTimeout } from '@/lib/queries/shared';

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
    const rl = rateLimit(`resto-matrix:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    // FIX-DEEP-1: `let` so resolveMonthLabel can reassign to actual DB case.
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const priorityFilter = url.searchParams.get('priority'); // P1, P2, P3, or null for all
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // FIX-DEEP-1 (DEEP-AUDIT-API-2): Resolve monthLabel case to actual DB case.
    // DB may have "AGUSTUS 2026" (upload-data.ts) or "Agustus 2026" (dashboard import).
    // Without this, raw SQL `WHERE ir."monthLabel" = ${month}` returns 0 rows on
    // case mismatch → "Tidak ada data sesuai filter" + currentIdx -1 → trend "?".
    const monthResolver = await getMonthResolver();
    month = resolveMonthLabel(month, monthResolver) || month;

    // ============================================================
    //  Load runtime thresholds (Settings-driven)
    // ============================================================
    const thresholds = await getRuntimeThresholds();
    const priorityThresholds: PriorityInput['thresholds'] = {
      HIGH_LOSS_NOMINAL_THRESHOLD: thresholds.HIGH_LOSS_NOMINAL_THRESHOLD,
      P2_NOMINAL_THRESHOLD: thresholds.P2_NOMINAL_THRESHOLD,
      STD_DEVIASI_BOM_PCT: thresholds.STD_DEVIASI_BOM_PCT,
      RESIDUAL_LOSS_WARN_PCT: thresholds.RESIDUAL_LOSS_WARN_PCT,
      RESIDUAL_LOSS_HIGH_PCT: thresholds.RESIDUAL_LOSS_HIGH_PCT,
      HISTORICAL_ZSCORE_HIGH: thresholds.HISTORICAL_ZSCORE_HIGH,
    };

    // Build area filter using parameterized query (not string interpolation)
    const areaCondition = area && area !== 'all'
      ? Prisma.sql`AND ir.area = ${area}`
      : Prisma.empty;

    // ============================================================
    //  Get all outlet+item combos with deviation for this period.
    //  FIX (BUG-1-6): Added GROUP BY (outletId, itemId, akunPenyesuaian) with
    //    SUM/MAX aggregates so multi-akun items don't produce duplicate rows
    //    when multiple source files contribute records for the same week.
    //  FIX (BUG-1-5): Added ir."akunPenyesuaian" to SELECT so the prev lookup
    //    can be keyed by (outletCode, itemName, akunPenyesuaian).
    // ============================================================
    // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
    const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
      outletCode: string; outletName: string; area: string;
      itemName: string; satuan: string | null; akunPenyesuaian: string | null;
      qtyBom: number | null; qtyDeviasi: number | null;
      pctQtyDeviasiToBom: number | null;
      nominalLossSurplus: number | null; absNominalLossSurplus: number | null;
      direction: string | null;
      qtyWaste: number | null; qtySusut: number | null; qtyTrial: number | null;
      residualRatio: number | null;
      tolerancePct: number | null;
    }>>`
      SELECT
        o.code as "outletCode", o.name as "outletName", ir.area,
        i.name as "itemName", i.satuan, ir."akunPenyesuaian",
        SUM(ir."qtyBom") as "qtyBom", SUM(ir."qtyDeviasi") as "qtyDeviasi",
        MAX(ir."pctQtyDeviasiToBom") as "pctQtyDeviasiToBom",
        SUM(ir."nominalLossSurplus") as "nominalLossSurplus",
        SUM(ir."absNominalLossSurplus") as "absNominalLossSurplus",
        MAX(ir.direction) as "direction",
        SUM(ir."qtyWaste") as "qtyWaste", SUM(ir."qtySusut") as "qtySusut", SUM(ir."qtyTrial") as "qtyTrial",
        MAX(ir."residualRatio") as "residualRatio",
        MAX(ir."tolerancePct") as "tolerancePct"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
        AND ir."absNominalLossSurplus" IS NOT NULL
        AND ir."absNominalLossSurplus" > 0
        ${areaCondition}
      GROUP BY ir."outletId", o.code, o.name, ir.area, ir."itemId", i.name, i.satuan, ir."akunPenyesuaian"
      ORDER BY SUM(ir."absNominalLossSurplus") DESC
      LIMIT ${limit * 3}
    `);

    // ============================================================
    //  Get area avg devBom per item for benchmark
    //  NOTE: This is AVG(ABS(pctQtyDeviasiToBom)) — the AVERAGE OF PER-ROW
    //  Dev/BOM ratios across outlets for the same item. This is CORRECT for
    //  item-level benchmarking (each outlet = 1 equal observation for the same
    //  item). This is DIFFERENT from DevBomAggregate (SUM/SUM) used for
    //  outlet-level Dev/BOM. Field name "avgDevBom" = avgRowDevBom.
    // ============================================================
    // ============================================================
    //  FIX (BUG-1-2): Replaced PostgreSQL-specific `AVG(...) FILTER (WHERE ...)`
    //  with portable `AVG(CASE WHEN ... THEN ... END)`. AVG ignores NULLs
    //  naturally, so CASE-THEN-NULL reproduces FILTER semantics.
    // ============================================================
    // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
    const itemAreaBench = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
      itemName: string; avgDevBom: number; outletCount: number;
    }>>`
      SELECT i.name as "itemName",
        COALESCE(AVG(CASE WHEN ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL THEN ABS(ir."pctQtyDeviasiToBom") END), 0) as "avgDevBom",
        CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
      GROUP BY i.name
    `);
    const benchMap = new Map(itemAreaBench.map(b => [b.itemName, { avgDevBom: Number(b.avgDevBom), outletCount: Number(b.outletCount) }]));

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
    // FIX (BUG 4): Same-weekLabel in previous month (cumulative weeks).
    // Was: chronological previous (W4→W2 same month = false positive trend).
    let prevPeriod: { monthLabel: string; weekLabel: string } | null = null;
    if (currentIdx >= 0) {
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (allPeriods[i].weekLabel === week && allPeriods[i].monthLabel !== month) {
          prevPeriod = allPeriods[i];
          break;
        }
      }
      if (!prevPeriod && currentIdx > 0) prevPeriod = allPeriods[currentIdx - 1];
    }

    // ============================================================
    //  Get previous period devBom per outlet+item.
    //  FIX (BUG-1-5): Added ir."akunPenyesuaian" to SELECT and GROUP BY,
    //    and include akunPenyesuaian in the prevDevBomMap key. Multi-akun
    //    items no longer get the LAST row's prev value — they get the
    //    matching-akun value (or null).
    // ============================================================
    let prevDevBomMap = new Map<string, number | null>();
    if (prevPeriod) {
      // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
      const prevRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string; itemName: string; akunPenyesuaian: string | null; pctDevBom: number | null }>>`
        SELECT o.code as "outletCode", i.name as "itemName", ir."akunPenyesuaian",
          MAX(ir."pctQtyDeviasiToBom") as "pctDevBom"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE ir."monthLabel" = ${prevPeriod.monthLabel}
          AND ir."weekLabel" = ${prevPeriod.weekLabel}
        GROUP BY o.code, i.name, ir."akunPenyesuaian"
      `);
      prevDevBomMap = new Map(prevRows.map(r => [`${r.outletCode}|${r.itemName}|${r.akunPenyesuaian ?? ''}`, r.pctDevBom != null ? Number(r.pctDevBom) : null]));
    }

    // ============================================================
    //  Build matrix rows with priority + historical + benchmark
    //  Phase 3: Priority via Metric Engine (Settings-driven thresholds,
    //  no hardcoded 1_000_000 / 0.10 / 0.50)
    // ============================================================
    const matrix = rows.map(r => {
      const devBom = toNum(r.pctQtyDeviasiToBom);
      const absNominal = toNum(r.absNominalLossSurplus) ?? 0;
      const residualRatio = toNum(r.residualRatio);
      const bench = benchMap.get(r.itemName);
      const areaAvgDevBom = bench?.avgDevBom ?? 0;
      const areaOutletCount = bench?.outletCount ?? 0;
      const areaMultiplier = areaAvgDevBom > 0 && devBom != null ? Math.abs(devBom) / areaAvgDevBom : null;

      // Historical trend — Phase 3: calcGrowthAbs from Metric Engine
      // (Magnitude growth for Dev/BOM — direction is always positive when comparing |.|)
      // FIX (BUG-1-5): Lookup key now includes akunPenyesuaian so multi-akun
      //   items get the matching-akun prev value instead of the last row's.
      const prevDevBom = prevDevBomMap.get(`${r.outletCode}|${r.itemName}|${r.akunPenyesuaian ?? ''}`) ?? null;
      const devBomGrowth = calcGrowthAbs(devBom, prevDevBom);
      const historicalTrend = devBomGrowth != null
        ? devBomGrowth > 0.1 ? '↑' : devBomGrowth < -0.1 ? '↓' : '→'
        : '?';

      // Over-explained check
      const isOverExplained = (() => {
        const explained = Math.abs((toNum(r.qtyWaste) ?? 0) + (toNum(r.qtySusut) ?? 0) + (toNum(r.qtyTrial) ?? 0));
        const absDev = Math.abs(toNum(r.qtyDeviasi) ?? 0);
        return absDev > 0 && explained > absDev;
      })();

      // Metric Engine: priority (Settings-driven)
      const priority = computePriority({
        absNominalLossSurplus: absNominal,
        devBom,
        residualRatio,
        zScore: null, // zScore not computed at matrix level (item-history route handles per-item zScore)
        isOverExplained,
        thresholds: priorityThresholds,
      });

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
        devBomGrowth: devBomGrowth,
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
