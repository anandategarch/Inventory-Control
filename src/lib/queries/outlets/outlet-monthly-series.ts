// ============================================================
//  Outlet Monthly Series + Peer Track Record (DEEP-RESTO-1)
//  --------------------------------------------------------
//  Two multi-month, SAME-weekLabel views for ONE outlet — the
//  in-app versions of the "Deret Bulanan" + "Peer Comparison
//  track-record" sheets from the offline deep resto analysis
//  (Analisa-Anomali-TJPPLU report):
//
//  1. queryOutletMonthlySeries — per month (same-week snapshot,
//     most recent N months INCLUDING the running month):
//       sales (MODE), MoM sales growth, ΣABS qtyBom, signed
//       Σ nominalDeviasi, Dev/BOM (ΣABS qtyDev / ΣABS qtyBom),
//       Total Loss / Total Surplus (Excel convention from
//       nominalLossSurplus), Net Cost Ratio = (L−S)/sales, and
//       an `abnormal` flag using the EXACT same thresholds as
//       outlet-recurrence.ts (devBom > FALLBACK_TOLERANCE_PCT
//       OR loss > HIGH_LOSS_NOMINAL_THRESHOLD) — one definition
//       everywhere.
//
//  2. queryPeerTrackRecord — for the SAME window, per month:
//       the dynamic sales band (outlets with sales within ±10%
//       of the target's sales THAT month — band membership is
//       recomputed per month, matching /api/peer-comparison),
//       the target's rank inside the band on net deviation
//       (1 = most negative = TERBURUK) and total loss
//       (1 = largest), band size, and the band's median loss.
//
//  GRAIN (critical): a "week" is a CUMULATIVE MTD snapshot
//  (W1=1-7 … W4=1-25) — the ONLY valid cross-month comparison
//  is SAME weekLabel, so both queries pin ir."weekLabel" = week
//  exactly like outlet-recurrence.ts / queryTrendAgg. Months
//  come from SourceFile.monthKey (sortable "YYYY-MM"); the
//  window is capped to the most recent 12 months ending at the
//  running month (monthKey <= currentMonthKey). When
//  currentMonthKey is null (month label not in SourceFile) no
//  upper bound is applied — every same-week month with data is
//  in scope.
//
//  Median loss uses the classic ROW_NUMBER/COUNT window form
//  (AVG of the middle 1-2 rows) because PostgreSQL ordered-set
//  aggregates (PERCENTILE_CONT) cannot be used as window
//  functions.
//
//  PURELY ADDITIVE: nothing existing imports these — they feed
//  the new /api/outlet-monthly-series + /api/peer-track-record
//  routes used by the Resto tab's "Riwayat Multi-Bulan" section.
// ============================================================
import { Prisma } from '@prisma/client';
import { withStatementTimeout } from '../shared';

/** Max months in the series / track-record window (incl. running month). */
export const OUTLET_MONTHLY_SERIES_WINDOW_MONTHS = 12;

// ------------------------------------------------------------
// 1. Monthly series — types
// ------------------------------------------------------------

/** Raw SQL row (bigint aggregates coerced in buildMonthlySeriesRows). */
interface MonthlySeriesRawRow {
  monthKey: string;
  monthLabel: string;
  sales: number | bigint;
  qtyBom: number | bigint;
  nominalDeviasi: number | bigint;
  devBom: number | bigint;
  totalLoss: number | bigint;
  totalSurplus: number | bigint;
}

export interface MonthlySeriesRow {
  monthKey: string;
  monthLabel: string;
  /** MODE(nominalSales) for this outlet in this (month, week). 0 when absent. */
  sales: number;
  /** Sales growth vs the previous month in the window (fraction). Null on the first row. */
  salesMoM: number | null;
  qtyBom: number;
  /** Signed Σ nominalDeviasi — negative = net loss. */
  nominalDeviasi: number;
  /** ΣABS qtyDeviasi / ΣABS qtyBom (qty-based, same as queryTrendAgg). */
  devBom: number;
  totalLoss: number;
  totalSurplus: number;
  /** (totalLoss − totalSurplus) / sales; 0 when sales is 0/absent. */
  netCostRatio: number;
  /** Same definition as outlet-recurrence.ts — no new thresholds. */
  abnormal: boolean;
}

export interface MonthlySeriesTotal {
  months: number;
  sales: number;
  qtyBom: number;
  nominalDeviasi: number;
  totalLoss: number;
  totalSurplus: number;
  netCostRatio: number;
  abnormalCount: number;
}

