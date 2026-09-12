'use client';

// ============================================================
//  ItemTrendRankChart — Compact Recharts LineChart showing the
//  item's national rank (by ABS(nominalDeviasi)) across all
//  periods. Sits below the main QTY chart in the Trend Item Tab.
//  --------------------------------------------------------
//  Y-axis is INVERTED: rank #1 at TOP (worst — highest deviasi),
//  rank #N at BOTTOM (best — lowest deviasi). This visual
//  convention matches "higher on chart = worse" intuition for
//  rank data (rank 1 is the most-anomalous item).
//
//  Per-period dot color (severity):
//    rank ≤ 5    → red (#dc2626)     — top deviasi, very bad
//    rank 6-20   → amber (#f59e0b)   — high deviasi
//    rank > 20   → emerald (#10b981) — relatively normal
//
//  ReferenceLines at rank=5 (red dashed) and rank=20 (amber
//  dashed) mark the severity thresholds visually. They are only
//  rendered when maxRank reaches the threshold (avoids lines
//  outside the visible domain).
//
//  Click handler: same pattern as ItemTrendLineChart — Recharts
//  passes `activeTooltipIndex` (nearest-point index) on click,
//  which is mapped back to the underlying period and forwarded
//  to the parent's `onDotClick` callback (powers the Phase 2
//  drill-down into ItemPeerComparison).
//
//  Compact size: 100px height. No Legend (header text explains
//  the line). No Z-Score axis (rank-only). Animation disabled
//  to prevent jank on data refresh.
// ============================================================

import { memo, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { fmtIDR } from '@/lib/format';

interface RankPeriod {
  monthLabel: string;
  weekLabel: string;
  monthKey: string | null;
  rankNominal: number;
  totalItems: number;
  absNominal: number;
}

export interface ItemTrendRankChartProps {
  periods: RankPeriod[];
  /** Optional click handler — receives `{ month, week }` so the parent
   *  can sync the drill-down period. Same shape as ItemTrendLineChart's
   *  onDotClick (but with a narrower payload — rank chart doesn't need
   *  the full ItemTrendPeriod). */
  // Underscore prefix matches ItemTrendLineChart's onDotClick convention
  // (the project's no-unused-vars rule has no argsIgnorePattern, so this
  // still warns — accepted as a known codebase pattern).
  onDotClick?: (_period: { monthLabel: string; weekLabel: string }) => void;
}

interface ChartRow {
  /** Short X-axis label, e.g. "Jun W4". */
  period: string;
  /** Full label for tooltip, e.g. "JUNI · WEEK 4". */
  fullLabel: string;
  /** National rank (1 = worst). FIX (BUG-3-05): always number — query coerces
   *  null→0 via `Number(r.rankNominal) || 0`. The `| null` in the type was
   *  dead (unreachable) since the source RankPeriod.rankNominal is `number`. */
  rank: number;
  /** Total items ranked in that period (denominator for "Rank #N of M"). */
  totalItems: number;
  /** This item's |nominalDeviasi| for that period (IDR-formatted in tooltip). */
  absNominal: number;
}

// Color thresholds — FIX (BUG-3-01): aligned with the rank badge in
// ItemTrendTab header (rankBadgeClass). Was using emerald for rank > 20,
// but the badge uses muted-gray for rank > 20 (not in top 20 = normal/not
// severe). Now both chart + badge use the same palette:
//   rank ≤ 5    → red (severe)
//   rank 6-20   → amber (warning)
//   rank > 20   → muted-gray (normal — not in top 20)
function rankColor(rank: number): string {
  if (rank <= 5) return '#dc2626'; // red-600
  if (rank <= 20) return '#f59e0b'; // amber-500
  return 'var(--muted-foreground)'; // muted — matches badge's "Rank > 20" style
}

// Build per-period row for Recharts. Short X-axis label matches the
// main chart's format ("Jun W4") so the two charts align visually.
function buildRow(p: RankPeriod): ChartRow {
  return {
    period: `${p.monthLabel.slice(0, 3)} ${p.weekLabel.replace('WEEK ', 'W')}`,
    fullLabel: `${p.monthLabel} · ${p.weekLabel}`,
    rank: p.rankNominal,
    totalItems: p.totalItems,
    absNominal: p.absNominal,
  };
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
}

// Custom tooltip — shows period, "Rank #N of M items", |Nominal Deviasi|.
// Rank value is colored to match the dot severity for visual consistency.
function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const color = rankColor(row.rank);
  return (
    <div className="rounded-md border bg-background/95 backdrop-blur-sm shadow-lg p-2.5 text-[11px] space-y-1 max-w-[240px]">
      <p className="font-semibold text-foreground">{row.fullLabel}</p>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Rank Nasional:</span>
        {/* FIX (BUG-3-05): rank is always number now (dead null branch removed) */}
        <span className="font-bold tabular-nums" style={{ color }}>
          #{row.rank} dari {row.totalItems} item
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">|Nominal Deviasi|:</span>
        <span className="font-medium tabular-nums">{fmtIDR(row.absNominal)}</span>
      </div>
    </div>
  );
}

