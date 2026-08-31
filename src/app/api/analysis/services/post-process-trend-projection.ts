// ============================================================
//  post-process-trend-projection — Sub-step 5: buildTrendProjection
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    Linear projection of next period's |nominalDeviasi|.
//    Reuses trendAggRows (already fetched) — no extra DB query.
//    Sign convention: input uses signed nominal (LOSS = negative);
//    projectTrend takes ABS internally.
// ============================================================
import { projectTrend } from '@/lib/metrics';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';

/**
 * Sub-step 5 — linear projection of next period's |nominalDeviasi|.
 * Reuses trendAggRows (already fetched) — no extra DB query.
 * Sign convention: input uses signed nominal (LOSS = negative); projectTrend takes ABS internally.
 */
export function buildTrendProjection(
  trendAggRows: QueryResults['trendAggRows'],
  monthKeyByLabel: FetchedRecords['monthKeyByLabel'],
): ReturnType<typeof projectTrend> {
  // FIX FORECAST-1: sort trendAggRows chronologically before projecting
  // (DB returns rows in arbitrary order; projectTrend needs chronological W1→W4)
  return projectTrend(
    trendAggRows
      .map((r) => {
        const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
        return {
          sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, "")) || 0).padStart(2, "0")}`,
          weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
          nominalDeviasi: r.nominal,
          devBom: r.devBom,
          sales: r.sales,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey)),
  );
}
