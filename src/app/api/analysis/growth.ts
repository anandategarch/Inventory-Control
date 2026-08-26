// ============================================================
//  ANALYSIS API — Growth comparison + trend computation
//  - computeTrend:               per-week aggregates with proper devBom
//  - computeGrowthComparison:    period-over-period growth (current vs
//                                compareWeek), mutates execSummary in place
//                                to fill previous/growth slots
//  - computeMultiPeriodComparison: P1-1 — current + 1/2/4/8 periods ago
// ============================================================
import type { Client, InValue } from '@libsql/client';
import type {
  ExecutiveSummary,
  Totals,
  GrowthComparison,
  TrendPoint,
  AggRow,
  MultiPeriodRow,
} from './types';
import {
  trendSql,
  trendSalesSql,
  cmpSql,
  cmpSalesSql,
  buildCompareWhereClause,
} from './queries';

// ------------------------------------------------------------
//  Trend (per-week aggregates)
// ------------------------------------------------------------

/** Compute the per-week trend (devBom, sales, nominal). */
export async function computeTrend(
  client: Client,
  trendWhere: string,
  trendArgs: InValue[]
): Promise<TrendPoint[]> {
  const trendRes = await client.execute({ sql: trendSql(trendWhere), args: trendArgs });

  // Sales per period = SUM of MAX-per-outlet (avoids duplication)
  const trendSalesRes = await client.execute({
    sql: trendSalesSql(trendWhere),
    args: trendArgs,
  });
  const salesByPeriod = new Map<string, number>();
  for (const s of trendSalesRes.rows as Array<Record<string, unknown>>) {
    const key = `${s.monthLabel}|${s.weekLabel}`;
    salesByPeriod.set(key, (salesByPeriod.get(key) || 0) + (Number(s.sales) || 0));
  }

  return (trendRes.rows as Array<Record<string, unknown>>).map((t) => {
    const key = `${t.monthLabel}|${t.weekLabel}`;
    const sales = salesByPeriod.get(key) || 0;
    const qtyDev = Number(t.qtyDeviasi) || 0;
    const qtyBom = Number(t.qtyBom) || 0;
    return {
      weekLabel: `${t.weekLabel} ${String(t.monthLabel || '').split(' ')[0]?.slice(0, 3) || ''}`,
      devBom: qtyBom > 0 ? qtyDev / qtyBom : 0,
      sales,
      nominal: Number(t.nominal) || 0,
    };
  });
}

// ------------------------------------------------------------
//  Growth comparison
// ------------------------------------------------------------

export interface GrowthArgs {
  client: Client;
  totals: Totals;
  monthLabel: string | null;
  compareMonth: string | null;
  compareWeek: string | null;
  area: string | null;
  outletCode: string | null;
  pic: string | null;
  execSummary: ExecutiveSummary;
  /** FIX P0-2: rows needed for avgPrice computation */
  rows: AggRow[];
}

/** Growth helper: (curr - prev) / |prev|, or null if prev is 0. */
function growth(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return (curr - prev) / Math.abs(prev);
}

/**
 * Compute growth comparison between the current period and the resolved
 * comparison period (compareWeek + compareMonth). When a comparison is
 * available, the executive summary's previous/growth slots are filled
 * in-place to mirror the original behaviour.
 *
 * Returns the GrowthComparison object (always populated; growth fields
 * are null when no comparison was possible).
 */
