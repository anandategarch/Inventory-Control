// ============================================================
//  Peer Track Record — queryPeerTrackRecord (DEEP-RESTO-1)
//  --------------------------------------------------------
//  GODSPLIT-W3-A: moved verbatim out of outlet-monthly-series.ts
//  (was a 506-LOC two-pipeline file; findings-GODSPLIT-A #4) —
//  named after its own route, mirroring waste/peer-zscore.ts.
//  The monthly-series pipeline lives in ./monthly-series.ts
//  (window constant OUTLET_MONTHLY_SERIES_WINDOW_MONTHS + the
//  GRAIN header); outlet-monthly-series.ts is now a barrel.
//  toNum + monthWindowBound are IMPORTED from ../waste/shared —
//  verbatim duplicates consolidated at GODSPLIT-W3-A (they were
//  flagged in waste/shared.ts at GODSPLIT-W1-B).
//
//  Multi-month, SAME-weekLabel peer view for ONE outlet — the
//  in-app version of the "Peer Comparison track-record" sheet
//  from the offline deep resto analysis (Analisa-Anomali-
//  TJPPLU report):
//
//  2. queryPeerTrackRecord — for the SAME window, per month:
//       the dynamic sales band (outlets with sales within ±10%
//       of the target's sales THAT month — band membership is
//       recomputed per month, matching /api/peer-comparison),
//       the target's rank inside the band on net deviation
//       (1 = most negative = TERBURUK) and total loss
//       (1 = largest), band size, and the band's median loss.
//
//  GRAIN: the SAME same-week month window as ./monthly-series.ts
//  (see its header, moved verbatim); the window SQL fragment
//  itself lives in ../waste/shared.ts (monthWindowBound).
//
//  Median loss uses the classic ROW_NUMBER/COUNT window form
//  (AVG of the middle 1-2 rows) because PostgreSQL ordered-set
//  aggregates (PERCENTILE_CONT) cannot be used as window
//  functions.
//
//  PURELY ADDITIVE: feeds the /api/peer-track-record route used
//  by the Resto tab's "Riwayat Multi-Bulan" section
//  (PeerTrackRecordCard).
// ============================================================
import { Prisma } from '@prisma/client';
import { withStatementTimeout } from '../shared';
import { monthWindowBound, toNum } from '../waste/shared';
import { OUTLET_MONTHLY_SERIES_WINDOW_MONTHS } from './monthly-series';
// GODSPLIT-W4: ±10% band predicate — shared builder (was inline text
// here; strict targetSales-alias variant).
import { peerBandPredicate } from './peer-band';

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
        ${peerBandPredicate('s.sales', 'ts."targetSales"')}
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