// ------------------------------------------------------------
// 2. Peer track record — types
// ------------------------------------------------------------

interface PeerTrackRecordRawRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number | bigint;
  nominalDeviasi: number | bigint;
  totalLoss: number | bigint;
  rankNetDev: number | bigint;
  rankLoss: number | bigint;
  bandSize: number | bigint;
  medianLoss: number | bigint;
}

export interface PeerTrackRecordRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number;
  /** Target's signed net deviation that month. */
  nominalDeviasi: number;
  totalLoss: number;
  /** 1 = most negative net deviation in the band (TERBURUK). */
  rankNetDev: number;
  /** 1 = largest total loss in the band. */
  rankLoss: number;
  bandSize: number;
  /** Median totalLoss across the band that month (0 when band degenerate). */
  medianLoss: number;
}

export interface PeerTrackRecordSummary {
  monthsTracked: number;
  avgRankNetDev: number | null;
  avgRankLoss: number | null;
  /** Months where the outlet was #1 worst net deviation in its band. */
  monthsWorstNetDev: number;
  /** Months where the outlet had the #1 largest loss in its band. */
  monthsWorstLoss: number;
  /** Latest month in the window (chronologically last with a band). */
  lastMonthLabel: string | null;
  lastRankNetDev: number | null;
  lastRankLoss: number | null;
  lastBandSize: number | null;
}

// ------------------------------------------------------------
// Pure transforms (exported for vitest — same pattern as
// change-analysis.ts compute/classify split)
// ------------------------------------------------------------

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Map raw SQL rows → MonthlySeriesRow[] (chronological, monthKey ASC —
 * the SQL already orders) adding MoM sales growth, Net Cost Ratio and
 * the recurrence-style abnormal flag.
 */
export function buildMonthlySeriesRows(
  raw: MonthlySeriesRawRow[],
  toleranceFallback: number,
  highLossNominal: number,
): MonthlySeriesRow[] {
  return raw.map((r, i) => {
    const sales = toNum(r.sales);
    const prevSales = i > 0 ? toNum(raw[i - 1].sales) : null;
    return {
      monthKey: r.monthKey,
      monthLabel: r.monthLabel,
      sales,
      salesMoM: i > 0 && prevSales !== null && prevSales !== 0
        ? sales / prevSales - 1
        : null,
      qtyBom: toNum(r.qtyBom),
      nominalDeviasi: toNum(r.nominalDeviasi),
      devBom: toNum(r.devBom),
      totalLoss: toNum(r.totalLoss),
      totalSurplus: toNum(r.totalSurplus),
      netCostRatio: sales > 0 ? (toNum(r.totalLoss) - toNum(r.totalSurplus)) / sales : 0,
      abnormal: toNum(r.devBom) > toleranceFallback || toNum(r.totalLoss) > highLossNominal,
    };
  });
}

/** Window totals (Σ over the rows; Net Cost Ratio recomputed on totals). */
export function buildMonthlySeriesTotal(rows: MonthlySeriesRow[]): MonthlySeriesTotal {
  const total: MonthlySeriesTotal = {
    months: rows.length,
    sales: 0,
    qtyBom: 0,
    nominalDeviasi: 0,
    totalLoss: 0,
    totalSurplus: 0,
    netCostRatio: 0,
    abnormalCount: 0,
  };
  for (const r of rows) {
    total.sales += r.sales;
    total.qtyBom += r.qtyBom;
    total.nominalDeviasi += r.nominalDeviasi;
    total.totalLoss += r.totalLoss;
    total.totalSurplus += r.totalSurplus;
    if (r.abnormal) total.abnormalCount += 1;
  }
  total.netCostRatio = total.sales > 0
    ? (total.totalLoss - total.totalSurplus) / total.sales
    : 0;
  return total;
}

/** Track-record summary (pure) — averages, worst-month counts, latest month. */
export function summarizeTrackRecord(rows: PeerTrackRecordRow[]): PeerTrackRecordSummary {
  if (rows.length === 0) {
    return {
      monthsTracked: 0,
      avgRankNetDev: null,
      avgRankLoss: null,
      monthsWorstNetDev: 0,
      monthsWorstLoss: 0,
      lastMonthLabel: null,
      lastRankNetDev: null,
      lastRankLoss: null,
      lastBandSize: null,
    };
  }
  const last = rows[rows.length - 1];
  const sumRankNetDev = rows.reduce((a, r) => a + r.rankNetDev, 0);
  const sumRankLoss = rows.reduce((a, r) => a + r.rankLoss, 0);
  return {
    monthsTracked: rows.length,
    avgRankNetDev: sumRankNetDev / rows.length,
    avgRankLoss: sumRankLoss / rows.length,
    monthsWorstNetDev: rows.filter((r) => r.rankNetDev === 1).length,
    monthsWorstLoss: rows.filter((r) => r.rankLoss === 1).length,
    lastMonthLabel: last.monthLabel,
    lastRankNetDev: last.rankNetDev,
    lastRankLoss: last.rankLoss,
    lastBandSize: last.bandSize,
  };
}

