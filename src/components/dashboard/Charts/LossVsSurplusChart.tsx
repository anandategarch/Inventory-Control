'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { fmtHeatmapCompact, fmtIDR, formatByPreset } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import { memo } from 'react';

export const LossVsSurplusChart = memo(function LossVsSurplusChart({ data }: { data: AnalysisData }) {
  const l = data.lossVsSurplus;
  // FIX: l.loss/l.surplus are RECORD COUNTS, not QTY sums.
  // Label was "qty" (misleading) — changed to "records" for clarity.
  const chartData = [
    { name: 'LOSS', records: l.loss, nominal: l.lossNominal, color: 'var(--chart-loss)' },
    { name: 'SURPLUS', records: l.surplus, nominal: l.surplusNominal, color: 'var(--chart-surplus)' },
  ];

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Loss vs Surplus
          <FormulaInfo
            formula="LOSS: NET Deviation > 0 (actual > SOC)  |  SURPLUS: NET Deviation < 0 (actual < SOC)"
            description="Direction split berdasarkan tanda NET Deviation (qtyLossSurplus). Jumlah record LOSS vs SURPLUS. Nominal = |NET Deviasi × Price|."
            example="qtyLossSurplus = +50 → LOSS  |  qtyLossSurplus = -30 → SURPLUS"
            side="bottom"
          />
        </CardTitle>
        {/* SPEC-1 (§21): question-first subtitle (anti-pattern #12). */}
        <p className="text-xs text-muted-foreground ml-9"><span className="font-medium text-foreground/70">Bagaimana arah penggunaan aktual terhadap SOC?</span> — direction split (magnitude)</p>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" className="opacity-60" />
              <XAxis dataKey="name" fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => (v === 0 ? '0' : fmtHeatmapCompact(v))} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4, stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }} formatter={(v: number | string) => formatByPreset(Number(v), 'num0')} contentStyle={getTooltipStyle()} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance animation
                  replays on every Radix tab re-entry (tab content unmounts) and on every
                  period-change refetch; the double-fetch fix removed the second replay. */}
              <Bar dataKey="records" name="Jumlah Record" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border bg-red-50/40 dark:bg-red-950/20 px-3 py-1.5">
            <span className="text-muted-foreground">LOSS nominal:</span>{' '}
            <span className="font-semibold text-red-600 dark:text-red-400 tabular-nums">{fmtIDR(l.lossNominal)}</span>
          </div>
          <div className="rounded-md border bg-emerald-50/40 dark:bg-emerald-950/20 px-3 py-1.5">
            <span className="text-muted-foreground">SURPLUS nominal:</span>{' '}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtIDR(l.surplusNominal)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
