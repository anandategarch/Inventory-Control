'use client';

// ============================================================
//  Feature 4: Scatter Plot — Sales (X) vs Dev/BOM (Y)
// ============================================================

import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles } from 'lucide-react';
import { fmtIDR } from '@/lib/format';
import type { PeerRow } from './types';

interface ScatterPoint {
  sales: number;
  devBom: number;
  outletName: string;
  isTarget: boolean;
}

export function ScatterPlotCard({
  peers,
  targetCode,
}: {
  peers: PeerRow[];
  targetCode?: string;
}) {
  const data: ScatterPoint[] = peers.map(p => ({
    sales: p.sales,
    devBom: p.devBom * 100, // convert ratio → %
    outletName: p.outletName,
    isTarget: p.outletCode === targetCode,
  }));

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          Sales vs Dev/BOM
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Setiap titik = 1 resto. Target ditandai merah. Posisi kanan-bawah = sales tinggi &amp; deviasi rendah (ideal).
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 16, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" className="opacity-60" />
              <XAxis
                type="number"
                dataKey="sales"
                name="Sales"
                tickFormatter={(v) => fmtIDR(v)}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                tickLine={false}
                axisLine={false}
              >
              </XAxis>
              <YAxis
                type="number"
                dataKey="devBom"
                name="Dev/BOM"
                unit="%"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <RTooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as { outletName: string; sales: number; devBom: number; nominalDeviasi: number; direction: string; outletCode: string; isTarget: boolean };
                  return (
                    <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg">
                      <div className="font-semibold border-b pb-1 mb-1">{d.outletName}</div>
                      <div className="text-muted-foreground tabular-nums">Sales: {fmtIDR(d.sales)}</div>
                      <div className="text-muted-foreground tabular-nums">Dev/BOM: {d.devBom.toFixed(1)}%</div>
                      {d.isTarget && <div className="text-red-600 dark:text-red-400 font-semibold mt-1">TARGET</div>}
                    </div>
                  );
                }}
              />
              <Scatter data={data}>
                {data.map((entry, i) => (
                  <Cell
                    key={`cell-${i}`}
                    fill={entry.isTarget ? 'var(--chart-loss)' : '#71717a'}
                    r={entry.isTarget ? 7 : 4}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground mt-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600" /> Target
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" /> Peer
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
