// ============================================================
//  Resto Recommendation Engine — rank all outlets by priority
//  14 signals weighted into Priority Score (0-100)
//  Returns top N outlets needing attention + analysis summary
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

// ============================================================
//  Resto Recommendation Engine — rank all outlets by priority
//  8 signals weighted into Priority Score (0-100)
//  Returns top N outlets needing attention + analysis summary
// ============================================================
export interface RestoRecommendation {
  outletCode: string;
  outletName: string;
  area: string;
  priorityScore: number;
  priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  signals: {
    devBomRatio: number;
    deviasiGrowth: number | null;
    abnormalCount: number;
    residualRatio: number;
    lossToSales: number;
    directionFlip: boolean;
    trendDeteriorating: boolean;
    itemConcentration: number;
    toleranceBreachCount: number;
    toleranceBreachHighCount: number;
    zScoreAbnormalCount: number;
    overExplainedCount: number;
    highLossItemCount: number;
    noToleranceItems: number;
    benchmarkHighCount: number;
  };
  metrics: {
    sales: number;
    nominalDeviasi: number;
    devBom: number;
    totalLoss: number;
    totalSurplus: number;
    residualQty: number;
    itemCount: number;
    direction: string;
    topItem: string | null;
    topItemNominal: number;
  };
  analysis: string[];   // auto-generated analysis bullet points
  signalScores?: Array<{ name: string; score: number; weight: number; value: string }>; // 15 signal breakdown
}

