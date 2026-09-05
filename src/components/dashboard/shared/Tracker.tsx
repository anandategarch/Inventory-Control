'use client';

// ============================================================
//  Tracker — horizontal status blocks (Pattern 3)
//  --------------------------------------------------------
//  Inspired by tremor-npm's <Tracker> component.
//  Renders a row of colored blocks (one per period) showing
//  health/status at a glance:
//    - emerald = normal
//    - amber   = elevated / warning
//    - red     = abnormal
//    - zinc    = no data / not applicable
//
//  Each block:
//    - Equal width (`flex-1`) so the row stays compact + scannable
//    - Optional tooltip (Radix Tooltip — native cursor-help)
//    - aria-label fallback ("Period N") for screen readers
//
//  PC-focused design (compact `h-8` blocks, dark mode aware).
//  No indigo or blue colors per project rule.
// ============================================================

import { memo } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export type TrackerColor = 'emerald' | 'amber' | 'red' | 'zinc';

export interface TrackerBlock {
  /** Block color — semantic status. */
  color: TrackerColor;
  /** Tooltip shown on hover. Pass empty/undefined to skip tooltip. */
  tooltip?: string;
}

export interface TrackerProps {
  /** Status blocks (one per period). Renders left → right. */
  blocks: TrackerBlock[];
  /** Extra className appended to the row container. */
  className?: string;
}

const TRACKER_COLORS: Record<TrackerColor, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  zinc: 'bg-zinc-300 dark:bg-zinc-700',
};

export const Tracker = memo(function Tracker({ blocks, className }: TrackerProps) {
  return (
    <div className={`flex items-center h-8 gap-0.5 ${className ?? ''}`}>
      {blocks.map((block, idx) => (
        <Tooltip key={idx}>
          <TooltipTrigger asChild>
            <div
              className={`flex-1 h-full rounded-sm cursor-help ${TRACKER_COLORS[block.color]}`}
              role="img"
              aria-label={block.tooltip ?? `Period ${idx + 1}`}
            />
          </TooltipTrigger>
          {block.tooltip && (
            <TooltipContent side="top" className="text-xs p-2">
              {block.tooltip}
            </TooltipContent>
          )}
        </Tooltip>
      ))}
    </div>
  );
});
