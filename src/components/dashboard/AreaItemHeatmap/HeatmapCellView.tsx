'use client';

// ============================================================
//  HeatmapCellView — memoized single cell
//  --------------------------------------------------------
//  Click opens drill-down Sheet (parent-managed), hover notifies
//  parent (parent manages ONE Tooltip — see index.tsx).
//  PERF-FE: NO Radix Tooltip per cell (was 280 instances = 840
//  components + 1120 event listeners). Instead, parent manages
//  ONE Tooltip + we pass hover data up via onHover callback.
//  56× fewer component instances.
// ============================================================

import { memo } from 'react';
import { fmtHeatmapCompact } from '@/lib/format';
import {
  AVG_ELIGIBLE_METRICS,
  computeAvgPerOutlet,
  formatCellValue,
  getHeatColor,
  getTextColor,
} from './heatmapHelpers';
import type { HeatmapCell, HeatmapMetric } from './types';

interface CellProps {
  areaName: string;
  itemName: string;
  cell: HeatmapCell | undefined;
  maxVal: number;
  metric: HeatmapMetric;
  onCellClick: (area: string, item: string) => void;
  onCellHover: (cell: { area: string; item: string } | null) => void;
}

export const HeatmapCellView = memo(function HeatmapCellView({
  areaName, itemName, cell, maxVal, metric, onCellClick, onCellHover,
}: CellProps) {
  const value = cell?.value ?? 0;
  const bg = getHeatColor(value, maxVal);
  const textCls = getTextColor(value, maxVal);
  const showAvg = AVG_ELIGIBLE_METRICS.has(metric) && value > 0 && (cell?.outletCount ?? 0) > 0;
  const avgValue = showAvg ? computeAvgPerOutlet(value, cell!.outletCount) : 0;
  const avgTextCls = avgValue > 0 && getTextColor(avgValue, maxVal) === 'text-white' ? 'text-white/70' : 'text-foreground/60';

  return (
    <button
      type="button"
      className="h-11 w-full rounded-sm flex flex-col items-center justify-center cursor-pointer relative z-0 hover:z-10 hover:scale-110 hover:ring-2 hover:ring-amber-500 transition-transform gap-0"
      style={{ backgroundColor: bg === 'transparent' ? 'rgba(0,0,0,0.02)' : bg }}
      onClick={() => onCellClick(areaName, itemName)}
      onMouseEnter={() => onCellHover({ area: areaName, item: itemName })}
      onMouseLeave={() => onCellHover(null)}
      onFocus={() => onCellHover({ area: areaName, item: itemName })}
      onBlur={() => onCellHover(null)}
      aria-label={`Detail ${areaName} ${itemName}`}
    >
      {value > 0 && (
        <>
          <span className={`text-[10px] font-semibold leading-tight ${textCls}`}>
            {formatCellValue(metric, value)}
          </span>
          {showAvg && (
            <span className={`text-[8px] leading-tight ${avgTextCls}`}>
              Ø {fmtHeatmapCompact(avgValue)}
            </span>
          )}
        </>
      )}
    </button>
  );
}, (prev, next) =>
  prev.areaName === next.areaName &&
  prev.itemName === next.itemName &&
  prev.cell?.value === next.cell?.value &&
  prev.cell?.recordCount === next.cell?.recordCount &&
  prev.cell?.outletCount === next.cell?.outletCount &&
  prev.maxVal === next.maxVal &&
  prev.metric === next.metric
);
