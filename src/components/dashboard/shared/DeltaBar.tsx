'use client';

// ============================================================
//  DeltaBar — bidirectional progress bar (Pattern 1)
//  --------------------------------------------------------
//  Inspired by tremor-npm's <DeltaBar> component.
//  Renders a horizontal bar with a center (0) anchor:
//    - Right half (positive) = SURPLUS / growth
//    - Left half  (negative) = LOSS / decline
//
//  Color logic:
//    - `isIncreasePositive=true`  (default):
//        positive = emerald (good), negative = red (bad)
//      Use for: sales growth, surplus, outlet count.
//    - `isIncreasePositive=false`:
//        positive = red (bad), negative = emerald (good)
//      Use for: deviasi growth, waste, loss, residual (up = bad).
//
//  Notes:
//    - `value` is a percentage in [-100, 100]. Values outside
//      this range are clamped.
//    - Width of the colored portion = |value|% of the half-bar.
//    - Center separator is a 1px vertical line at left-1/2.
//    - Numeric value label uses Indonesian comma decimal.
//
//  PC-focused design (dark mode supported via `dark:` classes).
//  No indigo or blue colors per project rule.
// ============================================================

import { memo } from 'react';

export interface DeltaBarProps {
  /** Percentage in range [-100, 100]. Values outside are clamped. */
  value: number;
  /** When true (default), positive = emerald (good) and negative
   *  = red (bad). When false, the colors are inverted (positive =
   *  bad for "up is bad" metrics like deviasi/waste/loss). */
  isIncreasePositive?: boolean;
  /** Optional compact label rendered to the LEFT of the bar
   *  (max 20 chars; truncated). Pass "" for no label. */
  label?: string;
  /** Optional native `title` tooltip on the bar container. */
  tooltip?: string;
  /** Animate width transitions on value change. @default true */
  showAnimation?: boolean;
  /** Extra className appended to the outer flex container. */
  className?: string;
}

export const DeltaBar = memo(function DeltaBar({
  value,
  isIncreasePositive = true,
  label,
  tooltip,
  showAnimation = true,
  className,
}: DeltaBarProps) {
  // Clamp to [-100, 100]
  const clamped = Math.max(-100, Math.min(100, value));
  const absValue = Math.abs(clamped);
  const isPositive = clamped >= 0;

  // Determine color: increase (positive) when isIncreasePositive → green, else red
  const isGood = isPositive ? isIncreasePositive : !isIncreasePositive;
  const barColor = isGood ? 'bg-emerald-500' : 'bg-red-500';

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      {label && (
        <span
          className="text-xs text-muted-foreground shrink-0 w-20 truncate"
          title={label}
        >
          {label}
        </span>
      )}
      <div
        className="relative flex items-center w-full h-2 rounded-full bg-muted overflow-hidden"
        title={tooltip}
      >
        {/* Left (negative) side */}
        <div className="flex justify-end h-full w-1/2">
          {!isPositive && (
            <div
              className={`h-full rounded-l-full ${barColor} ${showAnimation ? 'transition-all duration-300' : ''}`}
              style={{ width: `${absValue}%` }}
            />
          )}
        </div>
        {/* Center separator */}
        <div className="absolute left-1/2 top-0 h-full w-px bg-foreground/30 -translate-x-1/2 z-10" />
        {/* Right (positive) side */}
        <div className="flex justify-start h-full w-1/2">
          {isPositive && (
            <div
              className={`h-full rounded-r-full ${barColor} ${showAnimation ? 'transition-all duration-300' : ''}`}
              style={{ width: `${absValue}%` }}
            />
          )}
        </div>
      </div>
      {/* Value label */}
      <span
        className={`text-xs font-medium tabular-nums shrink-0 ${
          isGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
        }`}
      >
        {value > 0 ? '+' : ''}
        {value.toFixed(1).replace('.', ',')}%
      </span>
    </div>
  );
});