export async function queryRestoRecommendations(
  month: string,
  week: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
  limit: number = 5
): Promise<RestoRecommendation[]> {
  const f = buildSqlFilters(filters);

  // Fetch current period outlet aggregates + previous period + historical avg
  // FIX: add historical comparison (same weekLabel across ALL previous months)
  const [currRows, prevRows, histRows] = await Promise.all([
    db.$queryRaw<any[]>`
      WITH sales_counts AS (
        SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
          AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
          ${f}
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
      outlet_aggs AS (
        SELECT
          ir."outletId",
          SUM(ir."nominalDeviasi") as "nominalDeviasi",
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "devBom",
          SUM(ABS(ir."qtyBom")) as "qtyBom",
          SUM(ABS(ir."qtyDeviasi")) as "qtyDeviasi",
          SUM(ABS(ir."qtyWaste")) as "qtyWaste",
          SUM(ABS(ir."qtySusut")) as "qtySusut",
          SUM(ABS(ir."qtyTrial")) as "qtyTrial",
          SUM(ir."absQtyLossSurplus") as "qtyLossSurplus",
          -- FIX Bug 1A: grossAbsNominal = SUM(ABS(nominalDeviasi)) for correct itemConcentration denominator
          SUM(ir."absNominalDeviasi") as "grossAbsNominal",
          -- FIX CALC-4: Excel convention: LOSS = negative nominalLossSurplus
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalLoss",
          SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalSurplus",
          -- FIX CALC-3: use nominalLossSurplus < 0 (LOSS) instead of stored ir.direction (which may be inverted)
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualQty") ELSE 0 END) as "residualQty",
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END) as "residualNominal",
          -- FIX CALC2-2: qtyDeviasiLoss = SUM(ABS(qtyDeviasi) WHERE LOSS) — for correct residualRatio (LOSS/LOSS)
          SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ir."absQtyDeviasi" ELSE 0 END) as "qtyDeviasiLoss",
          COUNT(DISTINCT ir."itemId") as "itemCount",
          COUNT(CASE WHEN ir."absNominalDeviasi" > 0 THEN 1 END) as "deviatingItems",
          -- FIX CALC-2: use ABS() on both sides — pctQtyDeviasiToBom and tolerancePct are SIGNED in Excel
          -- (both negative for LOSS items). Without ABS, -0.11 > -0.005 is FALSE even though magnitude is larger.
          COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > ABS(ir."tolerancePct") THEN 1 END) as "toleranceBreachCount",
          COUNT(CASE WHEN ir."tolerancePct" IS NOT NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > ABS(ir."tolerancePct") * 2 THEN 1 END) as "toleranceBreachHighCount",
          -- zScore and benchmarkFlag are NOT in InventoryRecord table — they're in PeriodComparison.
          -- FIX: threshold changed from 0.20 to 0.50 per user request
          -- Use ABS(pctQtyDeviasiToBom) > 0.50 as proxy for "abnormal" (high deviation ratio vs BOM)
          -- FIX CALC-2: ABS() needed because pctQtyDeviasiToBom is SIGNED (negative for LOSS)
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.50 THEN 1 END) as "zScoreAbnormalCount",
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.25 THEN 1 END) as "zScoreWarningCount",
          -- benchmarkFlag not available — use high devBom as proxy
          -- FIX: threshold changed from 0.30 to 0.50 per user request
          COUNT(CASE WHEN ir."pctQtyDeviasiToBom" IS NOT NULL AND ABS(ir."pctQtyDeviasiToBom") > 0.50 THEN 1 END) as "benchmarkHighCount",
          0 as "benchmarkWarningCount",
          COUNT(CASE WHEN ir."qtyDeviasi" IS NOT NULL AND ir."qtyDeviasi" != 0 AND ABS(ir."qtyWaste") + ABS(ir."qtySusut") + ABS(ir."qtyTrial") > ABS(ir."qtyDeviasi") THEN 1 END) as "overExplainedCount",
          -- FIX REC-1: was MAX() returning 0/1; now COUNT() returns actual number of items without tolerance
          COUNT(CASE WHEN ir."tolerancePct" IS NULL AND ir."pctQtyDeviasiToBom" IS NOT NULL THEN 1 END) as "hasNoTolerance",
          -- FIX CALC-4: LOSS = negative nominalLossSurplus. High loss = < -10jt
          COUNT(CASE WHEN ir."nominalLossSurplus" < -10000000 THEN 1 END) as "highLossItem",
          -- FIX CALC-5: compute outlet direction from net nominalLossSurplus (Excel convention: < 0 = LOSS)
          -- FIX VERIFY3-8: add qtyDeviasi NULL fallback
          CASE
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
            ELSE 'NEUTRAL'
          END as "outletDirection"
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
          ${f}
        GROUP BY ir."outletId"
      ),
      top_items AS (
        SELECT "outletId", "topItem", "topItemNominal" FROM (
          SELECT
            ir."outletId",
            i.name as "topItem",
            ir."absNominalDeviasi" as "topItemNominal",
            ROW_NUMBER() OVER (PARTITION BY ir."outletId" ORDER BY ir."absNominalDeviasi" DESC) as rn
          FROM "InventoryRecord" ir
          JOIN "Item" i ON ir."itemId" = i.id
          WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
            ${f}
            AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ) ranked WHERE rn = 1
      )
      SELECT
        o.code as "outletCode", o.name as "outletName", o.area,
        COALESCE(sm.sales, 0) as "sales",
        COALESCE(oa."nominalDeviasi", 0) as "nominalDeviasi",
        COALESCE(oa."devBom", 0) as "devBom",
        COALESCE(oa."totalLoss", 0) as "totalLoss",
        COALESCE(oa."totalSurplus", 0) as "totalSurplus",
        COALESCE(oa."residualQty", 0) as "residualQty",
        COALESCE(oa."qtyLossSurplus", 0) as "qtyLossSurplus",
        COALESCE(oa."itemCount", 0) as "itemCount",
        COALESCE(oa."deviatingItems", 0) as "deviatingItems",
        COALESCE(oa."qtyDeviasi", 0) as "totalQtyDeviasi",
        COALESCE(oa."grossAbsNominal", 0) as "grossAbsNominal",
        COALESCE(oa."qtyDeviasiLoss", 0) as "qtyDeviasiLoss",
        COALESCE(oa."residualNominal", 0) as "residualNominal",
        COALESCE(oa."toleranceBreachCount", 0) as "toleranceBreachCount",
        COALESCE(oa."toleranceBreachHighCount", 0) as "toleranceBreachHighCount",
        COALESCE(oa."zScoreAbnormalCount", 0) as "zScoreAbnormalCount",
        COALESCE(oa."zScoreWarningCount", 0) as "zScoreWarningCount",
        COALESCE(oa."benchmarkHighCount", 0) as "benchmarkHighCount",
        COALESCE(oa."benchmarkWarningCount", 0) as "benchmarkWarningCount",
        COALESCE(oa."overExplainedCount", 0) as "overExplainedCount",
        COALESCE(oa."hasNoTolerance", 0) as "hasNoTolerance",
        COALESCE(oa."highLossItem", 0) as "highLossItem",
        oa."outletDirection" as "direction",
        ti."topItem",
        COALESCE(ti."topItemNominal", 0) as "topItemNominal"
      FROM outlet_aggs oa
      JOIN "Outlet" o ON oa."outletId" = o.id
      LEFT JOIN sales_mode sm ON oa."outletId" = sm."outletId"
      LEFT JOIN top_items ti ON oa."outletId" = ti."outletId"
      ORDER BY ABS(COALESCE(oa."nominalDeviasi", 0)) DESC
    `,
    prevWeek && prevMonth
      ? db.$queryRaw<any[]>`
        SELECT
          o.code as "outletCode",
          SUM(ir."nominalDeviasi") as "prevNominalDeviasi",
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "prevDevBom",
          -- FIX CALC-5: compute prev direction from net nominalLossSurplus (Excel convention: < 0 = LOSS)
          -- FIX VERIFY3-8: add qtyDeviasi NULL fallback
          CASE
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
            ELSE 'NEUTRAL'
          END as "prevDirection"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}
          ${f}
        GROUP BY o.code
      `
      : Promise.resolve([]),
    // FIX: Historical average — same weekLabel across ALL months BEFORE current month
    // FIX (BUG-HUNT-CALC): was AVG(ABS(per-record nominalDeviasi)) — scale mismatch with
    // current |SUM(nominalDeviasi)|. Now uses 2-level CTE: weekly_dev (per outlet+month+week)
    // → AVG(weeklyTotal). This matches queryParetoHistorical pattern.
    db.$queryRaw<any[]>`
      WITH weekly_dev AS (
        SELECT o.code as "outletCode",
          ir."monthLabel", ir."weekLabel",
          ABS(SUM(ir."nominalDeviasi")) as "weeklyTotal"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE ir."weekLabel" = ${week}
          AND ir."monthLabel" != ${month}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
          ${f}
        GROUP BY o.code, ir."monthLabel", ir."weekLabel"
      )
      SELECT "outletCode",
        AVG("weeklyTotal") as "histAvgNominalDeviasi",
        CAST(COUNT(*) AS INTEGER) as "histPeriodCount"
      FROM weekly_dev
      WHERE "weeklyTotal" IS NOT NULL
      GROUP BY "outletCode"
    `,
  ]);

  // Build prev lookup
  const prevMap = new Map<string, any>();
  for (const r of prevRows) {
    prevMap.set(r.outletCode, r);
  }

  // Build historical lookup
  const histMap = new Map<string, { avgNominalDeviasi: number; periodCount: number }>();
  for (const r of histRows) {
    histMap.set(r.outletCode, {
      avgNominalDeviasi: Number(r.histAvgNominalDeviasi) || 0,
      periodCount: Number(r.histPeriodCount) || 0,
    });
  }

  // Compute network averages for ratio
  const networkAvgDevBom = currRows.length > 0
    ? currRows.reduce((s, r) => s + Number(r.devBom), 0) / currRows.length
    : 0;
  // REC-7: totalNetworkDeviasi was computed but never used — removed

  // Compute Priority Score per outlet
  const recommendations: RestoRecommendation[] = currRows.map((r: any) => {
    const outletCode = r.outletCode;
    const prev = prevMap.get(outletCode);
    const devBom = Number(r.devBom);
    const nominalDeviasi = Number(r.nominalDeviasi);
    const totalLoss = Number(r.totalLoss);
    const totalSurplus = Number(r.totalSurplus);
    const residualQty = Number(r.residualQty);
    const qtyLossSurplus = Number(r.qtyLossSurplus);
    const sales = Number(r.sales);
    const itemCount = Number(r.itemCount);
    const deviatingItems = Number(r.deviatingItems);
    const totalQtyDeviasi = Number(r.totalQtyDeviasi);
    const residualNominal = Number(r.residualNominal || 0);
    const toleranceBreachCount = Number(r.toleranceBreachCount || 0);
    const toleranceBreachHighCount = Number(r.toleranceBreachHighCount || 0);
    const zScoreAbnormalCount = Number(r.zScoreAbnormalCount || 0);
    const overExplainedCount = Number(r.overExplainedCount || 0);
    const hasNoTolerance = Number(r.hasNoTolerance || 0);
    const highLossItem = Number(r.highLossItem || 0);
    const benchmarkHighCount = Number(r.benchmarkHighCount || 0);
    const direction = r.direction || 'NEUTRAL';
    const topItem = r.topItem;
    const topItemNominal = Number(r.topItemNominal);

    // Signal 1: Dev/BOM vs Peer (15%) — FIX: was 12%, increased after S13 removal
    const devBomRatio = networkAvgDevBom > 0 ? devBom / networkAvgDevBom : 0;
    const s1Score = Math.min(100, devBomRatio * 33);

    // Signal 2: Deviasi Growth (10%) — HYBRID: MoM + Historical
    // FIX: compare vs BOTH previous month AND historical average, take worst case
    const prevNominal = prev ? Number(prev.prevNominalDeviasi) : null;
    const deviasiGrowth = prevNominal != null && Math.abs(prevNominal) > 0
      ? (Math.abs(nominalDeviasi) - Math.abs(prevNominal)) / Math.abs(prevNominal)
      : null;

    // Historical comparison: current vs avg of same week across all previous months
    const histData = histMap.get(outletCode);
    const histAvgNominal = histData?.avgNominalDeviasi ?? null;
    const histPeriodCount = histData?.periodCount ?? 0;
    const deviasiGrowthHistorical = histAvgNominal != null && histAvgNominal > 0 && histPeriodCount >= 2
      ? (Math.abs(nominalDeviasi) - histAvgNominal) / histAvgNominal
      : null;

    // HYBRID: take the WORST (higher) of MoM vs Historical
    const deviasiGrowthHybrid = [deviasiGrowth, deviasiGrowthHistorical]
      .filter((g): g is number => g != null)
      .reduce((max, g) => Math.max(max, g), 0);

    const s2Score = deviasiGrowthHybrid > 0
      ? Math.min(100, deviasiGrowthHybrid * 100)
      : 0;

    // Signal 3: High Deviation Item Count (10%) — items with |devBom| > 0.50 (proxy for z-score abnormal)
    // NOTE: not a true z-score — uses fixed threshold 0.50 as proxy. See queryNetworkItemRisk for true z-score.
    const abnormalCount = zScoreAbnormalCount;
    const s3Score = Math.min(100, zScoreAbnormalCount * 20);

    // Signal 4: Residual Ratio (10%)
    // FIX CALC2-2: use qtyDeviasiLoss (LOSS-only) as denominator, not totalQtyDeviasi (ALL items).
    // residualQty is LOSS-only, so ratio should be LOSS/LOSS for correct proportion.
    const qtyDeviasiLoss = Number(r.qtyDeviasiLoss || 0);
    const residualRatio = qtyDeviasiLoss > 0 ? Math.abs(residualQty) / qtyDeviasiLoss : 0;
    const s4Score = Math.min(100, residualRatio * 100);

    // Signal 5: Loss/Sales Ratio (8%)
    // FIX METRICS-1: when sales=0 but totalLoss > 0, this is a data quality anomaly
    // (outlet with losses but no sales recorded). Score should be MAX (100), not 0.
    const lossToSales = sales > 0 ? totalLoss / sales : 0;
    const s5Score = sales > 0
      ? Math.min(100, lossToSales * 1000)
      : (totalLoss > 0 ? 100 : 0);

    // Signal 6: Direction Flip (8%)
    const prevDirection = prev?.prevDirection || null;
    const directionFlip = prevDirection != null && direction !== prevDirection && direction !== 'NEUTRAL' && prevDirection !== 'NEUTRAL';
    const s6Score = directionFlip ? 100 : 0;

    // Signal 7: Trend (8%) — HYBRID: deteriorating if EITHER MoM or Historical shows deterioration
    const trendDeteriorating = (deviasiGrowth != null && deviasiGrowth > 0.2)
      || (deviasiGrowthHistorical != null && deviasiGrowthHistorical > 0.2);
    const s7Score = trendDeteriorating ? 100 : 0;

    // Signal 8: Item Concentration (5%)
    // FIX Bug 1A: use grossAbsNominal (SUM(ABS(nominalDeviasi))) as denominator, not |SUM(nominalDeviasi)|
    // which cancels out LOSS+SURPLUS. Also clamp to [0, 1] so donut chart values are always valid.
    const grossAbsNominal = Number(r.grossAbsNominal || 0);
    const itemConcentration = grossAbsNominal > 0 && topItemNominal > 0
      ? Math.min(1, topItemNominal / grossAbsNominal)
      : 0;
    const s8Score = Math.min(100, itemConcentration * 100);

    // Signal 9: Tolerance Breach High (8%) — TOLERANCE_BREACH_HIGH rule
    const s9Score = Math.min(100, toleranceBreachHighCount * 25);

    // Signal 10: Over-Explained / Fraud Indicator (7%) — OVER_EXPLAINED rule
    const s10Score = Math.min(100, overExplainedCount * 50);

    // Signal 11: High Loss Nominal Items (5%) — HIGH_LOSS_NOMINAL rule (>10M per item)
    const s11Score = Math.min(100, highLossItem * 20);

    // Signal 12: No Tolerance Set (3%) — TOLERANCE_NOT_SET rule
    // FIX REC-6: was binary 0/50; now scales with count (was inconsistent with other count-based signals)
    const s12Score = Math.min(100, hasNoTolerance * 20);

    // Signal 13: REMOVED (DEEP-AUDIT-LOGIC #2) — was identical to S3 (both used
    // ABS(pctQtyDeviasiToBom) > 0.50). Weight 3% redistributed to S1 (Dev/BOM vs Peer)
    // which IS the real benchmark comparison. S3 still captures high-deviation items.
    // const s13Score = ... (removed)

    // Signal 14: Residual Nominal Impact (2%) — financial impact of unexplained
    const s14Score = Math.min(100, (residualNominal / 1_000_000) * 5);

    // Signal 15: Tolerance Breach REGULAR (1%) — items that breach tolerance but NOT severely.
    // FIX (DEEP-AUDIT-LOGIC #3): was `toleranceBreachCount` which includes high-breach items
    // (S9). Every high-breach item was double-counted (9% combined weight). Now excludes
    // high-breach items: regular = total - high.
    const regularBreachCount = Math.max(0, toleranceBreachCount - toleranceBreachHighCount);
    const s15Score = Math.min(100, regularBreachCount * 5);

    // Weighted Priority Score (14 signals, total 100%)
    // FIX: S13 removed (3% redistributed to S1: 12% → 15%). S15 now excludes high-breach.
    const priorityScore = Math.round(
      s1Score * 0.15 + s2Score * 0.10 + s3Score * 0.10 + s4Score * 0.10 +
      s5Score * 0.08 + s6Score * 0.08 + s7Score * 0.08 + s8Score * 0.05 +
      s9Score * 0.08 + s10Score * 0.07 + s11Score * 0.05 +
      s12Score * 0.03 + s14Score * 0.02 + s15Score * 0.01
    );

    const priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH' =
      priorityScore >= 55 ? 'TINGGI' : priorityScore >= 30 ? 'SEDANG' : 'RENDAH';

    // Auto-generate analysis bullets
    const analysis: string[] = [];
    if (devBomRatio > 2) analysis.push(`Dev/BOM ${(devBom * 100).toFixed(1)}% adalah ${devBomRatio.toFixed(1)}× peer average (${(networkAvgDevBom * 100).toFixed(1)}%)`);
    if (deviasiGrowth != null && deviasiGrowth > 0.2) {
      const momPct = (deviasiGrowth * 100).toFixed(0);
      const histPct = deviasiGrowthHistorical != null ? (deviasiGrowthHistorical * 100).toFixed(0) : null;
      if (histPct != null) {
        analysis.push(`Nominal Deviasi naik ${momPct}% vs bulan lalu, ${histPct}% vs rata-rata historis (${histPeriodCount} bulan)`);
      } else {
        analysis.push(`Nominal Deviasi naik ${momPct}% vs periode sebelumnya`);
      }
    } else if (deviasiGrowthHistorical != null && deviasiGrowthHistorical > 0.2) {
      analysis.push(`Nominal Deviasi naik ${(deviasiGrowthHistorical * 100).toFixed(0)}% vs rata-rata historis (${histPeriodCount} bulan) — trend jangka panjang memburuk`);
    }
    if (zScoreAbnormalCount > 0) analysis.push(`${zScoreAbnormalCount} item dengan deviasi > 50% BOM (proxy z-score abnormal — indikasi perilaku tidak wajar)`);
    // FIX: removed residual ratio bullet per user request
    // if (residualRatio > 0.4) analysis.push(`Residual ${(residualRatio * 100).toFixed(0)}% — ${Math.abs(residualQty).toLocaleString('id-ID')} dari ${qtyDeviasiLoss.toLocaleString('id-ID')} total deviasi LOSS tidak terjelaskan`);
    if (lossToSales > 0.03) analysis.push(`Loss/Sales ${(lossToSales * 100).toFixed(1)}% — rugi Rp ${totalLoss.toLocaleString('id-ID')} dari penjualan Rp ${sales.toLocaleString('id-ID')}`);
    if (directionFlip) analysis.push(`Arah deviasi berubah: ${prevDirection} → ${direction}`);
    if (itemConcentration > 0.3 && topItem) analysis.push(`Item "${topItem}" kontribusi ${(itemConcentration * 100).toFixed(0)}% dari total deviasi`);
    if (toleranceBreachHighCount > 0) analysis.push(`${toleranceBreachHighCount} item melebihi toleransi > 2× (TOLERANCE_BREACH_HIGH)`);
    if (overExplainedCount > 0) analysis.push(`${overExplainedCount} item Waste+Susut+Trial melebihi total deviasi — indikasi salah input atau fraud`);
    if (highLossItem > 0) analysis.push(`${highLossItem} item dengan nominal loss > Rp 10Jt (HIGH_LOSS_NOMINAL)`);
    if (hasNoTolerance > 0) analysis.push(`${hasNoTolerance} item belum diset toleransinya — tidak bisa deteksi breach`);
    if (benchmarkHighCount > 0) analysis.push(`${benchmarkHighCount} item dengan deviasi > 50% BOM (proxy benchmark high — jauh di atas normal)`);
    if (toleranceBreachCount > 0 && toleranceBreachHighCount === 0) analysis.push(`${toleranceBreachCount} item melebihi toleransi (TOLERANCE_BREACH)`);
    // FIX: removed 2 residual bullets per user request (not needed in analysis):
    // - "Residual X% — Y dari Z total deviasi LOSS tidak terjelaskan" (was line 851)
    // - "Dampak residual Rp X — tidak terjelaskan secara finansial (RESIDUAL_NOMINAL)" (was line 861)
    // REC-3: removed unreachable Signal 7 bullet (trendDeteriorating requires deviasiGrowth > 0.2,
    // but the bullet condition excluded deviasiGrowth > 0.2 — logically impossible). Signal 2 already covers this case.
    if (analysis.length === 0) analysis.push('Tidak ada anomaly signifikan terdeteksi');

    return {
      outletCode,
      outletName: r.outletName,
      area: r.area,
      priorityScore,
      priorityLevel,
      signals: {
        devBomRatio,
        deviasiGrowth,
        abnormalCount,
        residualRatio,
        lossToSales,
        directionFlip,
        trendDeteriorating,
        itemConcentration,
        toleranceBreachCount,
        toleranceBreachHighCount,
        zScoreAbnormalCount,
        overExplainedCount,
        highLossItemCount: highLossItem,
        noToleranceItems: hasNoTolerance,
        benchmarkHighCount,
      },
      metrics: {
        sales,
        nominalDeviasi,
        devBom,
        totalLoss,
        totalSurplus,
        residualQty,
        itemCount,
        direction,
        topItem,
        topItemNominal,
      },
      analysis,
      // FIX DRILLDOWN: expose signal scores + weights for Priority Summary breakdown
      signalScores: [
        { name: 'Dev/BOM vs Peer', score: Math.round(s1Score), weight: 0.15, value: `${devBomRatio.toFixed(2)}×` },
        { name: 'Deviasi Growth', score: Math.round(s2Score), weight: 0.10, value: `MoM: ${deviasiGrowth != null ? (deviasiGrowth * 100).toFixed(0) + '%' : '—'} | Hist: ${deviasiGrowthHistorical != null ? (deviasiGrowthHistorical * 100).toFixed(0) + '%' : '—'}` },
        { name: 'Deviasi >50% BOM', score: Math.round(s3Score), weight: 0.10, value: `${zScoreAbnormalCount} item` },
        { name: 'Residual Ratio', score: Math.round(s4Score), weight: 0.10, value: `${(residualRatio * 100).toFixed(0)}%` },
        { name: 'Loss/Sales', score: Math.round(s5Score), weight: 0.08, value: `${(lossToSales * 100).toFixed(1)}%` },
        { name: 'Direction Flip', score: Math.round(s6Score), weight: 0.08, value: directionFlip ? 'YA' : 'Tidak' },
        { name: 'Trend Memburuk', score: Math.round(s7Score), weight: 0.08, value: trendDeteriorating ? 'YA' : 'Tidak' },
        { name: 'Item Concentration', score: Math.round(s8Score), weight: 0.05, value: `${(itemConcentration * 100).toFixed(0)}%` },
        { name: 'Tol Breach High', score: Math.round(s9Score), weight: 0.08, value: `${toleranceBreachHighCount} item` },
        { name: 'Over-Explained', score: Math.round(s10Score), weight: 0.07, value: `${overExplainedCount} item` },
        { name: 'High Loss Nominal', score: Math.round(s11Score), weight: 0.05, value: `${highLossItem} item` },
        { name: 'No Tolerance', score: Math.round(s12Score), weight: 0.03, value: `${hasNoTolerance} item` },
        // FIX (BUG2-RESTO-3): S13 'Benchmark High' removed — was duplicate of S3 'Deviasi >50% BOM'
        // (identical SQL: ABS(pctQtyDeviasiToBom) > 0.50). Removing eliminates duplicate badges + analysis bullets.
        { name: 'Residual Nominal', score: Math.round(s14Score), weight: 0.02, value: `Rp ${Math.round(residualNominal / 1000000)}jt` },
        // FIX (BUG2-RESTO-2): renamed 'Tol Breach Reg' → 'Tolerance Breach' to match UI constants.
        // The old name was orphaned — UI expected 'Tolerance Breach' but API sent 'Tol Breach Reg' → signal never displayed.
        { name: 'Tolerance Breach', score: Math.round(s15Score), weight: 0.01, value: `${regularBreachCount} item` },
      ],
    };
  });

  // Sort by priority score desc, take top N
  return recommendations
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, limit);
}