export async function computeGrowthComparison(args: GrowthArgs): Promise<GrowthComparison> {
  const {
    client,
    totals,
    monthLabel,
    compareMonth,
    compareWeek,
    area,
    outletCode,
    pic,
    execSummary,
  } = args;

  const {
    totalSales,
    qtyBomTotal,
    qtyDeviasiTotal,
    nomDeviasiTotal,
  } = totals;

  let growthComparison: GrowthComparison = {
    salesGrowth: null,
    bomGrowth: null,
    qtyDeviasiGrowth: null,
    nominalDeviasiGrowth: null,
    priceGrowth: null,
    deviationToSalesRatio: totalSales > 0 ? nomDeviasiTotal / totalSales : null,
    deviationToBomRatio: qtyBomTotal > 0 ? qtyDeviasiTotal / qtyBomTotal : null,
    growthGap: null,
    deviationToSalesPreviousRatio: null,
    ratioChange: null,
    // P0-3: Trend Decomposition — null until compare-period values are available
    volumeEffect: null,
    priceEffect: null,
    operationalEffect: null,
    // P0-2: Historical Z-Score analysis — populated by route.ts via
    // computeHistoricalAnalysis (in advancedAnalysis.ts). Default empty array
    // so callers can safely iterate without null-checking.
    historicalAnalysis: [],
    // P1-1: Multi-Period Comparison — populated by route.ts via
    // computeMultiPeriodComparison (below).
    multiPeriodComparison: [],
  };

  if (compareWeek && (compareMonth || monthLabel)) {
    const cmpMonth = compareMonth || monthLabel;
    const { where: cmpWhere, args: cmpArgs } = buildCompareWhereClause({
      cmpMonth,
      compareWeek,
      area,
      outletCode,
      pic,
    });

    const cmpRes = await client.execute({ sql: cmpSql(cmpWhere), args: cmpArgs });
    const cmpSalesRes = await client.execute({ sql: cmpSalesSql(cmpWhere), args: cmpArgs });
    const cmp = (cmpRes.rows[0] as Record<string, unknown> | undefined) || {};
    const cmpSales = Number((cmpSalesRes.rows[0] as Record<string, unknown> | undefined)?.sales) || 0;
    const cmpBom = Number(cmp.qtyBom) || 0;
    const cmpQtyDev = Number(cmp.qtyDeviasi) || 0;
    const cmpNomDev = Number(cmp.nominalDeviasi) || 0;
    const cmpAvgPrice = Number(cmp.avgPrice) || 0;

    // FIX P0-2: Compute avgPrice for current period from rows
    const currentAvgPrice = args.rows && args.rows.length > 0
      ? args.rows.reduce((s, r) => s + (r.avgPrice || 0), 0) / args.rows.length
      : 0;

    // FIX P0-2: Price growth = (currAvgPrice - prevAvgPrice) / |prevAvgPrice|
    const priceGrowth = (cmpAvgPrice > 0 && currentAvgPrice > 0)
      ? (currentAvgPrice - cmpAvgPrice) / Math.abs(cmpAvgPrice)
      : null;

    const salesGrowth = growth(totalSales, cmpSales);
    const nominalDeviasiGrowth = growth(nomDeviasiTotal, cmpNomDev);
    // P0-3: Compute qtyDeviasiGrowth locally so we can use it for trend
    // decomposition (volumeEffect = qtyDeviasiGrowth × avgPrice_prev).
    const qtyDeviasiGrowthLocal = growth(qtyDeviasiTotal, cmpQtyDev);

    // FIX §12: Growth Gap = deviation growth − sales growth
    const growthGap = (nominalDeviasiGrowth != null && salesGrowth != null)
      ? nominalDeviasiGrowth - salesGrowth
      : null;

    // FIX §12: Deviation/Sales Previous ratio
    const deviationToSalesPreviousRatio = cmpSales > 0 ? cmpNomDev / cmpSales : null;

    // FIX §12: Ratio Change = current ratio − previous ratio
    const currentRatio = totalSales > 0 ? nomDeviasiTotal / totalSales : null;
    const ratioChange = (currentRatio != null && deviationToSalesPreviousRatio != null)
      ? currentRatio - deviationToSalesPreviousRatio
      : null;

    // FIX C1: Trend Decomposition — absolute form (meaningful units)
    const prevNominal = cmpNomDev;
    const currNominal = nomDeviasiTotal;
    const currQtyDev = qtyDeviasiTotal;
    const prevQtyDev = cmpQtyDev;
    const prevPrice = cmpAvgPrice;
    const currPrice = currentAvgPrice;

    let volumeEffect: number | null = null;
    let priceEffect: number | null = null;
    let operationalEffect: number | null = null;

    if (prevNominal !== 0 && prevPrice > 0 && prevQtyDev > 0 && currPrice > 0) {
      const deltaQty = currQtyDev - prevQtyDev;
      const deltaPrice = currPrice - prevPrice;
      const volAbs = deltaQty * prevPrice;
      const priceAbs = deltaPrice * prevQtyDev;
      const crossAbs = deltaQty * deltaPrice;
      const totalDelta = currNominal - prevNominal;
      volumeEffect = volAbs / Math.abs(prevNominal);
      priceEffect = priceAbs / Math.abs(prevNominal);
      operationalEffect = (totalDelta - volAbs - priceAbs - crossAbs) / Math.abs(prevNominal);
    }

    growthComparison = {
      salesGrowth,
      bomGrowth: growth(qtyBomTotal, cmpBom),
      qtyDeviasiGrowth: growth(qtyDeviasiTotal, cmpQtyDev),
      nominalDeviasiGrowth,
      priceGrowth,
      deviationToSalesRatio: currentRatio,
      deviationToBomRatio: qtyBomTotal > 0 ? qtyDeviasiTotal / qtyBomTotal : null,
      growthGap,
      deviationToSalesPreviousRatio,
      ratioChange,
      volumeEffect,
      priceEffect,
      operationalEffect,
      historicalAnalysis: [],
      multiPeriodComparison: [],
    };

    // Update exec summary with previous values + growth (mutates in place)
    execSummary.sales.previous = cmpSales;
    execSummary.sales.growth = growthComparison.salesGrowth;
    execSummary.nominalDeviasi.previous = cmpNomDev;
    execSummary.nominalDeviasi.growth = growthComparison.nominalDeviasiGrowth;
    execSummary.qtyBom.previous = cmpBom;
    execSummary.qtyBom.growth = growthComparison.bomGrowth;
    execSummary.qtyDeviasi.previous = cmpQtyDev;
    execSummary.qtyDeviasi.growth = growthComparison.qtyDeviasiGrowth;
  }

  return growthComparison;
}

