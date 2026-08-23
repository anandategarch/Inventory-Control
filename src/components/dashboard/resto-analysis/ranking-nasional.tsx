'use client';

// ============================================================
//  RankingNasionalCard — Top Items by Deviasi Rank
//  Shows after resto is selected. Custom Top N selector.
//  (split from RestoAnalysis.tsx — Phase 3)
// ============================================================

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target } from 'lucide-react';
import { fmtIDR, fmtNum } from './helpers';
import type { AnalysisData, DeviasiRankItem } from '@/hooks/useAnalysis';

export function RankingNasionalCard({ focusOutlet, analysisData }: { focusOutlet: string; analysisData?: AnalysisData }) {
  const [topN, setTopN] = useState<string>('50');
  const [filterPic, setFilterPic] = useState<string>('all');
  // FIX: default 'all' (was focusOutlet) — topDeviasiRank only has 50 items,
  // most outlets won't have items in top 50 → table shows empty.
  // User can manually filter by resto via dropdown if needed.
  const [filterResto, setFilterResto] = useState<string>('all');

  const allItems: DeviasiRankItem[] = analysisData?.topDeviasiRank || [];
  const picOptions = [...new Set(allItems.map((it) => it.pic).filter((v): v is string => Boolean(v)))].sort();
  const restoOptions = [...new Set(allItems.map((it) => it.outletCode))].sort();

  const items = allItems
    .filter((it) => filterPic === 'all' || it.pic === filterPic)
    .filter((it) => filterResto === 'all' || it.outletCode === filterResto)
    .slice(0, topN === 'all' ? 9999 : parseInt(topN));

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Ranking Item Nasional (Deviasi)
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Ranking item per resto. Negatif (merah) = rugi. Positif (hijau) = untung.
          AVG Dev By BOM = rata-rata |QTY Deviasi| item yang sama di resto lain dengan BOM ±50%.
        </p>
        {/* Top N + Filters */}
        <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
          <select
            value={topN}
            onChange={(e) => setTopN(e.target.value)}
            className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="10">Top 10</option>
            <option value="20">Top 20</option>
            <option value="50">Top 50</option>
            {/* FIX M-H (AUDIT-2/3): removed "Top 100" / "Semua" — SQL caps at 50
                (queryTopItemsByDeviasiRank LIMIT 50). Showing those options silently
                truncated, misleading users. */}
          </select>
          <select
            value={filterPic}
            onChange={(e) => setFilterPic(e.target.value)}
            className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="all">Semua PIC</option>
            {picOptions.map((pic: string) => <option key={pic} value={pic}>{pic}</option>)}
          </select>
          <select
            value={filterResto}
            onChange={(e) => setFilterResto(e.target.value)}
            className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="all">Semua Resto</option>
            {restoOptions.map((resto: string) => <option key={resto} value={resto}>{resto}</option>)}
          </select>
          {(filterPic !== 'all' || filterResto !== 'all') && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setFilterPic('all'); setFilterResto('all'); }}>
              Reset
            </Button>
          )}
          <Badge variant="secondary" className="text-[10px] ml-auto tabular-nums font-medium">{items.length} item</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-auto">
          <Table className="min-w-[1200px]">
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider h-8">Rank Nas</TableHead>
                <TableHead className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider h-8">Rank BOM</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Item</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Resto</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY Deviasi</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY Waste</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY LS</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">%LS to BOM</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">AVG Dev By BOM</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground text-xs py-8">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow key={`${it.itemName}-${it.outletCode}-${i}`} className={`hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}>
                  <TableCell className="text-center text-xs font-bold tabular-nums">{it.rankNominal}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground tabular-nums">{it.rankBom != null ? it.rankBom : '—'}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[150px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.pic || '—'}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyDeviasi)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyWaste < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyWaste)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyLossSurplus < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyLossSurplus)}</TableCell>
                  {/* FIX H2 (AUDIT-3): pctLossSurplusToBom is always ≥0 (SQL uses ABS), so
                      `< 0` check was dead code — cell was always green, contradicting the
                      subtitle "Negatif (merah) = rugi". Color by nominalDeviasi sign instead:
                      negative nominal = LOSS (red), positive = SURPLUS (green). */}
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
