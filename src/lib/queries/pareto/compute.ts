// ============================================================
//  Pareto Computation Helpers
//  --------------------------------------------------------
//  - computePareto: 80/20 cumulative-share computation (delegates
//    to shared computePareto8020 in ../shared, mapping
//    totalMagnitude → totalAbsNominal so the ParetoResult shape
//    is preserved for downstream consumers).
//  - mergeHistoricalIntoPareto: attaches histAvg / zScore / histN
//    to each driver row from a historical stats Map.
// ============================================================
import { computePareto8020 } from '../shared';
import type { ParetoResult, ParetoRow } from './types';

export function computePareto<T extends { totalAbsNominal: number; name: string; nominalDeviasi: number; qtyDeviasi: number }>(
  rows: T[],
  threshold: number = 0.80,
  maxDrivers: number = 20,
): ParetoResult {
  // FIX (RESTORE-SHARED-1): delegate to shared computePareto8020 in ./shared.
  // The shared function uses |getValue(row)| for sorting + share% — pass
  // r.totalAbsNominal (already non-negative) so behaviour matches the
  // previous inline implementation. Map totalMagnitude → totalAbsNominal
  // to preserve the ParetoResult shape consumed by mergeHistoricalIntoPareto.
  const r = computePareto8020(rows, (row) => row.totalAbsNominal, threshold, maxDrivers);
  return {
    drivers: r.drivers as ParetoRow[],
    remainderCount: r.remainderCount,
    remainderPct: r.remainderPct,
    totalAbsNominal: r.totalMagnitude,
    totalCount: r.totalCount,
  };
}

// ============================================================
//  Merge historical stats into Pareto results
//  Adds histAvg, zScore, histN to each driver row
// ============================================================
export function mergeHistoricalIntoPareto(
  pareto: ParetoResult,
  historical: Map<string, { histAvg: number; histStdDev: number; histN: number }>,
): ParetoResult {
  return {
    ...pareto,
    drivers: pareto.drivers.map(d => {
      const hist = historical.get(d.name) || historical.get(d.code || '');
      if (!hist || hist.histStdDev <= 0) {
        return { ...d, histAvg: hist?.histAvg ?? null, zScore: null, histN: hist?.histN ?? 0 };
      }
      const zScore = (d.totalAbsNominal - hist.histAvg) / hist.histStdDev;
      return {
        ...d,
        histAvg: hist.histAvg,
        zScore: Number(zScore.toFixed(2)),
        histN: hist.histN,
      };
    }),
  };
}
