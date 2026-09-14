'use client';

// ============================================================
//  AreaItemHeatmap — Main orchestrator + barrel
//  --------------------------------------------------------
//  Main orchestrator component. Owns the react-query fetch, the
//  filter state (metric/mode/itemLimit), the controlled hover
//  state for the SINGLE shared Tooltip (PERF-FE: was 280 per-cell
//  Tooltips), and the drill-down Sheet open state. Delegates the
//  grid rendering, tooltip content, controls, and legend to
//  sibling sub-components.
//
//  Import path '@/components/dashboard/AreaItemHeatmap' resolves
//  to this file (folder + index.tsx). Barrel re-exports the main
//  component (named export — preserves existing caller imports
//  like `import { AreaItemHeatmap } from '@/components/dashboard/AreaItemHeatmap'`)
//  plus all sub-components, helpers, and types for reuse.
//
//  Usage:
//    import { AreaItemHeatmap } from '@/components/dashboard/AreaItemHeatmap';
//    import type { HeatmapMetric, HeatmapCell } from '@/components/dashboard/AreaItemHeatmap';
// ============================================================

import { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import dynamic from 'next/dynamic';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { fmtDecimal } from '@/lib/format';
import { Grid3x3 as HeatMapIcon } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';

import { HeatmapControls } from './HeatmapControls';
import { HeatmapGrid } from './HeatmapGrid';
import { HeatmapLegend } from './HeatmapLegend';
import { HeatmapTooltip } from './HeatmapTooltip';
import { METRIC_CONFIG } from './metricConfig';
import type {
  HeatmapCell,
  HeatmapMetric,
  HeatmapResponse,
  ItemSelectMode,
} from './types';

// PERF-FE: lazy-load the drill-down Sheet so its code (~150 lines + Sheet +
// ScrollArea + table primitives) is NOT in the eager heatmap chunk. The Sheet
// is only mounted when the user clicks a cell — until then, it's a separate
// chunk that loads on demand. Loading fallback is null because the Sheet
// already renders its own skeleton while fetching cell-detail data.
const AreaItemHeatmapSheet = dynamic(
  () => import('@/components/dashboard/AreaItemHeatmapSheet'),
  { ssr: false, loading: () => null },
);

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

  // FIX (BUG-3-b B7): the 80ms hover-debounce timer survived unmount —
  // switching tabs (keep-alive) right after hovering a cell fired
  // setHoveredCell on an unmounted component. Clear the pending timer on
  // unmount.
  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
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
          <HeatmapControls
            metric={metric}
            mode={mode}
            itemLimit={itemLimit}
            onMetricChange={handleMetricChange}
            onModeChange={handleModeChange}
            onItemLimitChange={handleItemLimitChange}
          />
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
                    <span>Kontribusi: <span className="font-medium text-foreground">{fmtDecimal(paretoInfo.cumulativePct, 1)}%</span> dari total</span>
                  </>
                ) : (
                  <>
                    <Badge variant="secondary" className="text-[9px] h-4 px-1.5">Top {paretoInfo.selectedItems}</Badge>
                    <span>Dari <span className="font-medium text-foreground">{paretoInfo.totalItems}</span> item</span>
                    <span>•</span>
                    <span>Kontribusi: <span className="font-medium text-foreground">{fmtDecimal(paretoInfo.cumulativePct, 1)}%</span></span>
                  </>
                )}
                <span className="ml-auto text-amber-700 dark:text-amber-400">💡 Total di atas · Ø rata-rata/resto · Klik sel untuk detail</span>
              </div>
            )}

            {/* Heatmap grid — wrapped in SINGLE Tooltip (PERF-FE: was 280 per-cell Tooltips) */}
            <TooltipPrimitive.Provider delayDuration={100}>
              <TooltipPrimitive.Root open={hoveredCell !== null}>
                <TooltipPrimitive.Trigger asChild>
                  <HeatmapGrid
                    areas={areas}
                    items={items}
                    cellMap={cellMap}
                    maxVal={maxVal}
                    metric={metric}
                    gridTemplate={gridTemplate}
                    onCellClick={handleCellClick}
                    onCellHover={handleCellHover}
                  />
                </TooltipPrimitive.Trigger>
                <HeatmapTooltip
                  hoveredCell={hoveredCell}
                  cellMap={cellMap}
                  metric={metric}
                />
              </TooltipPrimitive.Root>
            </TooltipPrimitive.Provider>

            <HeatmapLegend
              metric={metric}
              maxVal={maxVal}
              items={items}
              areasCount={areas.length}
              cellsWithData={data.cells.length}
              totalRecords={totalRecords}
            />
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

// ============================================================
//  Barrel re-exports — preserve original named export `AreaItemHeatmap`
//  (declared above) + expose sub-components, helpers, and types
//  for future reuse. All backward-compatible: no caller file
//  outside this folder needs to change.
// ============================================================
export { HeatmapCellView } from './HeatmapCellView';
export { HeatmapGrid } from './HeatmapGrid';
export { HeatmapTooltip } from './HeatmapTooltip';
export { HeatmapControls } from './HeatmapControls';
export { HeatmapLegend } from './HeatmapLegend';
export {
  AVG_ELIGIBLE_METRICS,
  computeAvgPerOutlet,
  formatCellValue,
  getHeatColor,
  getTextColor,
} from './heatmapHelpers';
export { METRIC_CONFIG } from './metricConfig';
export type {
  HeatmapCell,
  HeatmapMetric,
  HeatmapResponse,
  ItemSelectMode,
  ParetoInfo,
} from './types';
