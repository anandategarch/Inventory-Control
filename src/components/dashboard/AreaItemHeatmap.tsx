'use client';

import { memo, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import { useDashboard } from '@/hooks/useDashboard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { Grid3x3 as HeatMapIcon } from 'lucide-react';

// ============================================================
//  Types
// ============================================================
type HeatmapMetric = 'absNominalDeviasi' | 'nominalWaste' | 'nominalSusut' | 'pctQtyDeviasiToBom' | 'recordCount';

interface HeatmapCell {
  area: string;
  itemName: string;
  value: number;
  recordCount: number;
}

interface HeatmapResponse {
  success: boolean;
  areas: string[];
  items: string[];
  cells: HeatmapCell[];
  metric: HeatmapMetric;
  maxValue: number;
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
//  Uses HSL interpolation: hue 120 (green) → 60 (yellow) → 0 (red)
// ============================================================
function getHeatColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'transparent';
  const ratio = Math.min(1, value / max);
  // Hue: 120 (green) → 0 (red), interpolated linearly
  const hue = 120 * (1 - ratio);
  const saturation = 70 + ratio * 20; // 70% → 90%
  const lightness = 90 - ratio * 35; // 90% → 55% (darker for high values)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function getTextColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'transparent';
  const ratio = Math.min(1, value / max);
  // Dark text for light backgrounds (low values), light text for dark (high values)
  return ratio > 0.5 ? 'text-white' : 'text-foreground';
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
  const [hoveredCell, setHoveredCell] = useState<HeatmapCell | null>(null);

  // Build query params
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (monthLabel) p.set('month', monthLabel);
    if (currentWeek) p.set('week', currentWeek);
    p.set('metric', metric);
    p.set('itemLimit', String(itemLimit));
    if (area && area !== 'all') p.set('area', area);
    if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
    if (outletCode && outletCode !== 'all') p.set('outlet', outletCode);
    if (pic && pic !== 'all') p.set('pic', pic);
    return p;
  }, [monthLabel, currentWeek, metric, itemLimit, area, kelompok, outletCode, pic]);

  const { data, isLoading, isError } = useQuery<HeatmapResponse>({
    queryKey: ['area-item-heatmap', params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/area-item-heatmap?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!monthLabel && !!currentWeek,
    staleTime: 5 * 60 * 1000, // 5 min cache
    refetchOnWindowFocus: false,
  });

  // Build cell lookup map for O(1) access
  const cellMap = useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    if (data?.cells) {
      for (const c of data.cells) {
        m.set(`${c.area}|${c.itemName}`, c);
      }
    }
    return m;
  }, [data]);

  const maxVal = data?.maxValue ?? 0;
  const areas = data?.areas ?? [];
  const items = data?.items ?? [];

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
            <InfoTooltip content={METRIC_CONFIG[metric].description} />
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Metrik:</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as HeatmapMetric)}>
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
              <Label className="text-xs text-muted-foreground">Top Items:</Label>
              <Select value={String(itemLimit)} onValueChange={(v) => setItemLimit(parseInt(v, 10))}>
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
            <Skeleton className="h-[300px] w-full" />
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
            {/* Heatmap grid */}
            <div className="overflow-x-auto">
              <div className="inline-block min-w-full">
                {/* Column headers (items) */}
                <div
                  className="grid gap-px mb-px"
                  style={{ gridTemplateColumns: `120px repeat(${items.length}, minmax(50px, 1fr))` }}
                >
                  <div className="text-[10px] font-medium text-muted-foreground sticky left-0 bg-background z-10 flex items-end pb-1">
                    Area → Item ↓
                  </div>
                  {items.map((item) => (
                    <div
                      key={item}
                      className="text-[9px] font-medium text-muted-foreground text-center px-1 py-1 truncate"
                      title={item}
                      style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '70px' }}
                    >
                      {item.length > 15 ? item.slice(0, 15) + '…' : item}
                    </div>
                  ))}
                </div>

                {/* Rows (areas) */}
                {areas.map((areaName) => (
                  <div
                    key={areaName}
                    className="grid gap-px mb-px"
                    style={{ gridTemplateColumns: `120px repeat(${items.length}, minmax(50px, 1fr))` }}
                  >
                    <div className="text-[10px] font-medium text-foreground sticky left-0 bg-background z-10 flex items-center px-2 truncate" title={areaName}>
                      {areaName}
                    </div>
                    {items.map((itemName) => {
                      const cell = cellMap.get(`${areaName}|${itemName}`);
                      const value = cell?.value ?? 0;
                      const bg = getHeatColor(value, maxVal);
                      const textCls = getTextColor(value, maxVal);
                      return (
                        <div
                          key={itemName}
                          className="h-8 rounded-sm flex items-center justify-center cursor-pointer transition-transform hover:scale-110 hover:z-20 hover:ring-2 hover:ring-amber-500 relative"
                          style={{ backgroundColor: bg === 'transparent' ? 'rgba(0,0,0,0.02)' : bg }}
                          onMouseEnter={() => cell && setHoveredCell(cell)}
                          onMouseLeave={() => setHoveredCell(null)}
                        >
                          {value > 0 && (
                            <span className={`text-[8px] font-medium ${textCls}`}>
                              {value < 1000 ? fmtNum(value) : value < 1_000_000 ? `${(value / 1000).toFixed(0)}K` : `${(value / 1_000_000).toFixed(1)}M`}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Color legend */}
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
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

            {/* Hover tooltip */}
            {hoveredCell && (
              <div className="text-xs p-3 border rounded bg-muted/50 space-y-1">
                <div className="font-medium">{hoveredCell.area} → {hoveredCell.itemName}</div>
                <div className="text-muted-foreground">
                  {METRIC_CONFIG[metric].label}: <span className="font-medium text-foreground">{METRIC_CONFIG[metric].format(hoveredCell.value)}</span>
                </div>
                <div className="text-muted-foreground">
                  Jumlah record: <span className="font-medium text-foreground">{hoveredCell.recordCount}</span>
                </div>
              </div>
            )}

            {/* Summary stats */}
            <div className="flex items-center gap-4 text-[10px] text-muted-foreground border-t pt-2">
              <span>{areas.length} area × {items.length} item = {areas.length * items.length} sel</span>
              <span>•</span>
              <span>{data.cells.length} sel dengan data</span>
              <span>•</span>
              <span>{data.cells.reduce((s, c) => s + c.recordCount, 0)} total record</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const AreaItemHeatmap = memo(AreaItemHeatmapInner);
