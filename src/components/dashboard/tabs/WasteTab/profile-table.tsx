'use client';

// ============================================================
//  WasteProfileTable — "Profil Waste Outlet" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Per-outlet waste profile over the multi-month same-week
//  window, ranked by waste/sales (1 = tertinggi): sales, waste,
//  susut, trial, residual, loss, waste/sales + the 4 network
//  detector badges. The in-app version of the offline report's
//  "Profil Waste Outlet" sheet.
//  Long list handling: max-h-96 + custom scrollbar (convention).
// ============================================================

import { memo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Store, ChevronDown, ChevronUp } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import type { WasteOutletRow } from './types';

const INITIAL_ROWS = 15;

export const WasteProfileTable = memo(function WasteProfileTable({
  outlets,
}: {
  outlets: WasteOutletRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? outlets : outlets.slice(0, INITIAL_ROWS);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Store className="h-3.5 w-3.5" />
          </span>
          Profil Waste Outlet — Rank Waste/Sales
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Ranking {outlets.length} outlet pada scope filter aktif — rank 1 = rasio waste/sales tertinggi di window.
          Waste = ΣABS nominalWaste; Residual = bagian loss yang TIDAK dijelaskan waste/susut/trial.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {outlets.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada data waste pada scope ini.</div>
        ) : (
          <>
            <div className="max-h-96 overflow-auto waste-scroll">
              <Table className="min-w-[1050px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">#</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Area</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Sales</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Susut</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Trial</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Residual</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Total Loss</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste/Sales</TableHead>
                    <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Flag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => (
                    <TableRow key={o.outletCode} className="h-9">
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{o.rankWasteToSales}</TableCell>
                      <TableCell className="text-xs font-medium">
                        {o.outletCode}
                        <span className="text-muted-foreground font-normal"> · {o.outletName}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[140px] truncate" title={o.area}>{o.area}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtIDR(o.sales)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">{fmtIDR(o.waste)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(o.susut)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(o.trial)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">{fmtIDR(o.residual)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(o.totalLoss)}</TableCell>
                      <TableCell className={`text-right text-xs tabular-nums ${o.wasteToSales > 0.02 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}`}>
                        {fmtPct(o.wasteToSales, false, 2)}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1 flex-wrap">
                          {o.zeroWasteBigLoss && (
                            <Badge variant="outline" className="text-[9px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-4 px-1.5">
                              W0
                            </Badge>
                          )}
                          {o.spikeMonths > 0 && (
                            <Badge variant="outline" className="text-[9px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-4 px-1.5">
                              2σ×{o.spikeMonths}
                            </Badge>
                          )}
                          {o.underRecording && (
                            <Badge variant="outline" className="text-[9px] font-normal text-yellow-700 dark:text-yellow-400 border-yellow-300/70 dark:border-yellow-800/70 bg-yellow-50/60 dark:bg-yellow-950/30 h-4 px-1.5">
                              UR
                            </Badge>
                          )}
                          {o.residualDominant && (
                            <Badge variant="outline" className="text-[9px] font-normal text-zinc-600 dark:text-zinc-300 border-zinc-300/70 dark:border-zinc-700 h-4 px-1.5">
                              RD
                            </Badge>
                          )}
                          {!o.zeroWasteBigLoss && o.spikeMonths === 0 && !o.underRecording && !o.residualDominant && (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {outlets.length > INITIAL_ROWS && (
              <div className="p-2 border-t flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                >
                  {expanded
                    ? <><ChevronUp className="h-3.5 w-3.5 mr-1" />Tampilkan lebih sedikit</>
                    : <><ChevronDown className="h-3.5 w-3.5 mr-1" />Tampilkan semua {outlets.length} outlet</>}
                </Button>
              </div>
            )}
            <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
              Flag: W0 = waste ≈ 0 dengan loss &gt; ambang P1 · 2σ×n = n bulan lonjakan waste/sales &gt; 2σ vs riwayat window sendiri ·
              UR = waste/sales &lt; 0,1% (≥ 2 bulan, under-recording) · RD = residual &gt; 80% loss dan waste menjelaskan &lt; 10%.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
});