// ------------------------------------------------------------
// Shared SQL fragment: the same-week month window for ONE outlet
// (most recent N months ending at currentMonthKey, inclusive).
// ------------------------------------------------------------

/** Upper bound on monthKey — inclusive of the running month. */
function monthWindowBound(currentMonthKey: string | null): Prisma.Sql {
  return currentMonthKey
    ? Prisma.sql`AND sf."monthKey" <= ${currentMonthKey}`
    : Prisma.empty;
}

// ------------------------------------------------------------
// 1. queryOutletMonthlySeries
// ------------------------------------------------------------

export async function queryOutletMonthlySeries(
  outletCode: string,
  week: string,
  currentMonthKey: string | null,
  toleranceFallback: number,
  highLossNominal: number,
): Promise<{ rows: MonthlySeriesRow[]; total: MonthlySeriesTotal }> {
  // Same query pattern as outlet-recurrence.ts / peer-comparison.ts:
  // Prisma tagged template + withStatementTimeout (30s kill switch).
  // Shape:
  //   months        — DISTINCT same-week monthKeys for THIS outlet, most
  //                   recent 12 (incl. running month), = the window
  //   period_aggs   — per month aggregates for THIS outlet (same week)
  //   sales         — MODE per monthLabel from the precomputed
  //                   OutletPeriodSales table (DB-06 pattern)
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<MonthlySeriesRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE o.code = ${outletCode}
        AND ir."weekLabel" = ${week}
        ${monthWindowBound(currentMonthKey)}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${OUTLET_MONTHLY_SERIES_WINDOW_MONTHS}
    ),
    period_aggs AS (
      SELECT
        sf."monthKey",
        MIN(sf."monthLabel") as "monthLabel",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
        COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalLoss",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "totalSurplus"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE o.code = ${outletCode}
        AND ir."weekLabel" = ${week}
        AND sf."monthKey" IN (SELECT "monthKey" FROM months)
      GROUP BY sf."monthKey"
    ),
    sales AS (
      SELECT ops."monthLabel", MAX(ops."salesMode") as sales
      FROM "OutletPeriodSales" ops
      WHERE ops."weekLabel" = ${week}
        AND ops."outletId" IN (SELECT id FROM "Outlet" WHERE code = ${outletCode})
      GROUP BY ops."monthLabel"
    )
    SELECT
      pa."monthKey",
      pa."monthLabel",
      COALESCE(s.sales, 0) as "sales",
      pa."qtyBom",
      pa."nominalDeviasi",
      pa."devBom",
      pa."totalLoss",
      pa."totalSurplus"
    FROM period_aggs pa
    LEFT JOIN sales s ON s."monthLabel" = pa."monthLabel"
    ORDER BY pa."monthKey" ASC
  `);

  const mapped = buildMonthlySeriesRows(rows, toleranceFallback, highLossNominal);
  return { rows: mapped, total: buildMonthlySeriesTotal(mapped) };
}

// ------------------------------------------------------------
// 2. queryPeerTrackRecord
// ------------------------------------------------------------

export async function queryPeerTrackRecord(
  outletCode: string,
  week: string,
  currentMonthKey: string | null,
  kelompok?: string | null,
): Promise<{ rows: PeerTrackRecordRow[]; summary: PeerTrackRecordSummary }> {
  // kelompok scopes the PEER set only — the focus outlet is always
  // included (same predicate as peer-comparison.ts peerKelompokFilter).
  const peerKelompokFilter = kelompok
    ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
    : Prisma.empty;

  // Shape:
  //   months / month_labels — the window (same as the series query)
  //   metrics        — per (outlet, month) net deviation + total loss
  //                    for ALL outlets in scope (band candidates)
  //   sales          — per (outlet, month) MODE sales
  //   target_sales   — the focus outlet's sales per month
  //   band           — outlets with sales within ±10% of the target's
  //                    sales THAT month (dynamic band, sales > 0)
  //   band_stats     — median loss + size via ROW_NUMBER/COUNT (median
  //                    without ordered-set window aggregates)
  //   ranked         — RANK() per month: net deviation ASC (1 = worst),
  //                    total loss DESC (1 = largest)
  //   final          — target outlet's rows only, chronological
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<PeerTrackRecordRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE o.code = ${outletCode}
        AND ir."weekLabel" = ${week}
        ${monthWindowBound(currentMonthKey)}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${OUTLET_MONTHLY_SERIES_WINDOW_MONTHS}
    ),
    month_labels AS (
      SELECT sf."monthKey", MIN(sf."monthLabel") as "monthLabel"
      FROM "SourceFile" sf
      WHERE sf."monthKey" IN (SELECT "monthKey" FROM months)
      GROUP BY sf."monthKey"
    ),
    metrics AS (
      SELECT
        o.code as "outletCode",
        sf."monthKey",
        COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalLoss"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        AND sf."monthKey" IN (SELECT "monthKey" FROM months)
        ${peerKelompokFilter}
      GROUP BY o.code, sf."monthKey"
    ),
    sales AS (
      SELECT
        o.code as "outletCode",
        ml."monthKey",
        MAX(ops."salesMode") as sales
      FROM "OutletPeriodSales" ops
      JOIN "Outlet" o ON ops."outletId" = o.id
      JOIN month_labels ml ON ml."monthLabel" = ops."monthLabel"
      WHERE ops."weekLabel" = ${week}
      GROUP BY o.code, ml."monthKey"
    ),
    target_sales AS (
      SELECT "monthKey", MAX(sales) as "targetSales"
      FROM sales
      WHERE "outletCode" = ${outletCode}
      GROUP BY "monthKey"
    ),
    band AS (
      SELECT
        m."outletCode",
        m."monthKey",
        COALESCE(s.sales, 0) as "sales",
        m."nominalDeviasi",
        m."totalLoss",
        ts."targetSales"
      FROM metrics m
      JOIN target_sales ts ON ts."monthKey" = m."monthKey"
      LEFT JOIN sales s
        ON s."outletCode" = m."outletCode"
        AND s."monthKey" = m."monthKey"
      WHERE COALESCE(s.sales, 0) > 0
        AND ABS(COALESCE(s.sales, 0) - ts."targetSales") <= ts."targetSales" * 0.1
    ),
    band_stats AS (
      SELECT
        "monthKey",
        AVG("totalLoss") as "medianLoss",
        COUNT(*) as "bandSize"
      FROM (
        SELECT
          b."monthKey",
          b."totalLoss",
          ROW_NUMBER() OVER (PARTITION BY b."monthKey" ORDER BY b."totalLoss") as rn,
          COUNT(*) OVER (PARTITION BY b."monthKey") as n
        FROM band b
      ) x
      WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
      GROUP BY "monthKey"
    ),
    ranked AS (
      SELECT
        b."outletCode",
        b."monthKey",
        b."nominalDeviasi",
        b."totalLoss",
        b."targetSales",
        RANK() OVER (PARTITION BY b."monthKey" ORDER BY b."nominalDeviasi" ASC) as "rankNetDev",
        RANK() OVER (PARTITION BY b."monthKey" ORDER BY b."totalLoss" DESC) as "rankLoss",
        COUNT(*) OVER (PARTITION BY b."monthKey") as "bandSize"
      FROM band b
    )
    SELECT
      r."monthKey",
      ml."monthLabel",
      r."targetSales",
      r."nominalDeviasi",
      r."totalLoss",
      r."rankNetDev",
      r."rankLoss",
      r."bandSize",
      COALESCE(bs."medianLoss", 0) as "medianLoss"
    FROM ranked r
    JOIN month_labels ml ON ml."monthKey" = r."monthKey"
    LEFT JOIN band_stats bs ON bs."monthKey" = r."monthKey"
    WHERE r."outletCode" = ${outletCode}
    ORDER BY r."monthKey" ASC
  `);

  const mapped: PeerTrackRecordRow[] = rows.map((r) => ({
    monthKey: r.monthKey,
    monthLabel: r.monthLabel,
    targetSales: toNum(r.targetSales),
    nominalDeviasi: toNum(r.nominalDeviasi),
    totalLoss: toNum(r.totalLoss),
    rankNetDev: toNum(r.rankNetDev),
    rankLoss: toNum(r.rankLoss),
    bandSize: toNum(r.bandSize),
    medianLoss: toNum(r.medianLoss),
  }));
  return { rows: mapped, summary: summarizeTrackRecord(mapped) };
}
