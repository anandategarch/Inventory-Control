// ============================================================
//  Outlet Monthly Series — queryOutletMonthlySeries (DEEP-RESTO-1)
//  --------------------------------------------------------
//  GODSPLIT-W3-A: moved verbatim out of outlet-monthly-series.ts
//  (was a 506-LOC two-pipeline file; findings-GODSPLIT-A #4).
//  The track-record pipeline lives in ./peer-track-record.ts;
//  outlet-monthly-series.ts is now a barrel. toNum + monthWindow-
//  Bound were verbatim duplicates of waste/shared.ts (flagged
//  there at GODSPLIT-W1-B) — now IMPORTED from ../waste/shared
//  instead of redefined: the consolidation the audit asked for
//  (implementations compared verbatim — identical).
//
//  Multi-month, SAME-weekLabel view for ONE outlet — the in-app
//  version of the "Deret Bulanan" sheet from the offline deep
//  resto analysis (Analisa-Anomali-TJPPLU report). The sibling
//  "Peer Comparison track-record" view (queryPeerTrackRecord) is
//  in ./peer-track-record.ts.
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
//  PURELY ADDITIVE: feeds the /api/outlet-monthly-series route
//  used by the Resto tab's "Riwayat Multi-Bulan" section
//  (MonthlySeriesCard).
// ============================================================
import { toNum } from '../waste/shared';
import { getPeerBandScan, selectTargetScanRows, type PeerBandScan } from './peer-band-scan';
import { DASHBOARD_LOOKBACK_MONTHS } from '../window-config';

/**
 * Max months in the series / track-record window (incl. running month).
 * PERF-FILTER3 ("3 BULAN"): 12 → DASHBOARD_LOOKBACK_MONTHS (3) — see
 * window-config.ts. Also the default window for queryPeerTrackRecord.
 */
export const OUTLET_MONTHLY_SERIES_WINDOW_MONTHS = DASHBOARD_LOOKBACK_MONTHS;

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
// Pure transforms (exported for vitest — same pattern as
// change-analysis.ts compute/classify split)
// ------------------------------------------------------------

/**
 * monthKey "YYYY-MM" → absolute month index (year*12 + month) so calendar
 * adjacency is a plain −1 check — the SAME parsing convention as
 * outlet-recurrence.ts's SQL `mIdx` (BUG-2-c). Malformed keys yield NaN,
 * which never equals an adjacent gap → MoM nulls out (safe fallback).
 */
function monthIndex(monthKey: string): number {
  const parts = monthKey.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return Number.isFinite(y) && Number.isFinite(m) ? y * 12 + m : Number.NaN;
}

/**
 * Map raw SQL rows → MonthlySeriesRow[] (chronological, monthKey ASC —
 * the SQL already orders) adding MoM sales growth, Net Cost Ratio and
 * the recurrence-style abnormal flag.
 *
 * BUGHUNT-R1 FIX 8: MoM is only computed between CALENDAR-ADJACENT months.
 * A month with no data simply doesn't appear as a row, so the old
 * consecutive-row comparison bridged data gaps — if April was missing,
 * May's "MoM" silently compared against March (a 2-month jump presented
 * as a 1-month growth rate).
 */
export function buildMonthlySeriesRows(
  raw: MonthlySeriesRawRow[],
  toleranceFallback: number,
  highLossNominal: number,
): MonthlySeriesRow[] {
  return raw.map((r, i) => {
    const sales = toNum(r.sales);
    const prevSales = i > 0 ? toNum(raw[i - 1].sales) : null;
    const adjacent = i > 0 && monthIndex(r.monthKey) - monthIndex(raw[i - 1].monthKey) === 1;
    return {
      monthKey: r.monthKey,
      monthLabel: r.monthLabel,
      sales,
      salesMoM: adjacent && prevSales !== null && prevSales !== 0
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
  // PERF-FILTER1 (B): the per-outlet multi-month SQL is replaced by the
  // SHARED cached band scan ('q-peer-band-scan' — one row per (outlet,
  // month) for ALL outlets, 30-min TTL, mutation-invalidated; the same
  // row also serves peer-track-record + waste-peer-zscore). The target
  // outlet's rows are selected + mapped through the SAME pure builders
  // (buildMonthlySeriesRows/Total) — column-for-column identical to the
  // old SQL: qtyBom=ΣABS, nominalDeviasi signed, devBom=ΣABS(qtyDeviasi)
  // /ΣABS(qtyBom) (0 when qtyBom=0), sales=MAX(salesMode) (0 when
  // absent), totalLoss/totalSurplus from the nominalLossSurplus sign
  // convention.
  const scan = await getPeerBandScan(week, currentMonthKey);
  return computeOutletMonthlySeriesFromScan(
    scan, outletCode, toleranceFallback, highLossNominal,
  );
}

/**
 * Pure scan→series mapping (exported for vitest). selectTargetScanRows
 * applies the SAME window rule the old `months ... LIMIT 12` CTE used
 * (the target's most recent OUTLET_MONTHLY_SERIES_WINDOW_MONTHS
 * same-week months, chronological).
 */
export function computeOutletMonthlySeriesFromScan(
  scan: PeerBandScan,
  outletCode: string,
  toleranceFallback: number,
  highLossNominal: number,
): { rows: MonthlySeriesRow[]; total: MonthlySeriesTotal } {
  const targetRows = selectTargetScanRows(scan, outletCode, OUTLET_MONTHLY_SERIES_WINDOW_MONTHS);
  const raw: MonthlySeriesRawRow[] = targetRows.map((r) => ({
    monthKey: r.monthKey,
    monthLabel: r.monthLabel,
    sales: r.sales,
    qtyBom: r.absQtyBom,
    nominalDeviasi: r.nominalDeviasi,
    devBom: r.absQtyBom > 0 ? r.absQtyDeviasi / r.absQtyBom : 0,
    totalLoss: r.totalLoss,
    totalSurplus: r.totalSurplus,
  }));
  const mapped = buildMonthlySeriesRows(raw, toleranceFallback, highLossNominal);
  return { rows: mapped, total: buildMonthlySeriesTotal(mapped) };
}
