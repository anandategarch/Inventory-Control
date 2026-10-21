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
//
//  PERF-FILTER1 (B): the heavy multi-month × all-outlet scan now
//  lives in ../outlets/peer-band-scan.ts as ONE shared, cached,
//  outlet-independent row ('q-peer-band-scan' — 30-min TTL,
//  mutation-invalidated; the same row also serves peer-track-
//  record + outlet-monthly-series). This module keeps its public
//  signature; the per-outlet band/rank/z-score math is the PURE
//  function below (computeWastePeerZScoreFromScan — exported for
//  vitest). Behavior mirrors the former SQL exactly: RANK()
//  wasteToSales DESC with ties sharing a rank, band mean via AVG,
//  bandStd via STDDEV_SAMP (0 when n < 2 — the SQL COALESCE),
//  and z guarded on bandSize ≥ WASTE_ZSCORE_MIN_BAND AND std > 0.
// ============================================================
import { WASTE_WINDOW_MONTHS, WASTE_ZSCORE_MIN_BAND } from './shared';
import {
  buildPeerBands,
  getPeerBandScan,
  rankWithTies,
  stddevSamp,
  type PeerBandScan,
} from '../outlets/peer-band-scan';

// ------------------------------------------------------------
// 2. Peer waste z-score — types
// ------------------------------------------------------------

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
// 2. queryWastePeerZScore — shared-scan + pure compute
// ------------------------------------------------------------

/**
 * Compute the waste peer z-score view for ONE outlet from the shared band
 * scan (pure — no DB). Mirrors the former SQL's band_ratio/stats/ranked
 * CTEs:
 *
 *   wasteToSales  = waste / sales (members all have sales > 0)
 *   rankWasteToSales = RANK() OVER (PARTITION BY month ORDER BY
 *                     wasteToSales DESC) — 1 = highest
 *   bandMean      = AVG(wasteToSales) over the band
 *   bandStd       = STDDEV_SAMP(wasteToSales) (0 when n < 2)
 *   zScore        = (wasteToSales − bandMean) / bandStd, guarded on
 *                   bandSize ≥ WASTE_ZSCORE_MIN_BAND AND bandStd > 0
 */
export function computeWastePeerZScoreFromScan(
  scan: PeerBandScan,
  outletCode: string,
  kelompok?: string | null,
  windowMonths: number = WASTE_WINDOW_MONTHS,
): { rows: WastePeerZScoreRow[]; summary: WastePeerZScoreSummary } {
  const bands = buildPeerBands(scan, outletCode, windowMonths, kelompok);
  const rows: WastePeerZScoreRow[] = bands.map((band) => {
    const ratios = band.members.map((m) => m.waste / m.sales);
    const targetRatio = band.target.waste / band.targetSales;
    // RANK() DESC with ties sharing a rank (SQL RANK semantics).
    const ranks = rankWithTies(band.members, (a, b) => a.waste / a.sales > b.waste / b.sales);
    const targetIdx = band.members.indexOf(band.target);
    const bandMean = ratios.length > 0 ? ratios.reduce((s, v) => s + v, 0) / ratios.length : 0;
    const bandStd = stddevSamp(ratios);
    const bandSize = band.members.length;
    const zScore = bandSize >= WASTE_ZSCORE_MIN_BAND && bandStd > 0
      ? (targetRatio - bandMean) / bandStd
      : null;
    return {
      monthKey: band.monthKey,
      monthLabel: band.monthLabel,
      targetSales: band.targetSales,
      waste: band.target.waste,
      wasteToSales: targetRatio,
      rankWasteToSales: ranks[targetIdx],
      bandSize,
      bandMean,
      bandStd,
      zScore,
    };
  });
  return { rows, summary: summarizeWastePeerZScore(rows) };
}

export async function queryWastePeerZScore(
  outletCode: string,
  week: string,
  currentMonthKey: string | null,
  kelompok?: string | null,
): Promise<{ rows: WastePeerZScoreRow[]; summary: WastePeerZScoreSummary }> {
  // PERF-FILTER1 (B): ONE shared cached scan (all outlets × window months)
  // replaces the per-outlet multi-month SQL — the scan row is shared with
  // peer-track-record + outlet-monthly-series (same week/monthKey).
  const scan = await getPeerBandScan(week, currentMonthKey);
  return computeWastePeerZScoreFromScan(scan, outletCode, kelompok);
}
