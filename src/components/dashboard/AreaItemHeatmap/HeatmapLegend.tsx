'use client';

// ============================================================
//  HeatmapLegend — color gradient + numbered item list + summary
//  --------------------------------------------------------
//  Pure presentational. Three sub-sections rendered in document
//  order (color legend, collapsible item list, summary stats).
// ============================================================

import { METRIC_CONFIG } from './metricConfig';
import type { HeatmapMetric } from './types';

interface HeatmapLegendProps {
  metric: HeatmapMetric;
  maxVal: number;
  items: string[];
  areasCount: number;
  cellsWithData: number;
  totalRecords: number;
}

export function HeatmapLegend({
  metric, maxVal, items, areasCount, cellsWithData, totalRecords,
}: HeatmapLegendProps) {
  return (
    <>
      {/* Color legend */}
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground flex-wrap">
        <div className="flex items-center gap-2">
          <span>Rendah</span>
          <div
            className="h-3 w-32 rounded"
            style={{ background: 'linear-gradient(to right, hsl(120, 75%, 92%), hsl(60, 85%, 72%), hsl(30, 90%, 62%), hsl(0, 95%, 52%))' }}
          />
          <span>Tinggi</span>
        </div>
        <div>
          Max: <span className="font-medium text-foreground">{METRIC_CONFIG[metric].format(maxVal)}</span>
        </div>
      </div>

      {/* Numbered item legend */}
      <details className="text-[10px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground select-none">
          Lihat daftar item lengkap ({items.length})
        </summary>
        <ol className="grid grid-cols-3 gap-x-4 gap-y-0.5 mt-1 pl-4 list-decimal">
          {items.map((item, idx) => (
            <li key={`${item}-${idx}`} className="break-words leading-tight" title={item}>
              <span className="text-muted-foreground/60 mr-1">{idx + 1}.</span>
              {item}
            </li>
          ))}
        </ol>
      </details>

      {/* Summary stats */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground border-t pt-2">
        <span>{areasCount} area × {items.length} item = {areasCount * items.length} sel</span>
        <span>•</span>
        <span>{cellsWithData} sel dengan data</span>
        <span>•</span>
        <span>{totalRecords} total record</span>
      </div>
    </>
  );
}
