'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData, AreaTrendRow } from '@/hooks/useAnalysis';
import { fmtPct } from '@/lib/format';
import { TrendingUp } from 'lucide-react';
import { getTooltipStyle } from '@/lib/chart-constants';
import { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';

// Color palette for 14 areas — distinct hues for color-blind accessibility
const AREA_COLORS = [
  '#dc2626', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#eab308', // yellow
  '#64748b', // slate
];

export function AreaTrendChart({ data }: { data: AnalysisData }) {
  const rows = data.areaTrend || [];
  const [selectedAreas, setSelectedAreas] = useState<Set<string>>(new Set());

  // Build chart data: one row per period, columns = area → avgDevBom
  const { chartData, periods, allAreas } = useMemo(() => {
    if (rows.length === 0) return { chartData: [], periods: [], allAreas: [] };

    // Get all unique periods (sorted chronologically)
    const periodMap = new Map<string, { monthLabel: string; weekLabel: string; monthKey: string; sortKey: string; label: string }>();
    for (const r of rows) {
      const mk = r.monthKey || '0000-00';
      const wkNum = String(parseInt(r.weekLabel?.replace(/\D/g, '') || '0') || 0).padStart(2, '0');
      const sortKey = `${mk}|${wkNum}`;
      const label = `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`;
      if (!periodMap.has(sortKey)) {
        periodMap.set(sortKey, { monthLabel: r.monthLabel, weekLabel: r.weekLabel, monthKey: mk, sortKey, label });
      }
    }
    const periods = [...periodMap.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // Get all unique areas
    const areaSet = new Set<string>();
    for (const r of rows) areaSet.add(r.area);
    const allAreas = [...areaSet].sort();

    // Build chart data: for each period, map area → avgDevBom
    const chartData = periods.map(p => {
      const row: Record<string, number | string> = { period: p.label };
      for (const r of rows) {
        if (r.monthLabel === p.monthLabel && r.weekLabel === p.weekLabel) {
          row[r.area] = Number(r.avgDevBom) || 0;
        }
      }
      return row;
    });

    return { chartData, periods, allAreas };
  }, [rows]);

  // Auto-select top 5 areas by avg Dev/BOM if none selected
  const displayAreas = useMemo(() => {
    if (selectedAreas.size > 0) return [...selectedAreas].sort();
    // Auto-select top 5 worst areas (highest avg Dev/BOM across all periods)
    const areaAvg = new Map<string, number>();
    const areaPeriodCount = new Map<string, number>();
    for (const r of rows) {
      areaAvg.set(r.area, (areaAvg.get(r.area) ?? 0) + (Number(r.avgDevBom) || 0));
      areaPeriodCount.set(r.area, (areaPeriodCount.get(r.area) ?? 0) + 1);
    }
    // FIX BUG 4: Only include areas with ≥2 periods (can't draw trend with 1 point)
    // Compute average (not sum) for fair comparison
    const sorted = [...areaAvg.entries()]
      .filter(([area]) => (areaPeriodCount.get(area) ?? 0) >= 2)
      .map(([area, sum]) => [area, sum / (areaPeriodCount.get(area) ?? 1)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 5).map(([area]) => area);
  }, [selectedAreas, rows]);

  const toggleArea = (area: string) => {
    setSelectedAreas(prev => {
      const next = new Set(prev);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });
  };

  // FIX BUG 2: Summary logic was broken — compared avgDevBom (decimal) against
  // sortKey number (20260801). Now stores {sortKey, avgDevBom} separately.
  // Also uses AVERAGE across all periods (not just latest) for fairer comparison.
  const summary = useMemo(() => {
    if (rows.length === 0) return { worst: null, best: null, avgDevBom: 0 };
    const areaStats = new Map<string, { totalDevBom: number; count: number; latestDevBom: number; latestSortKey: string }>();
    for (const r of rows) {
      const mk = r.monthKey || '0000-00';
      const wkNum = String(parseInt(r.weekLabel?.replace(/\D/g, '') || '0') || 0).padStart(2, '0');
      const sortKey = `${mk}|${wkNum}`;
      const existing = areaStats.get(r.area);
      if (!existing) {
        areaStats.set(r.area, {
          totalDevBom: Number(r.avgDevBom) || 0,
          count: 1,
          latestDevBom: Number(r.avgDevBom) || 0,
          latestSortKey: sortKey,
        });
      } else {
        existing.totalDevBom += Number(r.avgDevBom) || 0;
        existing.count += 1;
        // Track latest period
        if (sortKey > existing.latestSortKey) {
          existing.latestSortKey = sortKey;
          existing.latestDevBom = Number(r.avgDevBom) || 0;
        }
      }
    }
    // Use AVERAGE Dev/BOM for worst/best ranking
    const sorted = [...areaStats.entries()]
      .map(([area, s]) => [area, s.totalDevBom / s.count] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    const avg = sorted.length > 0 ? sorted.reduce((s, [, v]) => s + v, 0) / sorted.length : 0;
    return { worst: sorted[0] || null, best: sorted[sorted.length - 1] || null, avgDevBom: avg };
  }, [rows]);

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-cyan-50 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400 shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Trend Dev/BOM per Area
          <FormulaInfo
            formula="Dev/BOM % = SUM(|QTY Deviasi|) / SUM(|QTY BOM|) × 100% per area per periode"
            description="Line chart menunjukkan trend Dev/BOM% setiap area selama semua periode historis. Setiap garis = 1 area. Filter by weekLabel yang sama (W4 vs W4, bukan W4 vs W1 — cumulative weeks). Klik legend untuk toggle area. Default: 5 area terburuk ditampilkan."
            example="JAWA BARAT 1: W1=15%, W2=18%, W3=22% → trend naik (memburuk)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          {periods.length} periode · {allAreas.length} area ·{' '}
          {summary.worst && <span className="text-red-600 dark:text-red-400 font-medium">Terburuk: {summary.worst[0]} ({fmtPct(summary.worst[1], false)})</span>}
          {summary.best && <span className="text-emerald-600 dark:text-emerald-400 font-medium ml-2">Terbaik: {summary.best[0]} ({fmtPct(summary.best[1], false)})</span>}
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada data trend area</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Upload multiple weeks untuk melihat trend</p>
          </div>
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: 0, right: 20, top: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" className="opacity-60" />
                  <XAxis dataKey="period" fontSize={10} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} angle={-30} textAnchor="end" height={50} />
                  <YAxis tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={getTooltipStyle()}
                    formatter={(v: number | string) => fmtPct(Number(v), false)}
                    labelStyle={{ fontWeight: 600, marginBottom: 4 }}
                  />
                  <Legend
                    iconType="circle"
                    wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                    onClick={(e: { value?: string }) => e.value && toggleArea(e.value)}
                  />
                  {displayAreas.map((area) => {
                    // FIX BUG 3: Use allAreas index (not displayAreas index) for consistent colors
                    const colorIdx = allAreas.indexOf(area);
                    const color = AREA_COLORS[colorIdx % AREA_COLORS.length];
                    return (
                      <Line
                        key={area}
                        type="monotone"
                        dataKey={area}
                        stroke={color}
                        strokeWidth={2}
                        dot={{ r: 2, fill: color }}
                        activeDot={{ r: 4 }}
                        connectNulls
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Area selector chips */}
            {/* FIX BUG 3: Chip colors now match line colors by using a shared color map */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {allAreas.map((area) => {
                const isSelected = displayAreas.includes(area);
                // Use consistent color index based on allAreas order
                const colorIdx = allAreas.indexOf(area);
                const color = AREA_COLORS[colorIdx % AREA_COLORS.length];
                return (
                  <button
                    key={area}
                    onClick={() => toggleArea(area)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[10px] transition-colors ${
                      isSelected ? 'border-foreground/30 bg-muted/50' : 'border-border opacity-50 hover:opacity-100'
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                    <span className="truncate max-w-[100px]">{area}</span>
                  </button>
                );
              })}
            </div>
            {selectedAreas.size > 0 && (
              <button
                onClick={() => setSelectedAreas(new Set())}
                className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
              >
                ✕ Reset ke 5 area terburuk
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
