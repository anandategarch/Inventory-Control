// ============================================================
//  Color Scale System — inspired by evidence-dev/evidence
//  --------------------------------------------------------
//  Provides smooth gradient color scales for data visualization.
//  Replaces step-based if/else coloring with continuous scales.
//
//  Scale type (FILTERDROP-1 dead-code audit: the diverging-scale family
//  was removed — see the tombstone at the bottom of this file):
//    Linear: min → max gradient (e.g. green → yellow → red)
//
//  Usage:
//    const scale = createLinearScale({ palette: HEATMAP_LINEAR, min: 0, max: 100 });
//
//  Auto text color:
//    autoTextColor('#dc2626') → 'white' (dark bg → white text)
//    autoTextColor('#dbeafe') → 'black' (light bg → black text)
// ============================================================

/** Pre-defined color palettes for common use cases. */

/** Green → Yellow → Red (heatmap linear, low → high). */
export const HEATMAP_LINEAR = [
  '#10b981', // emerald-500 (low)
  // P23 B12: lime-500 removed from the chart token family (FIX #23 — the same
  // de-lime decision that remapped --chart-trial lime #65a30d → amber-600
  // #ca8a04 in globals.css). In-family replacement: amber-600 #ca8a04, the
  // token value the family now uses where lime used to sit; it bridges
  // emerald-500 → yellow-500 while staying inside the emerald/yellow/amber/red
  // ramp the other scales (Z_SCORE_DIVERGING, FLIP_DIVERGING) share.
  '#ca8a04', // amber-600 (--chart-trial — replaced lime per FIX #23)
  '#eab308', // yellow-500
  '#f59e0b', // amber-500
  '#dc2626', // red-600 (high)
];

export interface ColorScaleResult {
  /** The scale function: pass a value → get hex color. */
  scale: (value: number) => string;
  /** Min value of the scale domain. */
  min: number;
  /** Max value of the scale domain. */
  max: number;
  /** Midpoint (for diverging scales). Null for linear. */
  midpoint: number | null;
  /** The palette actually used (may be subset for one-sided diverging). */
  palette: string[];
}

export interface LinearScaleOptions {
  palette: string[];
  min: number;
  max: number;
}

/**
 * Create a linear color scale (min → max gradient).
 * Simple interpolation across the palette.
 */
export function createLinearScale(opts: LinearScaleOptions): ColorScaleResult {
  const { palette, min, max } = opts;
  if (palette.length < 2) {
    throw new Error('Linear scale requires at least 2 colors');
  }

  const safeMin = min < max ? min : 0;
  const safeMax = max > min ? max : 1;
  const range = safeMax - safeMin || 1;

  const scale = (value: number): string => {
    const clamped = Math.max(safeMin, Math.min(safeMax, value));
    const t = (clamped - safeMin) / range;

    // Map t to palette segment.
    const segIdx = Math.min(Math.floor(t * (palette.length - 1)), palette.length - 2);
    const segT = (t * (palette.length - 1)) - segIdx;

    return interpolateColor(palette[segIdx], palette[segIdx + 1], segT);
  };

  return { scale, min: safeMin, max: safeMax, midpoint: null, palette };
}

/**
 * Linear interpolation between two hex colors.
 * Returns hex string. Uses simple RGB interpolation.
 */
function interpolateColor(hex1: string, hex2: string, t: number): string {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return hex2; // fallback

  // FIX (BUG-LIB-09): clamp r/g/b to [0, 255] to prevent invalid hex
  // when t is outside [0, 1] (shouldn't happen due to clamping upstream,
  // but defensive — prevents '#-5ff' etc.).
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(rgb1.r + (rgb2.r - rgb1.r) * t);
  const g = clamp(rgb1.g + (rgb2.g - rgb1.g) * t);
  const b = clamp(rgb1.b + (rgb2.b - rgb1.b) * t);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Convert hex string to RGB. Supports 3-digit shorthand (#fff) and 6-digit (#ffffff).
 * FIX (BUG-LIB-10): was rejecting 3-char hex. Now expands #fff → #ffffff before parsing.
 * Returns null for invalid input. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let cleaned = hex.replace('#', '');
  // FIX (BUG-LIB-10): expand 3-digit hex to 6-digit.
  if (cleaned.length === 3) {
    cleaned = cleaned.split('').map((c) => c + c).join('');
  }
  if (cleaned.length !== 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

/**
 * Determine whether to use black or white text on a given background color.
 * FIX (BUG-LIB-11): updated docstring — uses YIQ luminance approximation
 * (0.299r + 0.587g + 0.114b), not true WCAG sRGB luminance. YIQ is simpler
 * and sufficient for this use case (heatmap cells + chart backgrounds).
 * For strict WCAG AA conformance, use proper sRGB gamma decode.
 */
export function autoTextColor(bgHex: string): 'text-white' | 'text-black' | 'text-foreground' {
  // FIX (BUG-LIB-08): use 'text-black' instead of 'text-foreground' for
  // dark backgrounds. In dark mode, text-foreground is LIGHT, which would
  // be invisible on light-colored backgrounds (e.g. emerald-400). Using
  // static 'text-black' ensures the text is always dark on light bgs.
  // For dark bgs, 'text-white' is returned (already correct).
  const rgb = hexToRgb(bgHex);
  if (!rgb) return 'text-foreground';

  // FIX (BUG-INT-05): use true WCAG sRGB luminance (gamma-decode + 0.2126/0.7152/0.0722 weights)
  // instead of YIQ approximation. This fixes contrast for emerald-500 (#10b981)
  // which YIQ returned 0.502 (just under 0.55 → white text) but actual WCAG
  // contrast with white is ~2.6:1 (fails AA 4.5:1 for normal text).
  const decode = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * decode(rgb.r) + 0.7152 * decode(rgb.g) + 0.0722 * decode(rgb.b);
  // Threshold: luminance > 0.18 → dark text (light bg), else white text (dark bg).
  // 0.18 corresponds to WCAG AA 4.5:1 contrast with both black and white.
  return luminance > 0.18 ? 'text-black' : 'text-white';
}

// ============================================================
//  FILTERDROP-1 dead-code audit: the diverging-scale family was
//  REMOVED from this file — createDivergingScale, DivergingScaleOptions,
//  Z_SCORE_DIVERGING, FLIP_DIVERGING, getZScoreColorScale, zScoreColorHex,
//  zScoreColorClass, getFlipColorScale, flipColorHex (~130 LOC): zero
//  callers repo-wide. heatmapHelpers.ts (the sole consumer) only uses the
//  LINEAR family: createLinearScale + HEATMAP_LINEAR + autoTextColor.
//  Step-based z-score text classes live in src/lib/zScoreHelpers.ts.
// ============================================================
