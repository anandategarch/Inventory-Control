'use client';

// ============================================================
//  ItemTrendLineChart — Recharts LineChart for ItemTrendTab.
//  --------------------------------------------------------
//  Lazy-loaded by ItemTrendTab via next/dynamic (ssr: false) so
//  Recharts (5.4MB) stays out of the main bundle.
//
//  Chart layout:
//    X-axis  = period short label ("Jun W4", "Jul W4", …)
//    Y1 (left)  = selected metric's QTY value (signed — amber line)
//    Y2 (right) = Z-Score (-3 .. +3 typical range)
//    Dashed ReferenceLine per-period = historical mean baseline
//    Z-Score dot color: red (z>2), amber (1<z≤2), yellow (0<z≤1),
//                       green (z≤0), muted (z=null)
//
//  Tooltip shows: period, metric value, signed deviasi, z-score,
//  historical mean, outlet count, record count.
// ============================================================

import { memo, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Legend,
} from 'recharts';
import { fmtIDR, fmtNum } from '@/lib/format';
import type { ItemTrendMetric, ItemTrendPeriod } from '@/hooks/useAnalysis';
import { getFlipsForPeriod, periodKey as flipPeriodKey, type FlipAnalysis } from './ItemTrendTab/flipHelpers';

interface ChartRow {
  period: string;
  fullLabel: string;
  qty: number;
  zScore: number | null;
  historicalMean: number;
  outletCount: number;
  recordCount: number;
  qtyDeviasiSigned: number;
  qtyBom: number;
  nominalDeviasi: number;
  sampleSize: number;
  /** Phase A+B (FLIP-FE) — short period key (`${monthLabel}|${weekLabel}`)
   *  used to look up flip analyses for this row's period. */
  periodKey: string;
  /** Phase A+B (FLIP-FE) — when true, this period is part of ANY flip pair
   *  (either as P1 or P2). Used by renderZDot to draw an amber ring. */
  hasFlip: boolean;
  /** Phase A+B (FLIP-FE) — human-readable description of the flip pair(s)
   *  this period is part of (one entry per pair). Shown in the tooltip. */
  flipInfo: string[];
}

interface ItemTrendLineChartProps {
  periods: ItemTrendPeriod[];
  metric: ItemTrendMetric;
  /** Optional callback invoked when the user clicks a chart point (dot
   *  or active area). Powers the Phase 2 drill-down into ItemPeerComparison.
   *  Receives the underlying ItemTrendPeriod so the caller can build a
   *  `{ month, week }` drill key. */
  onDotClick?: (_period: ItemTrendPeriod) => void;
  /** Phase A+B (FLIP-FE) — flip analyses for the item. Dots whose period
   *  is part of ANY flip pair (as P1 or P2) get an amber dashed ring + a
   *  tooltip line "🔀 Flip detected vs {other period} ({X}% disparity)".
   *  Optional — when omitted, no flip annotations are rendered. */
  flips?: FlipAnalysis[];
}

const METRIC_LABELS: Record<ItemTrendMetric, string> = {
  qtyDeviasi: 'QTY Deviasi',
  qtyWaste: 'QTY Waste',
  qtySusut: 'QTY Susut',
  qtyTrial: 'QTY Trial',
};

// Color for the Z-Score dot — matches the table coloring exactly.
function zDotFill(z: number | null): string {
  if (z == null) return 'var(--muted-foreground)';
  if (z > 3) return '#dc2626'; // red-600
  if (z > 2) return '#f59e0b'; // amber-500
  if (z > 1) return '#eab308'; // yellow-500
  if (z < -2) return '#10b981'; // emerald-500
  if (z < -1) return '#34d399'; // emerald-400
  return '#9ca3af'; // gray-400 (near-zero)
}

// Build per-period row for Recharts. The `qty` field is the SIGNED
// deviasi (for default metric) so the chart shows direction (LOSS below
// 0, SURPLUS above 0). For Waste/Susut/Trial we use the ABS magnitude
// (those fields are always-positive aggregates from the API).
//
// Phase A+B (FLIP-FE): also attaches the period key + any matching flip
// info from the `flips` array (passed down from ItemTrendTab).
function buildRow(
  p: ItemTrendPeriod,
  metric: ItemTrendMetric,
  flips?: FlipAnalysis[],
): ChartRow {
  let qty: number;
  switch (metric) {
    case 'qtyDeviasi':
      // Use ABS for chart — historicalMean is also ABS (comparable on same axis)
      qty = Math.abs(p.qtyDeviasiSigned);
      break;
    case 'qtyWaste':
      qty = p.qtyWaste;
      break;
    case 'qtySusut':
      qty = p.qtySusut;
      break;
    case 'qtyTrial':
      qty = p.qtyTrial;
      break;
  }
  const pk = flipPeriodKey(p);
  // FIX (BUG-FLIP-01): only show flip annotation for ACTUAL flips (isFlip=true).
  // Was showing amber ring + tooltip for ALL pairs including konsisten-naik/turun
  // (same-direction pairs) — misleading. Now filters to actual sign-change flips.
  const pairs = flips ? getFlipsForPeriod(flips, pk).filter((f) => f.isFlip) : [];
  const flipInfo = pairs.map((f) => {
    const otherLabel = f.period1Key === pk ? f.period2Label : f.period1Label;
    return `🔀 Flip detected vs ${otherLabel} (${Math.round(f.disparityPct)}% disparity)`;
  });
  return {
    period: `${p.monthLabel.slice(0, 3)} ${p.weekLabel.replace('WEEK ', 'W')}`,
    fullLabel: `${p.monthLabel} · ${p.weekLabel}`,
    qty,
    zScore: p.zScore,
    historicalMean: p.historicalMean,
    outletCount: p.outletCount,
    recordCount: p.recordCount,
    qtyDeviasiSigned: p.qtyDeviasiSigned,
    qtyBom: p.qtyBom,
    nominalDeviasi: p.nominalDeviasi,
    sampleSize: p.sampleSize,
    periodKey: pk,
    hasFlip: pairs.length > 0,
    flipInfo,
  };
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  metric: ItemTrendMetric;
}

