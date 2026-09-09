'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)

import { memo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useDrilldown } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { AnalysisData, DrilldownRecord, TopItemByNominal } from '@/hooks/useAnalysis';
import { X, Package, TrendingDown, TrendingUp } from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from 'recharts';

// Recharts Tooltip payload entry. `payload` is optional here to match Recharts'
// own `Payload<ValueType, NameType>` shape (TS would otherwise reject the
// assignment). The render code already guards with `payload[0].payload` access
// inside an `active && payload && payload[0]` branch.
type TipPayloadEntry = {
  payload?: { name?: string; value?: number };
  value?: unknown;
  name?: unknown;
  label?: unknown;
};
type TipPayload = TipPayloadEntry[] | undefined;

// ============================================================
//  ItemDeepDive
//  Modal detail item (terbuka ketika deepDiveItem.itemName di-set)
// ============================================================
export const ItemDeepDive = memo(function ItemDeepDive({ data }: { data: AnalysisData | undefined }) {
  const { deepDiveItem, setDeepDiveItem, setDrilldown, monthLabel, currentWeek } = useDashboard(useShallow((s) => ({
    deepDiveItem: s.deepDiveItem,
    setDeepDiveItem: s.setDeepDiveItem,
    setDrilldown: s.setDrilldown,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
  })));
  const open = Boolean(deepDiveItem?.itemName);
  const itemName = deepDiveItem?.itemName || null;

  // Top 5 outlets with this item (from topItemsByNominal — pre-sorted by absNominal)
  const topOutlets = (data?.topItemsByNominal || [])
    .filter((it: TopItemByNominal) => it.itemName === itemName)
    .slice(0, 5);

  // FIX H6 (AUDIT-4): "Total Kemunculan" + LOSS/SURPLUS counts were derived from
  // topItemsByNominal (capped at top-10 per thresholds.TOP_N_ITEMS). For an item
  // in 50 outlets, only ≤10 entries were counted — wildly inaccurate.
  // Now use drilldown data (which fetches ALL records for this item, up to 500)
  // when available. Fall back to topItemsByNominal while loading.
  // Use limit=500 only when drilling by itemName (no outletCode filter) to get all outlets.
  const drilldownLimit = deepDiveItem?.outletCode ? 50 : 500;

  // Multi-period trend for this item (filter trend data)
  // Phase B-2: Include devBom for historical trend chart
  const trendData = (data?.trend || []).map((t) => ({
    weekLabel: t.weekLabel,
    nominal: Math.abs(t.nominal || 0),
    devBom: Math.abs(t.devBom || 0) * 100, // Convert to percentage for chart
  }));
  // Compute historical avg Dev/BOM for reference line
  const histAvgDevBom = trendData.length > 0
    ? trendData.reduce((sum, t) => sum + t.devBom, 0) / trendData.length
    : 0;

  // Use drilldown hook to fetch detailed records — for ItemDeepDive, this fetches
  // ALL outlets with this item (when outletCode is null) for accurate counts.
  const drilldownQuery = useDrilldown({
    outletCode: deepDiveItem?.outletCode ?? null,
    itemName: itemName,
    weekLabel: currentWeek,
    monthLabel: monthLabel,
    limit: drilldownLimit,
  });

  // Derive counts from drilldown data (true counts) or fall back to topItemsByNominal
  const drilldownRecords = drilldownQuery.data?.records ?? [];
  const hasDrilldown = drilldownRecords.length > 0;
  // FIX H6: keep types separate — allOccurrences is DrilldownRecord[] OR TopItemByNominal[],
  // not a union. Compute counts in two branches to avoid TS union-type errors.
  const fallbackOccurrences: TopItemByNominal[] = (data?.topItemsByNominal || []).filter((it: TopItemByNominal) => it.itemName === itemName);
  const lossCount = hasDrilldown
    ? drilldownRecords.filter((r: DrilldownRecord) => r.derived?.direction === 'LOSS').length
    : fallbackOccurrences.filter((it: TopItemByNominal) => it.direction === 'LOSS').length;
  const surplusCount = hasDrilldown
    ? drilldownRecords.filter((r: DrilldownRecord) => r.derived?.direction === 'SURPLUS').length
    : fallbackOccurrences.filter((it: TopItemByNominal) => it.direction === 'SURPLUS').length;
  const totalAbsNominal = hasDrilldown
    ? drilldownRecords.reduce((s: number, r: DrilldownRecord) => s + (r.derived?.absNominalDeviasi ?? Math.abs(r.nominal?.deviasi ?? 0)), 0)
    : fallbackOccurrences.reduce((s: number, it: TopItemByNominal) => s + (it.absNominal || 0), 0);
  const totalCount = hasDrilldown ? drilldownRecords.length : fallbackOccurrences.length;

  const onClose = () => setDeepDiveItem({ itemName: null, outletCode: null });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-[800px] max-h-[80vh] flex flex-col overflow-hidden" showCloseButton={false}>
        <DialogHeader className="shrink-0">
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
                {' · '}Arah: LOSS {lossCount} · SURPLUS {surplusCount}
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
          <div className="flex-1 overflow-y-auto pr-1">
            <div className="space-y-4">
              {/* Direction distribution */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border p-2.5">
                  <p className="text-[11px] text-muted-foreground">Total Kemunculan</p>
                  <p className="text-base font-bold">
                    {totalCount}
                    {drilldownQuery.isLoading && <span className="text-xs text-muted-foreground ml-1">…</span>}
                  </p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[11px] text-muted-foreground">Total |NOMINAL|</p>
                  <p className="text-base font-bold">{fmtIDR(totalAbsNominal)}</p>
                </div>
                <div className="rounded-md border p-2.5">
                  <p className="text-[11px] text-muted-foreground">LOSS vs SURPLUS</p>
                  <p className="text-xs font-bold">
                    <span className="text-red-600">{lossCount}L</span>
                    {' / '}
                    <span className="text-emerald-600">{surplusCount}S</span>
                  </p>
                </div>
              </div>

              {/* Direction pie */}
              {(lossCount > 0 || surplusCount > 0) && (
                <div className="rounded-md border p-3">
                  <p className="text-xs font-semibold mb-2">Distribusi Arah</p>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance
                            animation replays on every dialog open (Dialog unmounts on close)
                            and on every period-change refetch; the double-fetch fix removed
                            the second replay. */}
                        <Pie
                          data={[
                            { name: 'LOSS', value: lossCount, color: 'var(--chart-loss)' },
                            { name: 'SURPLUS', value: surplusCount, color: 'var(--chart-surplus)' },
                          ].filter((d) => d.value > 0)}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={55}
                          isAnimationActive={false}
                          label={({ name, percent }: { name?: string; percent?: number }) =>
                            name && percent != null ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                          }
                          labelLine={false}
                        >
                          {[
                            { name: 'LOSS', value: lossCount, color: 'var(--chart-loss)' },
                            { name: 'SURPLUS', value: surplusCount, color: 'var(--chart-surplus)' },
                          ].filter((d) => d.value > 0).map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip
                          content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                            active && payload && payload[0] && payload[0].payload
                              ? (
                                <div className="rounded-md border bg-background p-2 shadow-md text-xs">
                                  <p className="font-medium">{payload[0].payload?.name ?? ''}</p>
                                  <p className="text-muted-foreground">{Number(payload[0].payload?.value ?? 0).toLocaleString()} outlet</p>
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
                      <TableHead className="text-[11px] h-9 px-3">#</TableHead>
                      <TableHead className="text-[11px] h-9 px-3">Outlet</TableHead>
                      <TableHead className="text-[11px] h-9 px-3 text-right">|NOMINAL|</TableHead>
                      <TableHead className="text-[11px] h-9 px-3 text-center">Dir</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topOutlets.length === 0 ? (
                      <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-3">Tidak ada data</TableCell></TableRow>
                    ) : topOutlets.map((it: TopItemByNominal, i: number) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer hover:bg-muted/50"
                        {...clickableRowProps(() => {
                          // Close deep dive first, then open drilldown drawer (avoid double overlay)
                          onClose();
                          setDrilldown({ outletCode: it.outletCode, itemName: it.itemName });
                        })}
                      >
                        <TableCell className="text-[11px] text-muted-foreground px-3 py-1.5">{i + 1}</TableCell>
                        <TableCell className="text-[11px] px-3 py-1.5 font-medium">{it.outletCode}</TableCell>
                        <TableCell className="text-[11px] px-3 py-1.5 text-right font-semibold">{fmtIDR(it.absNominal)}</TableCell>
                        <TableCell className={`text-[11px] px-3 py-1.5 text-center font-semibold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Variance per outlet (from drilldown records if available) */}
              {deepDiveItem?.outletCode && drilldownQuery.data && drilldownQuery.data.records?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5">Detail Record (Outlet: {deepDiveItem.outletCode})</p>
                  <div className="h-40 overflow-auto rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                        <TableRow>
                          <TableHead className="text-[11px] h-9 px-3">Minggu</TableHead>
                          <TableHead className="text-[11px] h-9 px-3 text-right">QTY Deviasi</TableHead>
                          <TableHead className="text-[11px] h-9 px-3 text-right">NOMINAL</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {drilldownQuery.data.records.slice(0, 8).map((r: DrilldownRecord, i: number) => (
                          <TableRow key={i}>
                            <TableCell className="text-[11px] px-3 py-1.5 text-muted-foreground">{r.period?.weekLabel || '—'}</TableCell>
                            <TableCell className="text-[11px] px-3 py-1.5 text-right">{fmtNum(r.qty?.deviasi)}</TableCell>
                            <TableCell className="text-[11px] px-3 py-1.5 text-right font-semibold">{fmtIDR(r.nominal?.deviasi ?? r.derived?.absNominalDeviasi)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {/* Multi-period trend */}
              {trendData.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
                    <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                    Trend Dev/BOM Multi-Periode
                  </p>
                  {/* Phase B-2: LineChart showing Dev/BOM over time with historical avg reference */}
                  <div className="h-32 mb-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendData} margin={{ top: 5, right: 5, bottom: 5, left: -20 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                        <XAxis dataKey="weekLabel" tick={{ fontSize: 9 }} interval={0} angle={-45} textAnchor="end" height={30} />
                        <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                        <Tooltip
                          contentStyle={{ fontSize: '11px', padding: '4px 8px' }}
                          formatter={(value: number) => [`${value.toFixed(1)}%`, 'Dev/BOM']}
                          labelFormatter={(label) => `Periode: ${label}`}
                        />
                        <ReferenceLine y={histAvgDevBom} stroke="var(--chart-surplus, #10b981)" strokeDasharray="5 5" label={{ value: `Avg: ${histAvgDevBom.toFixed(1)}%`, fontSize: 9, fill: 'var(--chart-surplus, #10b981)' }} />
                        {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance
                            animation replays on every dialog open (Dialog unmounts on close)
                            and on every period-change refetch; the double-fetch fix removed
                            the second replay. */}
                        <Line type="monotone" dataKey="devBom" stroke="var(--chart-loss, #ef4444)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1">
                    {trendData.map((t, i) => (
                      <div key={i} className="flex items-center justify-between text-[11px] rounded-md border px-3 py-1.5">
                        <span className="text-muted-foreground">{t.weekLabel}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-muted-foreground tabular-nums">{t.devBom.toFixed(1)}%</span>
                          <span className="font-semibold">{fmtIDR(t.nominal)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
});
