// ============================================================
//  Peer Band Scan — ONE shared national scan for the Resto tab's
//  band-family queries (PERF-FILTER1 / B)
//  --------------------------------------------------------
//  Consumers (all previously re-scanned the SAME multi-month ×
//  all-outlet tables independently, keyed per OUTLET — so every
//  "Filter Resto" selection re-paid the full cold compute):
//    1. queryPeerTrackRecord   (peer-track-record.ts)     — ±10%
//       sales-band rank on net deviation / total loss + median
//    2. queryWastePeerZScore   (waste/peer-zscore.ts)     — waste/
//       sales z-score vs the same band
//    3. queryOutletMonthlySeries (monthly-series.ts)      — the
//       target outlet's own per-month aggregates (sales/qtyBom/
//       devBom/loss/surplus)
//
//  PERF-FILTER1 (B): the scan is OUTLET-INDEPENDENT — one row per
//  (outlet × month) for EVERY outlet, plus the month labels — so it
//  is cached under 'q-peer-band-scan' keyed ONLY by (week,
//  currentMonthKey). The per-outlet band/rank/z-score math moves to
//  pure JS (peer-band compute functions in each consumer module),
//  which runs in microseconds on the ≤ ~4K-row scan. Switching the
//  Filter Resto outlet after the first view of a period therefore
//  costs ONE ~300KB cache read instead of a fresh 7-14s SQL pass.
//
//  Kelompok scoping note: the OLD per-outlet SQL embedded
//  `(o.code = ${outletCode} OR LEFT(SUBSTRING(...)) = kelompok)`
//  inside the metrics CTE, making the scan itself target-dependent.
//  The shared scan drops that predicate ENTIRELY (all outlets) and
//  the JS band builder re-applies the EXACT same membership rule
//  (target always in scope + kelompok match via
//  extractKelompokFromCode — the JS twin of the SQL expression, see
//  kelompok-resolver.ts). Result: one scan row serves every outlet
//  AND every kelompok value.
//
//  Window: the consumers each want the target's most recent 12
//  same-week months. The scan fetches the most recent
//  PEER_BAND_SCAN_WINDOW_MONTHS (24) months of the UNION month set
//  (months where ANY outlet has records for the weekLabel) — 2×
//  headroom so any single outlet's last-12 is fully contained for
//  any outlet whose active span fits in 24 months (guaranteed while
//  total data history ≤ 24 months; the drift edge — an outlet whose
//  data ends > 24 months before currentMonthKey — merely shows a
//  shorter window, never wrong numbers).
//
//  Freshness: cachedSharedQuery TTL 30 min + mutation-triggered
//  invalidation ('q-peer-band-scan' is listed in invalidate.ts's
//  routes array) — the same contract as every other q-* row.
// ============================================================
import { withStatementTimeout, type SqlFilterOpts } from '../shared';
import { monthWindowBound } from '../waste/shared';
import { cachedSharedQuery } from '../query-cache';
import { extractKelompokFromCode } from '@/lib/kelompok-resolver';

// ------------------------------------------------------------
// Constants + shared pure helpers
// ------------------------------------------------------------

/**
 * Months fetched by the shared scan (union month set, ≤ currentMonthKey).
 * 2× the consumers' 12-month windows — see module header.
 */
export const PEER_BAND_SCAN_WINDOW_MONTHS = 24;

/** ±10% band tolerance — the JS twin of peerBandPredicate's SQL literal. */
export { PEER_BAND_TOLERANCE } from './peer-band';

/**
 * RANK() semantics in JS: 1 + count(strictly better) — ties SHARE a rank,
 * exactly like SQL RANK() OVER (ORDER BY ...). `better` must report
 * whether its first argument (the candidate being scored) ranks strictly
 * above its second (the row being scored against).
 */
// eslint-disable-next-line no-unused-vars -- plain rule mis-flags TYPE-position params (pre-existing class; the @typescript-eslint twin is authoritative)
export function rankWithTies<T>(items: T[], better: (candidate: T, baseline: T) => boolean): number[] {
  return items.map((row) => 1 + items.filter((other) => other !== row && better(other, row)).length);
}

/**
 * Median via the classic ROW_NUMBER/COUNT window form the SQL used:
 * AVG of the middle 1 (odd n) or 2 (even n) values of the ASC-sorted
 * list — indexes (n-1)/2 floor+ceil reproduce PG's integer-division
 * rn IN ((n+1)/2, (n+2)/2) row selection exactly.
 */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor((n - 1) / 2);
  const a = sorted[mid];
  const b = sorted[Math.ceil((n - 1) / 2)];
  return (a + b) / 2;
}

