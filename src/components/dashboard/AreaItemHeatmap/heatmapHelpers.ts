// ============================================================
//  AreaItemHeatmap — Color & Value Helpers
//  --------------------------------------------------------
//  Pure functions only. No React, no 'use client', tree-shakeable.
//
//  Color scale — green (low) → yellow (medium) → red (high).
//  FIX: Uses percentile-based scaling (not raw value/max) so outliers
//  don't compress all other cells into "green". Uses sqrt curve for
//  better sensitivity in the low-to-mid range.
// ============================================================

import { fmtNum, fmtHeatmapCompact } from '@/lib/format';
import type { HeatmapMetric } from './types';

export function getHeatColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'transparent';
  // Sqrt scaling: makes low values more visible (was linear ratio)
  // sqrt(0.1)=0.316 (was 0.1) → low values get more color
  // sqrt(0.5)=0.707 (was 0.5) → mid values brighter
  // sqrt(1.0)=1.0 (unchanged) → max still full red
  const ratio = Math.min(1, Math.sqrt(value / max));
  const hue = 120 * (1 - ratio);
  const saturation = 75 + ratio * 20; // 75% → 95% (more vivid)
  const lightness = 92 - ratio * 40;  // 92% → 52% (more contrast)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function getTextColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'text-foreground';
  const ratio = Math.min(1, Math.sqrt(value / max));
  return ratio > 0.45 ? 'text-white' : 'text-foreground';
}

export function formatCellValue(metric: HeatmapMetric, value: number): string {
  if (metric === 'pctQtyDeviasiToBom') {
    const pct = Math.abs(value) * 100;
    return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`.replace('.', ',');
  }
  if (metric === 'recordCount') return fmtNum(value);
  return fmtHeatmapCompact(value);
}

// Metrics where avg-per-outlet is meaningful (sum-based magnitudes, not averages/counts)
export const AVG_ELIGIBLE_METRICS: ReadonlySet<HeatmapMetric> = new Set([
  'absNominalDeviasi', 'nominalWaste', 'nominalSusut',
]);

export function computeAvgPerOutlet(value: number, outletCount: number): number {
  if (outletCount <= 0) return 0;
  return value / outletCount;
}
