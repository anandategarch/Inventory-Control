'use client';

// ============================================================
//  WasteParetoCard — "Top Item Waste" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Pareto of items by ΣABS nominalWaste over the multi-month
//  same-week window + kumulatif share (the 80/20 reading) +
//  SISTEMIK columns (#outlet aktif / #bulan aktif) + trend
//  (last vs prev month) + expandable per-outlet breakdown (the
//  Item×Outlet matrix of the offline report).
//  Self-fetching (/api/waste-top-items) — independent of the
//  waste-series request, same query conventions (5-min
//  staleTime, keepPreviousData).
// ============================================================

import { memo, Fragment, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { fmtIDR, fmtPct, fmtNum } from '@/lib/format';
import type { WasteTopItemRow, WasteTopItemsResponse } from './types';

/** Trend glyph: last vs prev month waste. */
function TrendGlyph({ last, prev }: { last: number; prev: number }) {
  if (last <= 0 && prev <= 0) return <Minus className="h-3 w-3 text-muted-foreground inline" aria-label="datar" />;
  if (prev <= 0 && last > 0) return <TrendingUp className="h-3 w-3 text-red-600 dark:text-red-400 inline" aria-label="naik" />;
  const growth = last / prev - 1;
  if (Math.abs(growth) < 0.1) return <Minus className="h-3 w-3 text-muted-foreground inline" aria-label="datar" />;
  return growth > 0
    ? <TrendingUp className="h-3 w-3 text-red-600 dark:text-red-400 inline" aria-label="naik" />
    : <TrendingDown className="h-3 w-3 text-emerald-600 dark:text-emerald-400 inline" aria-label="turun" />;
}

export const WasteParetoCard = memo(function WasteParetoCard({
  monthLabel,
  currentWeek,
  area,
  kelompok,
  pic,
}: {
  monthLabel: string;
  currentWeek: string;
  area: string | null;
  kelompok: string | null;
  pic: string | null;
}) {
  const [expandedItem, setExpandedItem] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery<WasteTopItemsResponse>({
    queryKey: ['waste-top-items', monthLabel, currentWeek, area, kelompok, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (area) p.set('area', area);
      if (kelompok) p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/waste-top-items?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WasteTopItemsResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const items = data?.items || [];
  // BUGHUNT-R1 FIX 2: derive the sistematik month threshold from the
  // ACTUAL window size the server used (ceil(windowMonths/2)) instead of
  // the hardcoded "6 bulan" (the 12-month cap's half — wrong on the live
  // 8-9 month window). Sane fallback when the field is absent.
  const windowMonths = data?.windowMonths;
  const sistematikMonthsText = windowMonths != null && windowMonths > 0
    ? `≥ ${Math.ceil(windowMonths / 2)} bulan`
    : '≥ separuh bulan window';

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
          Pareto Item Waste — 80/20 + Sistematik
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Item teratas by ΣABS nominalWaste pada window same-week (maks. 12 bulan). Share & kumulatif = porsi dari
          total waste scope. <span className="font-medium text-foreground/70">SISTEMATIK</span> = aktif{' '}
          {sistematikMonthsText} dan ≥ 2 outlet (masalah resep/proses, bukan kejadian sekali). Klik baris untuk breakdown per outlet.
        </p>
        {data?.populationTotal != null && data.populationTotal > 0 && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            <Badge variant="secondary" className="text-xs tabular-nums font-medium">Σ Waste scope {fmtIDR(data.populationTotal)}</Badge>
            {items.filter((i) => i.sistematik).length > 0 && (
              <Badge variant="outline" className="text-[10px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
                {items.filter((i) => i.sistematik).length} item sistematik
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat Pareto waste…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada item waste pada scope ini.</div>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[880px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 w-8" />
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Item</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Share</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Kumulatif</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">#Outlet</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">#Bulan</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it: WasteTopItemRow) => (
                  <Fragment key={it.itemId}>
                    <TableRow
                      className="h-9 cursor-pointer hover:bg-muted/50 dark:hover:bg-zinc-800/40"
                      onClick={() => setExpandedItem(expandedItem === it.itemId ? null : it.itemId)}
                      aria-expanded={expandedItem === it.itemId}
                    >
                      <TableCell className="w-8 p-0">
                        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expandedItem === it.itemId ? 'rotate-90' : ''}`} />
                      </TableCell>
                      <TableCell className="text-xs font-medium">
                        {it.itemName}
                        {it.sistematik && (
                          <Badge variant="outline" className="ml-2 text-[9px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-4 px-1.5">
                            SISTEMATIK
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">{fmtIDR(it.totalWaste)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(it.wasteQty, it.satuan || '')}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtPct(it.share, false, 1)}</TableCell>
                      <TableCell className={`text-right text-xs tabular-nums ${it.cumulativeShare >= 0.8 ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}>
                        {fmtPct(it.cumulativeShare, false, 1)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{it.outletsActive}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{it.monthsActive}</TableCell>
                      <TableCell className="text-center">
                        <TrendGlyph last={it.lastMonthWaste} prev={it.prevMonthWaste} />
                      </TableCell>
                    </TableRow>
                    {expandedItem === it.itemId && (
                      <TableRow className="bg-muted/30 dark:bg-zinc-900/40 hover:bg-muted/30 dark:hover:bg-zinc-900/40">
                        <TableCell colSpan={9} className="py-2.5 px-6">
                          <p className="text-[11px] text-muted-foreground mb-1.5">
                            Breakdown per outlet — {it.itemName} (maks. 8 outlet teratas):
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {it.byOutlet.length === 0 && <span className="text-[11px] text-muted-foreground">—</span>}
                            {it.byOutlet.map((b) => (
                              <div key={b.outletCode} className="flex items-center justify-between gap-2 rounded border bg-background/60 dark:bg-zinc-900/60 px-2 py-1">
                                <span className="text-[11px] font-medium truncate" title={`${b.outletCode} · ${b.outletName} · ${b.area}`}>
                                  {b.outletCode} <span className="text-muted-foreground font-normal">· {b.outletName}</span>
                                </span>
                                <span className="text-[11px] tabular-nums whitespace-nowrap">
                                  <span className="text-amber-600 dark:text-amber-400">{fmtIDR(b.waste)}</span>
                                  <span className="text-muted-foreground"> ({fmtPct(b.shareOfItem, false, 0)}, {b.monthsActive} bln)</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
          Trend = waste bulan terakhir vs bulan sebelumnya pada window (naik = memburuk). Kumulatif ≥ 80% = item
          masuk zona Pareto kritikal. #Outlet/#Bulan = jumlah distinct outlet/bulan dengan waste &gt; 0. SISTEMATIK ={' '}
          {sistematikMonthsText} dan ≥ 2 outlet.
        </p>
      </CardContent>
    </Card>
  );
});
