'use client';

// ============================================================
//  LossDecompositionCard — "Dekomomposisi Loss" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Stacked bars per outlet (top by total loss): how much of the
//  loss is EXPLAINED (waste + susut + trial) vs UNEXPLAINED
//  (residual) — the in-app version of the offline report's
//  "Dekomposisi Loss" sheet + stacked chart. Answers: "berapa
//  besar loss yang benar-benar terjelaskan peluruhan vs
//  selisih tak terjelaskan?"
//  Recharts + CHART_COLORS (same conventions as the Charts/
//  family; animations disabled — tab re-mounts).
// ============================================================

import { memo, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BarChart3 } from 'lucide-react';
import { fmtIDR, fmtHeatmapCompact } from '@/lib/format';
import { COLORS } from '@/lib/chart-constants';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import type { WasteMonthlyRow } from './types';

const INITIAL_OUTLETS = 10;

export const LossDecompositionCard = memo(function LossDecompositionCard({
  monthly,
}: {
  monthly: WasteMonthlyRow[];
}) {
  const [showAll, setShowAll] = useState(false);

  const { chartData, totalExplained, totalResidual } = useMemo(() => {
    const byOutlet = new Map<string, { waste: number; susut: number; trial: number; residual: number; totalLoss: number }>();
    for (const r of monthly) {
      const agg = byOutlet.get(r.outletCode) ?? { waste: 0, susut: 0, trial: 0, residual: 0, totalLoss: 0 };
      agg.waste += r.waste;
      agg.susut += r.susut;
      agg.trial += r.trial;
      agg.residual += r.residual;
      agg.totalLoss += r.totalLoss;
      byOutlet.set(r.outletCode, agg);
    }
    const sorted = [...byOutlet.entries()]
      .map(([code, v]) => ({ name: code, ...v }))
      .sort((a, b) => b.totalLoss - a.totalLoss);
    const sliced = showAll ? sorted : sorted.slice(0, INITIAL_OUTLETS);
    const te = sorted.reduce((a, o) => a + o.waste + o.susut + o.trial, 0);
    const tr = sorted.reduce((a, o) => a + o.residual, 0);
    return { chartData: sliced, totalExplained: te, totalResidual: tr };
  }, [monthly, showAll]);

  const explainedShare = totalExplained + totalResidual > 0
    ? totalExplained / (totalExplained + totalResidual)
    : 0;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Dekomposisi Loss — Terjelaskan vs Residual
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Loss yang terjelaskan peluruhan (waste + susut + trial) vs residual (tak terjelaskan) per outlet —
          {showAll ? ` semua ${chartData.length} outlet` : ` ${Math.min(INITIAL_OUTLETS, chartData.length)} outlet dengan loss terbesar`}.
          Window: {fmtPctId(explainedShare)} loss terjelaskan.
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada loss pada scope ini.</div>
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" className="opacity-60" />
                  <XAxis dataKey="name" fontSize={10} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} interval={0} angle={-35} textAnchor="end" height={52} />
                  <YAxis tickFormatter={(v) => (v === 0 ? '0' : fmtHeatmapCompact(v))} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} width={54} />
                  <Tooltip
                    cursor={{ fill: 'var(--muted)', opacity: 0.4, stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    formatter={(v: number | string, name: string) => [fmtIDR(Number(v)), name]}
                    contentStyle={getTooltipStyle()}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="waste" name="Waste" stackId="loss" fill={COLORS.waste} maxBarSize={44} isAnimationActive={false} />
                  <Bar dataKey="susut" name="Susut" stackId="loss" fill={COLORS.susut} maxBarSize={44} isAnimationActive={false} />
                  <Bar dataKey="trial" name="Trial" stackId="loss" fill={COLORS.trial} maxBarSize={44} isAnimationActive={false} />
                  <Bar dataKey="residual" name="Residual" stackId="loss" fill={COLORS.residual} maxBarSize={44} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {monthly.length > 0 && (
              <div className="mt-2 flex justify-center">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? 'Tampilkan top outlet saja' : `Tampilkan semua outlet (${chartData.length})`}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
});

/** Local pct formatter (no sign, 1 digit). */
function fmtPctId(v: number): string {
  return `${(v * 100).toFixed(1).replace('.', ',')}%`;
}
