'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)

// ============================================================
//  Feature 6: Trend Chart — Dev/BOM across weeks
//  Target vs peer avg line chart.
// ============================================================

import { memo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, TrendingUp } from 'lucide-react';
import type { TrendResponse } from './types';

export const TrendChartCard = memo(function TrendChartCard({
  data,
  isLoading,
  error,
}: {
  data: TrendResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const chartData = (data?.weeks || []).map(w => ({
    week: w.weekLabel,
    target: +(w.devBomTarget * 100).toFixed(2),
    peerAvg: +(w.devBomPeerAvg * 100).toFixed(2),
  }));

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Trend Dev/BOM — Target vs Peer Avg
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Perbandingan Dev/BOM target vs rata-rata peer di setiap minggu bulan ini.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : !data ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Menunggu peer data...
          </p>
        ) : error || !data?.success ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400 py-6">
            Error: {error?.message || data?.error || 'Unknown'}
          </p>
        ) : chartData.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Tidak ada data mingguan pada bulan ini.
          </p>
        ) : (
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="opacity-60" />
                <XAxis dataKey="week" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} stroke="var(--border)" tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  stroke="var(--border)"
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  unit="%"
                />
                <RTooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    return (
                      <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg">
                        <div className="font-semibold mb-1 border-b pb-1">{label}</div>
                        {payload.map((pl, i) => (
                          <div key={i} style={{ color: pl.color }} className="tabular-nums">
                            {pl.name}: {(pl.value as number).toFixed(2)}%
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance animation
                    replays on every Radix tab re-entry (tab content unmounts) and on every
                    period-change refetch; the double-fetch fix removed the second replay. */}
                <Line
                  type="monotone"
                  dataKey="target"
                  name="Target"
                  stroke="var(--chart-loss)"
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: 'var(--chart-loss)' }}
                  activeDot={{ r: 6 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="peerAvg"
                  name="Peer Avg"
                  stroke="#71717a"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 3, fill: '#71717a' }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
