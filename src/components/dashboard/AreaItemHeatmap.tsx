'use client';

import { memo, useMemo, useState, useCallback } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import { useDashboard } from '@/hooks/useDashboard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtIDR, fmtNum, fmtPctAbs, fmtHeatmapCompact } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { Grid3x3 as HeatMapIcon, X } from 'lucide-react';

// ============================================================
//  Types
// ============================================================
type HeatmapMetric = 'absNominalDeviasi' | 'nominalWaste' | 'nominalSusut' | 'pctQtyDeviasiToBom' | 'recordCount';
type ItemSelectMode = 'pareto80' | 'top';

interface HeatmapCell {
  area: string;
  itemName: string;
  value: number;
  recordCount: number;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
}

interface ParetoInfo {
  totalItems: number;
  selectedItems: number;
  cumulativePct: number;
  totalMagnitude: number;
}

interface HeatmapResponse {
  success: boolean;
  areas: string[];
  items: string[];
  cells: HeatmapCell[];
  metric: HeatmapMetric;
  maxValue: number;
  itemSelectMode: ItemSelectMode;
  paretoInfo: ParetoInfo;
}

interface CellDetailRow {
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
  pctQtyDeviasiToBom: number;
  recordCount: number;
}

// ============================================================
//  Metric config
// ============================================================
const METRIC_CONFIG: Record<HeatmapMetric, { label: string; format: (v: number) => string; description: string }> = {
  absNominalDeviasi: {
    label: 'Total Deviasi (Rp)',
    format: (v) => fmtIDR(v),
    description: 'Total absolute nominal deviasi per area+item. Warna merah = deviasi tinggi.',
  },
  nominalWaste: {
    label: 'Total Waste (Rp)',
    format: (v) => fmtIDR(v),
    description: 'Total absolute nominal waste per area+item. Warna merah = waste tinggi.',
  },
  nominalSusut: {
    label: 'Total Susut (Rp)',
    format: (v) => fmtIDR(v),
    description: 'Total absolute nominal susut per area+item. Warna merah = susut tinggi.',
  },
  pctQtyDeviasiToBom: {
    label: 'Avg Dev/BOM (%)',
    format: (v) => fmtPctAbs(v),
    description: 'Rata-rata persentase deviasi terhadap BOM per area+item. Warna merah = % tinggi.',
  },
  recordCount: {
    label: 'Jumlah Record',
    format: (v) => fmtNum(v),
    description: 'Jumlah record yang deviasi per area+item. Warna merah = record banyak.',
  },
};

// ============================================================
//  Color scale — green (low) → yellow (medium) → red (high)
// ============================================================
function getHeatColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'transparent';
  const ratio = Math.min(1, value / max);
  const hue = 120 * (1 - ratio);
  const saturation = 70 + ratio * 20;
  const lightness = 90 - ratio * 35;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function getTextColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'text-foreground';
  const ratio = Math.min(1, value / max);
  return ratio > 0.5 ? 'text-white' : 'text-foreground';
}

