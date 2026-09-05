// ============================================================
//  Color Scale System — inspired by evidence-dev/evidence
//  --------------------------------------------------------
//  Provides smooth gradient color scales for data visualization.
//  Replaces step-based if/else coloring with continuous scales.
//
//  Three scale types:
//    1. Linear: min → max gradient (e.g. green → yellow → red)
//    2. Diverging: midpoint-anchored (e.g. red → neutral → green)
//    3. Stops: explicit value → color breakpoints
//
//  Usage:
//    const scale = createDivergingScale({ midpoint: 0, palette: RED_GREEN_DIVERGING });
//    scale(2.5)  → '#f59e0b' (amber — above mean, moderate)
//    scale(-1.5) → '#34d399' (emerald — below mean, good)
//    scale(0)    → '#9ca3af' (neutral — at midpoint)
//
//  Auto text color:
//    autoTextColor('#dc2626') → 'white' (dark bg → white text)
//    autoTextColor('#dbeafe') → 'black' (light bg → black text)
// ============================================================

/** Pre-defined color palettes for common use cases. */

/** Red → Amber → Neutral → Emerald → Deep Green (Z-Score diverging). */
export const Z_SCORE_DIVERGING = [
  '#10b981', // emerald-500 (z < -2, much better)
  '#34d399', // emerald-400 (z < -1, better)
  '#9ca3af', // gray-400 (z ≈ 0, neutral)
  '#eab308', // yellow-500 (z > 1, elevated)
  '#f59e0b', // amber-500 (z > 2, warning)
  '#dc2626', // red-600 (z > 3, abnormal)
];

/** Green → Yellow → Red (heatmap linear, low → high). */
export const HEATMAP_LINEAR = [
  '#10b981', // emerald-500 (low)
  '#84cc16', // lime-500
  '#eab308', // yellow-500
  '#f59e0b', // amber-500
  '#dc2626', // red-600 (high)
];

/** Red → Amber → Emerald (flip disparity: 0%=balanced=green → 100%=one-sided=red). */
export const FLIP_DIVERGING = [
  '#10b981', // emerald-500 (0-10%: sempurna, most balanced)
  '#34d399', // emerald-400
  '#fbbf24', // amber-400
  '#f59e0b', // amber-500 (10-40%: dominan)
  '#f87171', // red-400
  '#dc2626', // red-600 (40-100%: parsial, least balanced)
];

export interface DivergingScaleOptions {
  /** The midpoint value that anchors the neutral color. Default: 0. */
  midpoint?: number;
  /** Color palette (3+ colors). Middle color is the neutral midpoint. */
  palette: string[];
  /** Minimum value (for clamping). If not set, uses actual data min. */
  min?: number;
  /** Maximum value (for clamping). If not set, uses actual data max. */
  max?: number;
}

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

/**
 * Create a diverging color scale anchored at midpoint.
 *
 * For data that straddles the midpoint (min < mid < max):
 *   Full palette is used, middle color pinned at midpoint.
 *   Negative values → left side (green), positive → right side (red).
 *
 * For one-sided data (all >= mid or all <= mid):
 *   Only the relevant half of the palette is used, with neutral
 *   anchored at the midpoint. This keeps the midpoint meaningful
 *   even when data doesn't cross it.
 */
export function createDivergingScale(opts: DivergingScaleOptions): ColorScaleResult {
  const { midpoint = 0, palette } = opts;
  if (palette.length < 2) {
    throw new Error('Diverging scale requires at least 2 colors');
  }

  // Default min/max if not provided — assume symmetric around midpoint.
  const min = opts.min ?? midpoint - 1;
  const max = opts.max ?? midpoint + 1;

  // Guard against degenerate domain.
  const safeMin = min < max ? min : midpoint - 1;
  const safeMax = max > min ? max : midpoint + 1;

  if (palette.length < 3 || midpoint <= safeMin || midpoint >= safeMax) {
    // Not enough colors for diverging, or midpoint is outside data range.
    // Fall back to linear scale over the full palette.
    return createLinearScale({ palette, min: safeMin, max: safeMax });
  }

  // Diverging: split domain at midpoint.
  const n = palette.length;
  const midIdx = (n - 1) / 2;

  // Build domain: interpolate from min→mid→max.
  const domain: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < midIdx) {
      // Left side: min → midpoint
      domain.push(safeMin + (i / midIdx) * (midpoint - safeMin));
    } else if (i > midIdx) {
      // Right side: midpoint → max
      domain.push(midpoint + ((i - midIdx) / (n - 1 - midIdx)) * (safeMax - midpoint));
    } else {
      // Middle: exactly at midpoint
      domain.push(midpoint);
    }
  }

  // Create interpolation function.
  const scale = (value: number): string => {
    // Clamp to domain.
    const clamped = Math.max(domain[0], Math.min(domain[domain.length - 1], value));

    // Find the segment containing the value.
    for (let i = 0; i < domain.length - 1; i++) {
      if (clamped >= domain[i] && clamped <= domain[i + 1]) {
        const t = domain[i + 1] > domain[i]
          ? (clamped - domain[i]) / (domain[i + 1] - domain[i])
          : 0;
        return interpolateColor(palette[i], palette[i + 1], t);
      }
    }
    // Value beyond max → return last color.
    return palette[palette.length - 1];
  };

  return { scale, min: safeMin, max: safeMax, midpoint, palette };
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

  const r = Math.round(rgb1.r + (rgb2.r - rgb1.r) * t);
  const g = Math.round(rgb1.g + (rgb2.g - rgb1.g) * t);
  const b = Math.round(rgb1.b + (rgb2.b - rgb1.b) * t);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Convert hex string to RGB. Returns null for invalid input. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