/**
 * STDDEV_SAMP (sample standard deviation) — the JS twin of the SQL
 * aggregate the z-score pass used. n < 2 → 0 (SQL returns NULL, which
 * the old query COALESCEd to 0).
 */
export function stddevSamp(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const ss = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return Math.sqrt(ss / (n - 1));
}

// SQL-expression twin: the old metrics CTE scoped peers with
// LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(kelompok) —
// extractKelompokFromCode is that expression's JS counterpart (see
// kelompok-resolver.ts header).
function kelompokOf(code: string): string {
  return extractKelompokFromCode(code);
}

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** One (outlet × month) row of the shared scan — JSON-safe (cached). */
export interface PeerBandScanRow {
  monthKey: string;
  monthLabel: string;
  outletCode: string;
  /** Signed Σ nominalDeviasi. */
  nominalDeviasi: number;
  /** Σ|nominalLossSurplus| over loss-side (< 0) rows. */
  totalLoss: number;
  /** Σ nominalLossSurplus over surplus-side (> 0) rows. */
  totalSurplus: number;
  /** Σ|nominalWaste|. */
  waste: number;
  /** Σ|qtyDeviasi|. */
  absQtyDeviasi: number;
  /** Σ|qtyBom|. */
  absQtyBom: number;
  /** MAX(salesMode) for (outlet, month, week) — 0 when absent. */
  sales: number;
}

export interface PeerBandScan {
  rows: PeerBandScanRow[];
}

/** No-OP filter set — the scan is deliberately unfiltered (national). */
const NO_FILTERS: SqlFilterOpts = {
  area: null,
  kelompok: null,
  outletCode: null,
  itemName: null,
  picOutletCodes: null,
};

// ------------------------------------------------------------
//  The scan SQL
// ------------------------------------------------------------

