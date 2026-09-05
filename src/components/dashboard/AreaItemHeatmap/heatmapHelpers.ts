// ============================================================
//  AreaItemHeatmap — Color & Value Helpers
//  --------------------------------------------------------
//  Pure functions only. No React, no 'use client', tree-shakeable.
//
//  FIX (PATTERN-1): color scale now uses smooth gradient from
//  lib/colorScale.ts (createLinearScale) instead of step-based
//  hsl() formula. The gradient is smoother + more professional.
//  Sqrt curve is preserved for low-value sensitivity.
// ============================================================

import { fmtNum, fmtHeatmapCompact } from '@/lib/format';
import { createLinearScale, HEATMAP_LINEAR, autoTextColor, type ColorScaleResult } from '@/lib/colorScale';
import type { HeatmapMetric } from './types';

// Cache: one scale per max value (avoids recreating on every cell render).
// Key = max value rounded to 2 decimals.
const _scaleCache = new Map<string, ColorScaleResult>();

export function getHeatColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'transparent';
  // FIX (PATTERN-1): use smooth gradient from createLinearScale.
  // Sqrt curve preserved for low-value sensitivity (ratio = sqrt(value/max)).
  const ratio = Math.min(1, Math.sqrt(value / max));
  // Scale the ratio to the actual value range [0, max].
  const scaledValue = ratio * max;

  // Get or create cached scale for this max.
  const cacheKey = max.toFixed(2);
  let scale = _scaleCache.get(cacheKey);
  if (!scale) {
    scale = createLinearScale({
      palette: HEATMAP_LINEAR,
      min: 0,
      max: max,
    });
    _scaleCache.set(cacheKey, scale);
  }

  return scale.scale(scaledValue);
}

export function getTextColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'text-foreground';
  // FIX (PATTERN-1): use autoTextColor from colorScale for WCAG-compliant
  // text color (black/white based on background luminance).
  const bgColor = getHeatColor(value, max);
  if (bgColor === 'transparent') return 'text-foreground';
  return autoTextColor(bgColor);
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
