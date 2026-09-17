'use client';

// ============================================================
//  SparkLine — mini inline line chart (Pattern 5 from tremor)
//  --------------------------------------------------------
//  Ultra-compact line chart for inline display in table cells,
//  scorecards, and ranking rows. No axes, no grid — just a
//  smooth line with optional color.
//
//  Features:
//    - data: number[] (y values, plotted left to right)
//    - width / height (default 80×24)
//    - color (hex or CSS var)
//    - showDot (last point highlighted)
//    - showArea (filled area under line)
//
//  Usage:
//    <SparkLine data={[10, 15, 8, 20, 18, 25]} color="var(--chart-waste, #f59e0b)" />
//    <SparkLine data={periods.map(p => p.qtyDeviasiSigned)} width={60} showDot />
// ============================================================

import { memo, useMemo } from 'react';

export interface SparkLineProps {
  /** Y values, plotted left to right. */
  data: number[];
  /** Width in px (default 80). */
  width?: number;
  /** Height in px (default 24). */
  height?: number;
  /** Line color (hex or CSS var). Default: the adaptive amber chart token
   *  var(--chart-waste, #f59e0b) — same token family the other chart
   *  components use (light #f59e0b / dark #fbbf24), with a raw-hex fallback
   *  for contexts where the CSS var is unavailable. */
  color?: string;
  /** Show a dot on the last data point. Default: false. */
  showDot?: boolean;
  /** Show filled area under the line. Default: false. */
  showArea?: boolean;
  /** Area fill opacity (0-1). Default: 0.15. */
  areaOpacity?: number;
  /** Stroke width. Default: 1.5. */
  strokeWidth?: number;
  /** Line curve type. Default: 'monotone'. */
  curve?: 'linear' | 'monotone';
  className?: string;
}

export const SparkLine = memo(function SparkLine({
  data,
  width = 80,
  height = 24,
  // P23 B11: hardcoded #f59e0b bypassed the var(--chart-*) token family (no
  // dark-mode adaptation). Now defaults to the --chart-waste amber token with
  // a raw-hex fallback, mirroring the var(--chart-*, #hex) pattern used by
  // ItemDeepDive's ReferenceLine strokes. No current caller relies on the
  // default (ranking-nasional passes explicit colors) — safe change.
  color = 'var(--chart-waste, #f59e0b)',
  showDot = false,
  showArea = false,
  areaOpacity = 0.15,
  strokeWidth = 1.5,
  curve = 'linear',
  className,
}: SparkLineProps) {
  const { points, areaPath, dotPos } = useMemo(() => {
    if (!data || data.length === 0) {
      return { points: '', areaPath: '', dotPos: null };
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const stepX = data.length > 1 ? width / (data.length - 1) : 0;

    // Compute SVG points
    const pts = data.map((val, i) => {
      const x = i * stepX;
      const y = height - ((val - min) / range) * (height - 2) - 1;
      return { x, y };
    });

    // Build polyline points string
    const ptsStr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    // Build area path (if showArea)
    let areaP = '';
    if (showArea) {
      const areaPts = [
        `M0,${height}`,
        ...pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`),
        `L${width.toFixed(1)},${height}`,
        'Z',
      ];
      areaP = areaPts.join(' ');
    }

    // Last dot position
    const dot = pts.length > 0 ? pts[pts.length - 1] : null;

    return { points: ptsStr, areaPath: areaP, dotPos: dot };
  }, [data, width, height, showArea]);

  if (!data || data.length === 0) {
    return <div style={{ width, height }} className={`inline-block ${className ?? ''}`} />;
  }

  // Convert hex color to rgba for area fill.
  // FIX (BUG-SHARED-10): expand 3-digit hex to 6-digit before appending alpha.
  // Was: '#fff' + '26' = '#fff26' (invalid 5-char hex).
  // Now: '#ffffff' + '26' = '#ffffff26' (valid 8-char alpha hex).
  const expandHex = (hex: string): string => {
    const cleaned = hex.replace('#', '');
    if (cleaned.length === 3) {
      return '#' + cleaned.split('').map((c) => c + c).join('');
    }
    return hex;
  };
  const areaColor = color.startsWith('#')
    ? `${expandHex(color)}${Math.round(areaOpacity * 255).toString(16).padStart(2, '0')}`
    : color;

  return (
    <svg
      width={width}
      height={height}
      className={`inline-block ${className ?? ''}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {showArea && areaPath && <path d={areaPath} fill={areaColor} />}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {showDot && dotPos && (
        <circle cx={dotPos.x} cy={dotPos.y} r={2} fill={color} />
      )}
    </svg>
  );
});
