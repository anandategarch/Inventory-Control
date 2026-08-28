'use client';

// ============================================================
//  RankingNasionalCard — Top 30 Deviasi Items for selected outlet
//  Shows after resto is selected. No filters — fixed Top 30.
//  Data source: /api/outlet-items → topDeviasiRank (per-outlet query
//  with national rank + peer benchmark).
//  (split from RestoAnalysis.tsx — Phase 3)
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target } from 'lucide-react';
import { fmtIDR, fmtNum } from './helpers';
import type { AnalysisData, DeviasiRankItem } from '@/hooks/useAnalysis';

export function RankingNasionalCard({
  focusOutlet,
  analysisData,
  outletDeviasiRank,
}: {
  focusOutlet: string;
  analysisData?: AnalysisData;
  outletDeviasiRank?: DeviasiRankItem[];
}) {
  // Primary source: per-outlet top 30 (from /api/outlet-items — fired when
  // resto is selected). Falls back to analysisData.topDeviasiRank (national
  // top-50) if outlet-items hasn't loaded yet.
  const items: DeviasiRankItem[] = outletDeviasiRank && outletDeviasiRank.length > 0
    ? outletDeviasiRank
    : (analysisData?.topDeviasiRank || []).filter((it) => it.outletCode === focusOutlet).slice(0, 30);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Ranking Item Nasional (Deviasi)
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Top 30 item deviasi untuk <span className="font-medium text-foreground">{focusOutlet}</span>.
          Negatif (merah) = rugi. Positif (hijau) = untung.
          AVG Dev By BOM = rata-rata |QTY Deviasi| item yang sama di resto lain dengan BOM ±50%.
        </p>
        <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
          <Badge variant="secondary" className="text-xs tabular-nums font-medium">{items.length} item</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-auto">
          <Table className="min-w-[1200px]">
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 text-center text-xs font-semibold uppercase tracking-wider h-8">Rank Nas</TableHead>
                <TableHead className="w-8 text-center text-xs font-semibold uppercase tracking-wider h-8">Rank BOM</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Item</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Resto</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Deviasi</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Waste</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY LS</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">%LS to BOM</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">AVG Dev By BOM</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground text-xs py-8">Tidak ada data deviasi untuk outlet ini pada periode terpilih</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow key={`${it.itemName}-${it.outletCode}-${i}`} className={`hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}>
                  <TableCell className="text-center text-xs font-bold tabular-nums">{it.rankNominal}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground tabular-nums">{it.rankBom != null && it.rankBom > 0 ? it.rankBom : '—'}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[150px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.pic || '—'}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyDeviasi)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyWaste < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyWaste)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyLossSurplus < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyLossSurplus)}</TableCell>
                  {/* pctLossSurplusToBom is always ≥0 (SQL uses ABS). Color by
                      nominalDeviasi sign: negative = LOSS (red), positive = SURPLUS (green). */}
                  <TableCell className={`text-right text-xs tabular-nums ${it.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {it.pctLossSurplusToBom != null ? `${Math.abs(it.pctLossSurplusToBom * 100).toFixed(2)}%` : '—'}
                  </TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyBom < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyBom)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {it.avgDeviasiByBom != null ? fmtNum(it.avgDeviasiByBom) : '—'}
                  </TableCell>
                  <TableCell className={`text-right font-semibold text-xs tabular-nums ${it.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {fmtIDR(it.nominalDeviasi)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
