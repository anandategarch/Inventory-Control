'use client';

// ============================================================
//  Scatter Plot Card — presentational
//  --------------------------------------------------------
//  Renders a scatter plot with parameterized axes + color modes.
//  Pure presentational — caller computes points + tooltip lines.
//
//  Color modes:
//    - 'target-only': target=red, peers=gray (Peer Tab style).
//    - 'direction-based': LOSS=red, SURPLUS=green, NEUTRAL=gray,
//      target=amber+ring (Item Trend Tab style).
// ============================================================

import { memo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles } from 'lucide-react';
import type { ScatterPoint } from './types';

export interface ScatterPlotCardProps {
  /** Pre-computed scatter points (caller decides x/y/tooltip). */
  points: ScatterPoint[];
  /** Card title (e.g. "Sales vs Dev/BOM" or "QTY BOM vs |Nominal Deviasi|"). */
  title: string;
  /** Optional subtitle below the title. */
  subtitle?: string;
  /** Chart height in px (default 280). */
  height?: number;
  /** X-axis label (e.g. "Sales", "QTY BOM"). */
  xLabel: string;
  /** Y-axis label (e.g. "Dev/BOM", "|Nominal|"). */
  yLabel: string;
  /** Optional Y-axis unit suffix (e.g. "%"). */
  yUnit?: string;
  /** X-axis tick formatter. */
  formatX: (v: number) => string;
  /** Y-axis tick formatter. */
  formatY: (v: number) => string;
  /** Color mode — see file header. */
  colorMode: 'target-only' | 'direction-based';
  /** Optional legend items (color swatches). Caller provides when needed. */
  legend?: Array<{ label: string; color: string }>;
}

export const ScatterPlotCard = memo(function ScatterPlotCard({
  points,
  title,
  subtitle,
  height = 280,
  xLabel,
  yLabel,
  yUnit,
  formatX,
  formatY,
  colorMode,
  legend,
}: ScatterPlotCardProps) {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          {title}
        </CardTitle>
        {subtitle && (
          <p className="text-[11px] text-muted-foreground ml-9">{subtitle}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="w-full" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 16, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="opacity-60" />
              <XAxis
                type="number"
                dataKey="x"
                name={xLabel}
                tickFormatter={(v: number) => formatX(v)}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                stroke="var(--border)"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={yLabel}
                unit={yUnit}
                tickFormatter={(v: number) => formatY(v)}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                stroke="var(--border)"
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <RTooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as ScatterPoint;
                  return (
                    <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg">
                      <div className="font-semibold border-b pb-1 mb-1">{d.label}</div>
                      {d.tooltipLines?.map((line, i) => (
                        <div key={i} className="text-muted-foreground tabular-nums">
                          {line.label}: {line.value}
                        </div>
                      ))}
                      {d.direction && (
                        <div className="text-muted-foreground">Direction: {d.direction}</div>
                      )}
                      {d.isTarget && (
                        <div
                          className={`font-semibold mt-1 ${
                            colorMode === 'target-only'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          TARGET
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              <Scatter data={points}>
                {points.map((entry, i) => {
                  let fill = '#71717a'; // gray-500 (NEUTRAL / Peer Tab peer default)
                  let stroke = 'var(--background)';
                  let strokeWidth = 1;
                  if (colorMode === 'target-only') {
                    fill = entry.isTarget ? 'var(--chart-loss)' : '#71717a';
                  } else {
                    // direction-based
                    if (entry.direction === 'LOSS') fill = '#dc2626'; // red-600
                    else if (entry.direction === 'SURPLUS') fill = '#10b981'; // emerald-500
                    if (entry.isTarget) fill = '#f59e0b'; // amber-500
                    if (entry.isTarget) {
                      stroke = '#fbbf24'; // amber-400 (ring)
                      strokeWidth = 2;
                    }
                  }
                  return (
                    <Cell
                      key={`cell-${i}`}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      r={entry.isTarget ? 7 : 4}
                    />
                  );
                })}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        {legend && legend.length > 0 && (
          <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground mt-2 flex-wrap">
            {legend.map((l, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${l.color}`} /> {l.label}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
