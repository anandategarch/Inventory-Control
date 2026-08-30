'use client';

// ============================================================
//  AreaItemHeatmapSheet — drill-down Sheet for a heatmap cell.
//  --------------------------------------------------------
//  PERF-FE: extracted from AreaItemHeatmap.tsx (was 671 lines)
//  so the Sheet UI + cell-detail query can be lazy-loaded via
//  next/dynamic. The Sheet is only mounted when the user clicks
//  a cell — until then, this code is NOT in the heatmap bundle
//  (~150 lines + Sheet + ScrollArea + table primitives saved
//  from the eager heatmap chunk).
//
//  The cell-detail query uses TanStack Query with:
//    • placeholderData: keepPreviousData → switching cells keeps
//      the previous cell's data visible while the new one loads
//      (no skeleton flicker between cells).
//    • refetchOnWindowFocus: false → modal stays open across
//      browser tab switches without refetching.
//    • staleTime: 5 min (matches the heatmap query).
// ============================================================

import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtIDR, fmtNum } from '@/lib/format';
import { Grid3x3 as HeatMapIcon } from 'lucide-react';

export interface CellDetailRow {
  outletCode: string;
  outletName: string;
  area: string;
  akunPenyesuaian: string;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
  nominalLossSurplusSigned: number;
  pctQtyDeviasiToBom: number;
  recordCount: number;
}

export interface HeatmapCellFilters {
  area?: string | null;
  kelompok?: string | null;
  outletCode?: string | null;
  pic?: string | null;
}

export interface AreaItemHeatmapSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  areaName: string;
  itemName: string;
  monthLabel: string | null;
  currentWeek: string | null;
  filters: HeatmapCellFilters;
}

