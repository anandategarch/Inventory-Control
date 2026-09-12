'use client';

// ============================================================
//  Feature 3: Item-Level Peer Comparison
//  Top items at target outlet vs peer avg & peer best.
// ============================================================

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, BarChart3 } from 'lucide-react';
import { fmtIDR, fmtNum } from '@/lib/format';
import type { ItemComparisonResponse } from './types';

export const ItemLevelComparison = memo(function ItemLevelComparison({
  data,
  isLoading,
  error,
}: {
  data: ItemComparisonResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  return (
    <Card className="overflow-visible shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Item-Level Comparison
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Top 5 item di target outlet, dibandingkan dengan peer avg &amp; peer best.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : !data && !error ? (
          // FIX FE-2: When query is disabled (no outlet selected), show waiting state
          // instead of "Error: Unknown" (!data?.success = true when data=undefined)
          <p className="text-center text-xs text-muted-foreground py-6">
            Pilih outlet untuk melihat item-level comparison
          </p>
        ) : error || !data?.success ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400 py-6">
            Error: {error?.message || data?.error || 'Unknown'}
          </p>
        ) : !data.items || data.items.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Tidak ada item dengan deviasi signifikan pada periode ini.
          </p>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {data.items.map((item) => (
              <ItemComparisonBlock key={item.itemId} item={item} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});

const ItemComparisonBlock = memo(function ItemComparisonBlock({
  item,
}: {
  item: ItemComparisonResponse['items'][number];
}) {
  const fmtPctRatio = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
  const rows = [
    { label: 'QTY Deviasi', target: item.target.qtyDeviasi, avg: item.peerAvg.qtyDeviasi, best: item.peerBest.qtyDeviasi, gap: item.gap.qtyDeviasi, format: fmtNum },
    { label: 'Dev/BOM', target: item.target.devBom, avg: item.peerAvg.devBom, best: item.peerBest.devBom, gap: item.gap.devBom, format: fmtPctRatio },
    { label: 'Nominal', target: item.target.nominal, avg: item.peerAvg.nominal, best: item.peerBest.nominal, gap: item.gap.nominal, format: fmtIDR },
  ];

  return (
    <div className="rounded-lg border bg-muted/10 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30 dark:bg-zinc-900/30">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <span className="text-zinc-500 dark:text-zinc-400">📦</span>
          <span className="truncate" title={item.itemName}>{item.itemName}</span>
        </h4>
        <Badge variant="outline" className="text-[11px] h-4 tabular-nums font-medium">{item.peerCount} peer</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="border-b hover:bg-transparent">
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-7">Metrik</TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-right">Target</TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-right">Rata-rata Peer</TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-right">Peer Terbaik</TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-right">Gap</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(r => {
            // FIX FE-26: isWorse logic must account for signed values (qtyDeviasi, nominal can be negative=LOSS)
            // For signed metrics: "worse" = more negative (bigger loss). Compare ABS magnitudes.
            // For Dev/BOM (always positive ratio): higher = worse.
            const isSigned = r.label === 'QTY Deviasi' || r.label === 'Nominal';
            const isWorse = isSigned
              ? Math.abs(r.target) > Math.abs(r.best)  // bigger magnitude = worse
              : r.gap > 0;  // positive metric: gap > 0 = worse
            return (
              <TableRow key={r.label} className="hover:bg-muted/30 transition-colors">
                <TableCell className="text-xs py-1 font-medium">{r.label}</TableCell>
                <TableCell className="text-xs py-1 text-right font-mono font-semibold tabular-nums">{r.format(r.target)}</TableCell>
                <TableCell className="text-xs py-1 text-right font-mono text-muted-foreground tabular-nums">{r.format(r.avg)}</TableCell>
                <TableCell className="text-xs py-1 text-right font-mono text-emerald-600 dark:text-emerald-400 tabular-nums">{r.format(r.best)}</TableCell>
                <TableCell className={`text-xs py-1 text-right font-mono font-semibold tabular-nums ${isWorse ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {r.gap >= 0 ? '+' : ''}{r.format(r.gap)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
});
