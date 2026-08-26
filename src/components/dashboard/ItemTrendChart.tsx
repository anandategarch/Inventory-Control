'use client';

// ============================================================
//  ItemTrendChart — Line chart for item deviation across ALL periods
//  Dynamically imported by GlobalItemSearchModal to keep Recharts
//  out of the main bundle.
//
//  Shows top 5 outlets (by total abs nominalDeviasi) as multi-line.
//  X = period (monthLabel + weekLabel), Y = nominalDeviasi (signed).
// ============================================================

import { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { fmtIDR } from '@/lib/format';
import { getTooltipStyle } from '@/lib/chart-constants';
import type { ItemTrendRow } from '@/lib/queries/items/global-search';

// Distinct colors for up to 5 outlet lines (NO blue/indigo per design rules)
const LINE_COLORS = ['#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

interface ChartRow {
  period: string;
  sortKey: string;
  [outletCode: string]: string | number;
}

export function ItemTrendChart({ data }: { data: ItemTrendRow[] }) {
  // FIX (AUDIT-ANIMATION): memoize all derived chart data — 3 loops + sort + slice
  // were running on every render, causing frame drops during animation.
  // NOTE: useMemo must be called BEFORE any early return (rules-of-hooks).
  const { chartData, topOutlets, outletNames } = useMemo(() => {
    // Group by period → build chart rows
    const periodMap = new Map<string, ChartRow>();
    for (const r of data) {
      const periodKey = `${r.monthKey}|${r.weekLabel}`;
      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period: `${r.monthLabel.slice(0, 3)} ${r.weekLabel.replace('WEEK ', 'W')}`,
          sortKey: `${r.monthKey}|${String(parseInt(r.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
        });
      }
      periodMap.get(periodKey)![r.outletCode] = r.nominalDeviasi;
    }

    // Sort periods chronologically
    const sorted = Array.from(periodMap.values()).sort((a, b) =>
      (a.sortKey as string).localeCompare(b.sortKey as string)
    );

    // Find top 5 outlets by total abs nominalDeviasi
    const outletTotals = new Map<string, number>();
    const names = new Map<string, string>();
    for (const r of data) {
      outletTotals.set(r.outletCode, (outletTotals.get(r.outletCode) || 0) + Math.abs(r.nominalDeviasi));
      if (!names.has(r.outletCode)) {
        names.set(r.outletCode, r.outletName);
      }
    }
    const top = Array.from(outletTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code]) => code);

    return { chartData: sorted, topOutlets: top, outletNames: names };
  }, [data]);

  if (data.length === 0 || chartData.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-12">
        Tidak ada data tren untuk item ini
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Tren nominal deviasi per outlet — top {topOutlets.length} outlet by total impact
      </p>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ left: 0, right: 16, top: 5, bottom: 5 }}>
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
            <YAxis
              tickFormatter={(v: number) => {
                const abs = Math.abs(v);
                if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}M`;
                if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}Jt`;
                if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
                return v.toFixed(0);
              }}
              fontSize={10}
              stroke="var(--muted-foreground)"
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <Tooltip
              contentStyle={getTooltipStyle()}
              formatter={(v: number | string, name: string) => [fmtIDR(Number(v)), outletNames.get(name) || name]}
              labelStyle={{ fontWeight: 600 }}
            />
            <Legend
              formatter={(value: string) => outletNames.get(value) || value}
              wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
            />
            {topOutlets.map((code, i) => (
              <Line
                key={code}
                type="monotone"
                dataKey={code}
                stroke={LINE_COLORS[i % LINE_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