export default function AreaItemHeatmapSheet({
  open, onOpenChange, areaName, itemName, monthLabel, currentWeek, filters,
}: AreaItemHeatmapSheetProps) {
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (monthLabel) p.set('month', monthLabel);
    if (currentWeek) p.set('week', currentWeek);
    p.set('area', areaName);
    p.set('item', itemName);
    if (filters.kelompok && filters.kelompok !== 'all') p.set('kelompok', filters.kelompok);
    if (filters.outletCode && filters.outletCode !== 'all') p.set('outlet', filters.outletCode);
    if (filters.pic && filters.pic !== 'all') p.set('pic', filters.pic);
    return p;
  }, [monthLabel, currentWeek, areaName, itemName, filters]);

  const { data, isLoading, isError } = useQuery<{ success: boolean; rows: CellDetailRow[] }>({
    queryKey: ['heatmap-cell-detail', params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/area-item-heatmap/cell-detail?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open && !!monthLabel && !!currentWeek && !!areaName && !!itemName,
    staleTime: 5 * 60 * 1000,
    // PERF-FE: keep previous cell's data visible while switching to a new cell
    // (avoids skeleton flicker between cells when the user clicks rapidly).
    placeholderData: keepPreviousData,
    // PERF-FE: the Sheet is a user-initiated drill-down — no need to refetch
    // when the user switches browser tabs and comes back. The 5-min staleTime
    // is sufficient for freshness.
    refetchOnWindowFocus: false,
  });

  const rows = data?.rows ?? [];
  const totalNominal = useMemo(() => rows.reduce((s, r) => s + r.nominalLossSurplusSigned, 0), [rows]);
  const totalQtyDeviasi = useMemo(() => rows.reduce((s, r) => s + r.qtyDeviasi, 0), [rows]);
  const totalQtyBom = useMemo(() => rows.reduce((s, r) => s + r.qtyBom, 0), [rows]);
  const totalQtyWaste = useMemo(() => rows.reduce((s, r) => s + r.qtyWaste, 0), [rows]);
  const totalQtySusut = useMemo(() => rows.reduce((s, r) => s + r.qtySusut, 0), [rows]);
  const totalQtyTrial = useMemo(() => rows.reduce((s, r) => s + r.qtyTrial, 0), [rows]);
  const outletCount = rows.length;
  const avgNominal = outletCount > 0 ? totalNominal / outletCount : 0;
  const avgQtyDeviasi = outletCount > 0 ? totalQtyDeviasi / outletCount : 0;
  const avgQtyBom = outletCount > 0 ? totalQtyBom / outletCount : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b bg-muted/30">
          <SheetTitle className="text-sm flex items-center gap-2 flex-wrap">
            <HeatMapIcon className="h-4 w-4 text-amber-600" />
            <span>Detail Resto</span>
            <Badge variant="outline" className="text-[10px] font-normal">{areaName}</Badge>
            <span className="text-muted-foreground">→</span>
            <Badge variant="outline" className="text-[10px] font-normal break-all text-left max-w-[200px]">{itemName}</Badge>
          </SheetTitle>
          <SheetDescription className="text-xs">
            {monthLabel} · {currentWeek}
          </SheetDescription>
        </SheetHeader>

        {isLoading && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}

        {isError && (
          <div className="p-4 text-xs text-red-600">Gagal memuat detail. Coba tutup dan buka lagi.</div>
        )}

        {!isLoading && !isError && rows.length === 0 && (
          <div className="p-4 text-xs text-muted-foreground">Tidak ada data detail untuk sel ini.</div>
        )}

        {!isLoading && !isError && rows.length > 0 && (
          <>
            {/* Aggregate summary */}
            <div className="px-4 py-3 border-b bg-muted/20 grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-[10px] text-muted-foreground">Total Resto</div>
                <div className="text-sm font-semibold">{rows.length}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">Total Qty Deviasi</div>
                <div className="text-sm font-semibold tabular-nums">{fmtNum(totalQtyDeviasi)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">Total Nominal</div>
                <div className="text-sm font-semibold tabular-nums">{fmtIDR(totalNominal)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">Ø per Resto</div>
                <div className="text-sm font-semibold tabular-nums text-amber-600">{fmtIDR(avgNominal)}</div>
              </div>
            </div>

            {/* Detail table — scrollable */}
            <div className="flex-1 overflow-auto min-h-0">
              <div className="p-2">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background z-10">
                    <tr className="border-b text-left">
                      <th className="py-2 px-1.5 font-medium text-muted-foreground">Resto</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Qty BOM</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Qty Deviasi</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Dev/BOM</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Waste</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Susut</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Trial</th>
                      <th className="py-2 px-1.5 font-medium text-muted-foreground text-right">Nominal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, idx) => {
                      const devBomPct = r.qtyBom > 0 ? r.qtyDeviasi / r.qtyBom : 0;
                      const isLoss = r.nominalLossSurplusSigned < 0;
                      return (
                        <tr key={`${r.outletCode}-${r.akunPenyesuaian}-${idx}`} className="border-b hover:bg-muted/30">
                          <td className="py-1.5 px-1.5">
                            <div className="font-medium truncate max-w-[120px]" title={r.outletName}>{r.outletName}</div>
                            <div className="text-[9px] text-muted-foreground">{r.outletCode}</div>
                            <div className="text-[9px] text-muted-foreground/70 truncate max-w-[120px]">{r.akunPenyesuaian}</div>
                          </td>
                          <td className="py-1.5 px-1.5 text-right tabular-nums">{fmtNum(r.qtyBom)}</td>
                          <td className="py-1.5 px-1.5 text-right tabular-nums font-medium">{fmtNum(r.qtyDeviasi)}</td>
                          <td className="py-1.5 px-1.5 text-right tabular-nums">
                            <span className={devBomPct > 0.05 ? 'text-red-600 font-medium' : ''}>
                              {(devBomPct * 100).toFixed(1).replace('.', ',')}%
                            </span>
                          </td>
                          <td className="py-1.5 px-1.5 text-right tabular-nums text-muted-foreground">{r.qtyWaste > 0 ? fmtNum(r.qtyWaste) : '—'}</td>
                          <td className="py-1.5 px-1.5 text-right tabular-nums text-muted-foreground">{r.qtySusut > 0 ? fmtNum(r.qtySusut) : '—'}</td>
                          <td className="py-1.5 px-1.5 text-right tabular-nums text-muted-foreground">{r.qtyTrial > 0 ? fmtNum(r.qtyTrial) : '—'}</td>
                          <td className={`py-1.5 px-1.5 text-right tabular-nums font-medium ${isLoss ? 'text-red-600' : 'text-emerald-600'}`}>
                            {fmtIDR(r.nominalLossSurplusSigned)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 bg-muted/20 font-semibold">
                      <td className="py-2 px-1.5">TOTAL ({rows.length} resto)</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtNum(totalQtyBom)}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtNum(totalQtyDeviasi)}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">
                        {totalQtyBom > 0 ? `${((totalQtyDeviasi / totalQtyBom) * 100).toFixed(1).replace('.', ',')}%` : '—'}
                      </td>
                      <td className="py-2 px-1.5 text-right tabular-nums text-muted-foreground">{totalQtyWaste > 0 ? fmtNum(totalQtyWaste) : '—'}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums text-muted-foreground">{totalQtySusut > 0 ? fmtNum(totalQtySusut) : '—'}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums text-muted-foreground">{totalQtyTrial > 0 ? fmtNum(totalQtyTrial) : '—'}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtIDR(totalNominal)}</td>
                    </tr>
                    <tr className="bg-amber-50/50 dark:bg-amber-950/20 font-medium text-amber-700 dark:text-amber-400">
                      <td className="py-2 px-1.5">Ø PER RESTO</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtNum(avgQtyBom)}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtNum(avgQtyDeviasi)}</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">
                        {avgQtyBom > 0 ? `${((avgQtyDeviasi / avgQtyBom) * 100).toFixed(1).replace('.', ',')}%` : '—'}
                      </td>
                      <td colSpan={3} className="py-2 px-1.5 text-right text-[10px] text-muted-foreground">Rata-rata per resto</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtIDR(avgNominal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
