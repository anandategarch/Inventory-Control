'use client';

// ============================================================
//  HeatmapControls — mode toggle + metric + item-limit selectors
//  --------------------------------------------------------
//  Pure presentational controls row. Receives current values +
//  change handlers from the orchestrator (parent owns state).
// ============================================================

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { METRIC_CONFIG } from './metricConfig';
import type { HeatmapMetric, ItemSelectMode } from './types';

interface HeatmapControlsProps {
  metric: HeatmapMetric;
  mode: ItemSelectMode;
  itemLimit: number;
  onMetricChange: (v: string) => void;
  onModeChange: (v: string) => void;
  onItemLimitChange: (v: string) => void;
}

export function HeatmapControls({
  metric, mode, itemLimit, onMetricChange, onModeChange, onItemLimitChange,
}: HeatmapControlsProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">Mode:</Label>
        <Select value={mode} onValueChange={onModeChange}>
          <SelectTrigger className="h-8 text-xs w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pareto80" className="text-xs">Pareto 80%</SelectItem>
            <SelectItem value="top" className="text-xs">Top N</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">Metrik:</Label>
        <Select value={metric} onValueChange={onMetricChange}>
          <SelectTrigger className="h-8 text-xs w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(METRIC_CONFIG).map(([key, cfg]) => (
              <SelectItem key={key} value={key} className="text-xs">
                {cfg.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">Maks Item:</Label>
        <Select value={String(itemLimit)} onValueChange={onItemLimitChange}>
          <SelectTrigger className="h-8 text-xs w-[70px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10" className="text-xs">10</SelectItem>
            <SelectItem value="15" className="text-xs">15</SelectItem>
            <SelectItem value="20" className="text-xs">20</SelectItem>
            <SelectItem value="30" className="text-xs">30</SelectItem>
            <SelectItem value="50" className="text-xs">50</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
