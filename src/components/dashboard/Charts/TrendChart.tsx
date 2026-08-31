'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
  ComposedChart, Line,
} from 'recharts';
import { Activity } from 'lucide-react';
import { memo } from 'react';

export const TrendChart = memo(function TrendChart({ data }: { data: AnalysisData }) {
  const trend = data.trend;
  if (!trend || trend.length === 0) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
              <Activity className="h-3.5 w-3.5" />
            </span>
            Weekly Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Activity className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No trend data</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <Activity className="h-3.5 w-3.5" />
          </span>
          Weekly Trend
          <FormulaInfo
            formula="Dev/BOM % = |QTY Deviasi| / |QTY BOM| × 100%"
            description="Rasio deviation terhadap BOM per periode (semua outlet). Garis merah = Dev/BOM % (sumbu kiri). Garis kuning = Nominal Deviasi dalam Rupiah (sumbu kanan). Trend naik = deviation makin besar proporsinya terhadap BOM."
            example="Deviasi 60K / BOM 425K = 14.1%"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Deviation/BOM % &amp; Nominal Deviasi over weeks</p>
      </CardHeader>
      <CardContent>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trend} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="opacity-60" />
              <XAxis dataKey="weekLabel" fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <YAxis yAxisId="left" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => {
              const abs = Math.abs(v);
              if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace('.', ',')}M`;
              if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}Jt`;
              if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
              return v.toFixed(0);
            }} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
                formatter={(v: number | string, n: string) => n === 'Dev/BOM' ? `${(Number(v) * 100).toFixed(2)}%` : Number(v).toLocaleString()}
                contentStyle={getTooltipStyle()}
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="devBom" name="Dev/BOM" stroke="var(--chart-loss)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--chart-loss)' }} activeDot={{ r: 5 }} />
              <Line yAxisId="right" type="monotone" dataKey="nominal" name="Nominal Deviasi" stroke="var(--chart-waste)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--chart-waste)' }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
});
