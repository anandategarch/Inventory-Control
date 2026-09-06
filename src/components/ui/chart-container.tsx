'use client';

// ============================================================
//  ChartContainer + ChartConfig — inspired by shadcn/ui v4 chart.tsx
//  --------------------------------------------------------
//  Wraps Recharts with a config system that:
//    1. Stores label + color + icon per series in one object
//    2. Auto-injects CSS variables (--color-${key}) from config
//    3. Provides ChartTooltipContent + ChartLegendContent that
//       read from config (consistent across all charts)
//
//  Usage:
//    const config = {
//      qty: { label: 'QTY Deviasi', color: '#f59e0b' },
//      zScore: { label: 'Z-Score', color: 'var(--muted-foreground)' },
//    } satisfies ChartConfig;
//
//    <ChartContainer config={config} className="h-72">
//      <LineChart data={data}>
//        <Line dataKey="qty" stroke="var(--color-qty)" />
//        <ChartTooltip content={<ChartTooltipContent />} />
//        <ChartLegend content={<ChartLegendContent />} />
//      </LineChart>
//    </ChartContainer>
//
//  PC-focused design. No indigo or blue colors per project rule — the
//  `color` field is caller-supplied so callers stay on amber/emerald/
//  red/zinc palette.
// ============================================================

import { memo, createContext, useContext, useId, type ReactNode, type ReactElement } from 'react';
import { Tooltip, Legend, ResponsiveContainer } from 'recharts';

export interface ChartConfigItem {
  label?: string;
  color?: string;
  icon?: React.ElementType;
}

export type ChartConfig = Record<string, ChartConfigItem>;

interface ChartContextValue {
  config: ChartConfig;
}

const ChartContext = createContext<ChartContextValue | null>(null);

function useChart() {
  const ctx = useContext(ChartContext);
  if (!ctx) throw new Error('useChart must be used within <ChartContainer>');
  return ctx;
}

interface ChartContainerProps {
  config: ChartConfig;
  className?: string;
  // Recharts' ResponsiveContainer expects a single ReactElement child
  // (e.g. <LineChart>), not the broader ReactNode. Narrowing here keeps
  // tsc happy when we spread `children` into <ResponsiveContainer>.
  children: ReactElement;
}

export const ChartContainer = memo(function ChartContainer({
  config,
  className,
  children,
}: ChartContainerProps) {
  const uniqueId = useId();
  const chartId = `chart-${uniqueId.replace(/:/g, '')}`;

  // Generate CSS variables from config — one `--color-${key}` per series
  // that has a color. Injected as a scoped <style> so multiple charts on
  // the same page don't collide. Children read via `var(--color-${key})`.
  const colorVars = Object.entries(config)
    .filter(([, item]) => item.color)
    .map(([key, item]) => `--color-${key}: ${item.color};`)
    .join('\n');

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={`flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/40 [&_.recharts-reference-line_]:stroke-border [&_.recharts-surface]:outline-hidden ${className ?? ''}`}
      >
        <style dangerouslySetInnerHTML={{ __html: `[data-chart="${chartId}"] { ${colorVars} }` }} />
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});

// ============================================================
//  ChartTooltipContent — standardized tooltip
//  Reads label + color from config. Shows indicator (dot/line/dashed).
//
//  NOTE: this is the GENERIC tooltip — for charts with richer tooltip
//  requirements (e.g. ItemTrendLineChart shows period, metric, signed
//  deviasi, z-score, historical mean, nominal, outlets/records), keep
//  the existing custom tooltip and just wrap the chart with
//  ChartContainer to get the CSS variable + config system.
// ============================================================

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; dataKey?: string; color?: string; type?: string; payload?: Record<string, unknown> }>;
  label?: string;
  indicator?: 'dot' | 'line' | 'dashed';
  hideLabel?: boolean;
  hideIndicator?: boolean;
  // Parameter names in callback type signatures are documentation-only.
  // The project's base `no-unused-vars` rule (without `argsIgnorePattern`)
  // flags them as unused — this matches the existing pattern in
  // `src/hooks/useDashboard.ts:34` (`setFocusOutlet: (code: ...) => void`).
  labelFormatter?: (label: string, payload: unknown[]) => ReactNode;
  formatter?: (value: number | string, name: string, item: unknown, index: number, payload: unknown) => ReactNode;
  className?: string;
}

export const ChartTooltipContent = memo(function ChartTooltipContent({
  active,
  payload,
  label,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  labelFormatter,
  formatter,
  className,
}: ChartTooltipContentProps) {
  const { config } = useChart();

  if (!active || !payload || payload.length === 0) return null;

  const tooltipLabel = !hideLabel && label ? (
    <div className="font-medium mb-1">{labelFormatter ? labelFormatter(label, payload as unknown[]) : label}</div>
  ) : null;

  return (
    <div className={`rounded-lg border bg-background/95 backdrop-blur-sm shadow-lg p-2.5 text-[11px] min-w-32 ${className ?? ''}`}>
      {tooltipLabel}
      <div className="grid gap-1.5">
        {payload.filter((item) => item.type !== 'none').map((item, index) => {
          const key = item.dataKey ?? item.name ?? 'value';
          const itemConfig = config[key as string];
          const indicatorColor = item.color ?? itemConfig?.color ?? 'var(--muted-foreground)';

          if (formatter && item.value !== undefined && item.name) {
            return <div key={index}>{formatter(item.value, item.name, item, index, item.payload)}</div>;
          }

          return (
            <div key={index} className="flex items-center gap-2">
              {!hideIndicator && (
                <div
                  className={`shrink-0 rounded-sm ${indicator === 'dot' ? 'h-2.5 w-2.5' : indicator === 'line' ? 'w-1 h-2.5' : 'w-0 border-[1.5px] border-dashed bg-transparent h-2.5'}`}
                  style={{ backgroundColor: indicator !== 'dashed' ? indicatorColor : undefined, borderColor: indicator === 'dashed' ? indicatorColor : undefined }}
                />
              )}
              <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
              <span className="font-medium tabular-nums text-foreground ml-auto">
                {typeof item.value === 'number' ? item.value.toLocaleString('id-ID') : String(item.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ============================================================
//  ChartLegendContent — standardized legend
// ============================================================

interface ChartLegendContentProps {
  payload?: Array<{ value?: string; dataKey?: string; color?: string; type?: string }>;
  className?: string;
  hideIcon?: boolean;
}

export const ChartLegendContent = memo(function ChartLegendContent({
  payload,
  className,
  hideIcon = false,
}: ChartLegendContentProps) {
  const { config } = useChart();

  if (!payload || payload.length === 0) return null;

  return (
    <div className={`flex items-center justify-center gap-4 pt-3 text-xs text-muted-foreground ${className ?? ''}`}>
      {payload.filter((item) => item.type !== 'none').map((item, index) => {
        const key = item.dataKey ?? item.value ?? 'value';
        const itemConfig = config[key as string];
        const color = item.color ?? itemConfig?.color ?? 'var(--muted-foreground)';

        return (
          <span key={index} className="flex items-center gap-1.5">
            {!hideIcon && <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />}
            {itemConfig?.label ?? item.value}
          </span>
        );
      })}
    </div>
  );
});

// Re-export Recharts Tooltip + Legend for convenience so callers can
// import everything chart-related from one module.
export { Tooltip as ChartTooltip, Legend as ChartLegend };
