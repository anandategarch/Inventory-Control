'use client';

// ============================================================
//  HeatmapTooltip — single controlled Tooltip content
//  --------------------------------------------------------
//  PERF-FE: ONE Tooltip instance for the entire grid (was 280
//  per-cell Tooltips). The parent (index.tsx) owns hoveredCell
//  state and wraps HeatmapGrid in <TooltipProvider><TooltipRoot
//  open={hoveredCell !== null}><TooltipTrigger asChild>...
//  This component renders the Portal + Content subtree that
//  sits as a sibling of <TooltipTrigger> inside <TooltipRoot>.
//
//  Receives hoveredCell + cellMap + metric as props. Returns
//  null when hoveredCell is null (the Root's `open` prop is
//  also false in that case — Radix tolerates a null Portal).
// ============================================================

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { fmtIDR } from '@/lib/format';
import {
  AVG_ELIGIBLE_METRICS,
  computeAvgPerOutlet,
} from './heatmapHelpers';
import { METRIC_CONFIG } from './metricConfig';
import type { HeatmapCell, HeatmapMetric } from './types';

interface HeatmapTooltipProps {
  hoveredCell: { area: string; item: string } | null;
  cellMap: Map<string, HeatmapCell>;
  metric: HeatmapMetric;
}

export function HeatmapTooltip({ hoveredCell, cellMap, metric }: HeatmapTooltipProps) {
  if (!hoveredCell) return null;

  const hc = cellMap.get(`${hoveredCell.area}|${hoveredCell.item}`);
  const hv = hc?.value ?? 0;
  const hOutletCount = hc?.outletCount ?? 0;
  const hRecordCount = hc?.recordCount ?? 0;
  const hShowAvg = AVG_ELIGIBLE_METRICS.has(metric) && hv > 0 && hOutletCount > 0;
  const hAvg = hShowAvg ? computeAvgPerOutlet(hv, hOutletCount) : 0;

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side="top"
        avoidCollisions
        collisionPadding={8}
        className="max-w-[320px] text-xs z-50 bg-primary text-primary-foreground shadow-lg rounded-lg px-3 py-2"
        sideOffset={4}
      >
        <div className="font-medium leading-snug">{hoveredCell.area} → {hoveredCell.item}</div>
        <div className="text-primary-foreground/80 mt-0.5">
          {METRIC_CONFIG[metric].label}: <span className="font-medium text-primary-foreground">{METRIC_CONFIG[metric].format(hv)}</span>
        </div>
        {hShowAvg && (
          <div className="text-primary-foreground/80">
            Rata-rata per resto: <span className="font-medium text-primary-foreground">{fmtIDR(hAvg)}</span>
          </div>
        )}
        <div className="text-primary-foreground/80">
          Jumlah resto: <span className="font-medium text-primary-foreground">{hOutletCount}</span>
        </div>
        <div className="text-primary-foreground/80">
          Jumlah record: <span className="font-medium text-primary-foreground">{hRecordCount}</span>
        </div>
        {hc && hv > 0 && (
          <div className="text-primary-foreground/80 border-t border-primary-foreground/20 mt-1 pt-1">
            Klik untuk detail per resto →
          </div>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
