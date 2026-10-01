// ============================================================
//  Waste Peer Z-Score — queryWastePeerZScore (DEEP-WASTE-2)
//  --------------------------------------------------------
//  GODSPLIT-W1-B: moved verbatim out of waste-series.ts (was a
//  773-LOC two-pipeline monolith). Shared window constants +
//  helpers live in ./shared.ts; the network pipeline lives in
//  ./network.ts; waste-series.ts is now a barrel.
//
//  Multi-month, SAME-weekLabel peer view — the offline deep
//  waste report's "TJPPLU Fokus" case made per-outlet:
//
//  queryWastePeerZScore — for ONE outlet, per month: the SAME
//     dynamic ±10% sales band as peer-track-record.ts (band
//     membership recomputed per month; kelompok scopes the peer
//     set, the focus outlet is always included), the outlet's
//     waste/sales, its rank inside the band (1 = highest
//     waste/sales), band mean/std, and the outlet's z-score vs
//     the band (only when bandSize ≥ 3 and std > 0).
//
//  GRAIN + sales MODE conventions: see ./shared.ts (moved
//  verbatim). PURELY ADDITIVE: feeds the /api/waste-peer-zscore
//  route used by the Resto tab's "Profil Waste" card.
// ============================================================
import { Prisma } from '@prisma/client';
import { withStatementTimeout } from '../shared';
import { monthWindowBound, toNum, WASTE_WINDOW_MONTHS, WASTE_ZSCORE_MIN_BAND } from './shared';
// GODSPLIT-W4: ±10% band predicate — shared builder (was inline text
// here; strict targetSales-alias variant, same as outlets/peer-track-record).
import { peerBandPredicate } from '../outlets/peer-band';

// ------------------------------------------------------------
// 2. Peer waste z-score — types
// ------------------------------------------------------------

interface WastePeerZScoreRawRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number | bigint;
  waste: number | bigint;
  wasteToSales: number | bigint;
  rankWasteToSales: number | bigint;
  bandSize: number | bigint;
  bandMean: number | bigint;
  bandStd: number | bigint;
  zScore: number | null;
}

export interface WastePeerZScoreRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number;
  waste: number;
  wasteToSales: number;
  /** 1 = highest waste/sales in the band that month. */
  rankWasteToSales: number;
  bandSize: number;
  /** Mean waste/sales across the band (0 when band degenerate). */
  bandMean: number;
  /** StdDev of waste/sales across the band (0 when degenerate). */
  bandStd: number;
  /** (wasteToSales − bandMean) / bandStd — null when bandSize < 3 or std = 0. */
  zScore: number | null;
}

export interface WastePeerZScoreSummary {
  monthsTracked: number;
  /** Average z across months with a defined z (null when none). */
  avgZ: number | null;
  /** Months with z > 1. */
  monthsZAbove1: number;
  /** Months with z > 2. */
  monthsZAbove2: number;
  /** Months ranked #1 highest waste/sales in the band. */
  monthsHighestWaste: number;
  /** First → last month target sales growth (fraction; null when not computable). */
  salesGrowth: number | null;
  /** "Paradox" outlet: sales grew AND avg z > 1. */
  paradox: boolean;
  lastMonthLabel: string | null;
  lastWasteToSales: number | null;
  lastRankWasteToSales: number | null;
  lastZScore: number | null;
  lastBandSize: number | null;
}

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

/** Peer z-score summary (pure) — averages, worst-month counts, paradox flag. */
export function summarizeWastePeerZScore(rows: WastePeerZScoreRow[]): WastePeerZScoreSummary {
  if (rows.length === 0) {
    return {
      monthsTracked: 0,
      avgZ: null,
      monthsZAbove1: 0,
      monthsZAbove2: 0,
      monthsHighestWaste: 0,
      salesGrowth: null,
      paradox: false,
      lastMonthLabel: null,
      lastWasteToSales: null,
      lastRankWasteToSales: null,
      lastZScore: null,
      lastBandSize: null,
    };
  }
  const zs = rows.map((r) => r.zScore).filter((z): z is number => z != null);
  const avgZ = zs.length > 0 ? zs.reduce((a, z) => a + z, 0) / zs.length : null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const salesGrowth = first.targetSales > 0 && last.targetSales > 0
    ? last.targetSales / first.targetSales - 1
    : null;
  const monthsHighestWaste = rows.filter((r) => r.rankWasteToSales === 1).length;
  return {
    monthsTracked: rows.length,
    avgZ,
    monthsZAbove1: zs.filter((z) => z > 1).length,
    monthsZAbove2: zs.filter((z) => z > 2).length,
    monthsHighestWaste,
    salesGrowth,
    // "Paradox" (the offline report's TJPPLU case): sales grew while the
    // outlet's waste/sales stayed extreme vs its sales band.
    paradox: Boolean(salesGrowth != null && salesGrowth > 0 && (avgZ == null ? false : avgZ > 1)),
    lastMonthLabel: last.monthLabel,
    lastWasteToSales: last.wasteToSales,
    lastRankWasteToSales: last.rankWasteToSales,
    lastZScore: last.zScore,
    lastBandSize: last.bandSize,
  };
}

