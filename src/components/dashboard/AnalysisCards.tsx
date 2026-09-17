'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { fmtIDR, fmtDecimal } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { Calendar } from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';

// Shared tooltip payload type — `payload` is optional to match Recharts'
// `Payload<ValueType, NameType>` shape (TS would otherwise reject the assignment).
// The render code already guards with `active && payload && payload.length`.
type TipPayloadEntry = {
  payload?: { name?: string; value?: number };
  value?: unknown;
  name?: string | number;
  label?: unknown;
};
type TipPayload = TipPayloadEntry[] | undefined;

// ============================================================
//  2.3 MultiPeriodComparisonCard
//  Perbandingan multi-periode (trend sales/BOM/deviasi)
// ============================================================
export const MultiPeriodComparisonCard = memo(function MultiPeriodComparisonCard({ data }: { data: AnalysisData }) {
  const multi = data.growthComparison.multiPeriodComparison;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <Calendar className="h-3.5 w-3.5" />
          </span>
          Perbandingan Multi-Periode
          {/* P23 D3: 'across multiple period' → Indonesian; 'Bar = nilai absolut'
              was inaccurate — Sales/BOM bars are magnitudes but the Deviasi series
              is SIGNED (trend-builder deviation = SUM(nominalDeviasi)), so its bars
              carry the sign. Jt suffix now matches the format.ts convention. */}
          <FormulaInfo
            formula="Trend per periode: Sales vs BOM vs Deviasi + Growth %"
            description={'UNTUK APA: Membandingkan metric kunci (Sales, BOM, Deviasi) lintas beberapa periode untuk lihat pola trend.\nCARA BACA: Bar Sales & BOM = nilai absolut per periode. Bar Deviasi = nilai signed — tampil dengan tandanya (minus = loss, positif = surplus). Line = growth %. Trend deviasi naik (loss melebar) sementara Sales flat = memburuk.\nCONTOH: W1 Dev -10Jt, W2 Dev -15Jt, W3 Dev -25Jt → loss melebar meski Sales stabil.\nACTION: Trend deviasi naik konsisten → evaluasi perubahan proses bertahap.'}
            example="W1 → W2 → W3: Deviasi 30Jt → 25Jt → 40Jt (growth +60% di W3)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Trend lintas periode pembanding</p>
      </CardHeader>
      <CardContent>
        {!multi || multi.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground/50 mb-3">
              <Calendar className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">Tidak ada data multi-periode</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Pilih minimal 2 periode pembanding untuk melihat trend</p>
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={multi} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="opacity-60" />
                <XAxis dataKey="period" fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
                {/* P23 D7: Math.abs threshold + sign-preserving compact branch — negative
                    millions (Deviasi series is signed) previously fell through to the
                    non-compact branch, rendering long '-2.500.000' ticks next to compact
                    '3Jt' positives. Mirrors fmtNum/fmtCompact sign handling in lib/format.ts. */}
                <YAxis yAxisId="left" tickFormatter={(v) => Math.abs(v) >= 1_000_000 ? `${v < 0 ? '-' : ''}${fmtDecimal(Math.abs(v) / 1_000_000, 1)}Jt` : v.toLocaleString('id-ID')} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                  content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                    active && payload && payload.length
                      ? (
                        <div className="rounded-lg border bg-popover p-2.5 shadow-lg text-xs space-y-1">
                          <p className="font-semibold border-b pb-1 mb-1">{label}</p>
                          {payload.map((p, i) => (
                            <p key={i} className="text-muted-foreground tabular-nums">
                              <span className="font-medium text-foreground">{p.name}</span>: {p.name === 'Growth' ? `${fmtDecimal(Number(p.value) * 100, 1)}%` : fmtIDR(Number(p.value))}
                            </p>
                          ))}
                        </div>
                      )
                      : null
                  }
                />
                <Legend wrapperStyle={{ fontSize: 10 }} iconType="circle" />
                {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance animation
                    replays on every Radix tab re-entry (tab content unmounts) and on every
                    period-change refetch; the double-fetch fix removed the second replay. */}
                <Bar yAxisId="left" dataKey="sales" name="Sales" fill="var(--chart-surplus)" radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false} />
                <Bar yAxisId="left" dataKey="bom" name="BOM" fill="var(--chart-residual)" radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false} />
                <Bar yAxisId="left" dataKey="deviation" name="Deviasi" fill="var(--chart-waste)" radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false} />
                <Line yAxisId="right" type="monotone" dataKey="growthPct" name="Growth" stroke="var(--chart-loss)" strokeWidth={2} dot={{ r: 3, fill: 'var(--chart-loss)' }} activeDot={{ r: 5 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
