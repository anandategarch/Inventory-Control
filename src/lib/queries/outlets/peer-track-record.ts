// ============================================================
//  Peer Track Record — queryPeerTrackRecord (DEEP-RESTO-1)
//  --------------------------------------------------------
//  GODSPLIT-W3-A: moved verbatim out of outlet-monthly-series.ts
//  (was a 506-LOC two-pipeline file; findings-GODSPLIT-A #4) —
//  named after its own route, mirroring waste/peer-zscore.ts.
//  The monthly-series pipeline lives in ./monthly-series.ts
//  (window constant OUTLET_MONTHLY_SERIES_WINDOW_MONTHS + the
//  GRAIN header); outlet-monthly-series.ts is now a barrel.
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
//
//  PERF-FILTER1 (B): the heavy multi-month × all-outlet scan now
//  lives in ./peer-band-scan.ts as ONE shared, cached, outlet-
//  independent row ('q-peer-band-scan' — 30-min TTL, mutation-
//  invalidated). This module keeps its public signature but the
//  per-outlet band/rank/median math is the PURE function below
//  (computePeerTrackRecordFromScan — exported for vitest, same
//  compute/classify split convention as monthly-series.ts).
//  Behavior is byte-equivalent to the former SQL: RANK() ties
//  share a rank, the median is the AVG of the middle 1-2 rows,
//  months without positive target sales are absent (the old
//  target_sales inner-join semantics), and kelompok scopes the
//  peer set while ALWAYS keeping the focus outlet in scope.
// ============================================================
import { OUTLET_MONTHLY_SERIES_WINDOW_MONTHS } from './monthly-series';
import {
  buildPeerBands,
  getPeerBandScan,
  medianOf,
  rankWithTies,
  type PeerBandScan,
} from './peer-band-scan';

// ------------------------------------------------------------
// 2. Peer track record — types
// ------------------------------------------------------------

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
// 2. queryPeerTrackRecord — shared-scan + pure compute
// ------------------------------------------------------------

/**
 * Compute the track record for ONE outlet from the shared band scan
 * (pure — no DB). Mirrors the former SQL's band/ranked/band_stats CTEs:
 *
 *   rankNetDev = RANK() OVER (PARTITION BY month ORDER BY
 *                nominalDeviasi ASC)  — 1 = most negative = TERBURUK
 *   rankLoss   = RANK() OVER (PARTITION BY month ORDER BY
 *                totalLoss DESC)      — 1 = largest
 *   bandSize   = COUNT(*) OVER (PARTITION BY month)
 *   medianLoss = AVG of the middle 1-2 totalLoss values (the
 *                ROW_NUMBER/COUNT median form)
 */
export function computePeerTrackRecordFromScan(
  scan: PeerBandScan,
  outletCode: string,
  kelompok?: string | null,
  windowMonths: number = OUTLET_MONTHLY_SERIES_WINDOW_MONTHS,
): { rows: PeerTrackRecordRow[]; summary: PeerTrackRecordSummary } {
  const bands = buildPeerBands(scan, outletCode, windowMonths, kelompok);
  const rows: PeerTrackRecordRow[] = bands.map((band) => {
    // RANK() with ties sharing a rank (SQL RANK semantics).
    const ranksNetDev = rankWithTies(band.members, (a, b) => a.nominalDeviasi < b.nominalDeviasi);
    const ranksLoss = rankWithTies(band.members, (a, b) => a.totalLoss > b.totalLoss);
    const targetIdx = band.members.indexOf(band.target);
    return {
      monthKey: band.monthKey,
      monthLabel: band.monthLabel,
      targetSales: band.targetSales,
      nominalDeviasi: band.target.nominalDeviasi,
      totalLoss: band.target.totalLoss,
      rankNetDev: ranksNetDev[targetIdx],
      rankLoss: ranksLoss[targetIdx],
      bandSize: band.members.length,
      medianLoss: medianOf(band.members.map((m) => m.totalLoss)),
    };
  });
  return { rows, summary: summarizeTrackRecord(rows) };
}

export async function queryPeerTrackRecord(
  outletCode: string,
  week: string,
  currentMonthKey: string | null,
  kelompok?: string | null,
): Promise<{ rows: PeerTrackRecordRow[]; summary: PeerTrackRecordSummary }> {
  // PERF-FILTER1 (B): ONE shared cached scan (all outlets × window months)
  // replaces the per-outlet multi-month SQL — switching the Filter Resto
  // outlet now re-reads the cached scan instead of re-scanning history.
  const scan = await getPeerBandScan(week, currentMonthKey);
  return computePeerTrackRecordFromScan(scan, outletCode, kelompok);
}
