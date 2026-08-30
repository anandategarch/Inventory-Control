'use client';

import { memo, useMemo, useState, useCallback, useRef } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import dynamic from 'next/dynamic';
import { useDashboard } from '@/hooks/useDashboard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Badge } from '@/components/ui/badge';
import { fmtIDR, fmtNum, fmtPctAbs, fmtHeatmapCompact } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { Grid3x3 as HeatMapIcon } from 'lucide-react';

// PERF-FE: lazy-load the drill-down Sheet so its code (~150 lines + Sheet +
// ScrollArea + table primitives) is NOT in the eager heatmap chunk. The Sheet
// is only mounted when the user clicks a cell — until then, it's a separate
// chunk that loads on demand. Loading fallback is null because the Sheet
// already renders its own skeleton while fetching cell-detail data.
const AreaItemHeatmapSheet = dynamic(
  () => import('@/components/dashboard/AreaItemHeatmapSheet'),
  { ssr: false, loading: () => null },
);

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
  outletCount: number;
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

// PERF-FE: CellDetailRow + CellDetailSheet moved to AreaItemHeatmapSheet.tsx
// (lazy-loaded via next/dynamic above).

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

// Metrics where avg-per-outlet is meaningful (sum-based magnitudes, not averages/counts)
const AVG_ELIGIBLE_METRICS: ReadonlySet<HeatmapMetric> = new Set([
  'absNominalDeviasi', 'nominalWaste', 'nominalSusut',
]);

function computeAvgPerOutlet(value: number, outletCount: number): number {
  if (outletCount <= 0) return 0;
  return value / outletCount;
}

// ============================================================
//  Memoized Cell — click opens drill-down Sheet, hover notifies parent
//  PERF-FE: NO Radix Tooltip per cell (was 280 instances = 840 components +
//  1120 event listeners). Instead, parent manages ONE Tooltip + we pass
//  hover data up via onHover callback. 56× fewer component instances.
// ============================================================
interface CellProps {
  areaName: string;
  itemName: string;
  cell: HeatmapCell | undefined;
  maxVal: number;
  metric: HeatmapMetric;
  onCellClick: (area: string, item: string) => void;
  onCellHover: (cell: { area: string; item: string } | null) => void;
}

