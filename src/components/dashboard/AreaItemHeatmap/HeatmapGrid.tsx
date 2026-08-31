'use client';

// ============================================================
//  HeatmapGrid — area×item grid (presentational)
//  --------------------------------------------------------
//  Renders the scrollable grid container: header row (item names
//  rotated 90°) + one row per area with HeatmapCellView children.
//  Receives all data as props (no internal state) — the parent
//  orchestrator owns cellMap, maxVal, metric, hoveredCell, and
//  click/hover handlers.
// ============================================================

import type { CSSProperties } from 'react';
import { HeatmapCellView } from './HeatmapCellView';
import type { HeatmapCell, HeatmapMetric } from './types';

interface HeatmapGridProps {
  areas: string[];
  items: string[];
  cellMap: Map<string, HeatmapCell>;
  maxVal: number;
  metric: HeatmapMetric;
  gridTemplate: CSSProperties;
  onCellClick: (area: string, item: string) => void;
  onCellHover: (cell: { area: string; item: string } | null) => void;
}

export function HeatmapGrid({
  areas, items, cellMap, maxVal, metric, gridTemplate, onCellClick, onCellHover,
}: HeatmapGridProps) {
  return (
    <div
      className="overflow-auto max-h-[520px] rounded border border-border/40"
      style={{ contain: 'layout style' }}
      role="grid"
      aria-label={`Heatmap ${areas.length} area × ${items.length} item`}
    >
      <div className="inline-block min-w-full">
        <div
          className="grid gap-px mb-px sticky top-0 z-10 bg-background"
          style={gridTemplate}
        >
          <div className="text-[10px] font-semibold text-muted-foreground sticky left-0 bg-background z-20 flex flex-col items-start justify-end pb-1 px-2">
            <span>Area \ Item</span>
            <span className="text-[8px] text-muted-foreground/70 font-normal">(baris × kolom)</span>
          </div>
          {items.map((item, idx) => (
            <div
              key={item}
              className="text-[10px] font-medium text-muted-foreground text-center px-1 py-1 leading-tight"
              title={item}
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '120px' }}
            >
              <span className="inline-flex items-start gap-0.5">
                <span className="text-[7px] bg-muted text-muted-foreground rounded-full h-3.5 w-3.5 flex items-center justify-center not-italic" style={{ writingMode: 'horizontal-tb', transform: 'none' }}>
                  {idx + 1}
                </span>
                <span className="line-clamp-1">{item}</span>
              </span>
            </div>
          ))}
        </div>

        {areas.map((areaName) => (
          <div
            key={areaName}
            className="grid gap-px mb-px"
            style={gridTemplate}
          >
            <div
              className="text-[10px] font-medium text-foreground sticky left-0 bg-background z-10 flex items-center px-2 break-words leading-tight underline decoration-dotted underline-offset-2"
              title={areaName}
            >
              {areaName}
            </div>
            {items.map((itemName) => {
              const cell = cellMap.get(`${areaName}|${itemName}`);
              return (
                <HeatmapCellView
                  key={itemName}
                  areaName={areaName}
                  itemName={itemName}
                  cell={cell}
                  maxVal={maxVal}
                  metric={metric}
                  onCellClick={onCellClick}
                  onCellHover={onCellHover}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
