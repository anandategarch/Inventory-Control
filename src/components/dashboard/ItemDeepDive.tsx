'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useDrilldown } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { X, Package, TrendingDown, TrendingUp } from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
} from 'recharts';

type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

// ============================================================
//  ItemDeepDive
//  Modal detail item (terbuka ketika deepDiveItem.itemName di-set)
// ============================================================
export function ItemDeepDive({ data }: { data: AnalysisData | undefined }) {
  const { deepDiveItem, setDeepDiveItem, setDrilldown, monthLabel, currentWeek } = useDashboard();
  const open = Boolean(deepDiveItem?.itemName);
  const itemName = deepDiveItem?.itemName || null;

  // Top 5 outlets with this item
  const topOutlets = (data?.topItemsByNominal || [])
    .filter((it: any) => it.itemName === itemName)
    .slice(0, 5);

  // All occurrences of this item (for direction distribution)
  const allOccurrences = (data?.topItemsByNominal || []).filter((it: any) => it.itemName === itemName);
  const lossCount = allOccurrences.filter((it: any) => it.direction === 'LOSS').length;
  const surplusCount = allOccurrences.filter((it: any) => it.direction === 'SURPLUS').length;
  const totalAbsNominal = allOccurrences.reduce((s: number, it: any) => s + (it.absNominal || 0), 0);

  // Multi-period trend for this item (filter trend data)
  const trendData = (data?.trend || []).map((t) => ({
    weekLabel: t.weekLabel,
    nominal: Math.abs(t.nominal || 0),
  }));

  // Use drilldown hook to fetch detailed records if outletCode is also set
  const drilldownQuery = useDrilldown({
    outletCode: deepDiveItem?.outletCode ?? null,
    itemName: itemName,
    weekLabel: currentWeek,
    monthLabel: monthLabel,
  });

  const onClose = () => setDeepDiveItem({ itemName: null, outletCode: null });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-[800px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <DialogTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{itemName}</span>
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {deepDiveItem?.outletCode
                  ? `Outlet: ${deepDiveItem.outletCode}`
                  : 'Analisis lintas outlet'}
                {' · '}Direction: LOSS {lossCount} · SURPLUS {surplusCount}
              </DialogDescription>
            </div>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        {!itemName ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Item tidak ditemukan</div>
        ) : (
          <ScrollArea className="flex-1 pr-2">
            <div className="space-y-4">
              {/* Direction distribution */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">Total Occurrences</p>
                  <p className="text-base font-bold">{allOccurrences.length}</p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">Total |NOMINAL|</p>
                  <p className="text-base font-bold">{fmtIDR(totalAbsNominal)}</p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[10px] text-muted-foreground">LOSS vs SURPLUS</p>
                  <p className="text-xs font-bold">
                    <span className="text-red-600">{lossCount}L</span>
                    {' / '}
                    <span className="text-emerald-600">{surplusCount}S</span>
                  </p>
                </div>
              </div>

              {/* Direction pie */}
              {allOccurrences.length > 0 && (
                <div className="rounded-md border p-3">
                  <p className="text-xs font-semibold mb-2">Distribusi Arah</p>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'LOSS', value: lossCount, color: '#dc2626' },
                            { name: 'SURPLUS', value: surplusCount, color: '#10b981' },
                          ].filter((d) => d.value > 0)}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={55}
                          label={({ name, percent }: { name?: string; percent?: number }) =>
                            name && percent != null ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                          }
                          labelLine={false}
                        >
                          {[
                            { name: 'LOSS', value: lossCount, color: '#dc2626' },
                            { name: 'SURPLUS', value: surplusCount, color: '#10b981' },
                          ].filter((d) => d.value > 0).map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip
                          content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                            active && payload && payload[0]
                              ? (
                                <div className="rounded-md border bg-background p-2 shadow-md text-xs">
                                  <p className="font-medium">{payload[0].payload.name}</p>
                                  <p className="text-muted-foreground">{payload[0].payload.value.toLocaleString()} outlet</p>
                                </div>
                              )
                              : null
                          }
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Top 5 outlets with this item */}
              <div>
                <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                  Top 5 Outlet dengan Item Ini
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] h-7 px-2">#</TableHead>
                      <TableHead className="text-[10px] h-7 px-2">Outlet</TableHead>
                      <TableHead className="text-[10px] h-7 px-2 text-right">|NOMINAL|</TableHead>
                      <TableHead className="text-[10px] h-7 px-2 text-center">Dir</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topOutlets.length === 0 ? (
                      <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-3">Tidak ada data</TableCell></TableRow>
                    ) : topOutlets.map((it: any, i: number) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => {
                          setDrilldown({ outletCode: it.outletCode, itemName: it.itemName });
                          setDeepDiveItem({ itemName: it.itemName, outletCode: it.outletCode });
                        }}
                      >
                        <TableCell className="text-[11px] text-muted-foreground px-2 py-1">{i + 1}</TableCell>
                        <TableCell className="text-[11px] px-2 py-1 font-medium">{it.outletCode}</TableCell>
                        <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(it.absNominal)}</TableCell>
                        <TableCell className={`text-[11px] px-2 py-1 text-center font-semibold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Variance per outlet (from drilldown records if available) */}
              {deepDiveItem?.outletCode && drilldownQuery.data && drilldownQuery.data.records?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5">Detail Records (Outlet: {deepDiveItem.outletCode})</p>
                  <ScrollArea className="h-40 rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 bg-background z-10">
                        <TableRow>
                          <TableHead className="text-[10px] h-7 px-2">Minggu</TableHead>
                          <TableHead className="text-[10px] h-7 px-2 text-right">QTY Deviasi</TableHead>
                          <TableHead className="text-[10px] h-7 px-2 text-right">NOMINAL</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {drilldownQuery.data.records.slice(0, 8).map((r: any, i: number) => (
                          <TableRow key={i}>
                            <TableCell className="text-[11px] px-2 py-1 text-muted-foreground">{r.weekLabel || r.week || '—'}</TableCell>
                            <TableCell className="text-[11px] px-2 py-1 text-right">{fmtNum(r.qtyDeviasi ?? r.qtyDeviation)}</TableCell>
                            <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(r.nominalDeviasi ?? r.absNominal)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </div>
              )}

              {/* Multi-period trend */}
              {trendData.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
                    <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                    Trend Multi-Periode (Network)
                  </p>
                  <div className="space-y-1">
                    {trendData.map((t, i) => (
                      <div key={i} className="flex items-center justify-between text-[11px] rounded-md border px-2 py-1">
                        <span className="text-muted-foreground">{t.weekLabel}</span>
                        <span className="font-semibold">{fmtIDR(t.nominal)}</span>
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
