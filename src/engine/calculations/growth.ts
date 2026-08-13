// ============================================================
//  Calculation Engine — Growth metrics
//  All functions pure, deterministic, NULL-safe.
// ============================================================

export function calcGrowth(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null) return null;
  if (prev === 0) return curr === 0 ? 0 : null; // can't compute % growth from zero base
  return (curr - prev) / Math.abs(prev);
}

// For consumption columns (BOM/COM which are negative), growth should use absolute values
export function calcGrowthAbs(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null) return null;
  const ac = Math.abs(curr);
  const ap = Math.abs(prev);
  if (ap === 0) return ac === 0 ? 0 : null;
  return (ac - ap) / ap;
}

// Safe ratio
export function safeRatio(num: number | null, denom: number | null): number | null {
  if (num == null || denom == null || denom === 0) return null;
  return num / denom;
}

// Average price = |nominal / qty| (both should have same sign typically)
export function calcAvgPrice(nominal: number | null, qty: number | null): number | null {
  if (nominal == null || qty == null || qty === 0) return null;
  return Math.abs(nominal / qty);
}

// Standard deviation (sample, Bessel's correction) from list of values
// Bug 2 fix: use sample variance (n-1) instead of population variance (n)
// Historical data is a sample of ongoing business process, not full population.
// Population variance understates stdDev → inflates zScore → false positives.
export function calcStdDev(values: number[]): { mean: number; stdDev: number; n: number } | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Sample variance: divide by (n-1), not n. For n=1, use 0 (no variance).
  const denom = values.length > 1 ? values.length - 1 : 1;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / denom;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev, n: values.length };
}

// Z-score — LOGIC-04 fix: use absolute magnitude, not signed value
// Deviation direction (LOSS/SURPLUS) is handled separately; zScore measures
// how far the magnitude deviates from historical magnitude average.
export function calcZScore(value: number | null, mean: number, stdDev: number): number | null {
  if (value == null || stdDev === 0) return null;
  return (Math.abs(value) - mean) / stdDev;
}

import type { GrowthMetrics, HistoricalStats } from '@/types/inventory';

export function computeGrowthMetrics(curr: Record<string, number | null>, prev: Record<string, number | null>): GrowthMetrics {
  return {
    salesGrowth: calcGrowth(curr.nominalSales ?? null, prev.nominalSales ?? null),
    bomGrowth: calcGrowthAbs(curr.qtyBom ?? null, prev.qtyBom ?? null),
    qtyDeviasiGrowth: calcGrowthAbs(curr.qtyDeviasi ?? null, prev.qtyDeviasi ?? null),
    nominalDeviasiGrowth: calcGrowth(curr.nominalDeviasi ?? null, prev.nominalDeviasi ?? null),
    priceGrowth: calcGrowth(
      calcAvgPrice(curr.nominalDeviasi ?? null, curr.qtyDeviasi ?? null),
      calcAvgPrice(prev.nominalDeviasi ?? null, prev.qtyDeviasi ?? null)
    ),
    deviationToSalesRatio: safeRatio(curr.absNominalDeviasi ?? null, curr.nominalSales ?? null),
    deviationToBomRatio: safeRatio(curr.absQtyDeviasi ?? null, curr.qtyBom != null ? Math.abs(curr.qtyBom) : null),
  };
}

export function computeHistoricalStats(values: number[]): HistoricalStats | null {
  if (values.length < 4) return { avgDevBom: null, stdDev: null, zScore: null, sampleSize: values.length };
  const stats = calcStdDev(values);
  if (!stats) return null;
  return { avgDevBom: stats.mean, stdDev: stats.stdDev, zScore: null, sampleSize: stats.n };
}
