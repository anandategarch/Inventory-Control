'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { fmtIDR } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { Calendar } from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';

// Shared tooltip payload type (any required by Recharts typing)
type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

// ============================================================
//  2.3 MultiPeriodComparisonCard
//  Perbandingan multi-periode (trend sales/BOM/deviasi)
// ============================================================
export function MultiPeriodComparisonCard({ data }: { data: AnalysisData }) {
  const multi = (data.growthComparison as any)?.multiPeriodComparison as Array<Record<string, any>> | undefined;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <Calendar className="h-3.5 w-3.5" />
          </span>
          Perbandingan Multi-Periode
          <FormulaInfo
            formula="Trend per periode: Sales vs BOM vs Deviasi + Growth %"
            description={'UNTUK APA: Membandingkan metric kunci (Sales, BOM, Deviasi) across multiple period untuk lihat pola trend.\nCARA BACA: Bar = nilai absolut per period. Line = growth %. Trend naik di Deviasi sementara Sales flat = memburuk.\nCONTOH: W1 Dev 10M, W2 Dev 15M, W3 Dev 25M → trend naik meski Sales stabil.\nACTION: Trend deviasi naik konsisten → evaluasi perubahan proses bertahap.'}
            example="W1 → W2 → W3: Deviasi 30M → 25M → 40M (growth +60% di W3)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Trend lintas periode pembanding</p>
      </CardHeader>
      <CardContent>
        {!multi || multi.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Calendar className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada data multi-periode</p>
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={multi} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" className="opacity-60" />
                <XAxis dataKey="period" fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                <YAxis yAxisId="left" tickFormatter={(v) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(0)}Jt` : v.toLocaleString()} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                  content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                    active && payload && payload.length
                      ? (
                        <div className="rounded-lg border bg-popover p-2.5 shadow-lg text-xs space-y-1">
                          <p className="font-semibold border-b pb-1 mb-1">{label}</p>
                          {payload.map((p, i) => (
                            <p key={i} className="text-muted-foreground tabular-nums">
                              <span className="font-medium text-foreground">{p.name}</span>: {p.name === 'Growth' ? `${((p.value as number) * 100).toFixed(1)}%` : fmtIDR(p.value as number)}
                            </p>
                          ))}
                        </div>
                      )
                      : null
                  }
                />
                <Legend wrapperStyle={{ fontSize: 10 }} iconType="circle" />
                <Bar yAxisId="left" dataKey="sales" name="Sales" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={32} />
                <Bar yAxisId="left" dataKey="bom" name="BOM" fill="#71717a" radius={[3, 3, 0, 0]} maxBarSize={32} />
                <Bar yAxisId="left" dataKey="deviation" name="Deviasi" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={32} />
                <Line yAxisId="right" type="monotone" dataKey="growthPct" name="Growth" stroke="#dc2626" strokeWidth={2} dot={{ r: 3, fill: '#dc2626' }} activeDot={{ r: 5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
