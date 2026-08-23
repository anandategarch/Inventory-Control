'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import { ArrowUpDown, ArrowUp, ArrowDown, History } from 'lucide-react';
import { useState, useMemo } from 'react';

type SortKey = 'zScore' | 'absNominal' | 'currentDevBom' | 'historicalAvg' | 'itemName' | 'area';
type SortDir = 'asc' | 'desc';

function zScoreColor(z: number): string {
  const abs = Math.abs(z);
  if (abs > 3) return 'text-red-600 dark:text-red-400 font-bold';
  if (abs > 2) return 'text-amber-600 dark:text-amber-400 font-semibold';
  if (abs > 1) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-muted-foreground';
}

function zScoreBadge(z: number): { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' } {
  const abs = Math.abs(z);
  if (abs > 3) return { label: 'ABNORMAL', variant: 'destructive' };
  if (abs > 2) return { label: 'WARNING', variant: 'default' };
  if (abs > 1) return { label: 'ELEVATED', variant: 'secondary' };
  return { label: 'NORMAL', variant: 'outline' };
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return sortDir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

export function HistoricalZScoreCard({ data }: { data: AnalysisData }) {
  // FIX BUG 1: Filter out items with |Dev/BOM| > 500% — these are data anomalies
  // where BOM ≈ 0 (division by near-zero produces extreme pctQtyDeviasiToBom).
  // Z-Scores of 680.99 are meaningless and pollute the table.
  // Also filter out items with zScore = 0 (no historical baseline).
  const allItems = data.growthComparison?.historicalAnalysis?.criticalItems || [];
  const items = allItems.filter(i =>
    Math.abs(i.currentDevBom) <= 5 &&  // ≤ 500% Dev/BOM
    Math.abs(i.zScore) > 0 &&          // has valid Z-Score
    i.historicalAvg > 0                 // has historical baseline
  );
  const [sortKey, setSortKey] = useState<SortKey>('zScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'zScore': cmp = Math.abs(a.zScore) - Math.abs(b.zScore); break;
        case 'absNominal': cmp = a.absNominal - b.absNominal; break;
        case 'currentDevBom': cmp = Math.abs(a.currentDevBom) - Math.abs(b.currentDevBom); break;
        case 'historicalAvg': cmp = a.historicalAvg - b.historicalAvg; break;
        case 'itemName': cmp = a.itemName.localeCompare(b.itemName); break;
        case 'area': cmp = a.area.localeCompare(b.area); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [items, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const abnormalCount = items.filter(i => Math.abs(i.zScore) > 3).length;
  const warningCount = items.filter(i => Math.abs(i.zScore) > 2 && Math.abs(i.zScore) <= 3).length;

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 shrink-0">
            <History className="h-3.5 w-3.5" />
          </span>
          Historical Z-Score Analysis
          <FormulaInfo
            formula="Z-Score = (|Current Dev/BOM| - Mean(|Historical Dev/BOM|)) / StdDev"
            description="Mendeteksi item yang deviasinya jauh di atas rata-rata historisnya sendiri. Z-Score > 2 = WARNING, > 3 = ABNORMAL. Baseline = periode dengan weekLabel yang sama di bulan lain (W4 vs W4, bukan W4 vs W1). Klik header kolom untuk sort."
            example="Item X: current Dev/BOM 45%, historical avg 15%, stdDev 8% → Z = (45-15)/8 = 3.75 (ABNORMAL)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium tabular-nums">{items.length}</span> item dengan Z-Score tertinggi
          {allItems.length !== items.length && <span className="text-muted-foreground/60"> ({allItems.length - items.length} difilter: BOM≈0)</span>}
          {' · '}
          <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">{abnormalCount} abnormal</span> ·{' '}
          <span className="text-amber-600 dark:text-amber-400 font-medium tabular-nums">{warningCount} warning</span>
          {' · klik header untuk sort'}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <History className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada anomali historical</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Semua item dalam batas normal vs rata-rata historis</p>
          </div>
        ) : (
          <div className="max-h-[500px] overflow-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 w-8">#</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 cursor-pointer hover:bg-muted/40" onClick={() => toggleSort('itemName')}>
                    Item <SortIcon col="itemName" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 cursor-pointer hover:bg-muted/40" onClick={() => toggleSort('area')}>
                    Area <SortIcon col="area" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 text-right cursor-pointer hover:bg-muted/40" onClick={() => toggleSort('currentDevBom')}>
                    Current Dev/BOM <SortIcon col="currentDevBom" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 text-right cursor-pointer hover:bg-muted/40" onClick={() => toggleSort('historicalAvg')}>
                    Historical Avg <SortIcon col="historicalAvg" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 text-right cursor-pointer hover:bg-muted/40" onClick={() => toggleSort('zScore')}>
                    Z-Score <SortIcon col="zScore" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 text-center">Status</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 px-2 text-right cursor-pointer hover:bg-muted/40" onClick={() => toggleSort('absNominal')}>
                    |Nominal| <SortIcon col="absNominal" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((item, i) => {
                  const badge = zScoreBadge(item.zScore);
                  return (
                    <TableRow key={`${item.itemName}-${item.outletCode}-${i}`} className="hover:bg-muted/40 transition-colors border-b">
                      <TableCell className="text-[11px] text-muted-foreground px-2 py-1.5 tabular-nums">{i + 1}</TableCell>
                      <TableCell className="text-[11px] px-2 py-1.5">
                        <div className="font-medium leading-tight whitespace-normal max-w-[180px]" title={item.itemName}>{item.itemName}</div>
                        <div className="text-[11px] text-muted-foreground">{item.outletCode}</div>
                      </TableCell>
                      <TableCell className="text-[11px] px-2 py-1.5 text-muted-foreground">{item.area}</TableCell>
                      <TableCell className="text-[11px] px-2 py-1.5 text-right tabular-nums">{fmtPctAbs(item.currentDevBom)}</TableCell>
                      <TableCell className="text-[11px] px-2 py-1.5 text-right tabular-nums text-muted-foreground">{fmtPctAbs(item.historicalAvg)}</TableCell>
                      <TableCell className={`text-[11px] px-2 py-1.5 text-right tabular-nums ${zScoreColor(item.zScore)}`}>
                        {item.zScore.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-[11px] px-2 py-1.5 text-center">
                        <Badge variant={badge.variant} className="text-[9px] h-4 px-1 font-medium">{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="text-[11px] px-2 py-1.5 text-right tabular-nums font-semibold">{fmtIDR(item.absNominal)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