const HeatmapCellView = memo(function HeatmapCellView({
  areaName, itemName, cell, maxVal, metric, onCellClick, onCellHover,
}: CellProps) {
  const value = cell?.value ?? 0;
  const bg = getHeatColor(value, maxVal);
  const textCls = getTextColor(value, maxVal);
  const showAvg = AVG_ELIGIBLE_METRICS.has(metric) && value > 0 && (cell?.outletCount ?? 0) > 0;
  const avgValue = showAvg ? computeAvgPerOutlet(value, cell!.outletCount) : 0;
  const avgTextCls = avgValue > 0 && getTextColor(avgValue, maxVal) === 'text-white' ? 'text-white/70' : 'text-foreground/60';

  return (
    <button
      type="button"
      className="h-11 w-full rounded-sm flex flex-col items-center justify-center cursor-pointer relative z-0 hover:z-10 hover:scale-110 hover:ring-2 hover:ring-amber-500 transition-transform gap-0"
      style={{ backgroundColor: bg === 'transparent' ? 'rgba(0,0,0,0.02)' : bg }}
      onClick={() => onCellClick(areaName, itemName)}
      onMouseEnter={() => onCellHover({ area: areaName, item: itemName })}
      onMouseLeave={() => onCellHover(null)}
      onFocus={() => onCellHover({ area: areaName, item: itemName })}
      onBlur={() => onCellHover(null)}
      aria-label={`Detail ${areaName} ${itemName}`}
    >
      {value > 0 && (
        <>
          <span className={`text-[10px] font-semibold leading-tight ${textCls}`}>
            {formatCellValue(metric, value)}
          </span>
          {showAvg && (
            <span className={`text-[8px] leading-tight ${avgTextCls}`}>
              Ø {fmtHeatmapCompact(avgValue)}
            </span>
          )}
        </>
      )}
    </button>
  );
}, (prev, next) =>
  prev.areaName === next.areaName &&
  prev.itemName === next.itemName &&
  prev.cell?.value === next.cell?.value &&
  prev.cell?.recordCount === next.cell?.recordCount &&
  prev.cell?.outletCount === next.cell?.outletCount &&
  prev.maxVal === next.maxVal &&
  prev.metric === next.metric
);

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
  const [hoveredCell, setHoveredCell] = useState<{ area: string; item: string } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // PERF-FE: debounced hover to avoid rapid tooltip flicker when sweeping mouse
  const handleCellHover = useCallback((cell: { area: string; item: string } | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (cell) {
      hoverTimer.current = setTimeout(() => setHoveredCell(cell), 80);
    } else {
      setHoveredCell(null);
    }
  }, []);

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
  // PERF-FE: stable callback for Sheet open/close — prevents the Sheet
  // (and its internal query) from re-mounting on every parent render.
  const handleSheetOpenChange = useCallback((v: boolean) => {
    if (!v) setSelectedCell(null);
  }, []);
  // PERF-FE: memoize the filters object so its reference is stable across
  // re-renders — the Sheet's internal `useMemo(() => params, [filters])` will
  // only recompute when one of the underlying filter values actually changes.
  const sheetFilters = useMemo(
    () => ({ area, kelompok, outletCode, pic }),
    [area, kelompok, outletCode, pic],
  );

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
                <span className="ml-auto text-amber-700 dark:text-amber-400">💡 Total di atas · Ø rata-rata/resto · Klik sel untuk detail</span>
              </div>
            )}

            {/* Heatmap grid — wrapped in SINGLE Tooltip (PERF-FE: was 280 per-cell Tooltips) */}
            <TooltipPrimitive.Provider delayDuration={100}>
            <TooltipPrimitive.Root open={hoveredCell !== null}>
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
                          onCellHover={handleCellHover}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <TooltipPrimitive.Portal>
              {hoveredCell && (() => {
                const hc = cellMap.get(`${hoveredCell.area}|${hoveredCell.item}`);
                const hv = hc?.value ?? 0;
                const hOutletCount = hc?.outletCount ?? 0;
                const hRecordCount = hc?.recordCount ?? 0;
                const hShowAvg = AVG_ELIGIBLE_METRICS.has(metric) && hv > 0 && hOutletCount > 0;
                const hAvg = hShowAvg ? computeAvgPerOutlet(hv, hOutletCount) : 0;
                return (
                  <TooltipPrimitive.Content side="top" className="max-w-[320px] text-xs z-50 bg-primary text-primary-foreground shadow-lg rounded-lg px-3 py-2" sideOffset={4}>
                    <div className="font-medium leading-snug">{hoveredCell.area} → {hoveredCell.item}</div>
                    <div className="text-primary-foreground/80 mt-0.5">
                      {METRIC_CONFIG[metric].label}: <span className="font-medium text-primary-foreground">{METRIC_CONFIG[metric].format(hv)}</span>
                    </div>
                    {hShowAvg && (
                      <div className="text-primary-foreground/80">
                        Rata-rata per resto: <span className="font-medium text-primary-foreground">{fmtIDR(hAvg)}</span>
                      </div>
                    )}
                    <div className="text-primary-foreground/80">
                      Jumlah resto: <span className="font-medium text-primary-foreground">{hOutletCount}</span>
                    </div>
                    <div className="text-primary-foreground/80">
                      Jumlah record: <span className="font-medium text-primary-foreground">{hRecordCount}</span>
                    </div>
                    {hc && hv > 0 && (
                      <div className="text-primary-foreground/80 border-t border-primary-foreground/20 mt-1 pt-1">
                        Klik untuk detail per resto →
                      </div>
                    )}
                  </TooltipPrimitive.Content>
                );
              })()}
            </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
            </TooltipPrimitive.Provider>

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

      {/* Drill-down Sheet (lazy-loaded via next/dynamic) */}
      {selectedCell && (
        <AreaItemHeatmapSheet
          open={!!selectedCell}
          onOpenChange={handleSheetOpenChange}
          areaName={selectedCell.area}
          itemName={selectedCell.item}
          monthLabel={monthLabel}
          currentWeek={currentWeek}
          filters={sheetFilters}
        />
      )}
    </Card>
  );
}

export const AreaItemHeatmap = memo(AreaItemHeatmapInner);
