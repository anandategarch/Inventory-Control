// ============================================================
//  /api/outlet-focus — Outlet Focus Mode
//  Deep anomaly analysis for ONE outlet
//  Query: ?outletCode=1030.BDGSET&month=MEI 2026&week=WEEK 1
//
//  Returns comprehensive JSON:
//    - outlet summary (health, sales, devBom, residual, etc.)
//    - timeline (multi-week)
//    - itemAnomalies (per-item issue list)
//    - wasteAnalysis (W/S/T/Residual breakdown + over-explained + high residual)
//    - menuAnalysis (group by prefix → outlier detection)
//    - dqIssues (data quality issues for this outlet)
//    - benchmarks (area + network averages)
//    - newItems / disappearedItems / directionReversals
//    - worklist (P1/P2/P3 with evidence + recommended action)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { analysisCache } from '@/lib/cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getRuntimeThresholds, getThresholdsVersion } from '@/lib/settings';
import { calcGrowth, calcZScore } from '@/engine/calculations/growth';

export const dynamic = 'force-dynamic';

// ============================================================
//  Types
// ============================================================
interface OutletFocusRow {
  // current period records (joined with Item + Outlet)
  id: number;
  itemId: number;
  itemName: string;
  satuan: string | null;
  qtyBom: number | null;
  qtyCom: number | null;
  qtyDeviasi: number | null;
  qtyWaste: number | null;
  qtySusut: number | null;
  qtyTrial: number | null;
  qtyLossSurplus: number | null;
  nominalDeviasi: number | null;
  nominalWaste: number | null;
  nominalSusut: number | null;
  nominalTrial: number | null;
  nominalLossSurplus: number | null;
  nominalSales: number | null;
  avgPrice: number | null;
  tolerancePct: number | null;
  toleranceRaw: string | null;
  pctQtyDeviasiToBom: number | null;
  direction: string | null;
  residualQty: number | null;
  residualNominal: number | null;
  residualRatio: number | null;
  absQtyDeviasi: number | null;
  absNominalDeviasi: number | null;
  absQtyLossSurplus: number | null;
  absNominalLossSurplus: number | null;
  area: string;
  bulan: string;
  monthLabel: string;
  weekLabel: string;
  akunPenyesuaian: string | null;
  rowNumber: number | null;
  outletCode: string;
  outletName: string;
}

interface ItemAnomaly {
  itemName: string;
  satuan: string | null;
  qtyBom: number | null;
  qtyDeviasi: number | null;
  nominalDeviasi: number | null;
  direction: string | null;
  devBom: number | null;
  tolerance: number | null;
  residualQty: number | null;
  residualRatio: number | null;
  zScore: number | null;
  historicalAvg: number | null;
  isAbnormal: boolean;
  isCritical: boolean;
  vsAreaAvg: number | null;
  vsNetworkAvg: number | null;
  issues: string[];
  possibleCause: string;
}

interface WorklistEntry {
  priority: 'P1' | 'P2' | 'P3';
  itemName: string;
  issue: string;
  evidence: string;
  metric: string;
  benchmark: string;
  possibleCause: string;
  recommendedAction: string;
}