function formatCellValue(metric: HeatmapMetric, value: number): string {
  if (metric === 'pctQtyDeviasiToBom') {
    const pct = Math.abs(value) * 100;
    return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`.replace('.', ',');
  }
  if (metric === 'recordCount') return fmtNum(value);
  return fmtHeatmapCompact(value);
}

// ============================================================
//  Memoized Cell — click opens drill-down Sheet
// ============================================================
interface CellProps {
  areaName: string;
  itemName: string;
  cell: HeatmapCell | undefined;
  maxVal: number;
  metric: HeatmapMetric;
  onCellClick: (area: string, item: string) => void;
}

const HeatmapCellView = memo(function HeatmapCellView({
  areaName, itemName, cell, maxVal, metric, onCellClick,
}: CellProps) {
  const value = cell?.value ?? 0;
  const bg = getHeatColor(value, maxVal);
  const textCls = getTextColor(value, maxVal);
  const recordCount = cell?.recordCount ?? 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="h-9 w-full rounded-sm flex items-center justify-center cursor-pointer relative z-0 hover:z-10 hover:scale-110 hover:ring-2 hover:ring-amber-500 transition-transform"
          style={{ backgroundColor: bg === 'transparent' ? 'rgba(0,0,0,0.02)' : bg }}
          onClick={() => onCellClick(areaName, itemName)}
          aria-label={`Detail ${areaName} ${itemName}`}
        >
          {value > 0 && (
            <span className={`text-[10px] font-medium ${textCls}`}>
              {formatCellValue(metric, value)}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[320px] text-xs">
        <div className="font-medium leading-snug">{areaName} → {itemName}</div>
        <div className="text-primary-foreground/80 mt-0.5">
          {METRIC_CONFIG[metric].label}: <span className="font-medium text-primary-foreground">{METRIC_CONFIG[metric].format(value)}</span>
        </div>
        <div className="text-primary-foreground/80">
          Jumlah record: <span className="font-medium text-primary-foreground">{recordCount}</span>
        </div>
        {cell && value > 0 && (
          <div className="text-primary-foreground/80 border-t border-primary-foreground/20 mt-1 pt-1">
            Klik untuk detail per resto →
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}, (prev, next) =>
  prev.areaName === next.areaName &&
  prev.itemName === next.itemName &&
  prev.cell?.value === next.cell?.value &&
  prev.cell?.recordCount === next.cell?.recordCount &&
  prev.maxVal === next.maxVal &&
  prev.metric === next.metric
);

// ============================================================
//  Drill-down Sheet — shows per-outlet detail for a cell
// ============================================================
function CellDetailSheet({
  open, onOpenChange, areaName, itemName, monthLabel, currentWeek, filters,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  areaName: string;
  itemName: string;
  monthLabel: string | null;
  currentWeek: string | null;
  filters: { area?: string | null; kelompok?: string | null; outletCode?: string | null; pic?: string | null };
}) {
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
  });

  const rows = data?.rows ?? [];
  const totalNominal = useMemo(() => rows.reduce((s, r) => s + r.nominalDeviasi, 0), [rows]);
  const totalQtyDeviasi = useMemo(() => rows.reduce((s, r) => s + r.qtyDeviasi, 0), [rows]);
  const totalQtyBom = useMemo(() => rows.reduce((s, r) => s + r.qtyBom, 0), [rows]);

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
            <div className="px-4 py-3 border-b bg-muted/20 grid grid-cols-3 gap-2 text-center">
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
            </div>

            {/* Detail table */}
            <ScrollArea className="flex-1">
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
                      const isLoss = r.nominalLossSurplus < 0;
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
                            {fmtIDR(r.nominalLossSurplus)}
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
                      <td colSpan={3} className="py-2 px-1.5 text-right text-muted-foreground text-[10px]">Qty Waste/Susut/Trial total</td>
                      <td className="py-2 px-1.5 text-right tabular-nums">{fmtIDR(totalNominal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ============================================================
//  Component
// ============================================================
function AreaItemHeatmapInner() {
  const { monthLabel, currentWeek, area, kelompok, outletCode, pic } = useDashboard(
    useShallow((s) => ({
      monthLabel: s.monthLabel,
      currentWeek: s.currentWeek,
      area: s.area,
      kelompok: s.kelompok,
      outletCode: s.outletCode,
      pic: s.pic,
    })),
  );

  const [metric, setMetric] = useState<HeatmapMetric>('absNominalDeviasi');
  const [itemLimit, setItemLimit] = useState(20);
  const [mode, setMode] = useState<ItemSelectMode>('pareto80');
  const [selectedCell, setSelectedCell] = useState<{ area: string; item: string } | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (monthLabel) p.set('month', monthLabel);
    if (currentWeek) p.set('week', currentWeek);
    p.set('metric', metric);
    p.set('itemLimit', String(itemLimit));
    p.set('mode', mode);
    if (area && area !== 'all') p.set('area', area);
    if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
    if (outletCode && outletCode !== 'all') p.set('outlet', outletCode);
    if (pic && pic !== 'all') p.set('pic', pic);
    return p;
  }, [monthLabel, currentWeek, metric, itemLimit, mode, area, kelompok, outletCode, pic]);

  const { data, isLoading, isError, isFetching } = useQuery<HeatmapResponse>({
    queryKey: ['area-item-heatmap', params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/area-item-heatmap?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!monthLabel && !!currentWeek,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  const cellMap = useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    if (data?.cells) {
      for (const c of data.cells) {
        m.set(`${c.area}|${c.itemName}`, c);
      }
    }
    return m;
  }, [data]);

  const totalRecords = useMemo(
    () => data?.cells.reduce((s, c) => s + c.recordCount, 0) ?? 0,
    [data],
  );

  const maxVal = data?.maxValue ?? 0;
  const areas = data?.areas ?? [];
  const items = data?.items ?? [];
  const paretoInfo = data?.paretoInfo;

  const gridTemplate = useMemo(
    () => ({ gridTemplateColumns: `minmax(140px, auto) repeat(${items.length}, minmax(54px, 1fr))` }),
    [items.length],
  );

  const handleMetricChange = useCallback((v: string) => setMetric(v as HeatmapMetric), []);
  const handleItemLimitChange = useCallback((v: string) => setItemLimit(parseInt(v, 10)), []);
  const handleModeChange = useCallback((v: string) => setMode(v as ItemSelectMode), []);
  const handleCellClick = useCallback((a: string, i: string) => setSelectedCell({ area: a, item: i }), []);

  if (!monthLabel || !currentWeek) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <HeatMapIcon className="h-4 w-4 text-amber-600" />
            Heatmap Area × Item
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Pilih bulan dan minggu untuk melihat heatmap.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-sm">
            <HeatMapIcon className="h-4 w-4 text-amber-600" />
            Heatmap Area × Item
            {isFetching && !isLoading && (
              <span className="text-[10px] text-amber-600 animate-pulse">memperbarui…</span>
            )}
            <InfoTooltip content={METRIC_CONFIG[metric].description} />
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Mode:</Label>
              <Select value={mode} onValueChange={handleModeChange}>
                <SelectTrigger className="h-8 text-xs w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pareto80" className="text-xs">Pareto 80%</SelectItem>
                  <SelectItem value="top" className="text-xs">Top N</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Metrik:</Label>
              <Select value={metric} onValueChange={handleMetricChange}>
                <SelectTrigger className="h-8 text-xs w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METRIC_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      {cfg.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Maks Item:</Label>
              <Select value={String(itemLimit)} onValueChange={handleItemLimitChange}>
                <SelectTrigger className="h-8 text-xs w-[70px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10" className="text-xs">10</SelectItem>
                  <SelectItem value="15" className="text-xs">15</SelectItem>
                  <SelectItem value="20" className="text-xs">20</SelectItem>
                  <SelectItem value="30" className="text-xs">30</SelectItem>
                  <SelectItem value="50" className="text-xs">50</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-[520px] w-full" />
          </div>
        )}

        {isError && (
          <div className="text-xs text-red-600 p-4 border border-red-200 rounded bg-red-50">
            Gagal memuat heatmap. Coba refresh atau ganti filter.
          </div>
        )}

        {!isLoading && !isError && data && areas.length === 0 && (
          <div className="text-xs text-muted-foreground p-4 text-center">
            Tidak ada data untuk periode/filter ini.
          </div>
        )}

        {!isLoading && !isError && data && areas.length > 0 && (
          <div className="space-y-3">
            {/* Pareto info banner */}
            {paretoInfo && paretoInfo.totalItems > 0 && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5 flex-wrap">
                {data.itemSelectMode === 'pareto80' ? (
                  <>
                    <Badge variant="secondary" className="text-[9px] h-4 px-1.5">Pareto 80%</Badge>
                    <span>Menampilkan <span className="font-medium text-foreground">{paretoInfo.selectedItems}</span> dari <span className="font-medium text-foreground">{paretoInfo.totalItems}</span> item</span>
                    <span>•</span>
                    <span>Kontribusi: <span className="font-medium text-foreground">{paretoInfo.cumulativePct}%</span> dari total</span>
                  </>
                ) : (
                  <>
                    <Badge variant="secondary" className="text-[9px] h-4 px-1.5">Top {paretoInfo.selectedItems}</Badge>
                    <span>Dari <span className="font-medium text-foreground">{paretoInfo.totalItems}</span> item</span>
                    <span>•</span>
                    <span>Kontribusi: <span className="font-medium text-foreground">{paretoInfo.cumulativePct}%</span></span>
                  </>
                )}
                <span className="ml-auto text-amber-700 dark:text-amber-400">💡 Klik sel untuk detail per resto</span>
              </div>
            )}

            {/* Heatmap grid */}
            <div
              className="overflow-auto max-h-[520px] rounded border border-border/40"
              style={{ contain: 'layout style' }}
              role="grid"
              aria-label={`Heatmap ${areas.length} area × ${items.length} item`}
            >
              <div className="inline-block min-w-full">
                <div
                  className="grid gap-px mb-px sticky top-0 z-10 bg-background"
                  style={gridTemplate}
                >
                  <div className="text-[10px] font-semibold text-muted-foreground sticky left-0 bg-background z-20 flex flex-col items-start justify-end pb-1 px-2">
                    <span>Area \ Item</span>
                    <span className="text-[8px] text-muted-foreground/70 font-normal">(baris × kolom)</span>
                  </div>
                  {items.map((item, idx) => (
                    <div
                      key={item}
                      className="text-[10px] font-medium text-muted-foreground text-center px-1 py-1 leading-tight"
                      title={item}
                      style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '120px' }}
                    >
                      <span className="inline-flex items-start gap-0.5">
                        <span className="text-[7px] bg-muted text-muted-foreground rounded-full h-3.5 w-3.5 flex items-center justify-center not-italic" style={{ writingMode: 'horizontal-tb', transform: 'none' }}>
                          {idx + 1}
                        </span>
                        <span className="line-clamp-1">{item}</span>
                      </span>
                    </div>
                  ))}
                </div>

                {areas.map((areaName) => (
                  <div
                    key={areaName}
                    className="grid gap-px mb-px"
                    style={gridTemplate}
                  >
                    <div
                      className="text-[10px] font-medium text-foreground sticky left-0 bg-background z-10 flex items-center px-2 break-words leading-tight underline decoration-dotted underline-offset-2"
                      title={areaName}
                    >
                      {areaName}
                    </div>
                    {items.map((itemName) => {
                      const cell = cellMap.get(`${areaName}|${itemName}`);
                      return (
                        <HeatmapCellView
                          key={itemName}
                          areaName={areaName}
                          itemName={itemName}
                          cell={cell}
                          maxVal={maxVal}
                          metric={metric}
                          onCellClick={handleCellClick}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Color legend */}
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground flex-wrap">
              <div className="flex items-center gap-2">
                <span>Rendah</span>
                <div
                  className="h-3 w-32 rounded"
                  style={{ background: 'linear-gradient(to right, hsl(120, 75%, 88%), hsl(60, 80%, 75%), hsl(0, 85%, 58%))' }}
                />
                <span>Tinggi</span>
              </div>
              <div>
                Max: <span className="font-medium text-foreground">{METRIC_CONFIG[metric].format(maxVal)}</span>
              </div>
            </div>

            {/* Numbered item legend */}
            <details className="text-[10px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground select-none">
                Lihat daftar item lengkap ({items.length})
              </summary>
              <ol className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 mt-1 pl-4 list-decimal">
                {items.map((item, idx) => (
                  <li key={`${item}-${idx}`} className="break-words leading-tight" title={item}>
                    <span className="text-muted-foreground/60 mr-1">{idx + 1}.</span>
                    {item}
                  </li>
                ))}
              </ol>
            </details>

            {/* Summary stats */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground border-t pt-2">
              <span>{areas.length} area × {items.length} item = {areas.length * items.length} sel</span>
              <span>•</span>
              <span>{data.cells.length} sel dengan data</span>
              <span>•</span>
              <span>{totalRecords} total record</span>
            </div>
          </div>
        )}
      </CardContent>

      {/* Drill-down Sheet */}
      {selectedCell && (
        <CellDetailSheet
          open={!!selectedCell}
          onOpenChange={(v) => { if (!v) setSelectedCell(null); }}
          areaName={selectedCell.area}
          itemName={selectedCell.item}
          monthLabel={monthLabel}
          currentWeek={currentWeek}
          filters={{ area, kelompok, outletCode, pic }}
        />
      )}
    </Card>
  );
}

export const AreaItemHeatmap = memo(AreaItemHeatmapInner);
