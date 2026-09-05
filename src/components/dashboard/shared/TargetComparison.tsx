'use client';

// ============================================================
//  TargetComparison — generic comparison display component
//  --------------------------------------------------------
//  Inspired by evidence-dev/evidence's target_comparison tag.
//  Renders a "current vs baseline" comparison with:
//    - Percentage change: "+25%" or "-12%"
//    - Absolute change: "+500" or "-200"
//    - Compared value: just the baseline value formatted
//
//  Features:
//    - `downIsGood` flag: when true, negative change = green (good)
//    - `format` preset: uses formatByPreset() from lib/format.ts
//    - Optional label + sublabel
//    - Color-coded delta (green/red based on direction + downIsGood)
//    - Optional arrow icon (↑/↓)
//
//  Usage:
//    <TargetComparison
//      current={1200000}
//      baseline={1000000}
//      displayType="pct"
//      formatPreset="idr0m"
//      label="Nominal Deviasi"
//      sublabel="vs peer avg"
//    />
//    // → shows "Rp 1,2Jt" with "+20,0%" in green (up = worse for deviasi)
//
//    <TargetComparison
//      current={5000}
//      baseline={8000}
//      displayType="abs"
//      formatPreset="qty0"
//      downIsGood
//      label="QTY Deviasi"
//    />
//    // → shows "-3.000" in green (down = good because downIsGood)
// ============================================================

import { memo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { formatByPreset, isValidPreset } from '@/lib/format';

export type TargetComparisonDisplayType = 'pct' | 'abs' | 'compared_value';

export interface TargetComparisonProps {
  /** Current value (the value being compared). */
  current: number | null | undefined;
  /** Baseline to compare against (peer avg, previous period, target, etc.). */
  baseline: number | null | undefined;
  /** How to display the comparison:
   *  - 'pct': percentage change ((current - baseline) / |baseline|) × 100
   *  - 'abs': absolute change (current - baseline)
   *  - 'compared_value': just show the baseline value (no delta)
   *  @default 'pct'
   */
  displayType?: TargetComparisonDisplayType;
  /** Format preset code for the value display (e.g. 'idr1m', 'num2', 'qty0').
   *  Falls back to 'num0' if invalid. */
  formatPreset?: string;
  /** Label shown above the values (e.g. "Nominal Deviasi"). */
  label?: string;
  /** Sublabel shown below values (e.g. "vs peer avg"). */
  sublabel?: string;
  /** When true, negative change = good (green). When false (default),
   *  positive change = good (green). Use `downIsGood` for metrics where
   *  a decrease is an improvement (e.g. deviasi, waste, loss).
   *  @default false
   */
  downIsGood?: boolean;
  /** Show arrow icon (↑/↓/—) next to the delta. Default true.
   *  Set false for compact layout. */
  showArrow?: boolean;
  /** Show the baseline value alongside the delta (e.g. "vs Rp 1,2Jt").
   *  Default true. Set false to hide baseline. */
  showBaseline?: boolean;
  /** Size variant: 'sm' for compact (inline), 'md' for card-style. */
  size?: 'sm' | 'md';
}

/**
 * Determine if a change is "good" given the direction + downIsGood flag.
 * - Positive change + !downIsGood → good (up is good)
 * - Positive change + downIsGood  → bad (up is bad)
 * - Negative change + !downIsGood → bad (down is bad)
 * - Negative change + downIsGood  → good (down is good)
 * - Zero change → neutral
 */
function isGoodChange(delta: number, downIsGood: boolean): 'good' | 'bad' | 'neutral' {
  if (delta === 0) return 'neutral';
  if (delta > 0) return downIsGood ? 'bad' : 'good';
  return downIsGood ? 'good' : 'bad';
}

function colorClass(assessment: 'good' | 'bad' | 'neutral'): string {
  switch (assessment) {
    case 'good':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'bad':
      return 'text-red-600 dark:text-red-400';
    case 'neutral':
      return 'text-muted-foreground';
  }
}

export const TargetComparison = memo(function TargetComparison({
  current,
  baseline,
  displayType = 'pct',
  formatPreset = 'num0',
  label,
  sublabel,
  downIsGood = false,
  showArrow = true,
  showBaseline = true,
  size = 'md',
}: TargetComparisonProps) {
  // Guard: null/undefined/NaN
  if (current == null || baseline == null || isNaN(current) || isNaN(baseline) || !isFinite(current) || !isFinite(baseline)) {
    return (
      <div className={size === 'sm' ? 'inline-flex items-center gap-1 text-xs' : 'rounded-lg border bg-muted/20 p-2.5'}>
        {label && <span className="text-[11px] text-muted-foreground">{label}: </span>}
        <span className="text-muted-foreground">—</span>
      </div>
    );
  }

  const preset = isValidPreset(formatPreset) ? formatPreset : 'num0';
  const delta = current - baseline;
  const assessment = isGoodChange(delta, downIsGood);
  const color = colorClass(assessment);

  // Compute display value based on displayType
  let deltaDisplay: string;
  if (displayType === 'pct') {
    // Percentage change: (current - baseline) / |baseline| × 100
    // Guard div-by-zero
    const pct = baseline !== 0 ? (delta / Math.abs(baseline)) * 100 : 0;
    const sign = pct > 0 ? '+' : '';
    deltaDisplay = `${sign}${pct.toFixed(1).replace('.', ',')}%`;
  } else if (displayType === 'abs') {
    // Absolute change
    const sign = delta > 0 ? '+' : '';
    deltaDisplay = `${sign}${formatByPreset(delta, preset)}`;
  } else {
    // compared_value — just show current formatted
    deltaDisplay = formatByPreset(current, preset);
  }

  // Arrow: up for positive delta, down for negative, minus for zero
  const Arrow = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus;

  const currentDisplay = formatByPreset(current, preset);
  const baselineDisplay = formatByPreset(baseline, preset);

  if (size === 'sm') {
    // Compact inline variant
    return (
      <span className="inline-flex items-center gap-1.5 text-xs tabular-nums">
        {label && <span className="text-muted-foreground">{label}:</span>}
        <span className="font-medium">{currentDisplay}</span>
        {displayType !== 'compared_value' && (
          <span className={`font-medium ${color}`}>
            {showArrow && <Arrow className="h-3 w-3 inline" />}
            {deltaDisplay}
          </span>
        )}
        {showBaseline && displayType !== 'compared_value' && (
          <span className="text-muted-foreground text-[10px]">vs {baselineDisplay}</span>
        )}
      </span>
    );
  }

  // Card-style variant (default 'md')
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      {label && (
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        </div>
      )}
      <div className="flex items-baseline gap-2 tabular-nums">
        <span className="text-sm font-semibold">{currentDisplay}</span>
        {displayType !== 'compared_value' && (
          <span className={`text-xs font-medium ${color}`}>
            {showArrow && <Arrow className="h-3 w-3 inline mr-0.5" />}
            {deltaDisplay}
          </span>
        )}
      </div>
      {sublabel && (
        <p className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</p>
      )}
      {showBaseline && displayType !== 'compared_value' && !sublabel && (
        <p className="text-[10px] text-muted-foreground mt-0.5">
          vs baseline {baselineDisplay}
        </p>
      )}
    </div>
  );
});

