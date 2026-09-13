'use client';

// ============================================================
//  QuadrantCard — single quadrant card showing top drivers
//  for one dimension (item/outlet/area/kelompok/pic).
//  Pure presentational component — no hooks, no state.
// ============================================================

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtIDR, fmtNum, fmtDecimal, numberColor } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { countSuffix } from './constants';
import type { ParetoResult } from './types';

// FIX (BUG-HUNT C4/B4): `barColor` was declared and passed at all 5 call sites
// but never referenced in the body — dead prop (the visible rainbow-kill comes
// solely from the `color` prop). Pure deletion, zero render change.
export function QuadrantCard({ title, icon, data, color, tooltip }: { title: string; icon: React.ReactNode; data: ParetoResult; color: string; tooltip?: string }) {
  const suffix = countSuffix(title);
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${color}`}>{icon}</span>
            {title}
            {tooltip && <InfoTooltip content={tooltip} />}
          </CardTitle>
          {data && data.totalCount > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {data.drivers.length} dari {data.totalCount} = 80%
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!data || data.drivers.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Tidak ada data</p>
        ) : (
          <div className="max-h-[300px] overflow-auto">
            <Table className="min-w-[600px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider h-7 p-1">#</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7 p-1">Nama</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1">QTY</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1">Nominal</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1">Hist Avg</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1">Z</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1 w-10">%</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1 w-10">Cum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.drivers.map((d, i) => (
                  <TableRow key={`${d.name}-${i}`} className="hover:bg-muted/40 transition-colors border-b border-border/20 last:border-0">
                    <TableCell className="text-center text-xs tabular-nums p-1 font-bold shrink-0 w-8">
                      <span className={i === 0 ? 'text-amber-500' : i === 1 ? 'text-zinc-400' : i === 2 ? 'text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}>
                        {i + 1}
                      </span>
                    </TableCell>
                    <TableCell className="p-1">
                      <div className="font-medium text-xs truncate max-w-[180px]" title={d.name}>{d.name}</div>
                      {d.outletCount != null && suffix && <div className="text-[10px] text-muted-foreground tabular-nums">{d.outletCount} {suffix}</div>}
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums p-1 ${numberColor(d.qtyDeviasi)}`}>{fmtNum(d.qtyDeviasi)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums font-medium p-1 ${numberColor(d.nominalDeviasi)}`}>{fmtIDR(d.nominalDeviasi)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground p-1" title={d.histN ? `${d.histN} periode historis (all months)` : ''}>
                      {d.histAvg != null ? fmtIDR(d.histAvg) : '—'}
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums font-medium p-1 ${
                      d.zScore == null ? 'text-muted-foreground' : Math.abs(d.zScore) > 2 ? 'text-red-600 dark:text-red-400 font-bold' : Math.abs(d.zScore) > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                    }`} title={d.zScore != null ? `Z-score: ${fmtDecimal(d.zScore, 2)} (${d.histN} periode)` : ''}>
                      {d.zScore != null ? (d.zScore > 0 ? '+' : '') + fmtDecimal(d.zScore, 1) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground p-1">{d.sharePct.toFixed(0)}%</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground/60 p-1">{d.cumPct.toFixed(0)}%</TableCell>
                  </TableRow>
                ))}
                {data.remainderCount > 0 && (
                  <TableRow className="border-0">
                    <TableCell colSpan={8} className="text-[10px] text-muted-foreground/60 p-1 pl-6">
                      Sisa {data.remainderPct.toFixed(0)}%: {data.remainderCount} lainnya
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