// ------------------------------------------------------------
// 2. queryWastePeerZScore
// ------------------------------------------------------------

export async function queryWastePeerZScore(
  outletCode: string,
  week: string,
  currentMonthKey: string | null,
  kelompok?: string | null,
): Promise<{ rows: WastePeerZScoreRow[]; summary: WastePeerZScoreSummary }> {
  // kelompok scopes the PEER set only — the focus outlet is always
  // included (same predicate as peer-track-record.ts).
  const peerKelompokFilter = kelompok
    ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
    : Prisma.empty;

  // Shape (mirrors queryPeerTrackRecord with the waste metric):
  //   months / month_labels — the window for THIS outlet
  //   metrics        — per (outlet, month) ΣABS nominalWaste for ALL
  //                    outlets in scope (band candidates)
  //   sales          — per (outlet, month) MODE sales
  //   target_sales   — the focus outlet's sales per month
  //   band           — outlets with sales within ±10% of the target's
  //                    sales THAT month (dynamic, sales > 0)
  //   band_ratio     — band + wasteToSales ratio per member
  //   stats          — per month band mean/stddev_samp/count of the ratio
  //   ranked         — RANK() per month on waste/sales DESC (1 = highest)
  //   final          — target outlet's rows, chronological
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<WastePeerZScoreRawRow[]>`
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
      LIMIT ${WASTE_WINDOW_MONTHS}
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
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste"
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
        m.waste,
        ts."targetSales"
      FROM metrics m
      JOIN target_sales ts ON ts."monthKey" = m."monthKey"
      LEFT JOIN sales s
        ON s."outletCode" = m."outletCode"
        AND s."monthKey" = m."monthKey"
      WHERE COALESCE(s.sales, 0) > 0
        ${peerBandPredicate('s.sales', 'ts."targetSales"')}
    ),
    band_ratio AS (
      SELECT b.*,
        b.waste / b.sales as "wasteToSales"
      FROM band b
    ),
    stats AS (
      SELECT "monthKey",
        AVG("wasteToSales") as "bandMean",
        COALESCE(STDDEV_SAMP("wasteToSales"), 0) as "bandStd",
        COUNT(*) as "bandSize"
      FROM band_ratio
      GROUP BY "monthKey"
    ),
    ranked AS (
      SELECT
        b."outletCode",
        b."monthKey",
        b."targetSales",
        b.waste,
        b."wasteToSales",
        RANK() OVER (PARTITION BY b."monthKey" ORDER BY b."wasteToSales" DESC) as "rankWasteToSales",
        COUNT(*) OVER (PARTITION BY b."monthKey") as "bandSize"
      FROM band_ratio b
    )
    SELECT
      r."monthKey",
      ml."monthLabel",
      r."targetSales",
      r.waste,
      r."wasteToSales",
      r."rankWasteToSales",
      r."bandSize",
      COALESCE(st."bandMean", 0) as "bandMean",
      COALESCE(st."bandStd", 0) as "bandStd",
      CASE
        WHEN st."bandSize" >= ${WASTE_ZSCORE_MIN_BAND} AND st."bandStd" > 0
          THEN (r."wasteToSales" - st."bandMean") / st."bandStd"
        ELSE NULL END as "zScore"
    FROM ranked r
    JOIN month_labels ml ON ml."monthKey" = r."monthKey"
    LEFT JOIN stats st ON st."monthKey" = r."monthKey"
    WHERE r."outletCode" = ${outletCode}
    ORDER BY r."monthKey" ASC
  `);

  const mapped: WastePeerZScoreRow[] = rows.map((r) => ({
    monthKey: r.monthKey,
    monthLabel: r.monthLabel,
    targetSales: toNum(r.targetSales),
    waste: toNum(r.waste),
    wasteToSales: toNum(r.wasteToSales),
    rankWasteToSales: toNum(r.rankWasteToSales),
    bandSize: toNum(r.bandSize),
    bandMean: toNum(r.bandMean),
    bandStd: toNum(r.bandStd),
    zScore: r.zScore == null ? null : Number(r.zScore),
  }));
  return { rows: mapped, summary: summarizeWastePeerZScore(mapped) };
}
