// ============================================================
//  build-rankings — Section 5 of /api/outlet-items GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 673-line route.ts (lines ~614-631).
//
//  Responsibility: produce the 3 ranked item slices that become
//  response.rankings. Pure data-shaping — no I/O, no awaits.
//
//  Rankings:
//    A. financial    — top 20 by absNominalLossSurplus (financial impact)
//    B. operational  — top 20 by |devBom|               (operational efficiency)
//    C. unexplained  — top 20 by residualRatio          (unexplained variance)
//
//  Each entry gets a sequential `rank` field (1-indexed).
// ============================================================
import type { ItemBreakdownRow, Rankings } from './types';

export function buildRankings(itemBreakdown: ItemBreakdownRow[]): Rankings {
  return {
    // A. Financial Impact
    financial: [...itemBreakdown]
      .sort((a, b) => b.absNominalLossSurplus - a.absNominalLossSurplus)
      .slice(0, 20)
      .map((r, i) => ({ rank: i + 1, ...r })),
    // B. Operational (Dev/BOM)
    operational: [...itemBreakdown]
      .sort((a, b) => Math.abs(b.devBom ?? 0) - Math.abs(a.devBom ?? 0))
      .slice(0, 20)
      .map((r, i) => ({ rank: i + 1, ...r })),
    // C. Unexplained (Residual Ratio)
    unexplained: [...itemBreakdown]
      .sort((a, b) => (b.residualRatio ?? 0) - (a.residualRatio ?? 0))
      .slice(0, 20)
      .map((r, i) => ({ rank: i + 1, ...r })),
  };
}
