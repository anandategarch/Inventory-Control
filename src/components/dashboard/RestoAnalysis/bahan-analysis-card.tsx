'use client';

// ============================================================
//  RestoAnalysis — Bahan Analysis (3 rankings) card
//  (split from RestoAnalysis.tsx — SPLIT-G; pure code motion)
//
//  Financial (dampak uang) · Operational (Dev/BOM) · Unexplained
//  (residual ratio). FIX M-K (AUDIT-3): the operational +
//  unexplained rankings were computed server-side but never
//  rendered before — all 3 tabs live here.
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle } from 'lucide-react';
import type { Dispatch } from 'react';
import { fmtIDR, fmtNum, fmtPct, fmtDecimal } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { ItemRow } from '@/components/dashboard/resto-analysis/types';
import { priorityColor, priorityBg, directionColor } from '@/components/dashboard/resto-analysis/helpers';

export interface BahanAnalysisCardProps {
  rankingTab: string;
  // (Dispatch<string> = (tab: string) => void — spelled without a param
  //  name; the repo's base no-unused-vars rule flags type-position params.)
  onRankingTabChange: Dispatch<string>;
  currentRanking: ItemRow[];
  /** Setter for the Item Detail Modal (outletCode + itemName pair). */
  onSelectItem: Dispatch<{ outletCode: string; itemName: string }>;
  /** The outlet being analyzed (guaranteed non-null — the orchestrator's
   *  early returns fire before this card renders). */
  activeOutlet: string;
}

export function BahanAnalysisCard({
  rankingTab,
  onRankingTabChange,
  currentRanking,
  onSelectItem,
  activeOutlet,
}: BahanAnalysisCardProps) {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
            Bahan Analysis
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
            3 ranking: Financial (dampak uang) · Operational (Dev/BOM) · Unexplained (residual ratio)
          </p>
      </CardHeader>
      <CardContent>
        <Tabs value={rankingTab} onValueChange={onRankingTabChange}>
            {/* FIX M-K (AUDIT-3): operational + unexplained rankings were computed
                server-side but never rendered (only financial tab existed). Added
                the 2 missing tabs so the data is actually usable. */}
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="financial" className="text-xs">A. Financial</TabsTrigger>
              <TabsTrigger value="operational" className="text-xs">B. Operational</TabsTrigger>
              <TabsTrigger value="unexplained" className="text-xs">C. Unexplained</TabsTrigger>
            </TabsList>

            <TabsContent value={rankingTab} className="mt-3">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto border rounded-lg">
                {/* STRUCTURAL (S-3, opsi b): cells bumped text-[11px] → text-xs
                    (12px readability floor). py-1.5 + font-mono kept on purpose —
                    this 14-column ranking stays compact; declared deviation
                    from the py-2 default (nested-detail density precedent). */}
                <Table>
                  <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                    <TableRow className="border-b hover:bg-transparent">
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">#</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Nama Bahan</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">BOM</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Deviasi</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Dev/BOM</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Nominal</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-center">Dir</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">W</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">S</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">T</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Resid%</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-center">Hist</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">vs Area</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-center">Pri</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentRanking.map((r) => (
                      <TableRow key={r.rank} className={`${priorityBg(r.priority)} cursor-pointer hover:ring-1 hover:ring-foreground/20 transition-all`} {...clickableRowProps(() => onSelectItem({ outletCode: activeOutlet!, itemName: r.itemName }))}>
                        <TableCell className="text-xs py-1.5 font-mono tabular-nums">{r.rank}</TableCell>
                        <TableCell className="text-xs py-1.5 font-medium max-w-[200px] whitespace-normal" title={r.itemName}>{r.itemName}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">{fmtNum(r.qtyBom)}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">{fmtNum(r.qtyDeviasi)}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono font-semibold text-red-600 dark:text-red-400 tabular-nums">{fmtPct(r.devBom)}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">{fmtIDR(r.nominalLossSurplus)}</TableCell>
                        <TableCell className={`text-xs py-1.5 text-center font-bold ${directionColor(r.direction)}`}>{r.direction === 'LOSS' ? 'L' : r.direction === 'SURPLUS' ? 'S' : '-'}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono text-muted-foreground tabular-nums">{r.qtyWaste > 0 ? fmtNum(r.qtyWaste) : '—'}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono text-muted-foreground tabular-nums">{r.qtySusut > 0 ? fmtNum(r.qtySusut) : '—'}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono text-muted-foreground tabular-nums">{r.qtyTrial > 0 ? fmtNum(r.qtyTrial) : '—'}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">{r.residualRatio != null ? fmtPct(r.residualRatio) : '—'}</TableCell>
                        <TableCell className={`text-xs py-1.5 text-center font-bold ${r.historicalTrend === '↑' ? 'text-red-600 dark:text-red-400' : r.historicalTrend === '↓' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>{r.historicalTrend}</TableCell>
                        <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">
                          {r.areaMultiplier != null ? (
                            <span className={r.areaMultiplier > 1.5 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}>
                              {/* FIX (BUG-HUNT B13/B2-04): leftover dot-decimal — the same
                                  metric shows "1,92×" (comma) in the Benchmark card above;
                                  one metric, one separator (SEDANG-1 convention). */}
                              {fmtDecimal(r.areaMultiplier, 1)}×
                            </span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className={`text-xs py-1.5 text-center font-bold ${priorityColor(r.priority)}`}>{r.priority}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                W = Waste · S = Susut · T = Trial · Resid% = Residual Ratio · Hist = Historical Trend (↑ memburuk, ↓ membaik) · vs Area = Area Multiplier · Pri = Priority
              </p>
            </TabsContent>
          </Tabs>
      </CardContent>
    </Card>
  );
}