// ============================================================
//  Helpers
// ============================================================
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function fmtMetric(v: number | null): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(2)}M`;
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(2)}Jt`;
  if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toFixed(1)}Rb`;
  return `${sign}Rp ${abs.toFixed(0)}`;
}

function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return '—';
  return `${(Math.abs(v) * 100).toFixed(digits).replace('.', ',')}%`;
}

// Bug 2 fix: Direction must be based on NET DEVIATION (QTY LOSS/SURPLUS),
// NOT GROSS DEVIATION (QTY DEVIASI). Falls back to gross if net is null.
function classifyDirection(netDeviation: number | null, grossDeviation: number | null = null): string {
  if (netDeviation !== null) {
    if (netDeviation > 0) return 'LOSS';
    if (netDeviation < 0) return 'SURPLUS';
    return 'NEUTRAL';
  }
  if (grossDeviation !== null) {
    if (grossDeviation > 0) return 'LOSS';
    if (grossDeviation < 0) return 'SURPLUS';
  }
  return 'NEUTRAL';
}

// Map issue codes → human-readable possible cause
function possibleCauseFor(issues: string[]): string {
  if (issues.includes('TOLERANCE_BREACH') && issues.includes('HISTORICAL_ABNORMAL')) {
    return 'Deviasi melampaui toleransi DAN tidak sesuai pola historis — kemungkinan masalah operasional atau pencatatan.';
  }
  if (issues.includes('OVER_EXPLAINED')) {
    return 'Waste+Susut+Trial melampaui Deviasi — indikasi salah input SPV, double-counting, atau fraud.';
  }
  if (issues.includes('RESIDUAL_HIGH')) {
    return 'Sebagian besar deviasi tidak terjelaskan Waste/Susut/Trial — investigasi pemakaian aktual vs SOC.';
  }
  if (issues.includes('DIRECTION_REVERSAL')) {
    return 'Arah deviasi berbalik vs periode sebelumnya — cek perubahan operasional atau error input.';
  }
  if (issues.includes('NEW_ITEM')) {
    return 'Item baru di periode ini — cek apakah BOM/toleransi sudah diset dengan benar.';
  }
  if (issues.includes('HISTORICAL_ABNORMAL')) {
    return 'Deviasi signifikan vs rata-rata historis — kemungkinan outlier atau perubahan pola.';
  }
  if (issues.includes('TOLERANCE_BREACH')) {
    return 'Deviasi melampaui toleransi yang diset — review SOC dan sampling pemakaian aktual.';
  }
  if (issues.includes('ABOVE_AREA') || issues.includes('ABOVE_NETWORK')) {
    return 'Deviasi outlet lebih tinggi dari rata-rata area/jaringan — benchmarking vs outlet serupa.';
  }
  return 'Investigasi lanjutan diperlukan.';
}

// ============================================================
//  Main GET handler
// ============================================================
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`outlet-focus:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Coba lagi dalam beberapa detik.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      );
    }

    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    const month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const compareWeekParam = url.searchParams.get('compareWeek');
    const compareMonthParam = url.searchParams.get('compareMonth');

    if (!outletCode) {
      return NextResponse.json({ success: false, error: 'outletCode is required' }, { status: 400 });
    }
    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week are required' }, { status: 400 });
    }

    const thresholdsVersion = await getThresholdsVersion();
    const cacheKey = `outlet-focus|${outletCode}|${month}|${week}|${compareWeekParam || ''}|${compareMonthParam || ''}|tv${thresholdsVersion}`;
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ ...(cached as object), cached: true, durationMs: Date.now() - startedAt });
    }

    // ============================================================
    //  P1 fix: Phase 1 — metadata + independent data fetches (8 parallel)
    //  All queries use only input params (outletCode, month, week) or are
    //  fully independent. Previously these were 8 serial awaits → now 1 Promise.all.
    //  Queries: thresholds, outlet, pic, weeks, sourceFiles, currentRecs,
    //           trendRows (timeline), networkBench.
    // ============================================================
    const [
      thresholds, outlet, picRow, weeksRaw, fileMonthKeys,
      currentRecs, trendRows, networkBenchRows,
    ] = await Promise.all([
      getRuntimeThresholds(),
      db.outlet.findFirst({
        where: { code: outletCode },
        select: { id: true, code: true, name: true, area: true },
      }),
      db.outletPIC.findUnique({ where: { outletCode } }).catch(() => null),
      db.week.findMany({
        select: { weekLabel: true, monthKey: true },
        distinct: ['monthKey', 'weekLabel'],
      }),
      db.sourceFile.findMany({
        select: { monthLabel: true, monthKey: true },
      }),
      db.$queryRaw<OutletFocusRow[]>`
        SELECT ir.id, ir."itemId", i.name as "itemName", i.satuan,
          ir."qtyBom", ir."qtyCom", ir."qtyDeviasi", ir."qtyWaste", ir."qtySusut",
          ir."qtyTrial", ir."qtyLossSurplus",
          ir."nominalDeviasi", ir."nominalWaste", ir."nominalSusut", ir."nominalTrial",
          ir."nominalLossSurplus", ir."nominalSales", ir."avgPrice",
          ir."tolerancePct", ir."toleranceRaw",
          ir."pctQtyDeviasiToBom", ir.direction,
          ir."residualQty", ir."residualNominal", ir."residualRatio",
          ir."absQtyDeviasi", ir."absNominalDeviasi",
          ir."absQtyLossSurplus", ir."absNominalLossSurplus",
          ir.area, ir.bulan, ir."monthLabel", ir."weekLabel",
          ir."akunPenyesuaian", NULL::int as "rowNumber",
          o.code as "outletCode", o.name as "outletName"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `,
      db.$queryRaw<
        Array<{
          monthLabel: string;
          weekLabel: string;
          sales: number;
          nominal: number;
          devBom: number;
          lossNominal: number;
          surplusNominal: number;
          abnormalCount: number;
          topIssue: string | null;
        }>
      >`
        WITH sales_counts AS (
          SELECT ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales", COUNT(*) as cnt
          FROM "InventoryRecord" ir
          JOIN "Outlet" o ON ir."outletId" = o.id
          WHERE o.code = ${outletCode}
            AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
          GROUP BY ir."monthLabel", ir."weekLabel", ir."outletId", ir."nominalSales"
        ),
        ranked_sales AS (
          SELECT "monthLabel", "weekLabel", "outletId", "nominalSales",
            ROW_NUMBER() OVER (PARTITION BY "monthLabel", "weekLabel", "outletId" ORDER BY cnt DESC, "nominalSales" DESC) as rn
          FROM sales_counts
        ),
        sales_per_period AS (
          SELECT "monthLabel", "weekLabel", SUM("nominalSales") as sales
          FROM ranked_sales WHERE rn = 1
          GROUP BY "monthLabel", "weekLabel"
        ),
        period_aggs AS (
          SELECT ir."monthLabel", ir."weekLabel",
            COALESCE(SUM(ir."absNominalDeviasi"), 0) as nominal,
            COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "devBom",
            COALESCE(SUM(CASE WHEN ir."nominalDeviasi" > 0 THEN ir."nominalDeviasi" ELSE 0 END), 0) as "lossNominal",
            COALESCE(SUM(CASE WHEN ir."nominalDeviasi" < 0 THEN ABS(ir."nominalDeviasi") ELSE 0 END), 0) as "surplusNominal",
            COUNT(*) FILTER (WHERE ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
              AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > COALESCE(ir."tolerancePct", 0.05))::int as "abnormalCount",
            MODE() WITHIN GROUP (ORDER BY CASE WHEN ir."absNominalDeviasi" > 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL
              AND ABS(ir."pctQtyDeviasiToBom") > COALESCE(ir."tolerancePct", 0.05)
              THEN 'TOLERANCE_BREACH' ELSE NULL END) as "topIssue"
          FROM "InventoryRecord" ir
          JOIN "Outlet" o ON ir."outletId" = o.id
          WHERE o.code = ${outletCode}
          GROUP BY ir."monthLabel", ir."weekLabel"
        )
        SELECT pa."monthLabel", pa."weekLabel",
          COALESCE(sp.sales, 0) as sales,
          pa.nominal, pa."devBom", pa."lossNominal", pa."surplusNominal",
          pa."abnormalCount", pa."topIssue"
        FROM period_aggs pa
        LEFT JOIN sales_per_period sp ON pa."monthLabel" = sp."monthLabel" AND pa."weekLabel" = sp."weekLabel"
        ORDER BY pa."monthLabel", pa."weekLabel"
      `,
      db.$queryRaw<Array<{ avgDevBom: number; lossToSales: number | null }>>`
        WITH sales_per_outlet AS (
          SELECT DISTINCT "outletId", "nominalSales"
          FROM "InventoryRecord"
          WHERE "monthLabel" = ${month} AND "weekLabel" = ${week}
            AND "nominalSales" > 0
        )
        SELECT
          COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
          CASE WHEN (SELECT COALESCE(SUM("nominalSales"), 0) FROM sales_per_outlet) > 0
            THEN SUM(CASE WHEN ir."nominalDeviasi" > 0 THEN ir."nominalDeviasi" ELSE 0 END)
              / NULLIF((SELECT SUM("nominalSales") FROM sales_per_outlet), 0)
            ELSE NULL END as "lossToSales"
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `,
    ]);

    if (!outlet) {
      return NextResponse.json({ success: false, error: `Outlet ${outletCode} not found` }, { status: 404 });
    }
    if (currentRecs.length === 0) {
      return NextResponse.json({
        success: false,
        message: `No records found for outlet ${outletCode} in ${month} / ${week}`,
      }, { status: 404 });
    }

    const pic = picRow?.pic ?? null;
    const area = outlet.area;

    // Build period maps (CPU only)
    const monthKeyByLabel = new Map(fileMonthKeys.map((f) => [f.monthLabel, f.monthKey]));
    const monthLabelByKey = new Map(fileMonthKeys.map((f) => [f.monthKey, f.monthLabel]));
    const allPeriods = weeksRaw
      .map((w) => {
        const ml = monthLabelByKey.get(w.monthKey) || 'Unknown';
        return { monthLabel: ml, weekLabel: w.weekLabel, monthKey: w.monthKey, sortKey: `${w.monthKey}|${w.weekLabel}` };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    const currentPeriodIdx = allPeriods.findIndex((p) => p.monthLabel === month && p.weekLabel === week);
    const historicalPeriods = currentPeriodIdx >= 0 ? allPeriods.slice(0, currentPeriodIdx) : [];
    // Use explicit compareWeek from filter if provided, else auto-chronological
    const prevPeriod = compareWeekParam && compareMonthParam
      ? { monthLabel: compareMonthParam, weekLabel: compareWeekParam }
      : currentPeriodIdx > 0 ? allPeriods[currentPeriodIdx - 1] : null;

    // ============================================================
    //  P1 fix: Phase 2 — dependent queries (3 parallel)
    //  prevRecs (needs prevPeriod), historicalStats (needs historicalPeriods),
    //  areaBench (needs outlet.area) — all depend on Phase 1 results.
    // ============================================================
    const periodPairs = historicalPeriods.map((p) => `${p.monthLabel}|${p.weekLabel}`);
    const [prevRecs, histRows, areaBenchRows] = await Promise.all([
      prevPeriod
        ? db.$queryRaw<OutletFocusRow[]>`
            SELECT ir.id, ir."itemId", i.name as "itemName", i.satuan,
              ir."qtyBom", ir."qtyCom", ir."qtyDeviasi", ir."qtyWaste", ir."qtySusut",
              ir."qtyTrial", ir."qtyLossSurplus",
              ir."nominalDeviasi", ir."nominalWaste", ir."nominalSusut", ir."nominalTrial",
              ir."nominalLossSurplus", ir."nominalSales", ir."avgPrice",
              ir."tolerancePct", ir."toleranceRaw",
              ir."pctQtyDeviasiToBom", ir.direction,
              ir."residualQty", ir."residualNominal", ir."residualRatio",
              ir."absQtyDeviasi", ir."absNominalDeviasi",
              ir."absQtyLossSurplus", ir."absNominalLossSurplus",
              ir.area, ir.bulan, ir."monthLabel", ir."weekLabel",
              ir."akunPenyesuaian", NULL::int as "rowNumber",
              o.code as "outletCode", o.name as "outletName"
            FROM "InventoryRecord" ir
            JOIN "Item" i ON ir."itemId" = i.id
            JOIN "Outlet" o ON ir."outletId" = o.id
            WHERE o.code = ${outletCode}
              AND ir."monthLabel" = ${prevPeriod.monthLabel}
              AND ir."weekLabel" = ${prevPeriod.weekLabel}
          `
        : Promise.resolve([] as OutletFocusRow[]),
      historicalPeriods.length > 0
        ? db.$queryRaw<Array<{ itemId: number; mean: number; stdDev: number; n: number }>>`
            SELECT ir."itemId",
              AVG(ir."pctQtyDeviasiToBom") as mean,
              COALESCE(STDDEV_POP(ir."pctQtyDeviasiToBom"), 0) as "stdDev",
              COUNT(*)::int as n
            FROM "InventoryRecord" ir
            JOIN "Outlet" o ON ir."outletId" = o.id
            WHERE o.code = ${outletCode}
              AND (ir."monthLabel" || '|' || ir."weekLabel") IN (${Prisma.join(periodPairs)})
              AND ir."pctQtyDeviasiToBom" IS NOT NULL
              AND ir."qtyBom" != 0
            GROUP BY ir."itemId"
          `
        : Promise.resolve([] as Array<{ itemId: number; mean: number; stdDev: number; n: number }>),
      db.$queryRaw<Array<{ avgDevBom: number; lossToSales: number | null }>>`
        WITH sales_per_outlet AS (
          SELECT DISTINCT "outletId", "nominalSales"
          FROM "InventoryRecord"
          WHERE area = ${area} AND "monthLabel" = ${month} AND "weekLabel" = ${week}
            AND "nominalSales" > 0
        )
        SELECT
          COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")) FILTER (WHERE ir."qtyBom" != 0 AND ir."pctQtyDeviasiToBom" IS NOT NULL), 0) as "avgDevBom",
          CASE WHEN (SELECT COALESCE(SUM("nominalSales"), 0) FROM sales_per_outlet) > 0
            THEN SUM(CASE WHEN ir."nominalDeviasi" > 0 THEN ir."nominalDeviasi" ELSE 0 END)
              / NULLIF((SELECT SUM("nominalSales") FROM sales_per_outlet), 0)
            ELSE NULL END as "lossToSales"
        FROM "InventoryRecord" ir
        WHERE ir.area = ${area}
          AND ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `,
    ]);

    // Build historicalStats map from parallel histRows result
    const historicalStats = new Map<number, { mean: number; stdDev: number; n: number }>();
    for (const r of histRows) {
      historicalStats.set(r.itemId, { mean: toNum(r.mean) ?? 0, stdDev: toNum(r.stdDev) ?? 0, n: r.n });
    }

    const areaAvgDevBom = toNum(areaBenchRows[0]?.avgDevBom) ?? 0;
    const networkAvgDevBom = toNum(networkBenchRows[0]?.avgDevBom) ?? 0;
    const areaAvgLossToSales = toNum(areaBenchRows[0]?.lossToSales);
    const networkAvgLossToSales = toNum(networkBenchRows[0]?.lossToSales);

    // Timeline (from parallel trendRows result in Phase 1)
    const timeline = trendRows.map((r) => {
      const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
      return {
        weekLabel: r.weekLabel,
        monthLabel: r.monthLabel,
        sortKey: `${mk}|${r.weekLabel}`,
        sales: toNum(r.sales) ?? 0,
        nominal: toNum(r.nominal) ?? 0,
        devBom: toNum(r.devBom) ?? 0,
        status:
          (toNum(r.abnormalCount) ?? 0) > 10 ? 'ABNORMAL' :
          (toNum(r.abnormalCount) ?? 0) > 0 ? 'WARNING' : 'NORMAL',
        topIssue: r.topIssue || null,
      };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

    // ============================================================
    //  Step 8: Build per-item anomalies
    // ============================================================
    // Aggregate per itemId (in case of multiple akunPenyesuaian rows)
    const byItemId = new Map<number, OutletFocusRow[]>();
    for (const r of currentRecs) {
      const arr = byItemId.get(r.itemId) || [];
      arr.push(r);
      byItemId.set(r.itemId, arr);
    }

    const prevByItemId = new Map<number, OutletFocusRow>();
    for (const r of prevRecs) {
      prevByItemId.set(r.itemId, r);
    }

    const itemAnomalies: ItemAnomaly[] = [];
    let normalCount = 0, warningCount = 0, abnormalCount = 0;
    let totalAbsNominal = 0;
    let totalSales = 0;
    let totalLossNominal = 0;
    let totalSurplusNominal = 0;
    let totalResidualNominal = 0;
    let totalWasteNominal = 0;
    let totalSusutNominal = 0;
    let totalTrialNominal = 0;
    let totalQtyDeviasi = 0;
    let totalQtyWaste = 0;
    let totalQtySusut = 0;
    let totalQtyTrial = 0;
    let totalResidualQty = 0;
    let totalQtyBom = 0;
    let validDevBomCount = 0;
    let sumAbsDevBom = 0;

    const newItems: Array<{ itemName: string; nominalDeviasi: number | null }> = [];
    const disappearedItems: Array<{ itemName: string; previousNominal: number | null }> = [];
    const directionReversals: Array<{
      itemName: string; prevDirection: string; currDirection: string; change: string;
    }> = [];

    // For waste analysis
    const overExplainedItems: Array<{
      itemName: string; explained: number; deviasi: number; overPct: number;
    }> = [];
    const highResidualItems: Array<{
      itemName: string; residualQty: number | null; residualPct: number | null;
    }> = [];

    // For menu analysis (group by first word)
    const menuGroups = new Map<string, Array<{
      itemName: string; nominalDeviasi: number | null; devBom: number | null; direction: string | null;
    }>>();

    for (const [itemId, rows] of byItemId.entries()) {
      // Aggregate across akun rows (typically 1 row per itemId+outlet+week)
      // Use sum for nominal, first for tolerance/satuan
      const first = rows[0];
      const sumQtyBom = rows.reduce((s, r) => s + Math.abs(r.qtyBom ?? 0), 0);
      const sumQtyDeviasi = rows.reduce((s, r) => s + (r.qtyDeviasi ?? 0), 0);
      const sumQtyWaste = rows.reduce((s, r) => s + (r.qtyWaste ?? 0), 0);
      const sumQtySusut = rows.reduce((s, r) => s + (r.qtySusut ?? 0), 0);
      const sumQtyTrial = rows.reduce((s, r) => s + (r.qtyTrial ?? 0), 0);
      const sumNominalDeviasi = rows.reduce((s, r) => s + (r.nominalDeviasi ?? 0), 0);
      const sumAbsNominalDeviasi = rows.reduce((s, r) => s + (r.absNominalDeviasi ?? 0), 0);
      const sumNominalWaste = rows.reduce((s, r) => s + Math.abs(r.nominalWaste ?? 0), 0);
      const sumNominalSusut = rows.reduce((s, r) => s + Math.abs(r.nominalSusut ?? 0), 0);
      const sumNominalTrial = rows.reduce((s, r) => s + Math.abs(r.nominalTrial ?? 0), 0);

      const tolerance = first.tolerancePct;
      const toleranceEffective = tolerance ?? thresholds.FALLBACK_TOLERANCE_PCT;
      const devBom = first.pctQtyDeviasiToBom; // raw signed value
      const absDevBom = devBom != null ? Math.abs(devBom) : null;

      // Bug 2 fix: use net deviation (qtyLossSurplus) for direction, fallback to gross
      const sumQtyLossSurplus = rows.reduce((s, r) => s + (r.qtyLossSurplus ?? 0), 0);
      const direction = first.direction || classifyDirection(sumQtyLossSurplus, sumQtyDeviasi);
      const residualQty = rows.reduce((s, r) => s + (r.residualQty ?? 0), 0);
      const residualRatio = first.residualRatio;
      const nominalDeviasi = sumNominalDeviasi;

      // Z-score (from historical mean + stddev)
      const hist = historicalStats.get(itemId);
      let zScore: number | null = null;
      if (hist && hist.stdDev > 0 && devBom != null) {
        zScore = calcZScore(devBom, hist.mean, hist.stdDev);
      }

      // vs area + network (this outlet's per-item devBom vs aggregate benchmarks)
      const vsAreaAvg = absDevBom != null ? absDevBom - areaAvgDevBom : null;
      const vsNetworkAvg = absDevBom != null ? absDevBom - networkAvgDevBom : null;

      // Issues detection
      const issues: string[] = [];
      const isZeroDev = sumQtyDeviasi === 0 || sumAbsNominalDeviasi === 0;

      if (!isZeroDev) {
        // TOLERANCE_BREACH
        if (absDevBom != null && absDevBom > toleranceEffective) {
          issues.push('TOLERANCE_BREACH');
        }
        // RESIDUAL_HIGH (> 50%)
        if (residualRatio != null && residualRatio > 0.5) {
          issues.push('RESIDUAL_HIGH');
        }
        // HISTORICAL_ABNORMAL (z > 2)
        if (zScore != null && zScore > 2) {
          issues.push('HISTORICAL_ABNORMAL');
        }
        // OVER_EXPLAINED (|W+S+T| > |Deviasi|)
        const explainedAbs = Math.abs(sumQtyWaste + sumQtySusut + sumQtyTrial);
        const deviasiAbs = Math.abs(sumQtyDeviasi);
        if (deviasiAbs > 0 && explainedAbs > deviasiAbs) {
          issues.push('OVER_EXPLAINED');
          const overPct = (explainedAbs - deviasiAbs) / deviasiAbs;
          overExplainedItems.push({
            itemName: first.itemName,
            explained: explainedAbs,
            deviasi: deviasiAbs,
            overPct,
          });
        }
        // HIGH_NOMINAL
        if (sumAbsNominalDeviasi > 10_000_000) {
          issues.push('HIGH_NOMINAL');
        }
        // BENCHMARK_ABOVE_AREA / NETWORK
        if (absDevBom != null && areaAvgDevBom > 0 && absDevBom > areaAvgDevBom * 1.5) {
          issues.push('ABOVE_AREA');
        }
        if (absDevBom != null && networkAvgDevBom > 0 && absDevBom > networkAvgDevBom * 1.5) {
          issues.push('ABOVE_NETWORK');
        }
      }

      // NEW_ITEM (no prev record)
      const prev = prevByItemId.get(itemId);
      if (!prev) {
        if (!isZeroDev) issues.push('NEW_ITEM');
        newItems.push({ itemName: first.itemName, nominalDeviasi });
      }

      // DISAPPEARED (in prev, not in current)
      // (handled in separate loop below)

      // DIRECTION_REVERSAL
      if (prev && prev.direction && direction) {
        if (prev.direction !== direction && prev.direction !== 'NEUTRAL' && direction !== 'NEUTRAL') {
          if (!isZeroDev) issues.push('DIRECTION_REVERSAL');
          directionReversals.push({
            itemName: first.itemName,
            prevDirection: prev.direction,
            currDirection: direction,
            change: `${prev.direction} → ${direction}`,
          });
        }
      }

      const isAbnormal = issues.length > 0 && (
        issues.includes('TOLERANCE_BREACH') ||
        issues.includes('OVER_EXPLAINED') ||
        issues.includes('HISTORICAL_ABNORMAL')
      );
      const isWarning = issues.length > 0 && !isAbnormal;
      const isCritical = isAbnormal && (zScore != null && zScore > 3) || (isAbnormal && sumAbsNominalDeviasi > 50_000_000);

      if (issues.length === 0) normalCount++;
      else if (isAbnormal) abnormalCount++;
      else warningCount++;

      totalAbsNominal += sumAbsNominalDeviasi;
      totalLossNominal += sumNominalDeviasi > 0 ? sumNominalDeviasi : 0;
      totalSurplusNominal += sumNominalDeviasi < 0 ? Math.abs(sumNominalDeviasi) : 0;
      totalResidualNominal += rows.reduce((s, r) => s + Math.abs(r.residualNominal ?? 0), 0);
      totalWasteNominal += sumNominalWaste;
      totalSusutNominal += sumNominalSusut;
      totalTrialNominal += sumNominalTrial;

      totalQtyDeviasi += Math.abs(sumQtyDeviasi);
      totalQtyWaste += Math.abs(sumQtyWaste);
      totalQtySusut += Math.abs(sumQtySusut);
      totalQtyTrial += Math.abs(sumQtyTrial);
      totalResidualQty += Math.abs(residualQty);
      totalQtyBom += sumQtyBom;

      if (absDevBom != null) {
        sumAbsDevBom += absDevBom;
        validDevBomCount++;
      }

      // High residual items
      if (residualRatio != null && residualRatio > 0.5 && !isZeroDev) {
        highResidualItems.push({
          itemName: first.itemName,
          residualQty,
          residualPct: residualRatio,
        });
      }

      // Menu group (first word of item name)
      const prefix = (first.itemName || '').split(/\s+/)[0] || 'LAINNYA';
      if (!menuGroups.has(prefix)) menuGroups.set(prefix, []);
      menuGroups.get(prefix)!.push({
        itemName: first.itemName,
        nominalDeviasi,
        devBom: absDevBom,
        direction,
      });

      // Build anomaly entry (skip zero-dev items entirely from anomalies list)
      if (!isZeroDev || issues.length > 0) {
        itemAnomalies.push({
          itemName: first.itemName,
          satuan: first.satuan,
          qtyBom: first.qtyBom,
          qtyDeviasi: sumQtyDeviasi,
          nominalDeviasi,
          direction,
          devBom,
          tolerance,
          residualQty,
          residualRatio,
          zScore,
          historicalAvg: hist?.mean ?? null,
          isAbnormal,
          isCritical: Boolean(isCritical),
          vsAreaAvg,
          vsNetworkAvg,
          issues,
          possibleCause: possibleCauseFor(issues),
        });
      }
    }

    // Disappeared items
    for (const [itemId, prev] of prevByItemId.entries()) {
      if (!byItemId.has(itemId) && (prev.absNominalDeviasi ?? 0) > 0) {
        disappearedItems.push({
          itemName: prev.itemName,
          previousNominal: prev.nominalDeviasi,
        });
      }
    }

    // Sort item anomalies by |nominal| desc
    itemAnomalies.sort((a, b) => Math.abs(b.nominalDeviasi ?? 0) - Math.abs(a.nominalDeviasi ?? 0));

    // ============================================================
    //  Step 9: Compute outlet summary metrics
    // ============================================================
    // Sales = MODE per outlet (single outlet here, so just take the most common value)
    // For single outlet, take MODE of nominalSales
    const salesCounts = new Map<number, number>();
    for (const r of currentRecs) {
      if (r.nominalSales != null && r.nominalSales > 0) {
        salesCounts.set(r.nominalSales, (salesCounts.get(r.nominalSales) ?? 0) + 1);
      }
    }
    let sales = 0;
    let maxCount = 0;
    for (const [val, cnt] of salesCounts.entries()) {
      if (cnt > maxCount) {
        maxCount = cnt;
        sales = val;
      }
    }
    if (sales === 0) {
      // fallback: sum of distinct
      sales = Array.from(salesCounts.keys()).reduce((s, v) => s + v, 0);
    }

    const prevSales = (() => {
      const counts = new Map<number, number>();
      for (const r of prevRecs) {
        if (r.nominalSales != null && r.nominalSales > 0) {
          counts.set(r.nominalSales, (counts.get(r.nominalSales) ?? 0) + 1);
        }
      }
      let s = 0, mc = 0;
      for (const [val, cnt] of counts.entries()) {
        if (cnt > mc) { mc = cnt; s = val; }
      }
      return s > 0 ? s : null;
    })();
    const prevNominalDeviasi = prevRecs.length > 0
      ? prevRecs.reduce((s, r) => s + (r.absNominalDeviasi ?? 0), 0)
      : null;

    const devBomOutlet = validDevBomCount > 0 ? sumAbsDevBom / validDevBomCount : 0;
    const residualPct = totalQtyDeviasi > 0 ? totalResidualQty / totalQtyDeviasi : null;
    const lossToSales = sales > 0 ? totalLossNominal / sales : null;

    // Health score (same formula as analysis.ts: 30% devBom + 25% residual + 25% lossToSales + 20% abnormalCount)
    const devBomScore = Math.max(0, 100 - devBomOutlet * 200); // 50% devBom → 0
    const residualScore = residualPct != null ? Math.max(0, 100 - residualPct * 100) : 100;
    const lossToSalesScore = lossToSales != null ? Math.max(0, 100 - lossToSales * 1000) : 100; // 10% loss/sales → 0
    const abnormalScore = byItemId.size > 0 ? Math.max(0, 100 - (abnormalCount / byItemId.size) * 200) : 100; // 50% abnormal → 0
    const healthScore = Math.round(
      devBomScore * 0.30 + residualScore * 0.25 + lossToSalesScore * 0.25 + abnormalScore * 0.20,
    );

    // Rank: count outlets in same period with lower health score
    // (simplified — health computed only for current outlet, rank is approximated)
    const totalOutletsInPeriodRows = await db.$queryRaw<Array<{ cnt: number }>>`
      SELECT COUNT(DISTINCT "outletId")::int as cnt
      FROM "InventoryRecord"
      WHERE "monthLabel" = ${month} AND "weekLabel" = ${week}
    `;
    const totalOutletsInPeriod = totalOutletsInPeriodRows[0]?.cnt ?? 0;

    // ============================================================
    //  Step 10: Waste analysis summary
    // ============================================================
    const totalBomQty = totalQtyBom || 1;
    const wasteAnalysis = {
      totalWaste: totalQtyWaste,
      totalSusut: totalQtySusut,
      totalTrial: totalQtyTrial,
      totalResidual: totalResidualQty,
      wastePctOfBom: totalQtyWaste / totalBomQty,
      susutPctOfBom: totalQtySusut / totalBomQty,
      trialPctOfBom: totalQtyTrial / totalBomQty,
      residualPct: residualPct ?? 0,
      wasteNominal: totalWasteNominal,
      susutNominal: totalSusutNominal,
      trialNominal: totalTrialNominal,
      residualNominal: totalResidualNominal,
      overExplainedItems: overExplainedItems.sort((a, b) => b.overPct - a.overPct).slice(0, 20),
      highResidualItems: highResidualItems.sort((a, b) => (b.residualPct ?? 0) - (a.residualPct ?? 0)).slice(0, 20),
    };

    // ============================================================
    //  Step 11: Menu analysis (group by prefix → outlier)
    // ============================================================
    const menuAnalysis = Array.from(menuGroups.entries())
      .map(([prefix, items]) => {
        const totalDeviation = items.reduce((s, it) => s + Math.abs(it.nominalDeviasi ?? 0), 0);
        const devs = items.map((it) => it.devBom).filter((d): d is number => d != null);
        const avgDevBom = devs.length > 0 ? devs.reduce((a, b) => a + b, 0) / devs.length : 0;
        const stdDev = devs.length > 1
          ? Math.sqrt(devs.reduce((s, d) => s + (d - avgDevBom) ** 2, 0) / devs.length)
          : 0;

        // Outlier: devBom > avg + 2*stdDev (or > 200% of avg if stdDev=0)
        const outliers = items.filter((it) => {
          if (it.devBom == null) return false;
          if (stdDev > 0) return it.devBom > avgDevBom + 2 * stdDev;
          return avgDevBom > 0 && it.devBom > avgDevBom * 3;
        }).sort((a, b) => (b.devBom ?? 0) - (a.devBom ?? 0));

        return {
          prefix,
          itemCount: items.length,
          totalDeviation,
          avgDeviation: avgDevBom,
          items: items.sort((a, b) => Math.abs(b.nominalDeviasi ?? 0) - Math.abs(a.nominalDeviasi ?? 0)).slice(0, 20),
          outliers,
        };
      })
      .sort((a, b) => b.totalDeviation - a.totalDeviation);

    // ============================================================
    //  Step 12: DQ issues for this outlet (from DQIssue table)
    // ============================================================
    let dqIssues: Array<{ severity: string; code: string; message: string; rowNumber: number | null }> = [];
    try {
      // Find DQ issues by outletId for current month's source files
      const dqRows = await db.dQIssue.findMany({
        where: {
          outletId: outlet.id,
          sourceFile: { monthLabel: month },
        },
        select: { severity: true, code: true, message: true, rowNumber: true },
        take: 200,
        orderBy: { id: 'desc' },
      });
      dqIssues = dqRows.map((r) => ({
        severity: r.severity,
        code: r.code,
        message: r.message,
        rowNumber: r.rowNumber,
      }));
    } catch {
      // DQIssue table may not have outletId populated; fallback computed issues
    }

    // Computed DQ issues (fallback / supplement):
    const computedDQ: Array<{ severity: string; code: string; message: string; rowNumber: number | null }> = [];
    for (const [itemId, rows] of byItemId.entries()) {
      for (const r of rows) {
        if (r.qtyBom === null || r.qtyBom === 0) {
          computedDQ.push({
            severity: 'WARNING',
            code: 'MISSING_BOM',
            message: `QTY BOM kosong/0 untuk ${r.itemName}`,
            rowNumber: r.rowNumber,
          });
        }
        if (r.tolerancePct === null && r.toleranceRaw && /BELUM ADA TOLERANSI/i.test(r.toleranceRaw)) {
          computedDQ.push({
            severity: 'INFO',
            code: 'TOLERANCE_NOT_SET',
            message: `Tolerance belum diset untuk ${r.itemName}`,
            rowNumber: r.rowNumber,
          });
        }
        if (r.qtyBom != null && r.qtyBom > 0) {
          computedDQ.push({
            severity: 'WARNING',
            code: 'BOM_POSITIVE',
            message: `QTY BOM positif (${r.qtyBom}) — konvensi normalnya negatif (konsumsi)`,
            rowNumber: r.rowNumber,
          });
        }
        // OVER_EXPLAINED
        const explained = Math.abs((r.qtyWaste ?? 0) + (r.qtySusut ?? 0) + (r.qtyTrial ?? 0));
        const deviasi = Math.abs(r.qtyDeviasi ?? 0);
        if (deviasi > 0 && explained > deviasi) {
          computedDQ.push({
            severity: 'WARNING',
            code: 'OVER_EXPLAINED',
            message: `WASTE+SUSUT+TRIAL (${explained.toFixed(0)}) > |DEVIASI| (${deviasi.toFixed(0)}) untuk ${r.itemName}`,
            rowNumber: r.rowNumber,
          });
        }
      }
    }
    // Merge: prefer table rows; if table empty, use computed
    if (dqIssues.length === 0) {
      dqIssues = computedDQ;
    }

    // ============================================================
    //  Step 13: Build worklist (P1/P2/P3)
    // ============================================================
    const worklist: WorklistEntry[] = itemAnomalies
      .filter((a) => a.issues.length > 0)
      .map((a) => {
        const absNominal = Math.abs(a.nominalDeviasi ?? 0);
        const absZ = Math.abs(a.zScore ?? 0);
        const hasBreach = a.issues.includes('TOLERANCE_BREACH');
        const hasHistAbn = a.issues.includes('HISTORICAL_ABNORMAL');
        const hasOverExp = a.issues.includes('OVER_EXPLAINED');
        const hasReversal = a.issues.includes('DIRECTION_REVERSAL');
        const isNew = a.issues.includes('NEW_ITEM');

        let priority: 'P1' | 'P2' | 'P3' = 'P3';
        if (absNominal > 10_000_000 && (hasBreach || hasOverExp) && absZ > 2) {
          priority = 'P1';
        } else if (absNominal > 10_000_000 && (hasBreach || hasOverExp)) {
          priority = 'P1';
        } else if (hasBreach && absNominal > 1_000_000) {
          priority = 'P2';
        } else if (hasOverExp && absNominal > 1_000_000) {
          priority = 'P2';
        } else if (hasReversal || isNew) {
          priority = 'P3';
        } else if (absNominal > 1_000_000) {
          priority = 'P2';
        }

        // Issue summary
        const issueBits: string[] = [];
        if (hasBreach) issueBits.push('Toleransi Dilanggar');
        if (a.issues.includes('RESIDUAL_HIGH')) issueBits.push('Residual Tinggi');
        if (hasHistAbn) issueBits.push('Anomali Historis');
        if (hasOverExp) issueBits.push('Over-Explained');
        if (hasReversal) issueBits.push('Arah Berbalik');
        if (isNew) issueBits.push('Item Baru');
        if (a.issues.includes('ABOVE_AREA')) issueBits.push('Above Area');
        if (a.issues.includes('ABOVE_NETWORK')) issueBits.push('Above Network');
        const issue = issueBits.join(', ') || 'Anomali Terdeteksi';

        // Evidence
        const evBits: string[] = [];
        if (a.devBom != null) evBits.push(`Dev/BOM ${fmtPct(a.devBom)}`);
        if (a.tolerance != null) evBits.push(`Toleransi ${fmtPct(a.tolerance)}`);
        if (a.residualRatio != null) evBits.push(`Residual ${fmtPct(a.residualRatio)}`);
        if (a.zScore != null) evBits.push(`Z-Score ${a.zScore.toFixed(2)}`);
        evBits.push(`|Nominal| ${fmtMetric(a.nominalDeviasi)}`);
        const evidence = evBits.join(' · ');

        // Metric
        const metric = a.devBom != null
          ? `${fmtPct(a.devBom)} deviasi terhadap BOM`
          : `${fmtMetric(a.nominalDeviasi)} nominal deviasi`;

        // Benchmark
        let benchmark = '—';
        if (a.vsAreaAvg != null && a.vsNetworkAvg != null) {
          benchmark = `Area avg ${fmtPct(areaAvgDevBom)} (Δ ${fmtPct(a.vsAreaAvg)}) · Network avg ${fmtPct(networkAvgDevBom)} (Δ ${fmtPct(a.vsNetworkAvg)})`;
        } else if (a.vsAreaAvg != null) {
          benchmark = `Area avg ${fmtPct(areaAvgDevBom)} (Δ ${fmtPct(a.vsAreaAvg)})`;
        }

        // Recommended action
        const actions: string[] = [];
        if (a.issues.includes('RESIDUAL_HIGH')) {
          actions.push('Validasi Actual Usage vs SOC + sampling fisik + cek pencatatan Waste/Susut/Trial');
        }
        if (hasBreach) {
          actions.push('Review SOC/standard + sampling pemakaian aktual per menu');
        }
        if (hasOverExp) {
          actions.push('Cek pencatatan — kemungkinan double-counting atau salah input SPV');
        }
        if (hasHistAbn) {
          actions.push('Investigasi pola abnormal vs historical behavior (outlier detection)');
        }
        if (hasReversal) {
          actions.push('Audit perubahan operasional + cek konsistensi input');
        }
        if (isNew) {
          actions.push('Verifikasi BOM/toleransi sudah diset dengan benar');
        }
        if (a.issues.includes('ABOVE_AREA') || a.issues.includes('ABOVE_NETWORK')) {
          actions.push('Benchmarking vs outlet serupa se-area');
        }
        if (actions.length === 0) {
          actions.push('Investigasi lanjutan diperlukan');
        }

        return {
          priority,
          itemName: a.itemName,
          issue,
          evidence,
          metric,
          benchmark,
          possibleCause: a.possibleCause,
          recommendedAction: actions.join(' | '),
        };
      })
      .sort((a, b) => {
        const order = { P1: 0, P2: 1, P3: 2 };
        return order[a.priority] - order[b.priority];
      });

    // ============================================================
    //  Step 14: Growth (sales + nominal)
    // ============================================================
    const growthSales = calcGrowth(sales, prevSales);
    const growthNominal = calcGrowth(totalAbsNominal, prevNominalDeviasi);

    // ============================================================
    //  Step 15: Assemble final response
    // ============================================================
    const result = {
      success: true,
      period: { monthLabel: month, weekLabel: week, prevMonthLabel: prevPeriod?.monthLabel ?? null, prevWeekLabel: prevPeriod?.weekLabel ?? null },
      outlet: {
        code: outlet.code,
        name: outlet.name,
        area: outlet.area,
        pic,
        healthScore,
        rank: 0, // filled by frontend via ranking data
        totalOutlets: totalOutletsInPeriod,
        sales,
        absNominal: totalAbsNominal,
        devBom: devBomOutlet,
        residualPct,
        lossToSales,
        normal: normalCount,
        warning: warningCount,
        abnormal: abnormalCount,
        salesPrev: prevSales,
        nominalDeviasiPrev: prevNominalDeviasi,
        growthSales,
        growthNominal,
        totalLoss: totalLossNominal,
        totalSurplus: totalSurplusNominal,
        wasteNominal: totalWasteNominal,
        susutNominal: totalSusutNominal,
        trialNominal: totalTrialNominal,
        residualNominal: totalResidualNominal,
      },
      timeline,
      itemAnomalies,
      wasteAnalysis,
      menuAnalysis,
      dqIssues,
      benchmarks: {
        areaAvgDevBom,
        networkAvgDevBom,
        areaAvgLossToSales,
        networkAvgLossToSales,
        aboveArea: devBomOutlet > areaAvgDevBom,
        aboveNetwork: devBomOutlet > networkAvgDevBom,
      },
      newItems: newItems.slice(0, 50),
      disappearedItems: disappearedItems.slice(0, 50),
      directionReversals: directionReversals.slice(0, 50),
      worklist: worklist.slice(0, 50),
      durationMs: Date.now() - startedAt,
    };

    analysisCache.set(cacheKey, result);

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[outlet-focus] error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 },
    );
  }
}
