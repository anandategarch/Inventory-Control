'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { X, Activity, Heart, TrendingDown, TrendingUp } from 'lucide-react';

// ============================================================
//  OutletScorecard
//  Modal detail outlet (terbuka ketika scorecardOutlet di-set)
// ============================================================
function healthScoreColor(score: number): string {
  if (score < 30) return 'text-red-600';
  if (score < 50) return 'text-amber-600';
  if (score < 70) return 'text-yellow-600';
  return 'text-emerald-600';
}

function healthScoreBg(score: number): string {
  if (score < 30) return 'bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-900';
  if (score < 50) return 'bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900';
  if (score < 70) return 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950/40 dark:border-yellow-900';
  return 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900';
}

export function OutletScorecard({ data }: { data: AnalysisData | undefined }) {
  const { scorecardOutlet, setScorecardOutlet, setDrilldown, setDeepDiveItem } = useDashboard();
  const open = Boolean(scorecardOutlet);

  const ranking = data?.outletHealthRanking || [];
  const outlet = ranking.find((o) => o.outletCode === scorecardOutlet);
  const sortedRanking = ranking.slice().sort((a, b) => a.healthScore - b.healthScore);
  const rank = outlet ? sortedRanking.findIndex((o) => o.outletCode === outlet.outletCode) + 1 : 0;

  // Top 5 anomalous items for this outlet (from topItemsByNominal)
  const topItems = (data?.topItemsByNominal || [])
    .filter((it: any) => it.outletCode === scorecardOutlet)
    .slice(0, 5);

  // Historical z-score for this outlet
  const hist = (data?.growthComparison?.historicalAnalysis as any);
  const histItems = hist?.criticalItems?.filter((it: any) => it.outletCode === scorecardOutlet) || [];

  // Recommended actions (from investigationWorklist for this outlet)
  const actions = (data?.investigationWorklist || [])
    .filter((w: any) => w.outletCode === scorecardOutlet)
    .slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setScorecardOutlet(null); }}>
      <DialogContent className="sm:max-w-[800px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <DialogTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{outlet?.outletName || 'Outlet'}</span>
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {outlet ? `${outlet.outletCode} · ${outlet.area}` : 'Outlet tidak ditemukan'}
              </DialogDescription>
            </div>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setScorecardOutlet(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        {!outlet ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Outlet tidak ditemukan</div>
        ) : (
          <ScrollArea className="flex-1 pr-2">
            <div className="space-y-4">
              {/* Health Score + Rank */}
              <div className={`rounded-lg border p-4 ${healthScoreBg(outlet.healthScore)}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Health Score</p>
                    <p className={`text-4xl font-bold ${healthScoreColor(outlet.healthScore)}`}>{outlet.healthScore}</p>
                    <p className="text-[10px] text-muted-foreground">dari 100</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Ranking</p>
                    <p className="text-2xl font-bold">#{rank}</p>
                    <p className="text-[10px] text-muted-foreground">dari {ranking.length} outlet</p>
                  </div>
                </div>
              </div>

              {/* 4-metric grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">% DEV TO BOM</p>
                  <p className={`text-base font-bold ${outlet.devBom > 0.1 ? 'text-red-600' : outlet.devBom > 0.05 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {fmtPctAbs(outlet.devBom)}
                  </p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">RESIDUAL %</p>
                  <p className={`text-base font-bold ${outlet.residualPct != null && outlet.residualPct > 0.5 ? 'text-red-600' : 'text-foreground'}`}>
                    {fmtPctAbs(outlet.residualPct)}
                  </p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">LOSS/PENJUALAN</p>
                  <p className={`text-base font-bold ${outlet.lossToSales != null && outlet.lossToSales > 0.10 ? 'text-red-600' : outlet.lossToSales != null && outlet.lossToSales > 0.05 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {fmtPctAbs(outlet.lossToSales)}
                  </p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">Jumlah Masalah</p>
                  <p className="text-base font-bold text-red-600">{outlet.abnormal}</p>
                  <p className="text-[9px] text-muted-foreground">{outlet.normal} normal · {outlet.warning} warning</p>
                </div>
              </div>

              {/* Sales + AbsNominal summary */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" /> PENJUALAN</p>
                  <p className="text-base font-bold">{fmtIDR(outlet.sales)}</p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1"><TrendingDown className="h-3 w-3" /> |NOMINAL DEVIASI|</p>
                  <p className="text-base font-bold">{fmtIDR(outlet.absNominal)}</p>
                </div>
              </div>

              {/* Top 5 anomalous items */}
              <div>
                <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
                  <Heart className="h-3.5 w-3.5 text-rose-600" />
                  Top 5 Item Anomali
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] h-7 px-2">Item</TableHead>
                      <TableHead className="text-[10px] h-7 px-2 text-right">|NOMINAL|</TableHead>
                      <TableHead className="text-[10px] h-7 px-2 text-center">Dir</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topItems.length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="text-center text-xs text-muted-foreground py-3">Tidak ada item</TableCell></TableRow>
                    ) : topItems.map((it: any, i: number) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => {
                          setDrilldown({ outletCode: it.outletCode, itemName: it.itemName });
                          setDeepDiveItem({ itemName: it.itemName, outletCode: it.outletCode });
                        }}
                      >
                        <TableCell className="text-[11px] px-2 py-1 font-medium truncate max-w-[180px]">{it.itemName}</TableCell>
                        <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(it.absNominal)}</TableCell>
                        <TableCell className={`text-[11px] px-2 py-1 text-center font-semibold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Historical z-score */}
              {histItems.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5">Historical Z-Score Anomaly</p>
                  <div className="space-y-1">
                    {histItems.map((it: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-[11px] rounded-md border px-2 py-1">
                        <span className="font-medium truncate max-w-[200px]">{it.itemName}</span>
                        <span className="text-muted-foreground">Current {fmtPctAbs(it.currentDevBom)} vs Hist {fmtPctAbs(it.historicalAvg)}</span>
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${it.zScore > 3 ? 'text-red-700 bg-red-50 border-red-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
                          Z: {it.zScore.toFixed(2)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recommended actions */}
              {actions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5">Recommended Actions</p>
                  <div className="space-y-1">
                    {actions.map((w: any, i: number) => (
                      <div key={i} className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${w.priority === 'P1' ? 'text-red-700 bg-red-50 border-red-200' : w.priority === 'P2' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-sky-700 bg-sky-50 border-sky-200'}`}>
                            {w.priority}
                          </Badge>
                          <span className="text-[11px] font-medium truncate">{w.itemName}</span>
                        </div>
                        <p className="text-[10px] text-amber-900 dark:text-amber-300 leading-tight">{w.recommendedAction}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