interface PeerBandScanRawRow {
  monthKey: string;
  monthLabel: string;
  outletCode: string;
  nominalDeviasi: number | bigint;
  totalLoss: number | bigint;
  totalSurplus: number | bigint;
  waste: number | bigint;
  absQtyDeviasi: number | bigint;
  absQtyBom: number | bigint;
  sales: number | bigint | null;
}

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function queryPeerBandScan(
  week: string,
  currentMonthKey: string | null,
): Promise<PeerBandScan> {
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<PeerBandScanRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        ${monthWindowBound(currentMonthKey)}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${PEER_BAND_SCAN_WINDOW_MONTHS}
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
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalLoss",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "totalSurplus",
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste",
        COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) as "absQtyDeviasi",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "absQtyBom"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        AND sf."monthKey" IN (SELECT "monthKey" FROM months)
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
    )
    SELECT
      m."monthKey",
      ml."monthLabel",
      m."outletCode",
      m."nominalDeviasi",
      m."totalLoss",
      m."totalSurplus",
      m.waste,
      m."absQtyDeviasi",
      m."absQtyBom",
      COALESCE(s.sales, 0) as "sales"
    FROM metrics m
    JOIN month_labels ml ON ml."monthKey" = m."monthKey"
    LEFT JOIN sales s
      ON s."outletCode" = m."outletCode"
      AND s."monthKey" = m."monthKey"
    ORDER BY m."monthKey" ASC, m."outletCode" ASC
  `);
  return {
    rows: rows.map((r) => ({
      monthKey: r.monthKey,
      monthLabel: r.monthLabel,
      outletCode: r.outletCode,
      nominalDeviasi: toNum(r.nominalDeviasi),
      totalLoss: toNum(r.totalLoss),
      totalSurplus: toNum(r.totalSurplus),
      waste: toNum(r.waste),
      absQtyDeviasi: toNum(r.absQtyDeviasi),
      absQtyBom: toNum(r.absQtyBom),
      sales: toNum(r.sales),
    })),
  };
}

// ------------------------------------------------------------
//  Cached entry point
// ------------------------------------------------------------

/**
 * Get the shared band scan for (week, currentMonthKey) — cached 30 min
 * under 'q-peer-band-scan' (invalidated by every mutation). Concurrent
 * callers for DIFFERENT outlets with the same period dedupe onto the
 * in-flight compute via withCacheAndDedup.
 *
 * The `month` cache-key part uses currentMonthKey ('ALL' when null —
 * deterministic sentinel-free literal) because the scan's response-
 * affecting inputs are exactly (week, upper monthKey bound).
 */
export async function getPeerBandScan(week: string, currentMonthKey: string | null): Promise<PeerBandScan> {
  // awaitWrite=true (PERF-FILTER1 B write-durability): production
  // verification showed the fire-and-forget after() write does NOT
  // reliably land on the deployment — awaiting costs ~150-300ms ONCE per
  // (week, monthKey) and guarantees the 30-min warm window for every
  // subsequent outlet switch.
  return cachedSharedQuery<PeerBandScan>(
    'q-peer-band-scan',
    {
      month: currentMonthKey ?? 'ALL',
      week,
      filters: NO_FILTERS,
      extra: { w: PEER_BAND_SCAN_WINDOW_MONTHS },
    },
    () => queryPeerBandScan(week, currentMonthKey),
    true,
  );
}

// ------------------------------------------------------------
//  Shared band-building pure helpers (consumed by the 3 queries)
// ------------------------------------------------------------

/** The ±10% band membership test — JS twin of peerBandPredicate variant C. */
export function inPeerBand(sales: number, targetSales: number): boolean {
  // The SQL guard was COALESCE(sales, 0) > 0 (stored as 0 when absent —
  // handled by the caller's sales > 0 filter) + ABS(sales - targetSales)
  // <= targetSales * 0.1.
  return sales > 0 && Math.abs(sales - targetSales) <= targetSales * 0.1;
}

/**
 * Select the target outlet's rows from the scan, chronological, capped
 * to the consumer's window — the JS twin of the OLD per-outlet
 * `months ... LIMIT ${windowMonths}` CTE (see peer-band-scan header for
 * the 24-month scan headroom that guarantees containment).
 */
export function selectTargetScanRows(
  scan: PeerBandScan,
  outletCode: string,
  windowMonths: number,
): PeerBandScanRow[] {
  return scan.rows
    .filter((r) => r.outletCode === outletCode)
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    .slice(-windowMonths);
}

/**
 * Build the per-month ±10% band around the target outlet.
 * Returns one entry per month where the target CAN be ranked
 * (target has a metrics row AND targetSales > 0 — the old inner-join
 * semantics: months without positive target sales never produced a
 * band row, so the final WHERE outletCode = target dropped them).
 *
 * kelompok scopes the PEER set only — the target is always included
 * (same predicate as the old SQL's `(o.code = ${outletCode} OR
 * LEFT(SUBSTRING(...)))`, re-applied via extractKelompokFromCode).
 */
export interface PeerBandMonth {
  monthKey: string;
  monthLabel: string;
  targetSales: number;
  /** Band members (INCLUDING the target) — scan rows. */
  members: PeerBandScanRow[];
  target: PeerBandScanRow;
}

export function buildPeerBands(
  scan: PeerBandScan,
  outletCode: string,
  windowMonths: number,
  kelompok?: string | null,
): PeerBandMonth[] {
  const targetRows = selectTargetScanRows(scan, outletCode, windowMonths);
  const kelompokUpper = kelompok ? kelompok.toUpperCase() : null;
  const rowsByMonth = new Map<string, PeerBandScanRow[]>();
  for (const r of scan.rows) {
    const list = rowsByMonth.get(r.monthKey);
    if (list) list.push(r);
    else rowsByMonth.set(r.monthKey, [r]);
  }
  const bands: PeerBandMonth[] = [];
  for (const target of targetRows) {
    const targetSales = target.sales;
    // Old semantics: no positive target sales → no target_sales row →
    // the band CTE's inner JOIN drops the month → target absent from
    // the final SELECT. Skip the month entirely (same outcome).
    if (!(targetSales > 0)) continue;
    const kelompokScoped = kelompokUpper
      ? (rowsByMonth.get(target.monthKey) ?? []).filter(
          (r) => r.outletCode === outletCode || kelompokOf(r.outletCode) === kelompokUpper,
        )
      : rowsByMonth.get(target.monthKey) ?? [];
    const members = kelompokScoped.filter((r) => inPeerBand(r.sales, targetSales));
    bands.push({ monthKey: target.monthKey, monthLabel: target.monthLabel, targetSales, members, target });
  }
  return bands;
}

// SQL-expression twin: the old metrics CTE scoped peers with
// LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(kelompok) —
// extractKelompokFromCode is that expression's JS counterpart (see
// kelompok-resolver.ts header).