// Custom tooltip — Recharts passes `payload[0].payload` as the row.
// Using a function component (not arrow) so Recharts can detect it.
function CustomTooltip({ active, payload, metric }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const z = row.zScore;
  const zColorClass = z == null
    ? 'text-muted-foreground'
    : z > 3 ? 'text-red-600' :
      z > 2 ? 'text-amber-600' :
      z > 1 ? 'text-yellow-600' :
      z < -2 ? 'text-emerald-600' :
      z < -1 ? 'text-emerald-500' :
      'text-muted-foreground';
  return (
    <div className="rounded-md border bg-background/95 backdrop-blur-sm shadow-lg p-2.5 text-[11px] space-y-1 max-w-[260px]">
      <p className="font-semibold text-foreground">{row.fullLabel}</p>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{METRIC_LABELS[metric]}:</span>
        <span className="font-medium tabular-nums text-amber-600 dark:text-amber-400">
          {row.qty.toLocaleString('id-ID', { maximumFractionDigits: 1 })}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">QTY Deviasi (signed):</span>
        <span className={`font-medium tabular-nums ${row.qtyDeviasiSigned < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
          {row.qtyDeviasiSigned.toLocaleString('id-ID', { maximumFractionDigits: 1 })}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">QTY BOM:</span>
        <span className="font-medium tabular-nums">{fmtNum(row.qtyBom)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Historical Mean:</span>
        <span className="font-medium tabular-nums">{fmtNum(row.historicalMean)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Z-Score:</span>
        <span className={`font-bold tabular-nums ${zColorClass}`}>
          {z == null ? '— (n<4)' : `${z > 0 ? '+' : ''}${z.toFixed(2)}`}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">|Nominal|:</span>
        <span className="font-medium tabular-nums">{fmtIDR(row.nominalDeviasi)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Outlets / Records:</span>
        <span className="font-medium tabular-nums">{row.outletCount} / {row.recordCount}</span>
      </div>
      {z != null && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Sample size:</span>
          <span className="font-medium tabular-nums">{row.sampleSize} weeks</span>
        </div>
      )}
      {/* Phase A+B (FLIP-FE) — show flip annotations when this period is
          part of any flip pair (either as P1 or P2). */}
      {row.flipInfo.length > 0 && (
        <div className="mt-1 pt-1 border-t border-amber-300/40 dark:border-amber-700/40 space-y-1">
          {row.flipInfo.map((line, i) => (
            <div key={i} className="text-amber-700 dark:text-amber-400 font-medium">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ItemTrendLineChart = memo(function ItemTrendLineChart({ periods, metric, onDotClick, flips }: ItemTrendLineChartProps) {
  const data = useMemo(() => periods.map(p => buildRow(p, metric, flips)), [periods, metric, flips]);

  // Phase 2 drill-down: Recharts passes the chart state to `onClick`,
  // including `activeTooltipIndex` (the index into `data` of the nearest
  // point to the click). Map that back to the underlying ItemTrendPeriod
  // and invoke the parent's `onDotClick` callback.
  const handleChartClick = (state: { activeTooltipIndex?: number }) => {
    if (!onDotClick) return;
    const idx = state?.activeTooltipIndex;
    if (idx == null || idx < 0 || idx >= periods.length) return;
    onDotClick(periods[idx]);
  };

  // Per-dot fill color — Recharts allows a function for `fill` on Dot.
  // We render a custom <Line dot={...}> to color each dot individually
  // based on its Z-Score.
  // NOTE: Recharts' LineDot type requires returning a ReactElement (not
  // null). When `cx`/`cy`/`payload` are missing (rare edge case during
  // animation), return an empty <g/> instead of null so the type matches.
  //
  // Phase A+B (FLIP-FE): if the period is part of any flip pair, draw
  // an outer amber dashed ring around the dot (the inner dot keeps its
  // Z-Score color so the flip annotation doesn't mask the Z-Score signal).
  const renderZDot = (props: { cx?: number; cy?: number; payload?: ChartRow }) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) {
      return <g />;
    }
    const fill = zDotFill(payload.zScore);
    return (
      <g>
        {/* Phase A+B (FLIP-FE) — outer amber dashed ring for flip periods. */}
        {payload.hasFlip && (
          <circle
            cx={cx}
            cy={cy}
            r={7}
            fill="none"
            stroke="#f59e0b"
            strokeWidth={1.5}
            strokeDasharray="2 2"
            opacity={0.9}
          />
        )}
        <circle
          cx={cx}
          cy={cy}
          r={4}
          fill={fill}
          stroke="var(--background)"
          strokeWidth={1.5}
        />
      </g>
    );
  };

  // Mean dot color — muted neutral. Used for the historical-mean Line.
  const renderMeanDot = (props: { cx?: number; cy?: number }) => {
    const { cx, cy } = props;
    if (cx == null || cy == null) {
      return <g />;
    }
    return (
      <circle
        cx={cx}
        cy={cy}
        r={2.5}
        fill="var(--muted-foreground)"
        opacity={0.55}
      />
    );
  };

  if (data.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-12">
        Tidak ada data tren untuk item ini
      </div>
    );
  }

  // FIX FE-10: 1-period data can't draw a trend line — show message instead of degenerate chart
  if (data.length === 1) {
    return (
      <div className="text-center text-muted-foreground text-sm py-12">
        Hanya 1 periode data tersedia — butuh minimal 2 periode untuk menampilkan tren
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Tren <span className="font-medium text-foreground">{METRIC_LABELS[metric]}</span> lintas {data.length} periode
        {' · '}
        <span className="text-amber-600 dark:text-amber-400">▮ QTY</span>
        {' · '}
        <span className="text-muted-foreground">▮ Historical Mean (baseline)</span>
        {' · '}
        <span>Dots berwarna = Z-Score</span>
        {data.some(d => d.hasFlip) && (
          <>
            {' · '}
            <span className="text-amber-600 dark:text-amber-400">⬤ Flip detected (amber dashed ring)</span>
          </>
        )}
      </p>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ left: 0, right: 16, top: 10, bottom: 5 }}
            onClick={onDotClick ? handleChartClick : undefined}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" className="opacity-60" />
            <XAxis
              dataKey="period"
              fontSize={10}
              stroke="var(--muted-foreground)"
              tickLine={false}
              axisLine={false}
              angle={-30}
              textAnchor="end"
              height={50}
            />
            {/* Left Y axis — QTY value */}
            <YAxis
              yAxisId="left"
              tickFormatter={(v: number) => {
                const abs = Math.abs(v);
                if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
                return v.toFixed(0);
              }}
              fontSize={10}
              stroke="var(--muted-foreground)"
              tickLine={false}
              axisLine={false}
              width={50}
            />
            {/* Right Y axis — Z-Score */}
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[-4, 4]}
              ticks={[-3, -2, -1, 0, 1, 2, 3]}
              tickFormatter={(v: number) => (v > 0 ? `+${v}` : `${v}`)}
              fontSize={10}
              stroke="var(--muted-foreground)"
              tickLine={false}
              axisLine={false}
              width={36}
            />
            <Tooltip
              content={<CustomTooltip metric={metric} />}
              cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
            />
            <Legend
              wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
              formatter={(value: string) => {
                if (value === 'qty') return METRIC_LABELS[metric];
                if (value === 'zScore') return 'Z-Score';
                if (value === 'historicalMean') return 'Historical Mean';
                return value;
              }}
            />
            {/* Historical mean baseline — dashed muted line */}
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="historicalMean"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={renderMeanDot}
              activeDot={false}
              connectNulls
              isAnimationActive={false}
              name="historicalMean"
            />
            {/* QTY value — solid amber line */}
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="qty"
              stroke="#f59e0b"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5, fill: '#f59e0b', stroke: 'var(--background)', strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
              name="qty"
            />
            {/* Z-Score — invisible line (just dots) on the right axis */}
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="zScore"
              stroke="transparent"
              strokeWidth={0}
              dot={renderZDot}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
              name="zScore"
            />
            {/* Reference lines at z=±2 and z=±3 (visual guide for severity) */}
            <ReferenceLine yAxisId="right" y={2} stroke="#f59e0b" strokeDasharray="2 4" strokeOpacity={0.4} />
            <ReferenceLine yAxisId="right" y={3} stroke="#dc2626" strokeDasharray="2 4" strokeOpacity={0.4} />
            <ReferenceLine yAxisId="right" y={0} stroke="var(--muted-foreground)" strokeDasharray="1 3" strokeOpacity={0.3} />
            <ReferenceLine yAxisId="right" y={-2} stroke="#10b981" strokeDasharray="2 4" strokeOpacity={0.3} />
            <ReferenceLine yAxisId="right" y={-3} stroke="#10b981" strokeDasharray="2 4" strokeOpacity={0.4} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});