// ============================================================
//  P1-1: Multi-Period Comparison
//  Returns a trend table for the current period + 1/2/4/8 periods ago.
//  Each row carries sales, BOM, deviation (signed + absolute), devBomRatio,
//  and the growth % vs the previous row in the table.
//  Uses the chronological period list from InventoryRecord to locate each
//  offset period; if an offset is out of range, that row is skipped.
// ============================================================
export async function computeMultiPeriodComparison(
  client: Client,
  monthLabel: string | null,
  currentWeek: string | null,
  area: string | null,
  outletCode: string | null,
  pic: string | null,
): Promise<MultiPeriodRow[]> {
  if (!monthLabel || !currentWeek) return [];
  try {
    // 1. Resolve the chronological period list (filtered by area/outlet/PIC
    //    so multi-period comparisons respect the same scope as the main view).
    const periodSql = `
      SELECT DISTINCT r.monthLabel AS monthLabel, r.weekLabel AS weekLabel
      FROM InventoryRecord r
      JOIN Outlet o ON r.outletId = o.id
      ${area || outletCode || pic ? 'WHERE ' : ''}
        ${area ? 'r.area = ?' : ''}
        ${area && outletCode ? 'AND ' : ''}
        ${outletCode ? 'o.code = ?' : ''}
        ${(area || outletCode) && pic ? 'AND ' : ''}
        ${pic ? 'o.code IN (SELECT outletCode FROM OutletPIC WHERE pic = ?)' : ''}
      ORDER BY
        CAST(SUBSTR(r.monthLabel, LENGTH(r.monthLabel) - 3) AS INTEGER) * 100 +
        CASE
          WHEN r.monthLabel LIKE 'Januari%' THEN 1
          WHEN r.monthLabel LIKE 'Februari%' THEN 2
          WHEN r.monthLabel LIKE 'Maret%' THEN 3
          WHEN r.monthLabel LIKE 'April%' THEN 4
          WHEN r.monthLabel LIKE 'Mei%' THEN 5
          WHEN r.monthLabel LIKE 'Juni%' THEN 6
          WHEN r.monthLabel LIKE 'Juli%' THEN 7
          WHEN r.monthLabel LIKE 'Agustus%' THEN 8
          WHEN r.monthLabel LIKE 'September%' THEN 9
          WHEN r.monthLabel LIKE 'Oktober%' THEN 10
          WHEN r.monthLabel LIKE 'November%' THEN 11
          WHEN r.monthLabel LIKE 'Desember%' THEN 12
          ELSE 99
        END,
        CASE
          WHEN r.weekLabel LIKE '%1' AND r.weekLabel NOT LIKE '%10%' AND r.weekLabel NOT LIKE '%11%' AND r.weekLabel NOT LIKE '%12%' THEN 1
          WHEN r.weekLabel LIKE '%2' AND r.weekLabel NOT LIKE '%12%' AND r.weekLabel NOT LIKE '%20%' AND r.weekLabel NOT LIKE '%21%' THEN 2
          WHEN r.weekLabel LIKE '%3' AND r.weekLabel NOT LIKE '%13%' AND r.weekLabel NOT LIKE '%23%' AND r.weekLabel NOT LIKE '%30%' THEN 3
          WHEN r.weekLabel LIKE '%4' AND r.weekLabel NOT LIKE '%14%' AND r.weekLabel NOT LIKE '%24%' AND r.weekLabel NOT LIKE '%34%' THEN 4
          WHEN r.weekLabel LIKE '%5' AND r.weekLabel NOT LIKE '%15%' AND r.weekLabel NOT LIKE '%25%' THEN 5
          ELSE 99
        END
    `;
    // Build args for the optional WHERE conditions (only those provided).
    const periodArgs: InValue[] = [];
    if (area) periodArgs.push(area);
    if (outletCode) periodArgs.push(outletCode);
    if (pic) periodArgs.push(pic);

    const periodRes = await client.execute({ sql: periodSql, args: periodArgs });
    const periods = (periodRes.rows as Array<Record<string, unknown>>).map((r) => ({
      monthLabel: String(r.monthLabel),
      weekLabel: String(r.weekLabel),
    }));
    const currentIdx = periods.findIndex(
      (p) => p.monthLabel === monthLabel && p.weekLabel === currentWeek,
    );
    if (currentIdx < 0) return [];

    // Offsets: 0 (current), 1, 2, 4, 8 periods ago
    const offsets = [0, 1, 2, 4, 8];
    const targetPeriods: Array<{ offset: number; monthLabel: string; weekLabel: string }> = [];
    for (const off of offsets) {
      const idx = currentIdx - off;
      if (idx < 0) continue;
      const p = periods[idx];
      targetPeriods.push({ offset: off, monthLabel: p.monthLabel, weekLabel: p.weekLabel });
    }

    if (targetPeriods.length === 0) return [];

    // 2. For each target period, run a compare-style aggregate query
    //    (sales = SUM of MAX-per-outlet; bom/deviasi/nominal = SUM(ABS)).
    const rows: MultiPeriodRow[] = [];
    let prevDeviation: number | null = null;

    for (const tp of targetPeriods) {
      const { where: cmpWhere, args: cmpArgs } = buildCompareWhereClause({
        cmpMonth: tp.monthLabel,
        compareWeek: tp.weekLabel,
        area,
        outletCode,
        pic,
      });
      const aggRes = await client.execute({ sql: cmpSql(cmpWhere), args: cmpArgs });
      const aggRow = (aggRes.rows[0] as Record<string, unknown> | undefined) || {};
      const bom = Number(aggRow.qtyBom) || 0;
      const qtyDeviasi = Number(aggRow.qtyDeviasi) || 0;
      const nominalDeviasi = Number(aggRow.nominalDeviasi) || 0;

      const salesRes = await client.execute({ sql: cmpSalesSql(cmpWhere), args: cmpArgs });
      const sales = Number((salesRes.rows[0] as Record<string, unknown> | undefined)?.sales) || 0;

      const growthPct = (prevDeviation != null && prevDeviation !== 0)
        ? (nominalDeviasi - prevDeviation) / Math.abs(prevDeviation)
        : null;

      rows.push({
        period: `${tp.weekLabel} ${tp.monthLabel}`,
        offset: tp.offset,
        sales,
        bom,
        deviation: nominalDeviasi,
        absDeviation: Math.abs(nominalDeviasi),
        devBomRatio: bom > 0 ? qtyDeviasi / bom : null,
        growthPct,
      });

      prevDeviation = nominalDeviasi;
    }

    return rows;
  } catch (e) {
    console.error('[analysis] Multi-period comparison failed:', e);
    return [];
  }
}