export const ItemTrendRankChart = memo(function ItemTrendRankChart({ periods, onDotClick }: ItemTrendRankChartProps) {
  const data = useMemo(() => periods.map(buildRow), [periods]);

  // Max rank across all periods — used as the Y-axis upper bound so the
  // chart auto-scales. Domain [1, maxRank] with `reversed` puts rank #1
  // at the TOP (worst) and #maxRank at the BOTTOM (best).
  // Floor at 2 so a single-rank chart still has a visible Y range.
  // FIX (BUG-3-05): rank is always number now — no null filter needed.
  const maxRank = useMemo(() => {
    if (data.length === 0) return 2;
    return Math.max(2, ...data.map(d => d.rank));
  }, [data]);

  // Phase 2 drill-down — same pattern as ItemTrendLineChart. Recharts
  // passes the chart state to `onClick`, including `activeTooltipIndex`
  // (the index into `data` of the nearest point to the click). Map that
  // back to the underlying RankPeriod and invoke the parent's callback.
  const handleChartClick = (state: { activeTooltipIndex?: number }) => {
    if (!onDotClick) return;
    const idx = state?.activeTooltipIndex;
    if (idx == null || idx < 0 || idx >= periods.length) return;
    onDotClick({ monthLabel: periods[idx].monthLabel, weekLabel: periods[idx].weekLabel });
  };

  // Per-dot fill color based on rank severity. White stroke for contrast
  // against the chart background (same pattern as ItemTrendLineChart's
  // renderZDot). When `cx`/`cy`/`payload` are missing (rare edge case
  // during animation), return an empty <g/> so Recharts' LineDot type
  // is satisfied (it requires a ReactElement, not null).
  const renderDot = (props: { cx?: number; cy?: number; payload?: ChartRow }) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) {
      return <g />;
    }
    const fill = rankColor(payload.rank);
    return (
      <circle
        cx={cx}
        cy={cy}
        r={4}
        fill={fill}
        stroke="var(--background)"
        strokeWidth={1.5}
      />
    );
  };

  // Edge case: 0 periods — render nothing (parent also guards this, but
  // defensive programming in case the chart is used elsewhere).
  if (data.length === 0) {
    return null;
  }

  // Edge case: 1 period — can't draw a trend line. Show a message instead
  // of a degenerate chart (matches ItemTrendLineChart edge case handling).
  if (data.length === 1) {
    return (
      <div className="text-center text-muted-foreground text-[11px] py-2">
        Hanya 1 periode — butuh minimal 2 periode untuk menampilkan tren rank
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <p className="text-[11px] text-muted-foreground">
        Ranking Nasional per Periode (by |Nominal Deviasi|) ·{' '}
        <span className="text-red-600 dark:text-red-400">▮</span>{' '}
        <span>Rank (1=terburuk, inverted Y-axis)</span>
      </p>
      <div className="h-[100px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ left: 0, right: 16, top: 5, bottom: 0 }}
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
              height={36}
            />
            {/* Y-axis INVERTED — rank #1 at top (worst), rank #N at bottom (best).
                `reversed` flips the axis direction; domain [1, maxRank] sets the
                visible range. allowDataOverflow guards against any stray value
                outside the computed domain. */}
            <YAxis
              reversed
              domain={[1, maxRank]}
              allowDataOverflow
              tickFormatter={(v: number) => `#${v}`}
              fontSize={10}
              stroke="var(--muted-foreground)"
              tickLine={false}
              axisLine={false}
              width={36}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
            />
            {/* Severity threshold reference lines — only render when maxRank
                reaches the threshold (avoids lines outside the visible domain). */}
            {maxRank >= 5 && (
              <ReferenceLine y={5} stroke="var(--chart-loss)" strokeDasharray="2 4" strokeOpacity={0.5} />
            )}
            {maxRank >= 20 && (
              <ReferenceLine y={20} stroke="var(--chart-waste)" strokeDasharray="2 4" strokeOpacity={0.5} />
            )}
            {/* Rank trend line — single muted stroke (connecting line) with
                per-period colored dots showing severity. connectNulls bridges
                periods where the item had no deviasi (rankNominal was null). */}
            <Line
              type="monotone"
              dataKey="rank"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              dot={renderDot}
              activeDot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});