// ============================================================
//  DeltaType — 5-level delta classification (Pattern 6)
//  --------------------------------------------------------
//  Inspired by tremor-npm's DeltaType system. Classifies a
//  percentage delta into 5 buckets so callers can pick a color
//  via `deltaTypeColor()` rather than re-implementing direction
//  + magnitude logic.
//
//  Levels (default `moderate` threshold = 10% = 0.10):
//    - 'increase'          delta > +moderate
//    - 'moderateIncrease'  0 < delta <= +moderate
//    - 'unchanged'         delta === 0
//    - 'moderateDecrease'  -moderate <= delta < 0
//    - 'decrease'          delta < -moderate
//
//  `deltaTypeColor()` maps a DeltaType to a Tailwind text color
//  class, respecting the `downIsGood` flag (for metrics where a
//  decrease is an improvement, e.g. deviasi, waste, loss).
//
//  Usage:
//    const dt = classifyDelta(0.15);             // 'increase' (>0.10)
//    const cls = deltaTypeColor(dt, true);        // red (up = bad)
//    const dt2 = classifyDelta(0.05);             // 'moderateIncrease'
//    const cls2 = deltaTypeColor(dt2, true);      // amber (moderate bad)
// ============================================================

export type DeltaType =
  | 'increase'
  | 'moderateIncrease'
  | 'unchanged'
  | 'moderateDecrease'
  | 'decrease';

export interface ClassifyDeltaOptions {
  /** Absolute threshold (e.g. 0.10 for 10%) above which a change
   *  is considered "big" rather than "moderate". @default 0.10 */
  moderate?: number;
}

/**
 * Classify a signed delta (typically a fraction 0.15 = +15%) into
 * 5 buckets. Pass an absolute ratio (e.g. 0.15), not a percent.
 *
 * The threshold is symmetric: +moderate / -moderate bracket the
 * "moderate" zone; anything above (or below) is a full
 * "increase" / "decrease".
 */
export function classifyDelta(
  delta: number,
  thresholds?: ClassifyDeltaOptions,
): DeltaType {
  const mod = thresholds?.moderate ?? 0.10; // 10% = moderate threshold
  if (delta === 0) return 'unchanged';
  if (delta > mod) return 'increase';
  if (delta > 0) return 'moderateIncrease';
  if (delta < -mod) return 'decrease';
  return 'moderateDecrease';
}

/**
 * Map a DeltaType to a Tailwind text-color class, respecting the
 * `downIsGood` flag.
 *
 * - `downIsGood=false` (default): increase = green (good),
 *   decrease = red (bad). Used for sales, surplus, outlet count.
 * - `downIsGood=true`: increase = red (bad), decrease = green
 *   (good). Used for deviasi, waste, loss, residual.
 *
 * Moderate variants get a softer color (amber instead of red,
 * emerald-500 instead of emerald-600) to distinguish "small
 * change" from "big change" at a glance.
 */
export function deltaTypeColor(deltaType: DeltaType, downIsGood: boolean): string {
  const goodColors = 'text-emerald-600 dark:text-emerald-400';
  const badColors = 'text-red-600 dark:text-red-400';
  const moderateGoodColors = 'text-emerald-500 dark:text-emerald-500';
  const moderateBadColors = 'text-amber-600 dark:text-amber-400';
  const neutralColors = 'text-muted-foreground';

  const isGood = (dt: DeltaType) => dt === 'increase' || dt === 'moderateIncrease';
  const isBad = (dt: DeltaType) => dt === 'decrease' || dt === 'moderateDecrease';

  // Flip if downIsGood (down = good, up = bad)
  const effectiveGood = downIsGood ? isBad(deltaType) : isGood(deltaType);
  const effectiveBad = downIsGood ? isGood(deltaType) : isBad(deltaType);
  const isModerate =
    deltaType === 'moderateIncrease' || deltaType === 'moderateDecrease';

  if (effectiveGood) return isModerate ? moderateGoodColors : goodColors;
  if (effectiveBad) return isModerate ? moderateBadColors : badColors;
  return neutralColors;
}