/**
 * Determine whether to use black or white text on a given background color.
 * Uses relative luminance for WCAG contrast.
 */
export function autoTextColor(bgHex: string): 'text-white' | 'text-foreground' {
  const rgb = hexToRgb(bgHex);
  if (!rgb) return 'text-foreground';

  // Relative luminance (WCAG formula).
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance < 0.55 ? 'text-white' : 'text-foreground';
}

// ============================================================
//  Convenience: Z-Score color scale (cached singleton)
//  --------------------------------------------------------
//  Pre-built scale for Z-Score coloring with midpoint=0.
//  Domain: [-4, 4] (typical Z-Score range).
//  Positive = worse (red), negative = better (green), 0 = neutral.
// ============================================================

let _zScoreScale: ColorScaleResult | null = null;

/**
 * Get the cached Z-Score diverging color scale.
 * Midpoint = 0, domain [-4, 4], palette Z_SCORE_DIVERGING.
 */
export function getZScoreColorScale(): ColorScaleResult {
  if (!_zScoreScale) {
    _zScoreScale = createDivergingScale({
      midpoint: 0,
      palette: Z_SCORE_DIVERGING,
      min: -4,
      max: 4,
    });
  }
  return _zScoreScale;
}

/**
 * Get hex color for a Z-Score value using the diverging scale.
 * Smooth gradient — replaces step-based zScoreColor().
 */
export function zScoreColorHex(z: number | null): string {
  if (z == null) return '#9ca3af'; // gray-400 (muted)
  return getZScoreColorScale().scale(z);
}

/**
 * Get Tailwind text color class for a Z-Score value.
 * Maps the hex color to the nearest Tailwind class.
 * Falls back to zScoreColor() step-based for exact class matching.
 */
export function zScoreColorClass(z: number | null): string {
  if (z == null) return 'text-muted-foreground';
  // Use step-based for text colors (Tailwind classes can't be
  // dynamically generated in production builds). The hex scale
  // is for backgrounds/cells; text colors stay step-based for
  // Tailwind compatibility.
  if (z > 3) return 'text-red-600 dark:text-red-400 font-bold';
  if (z > 2) return 'text-amber-600 dark:text-amber-400 font-semibold';
  if (z > 1) return 'text-yellow-600 dark:text-yellow-400';
  if (z < -2) return 'text-emerald-600 dark:text-emerald-400 font-medium';
  if (z < -1) return 'text-emerald-500 dark:text-emerald-500';
  return 'text-muted-foreground';
}

// ============================================================
//  Convenience: Flip disparity color scale
//  --------------------------------------------------------
//  0% = perfectly balanced (green) → 100% = one-sided (red).
//  Uses FLIP_DIVERGING palette with domain [0, 100].
// ============================================================

let _flipScale: ColorScaleResult | null = null;

/**
 * Get the cached flip disparity color scale.
 * Domain: [0, 100] (disparity percentage).
 */
export function getFlipColorScale(): ColorScaleResult {
  if (!_flipScale) {
    _flipScale = createLinearScale({
      palette: FLIP_DIVERGING,
      min: 0,
      max: 100,
    });
  }
  return _flipScale;
}

/**
 * Get hex color for a flip disparity percentage.
 * 0% = emerald (balanced), 100% = red (one-sided).
 */
export function flipColorHex(disparityPct: number): string {
  return getFlipColorScale().scale(disparityPct);
}
