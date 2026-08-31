'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { PieChart } from 'lucide-react';
import { useState, memo } from 'react';

export const DeviationBreakdownChart = memo(function DeviationBreakdownChart({ data }: { data: AnalysisData }) {
  const b = data.deviationBreakdown;
  const drivers = data.deviationDrivers || [];
  const [expanded, setExpanded] = useState<string | null>(null);
  // FIX M-C (AUDIT-1): reset expanded state when period changes.
  // Uses "adjust state during render" pattern (same as GrowthComparison).
  const periodKey = `${data.period.monthLabel}|${data.period.weekLabel}`;
  const [prevPeriod, setPrevPeriod] = useState(periodKey);
  if (prevPeriod !== periodKey) {
    setPrevPeriod(periodKey);
    setExpanded(null);
  }
  const total = b.total || 1;
  const chartData = [
    { name: 'Waste', value: b.waste, pct: (b.waste / total) * 100, color: 'var(--chart-waste)', key: 'waste' },
    // FIX L1 (AUDIT-1): Susut was #a16207 (amber variant) — too similar to Waste #f59e0b.
    // Changed to violet #7c3aed for color-blind accessibility (distinct hue).
    { name: 'Susut', value: b.susut, pct: (b.susut / total) * 100, color: '#7c3aed', key: 'susut' },
    { name: 'Trial', value: b.trial, pct: (b.trial / total) * 100, color: '#65a30d', key: 'trial' },
    { name: 'Residual', value: b.residual, pct: (b.residual / total) * 100, color: b.residual / total > 0.5 ? 'var(--chart-loss)' : '#71717a', key: 'residual' },
  ];

  const formatQty = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return v.toFixed(0);
  };

  const formatRp = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000_000) return `Rp ${(v / 1_000_000_000).toFixed(2)}M`;
    if (abs >= 1_000_000) return `Rp ${(v / 1_000_000).toFixed(1)}Jt`;
    if (abs >= 1_000) return `Rp ${(v / 1_000).toFixed(0)}Rb`;
    return `Rp ${v.toFixed(0)}`;
  };

  const getTopDriver = (catKey: string) => {
    const cd = drivers.find(d => d.category === catKey);
    if (!cd || cd.drivers.length === 0) return null;
    return { name: cd.drivers[0].item, share: cd.drivers[0].sharePct };
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <PieChart className="h-3.5 w-3.5" />
          </span>
          Deviation Breakdown
          <FormulaInfo
            formula="QTY Deviasi = |Waste| + |Susut| + |Trial| + |Residual|"
            description="Dekomposisi total deviation. Residual = |QTY Deviasi| - |Waste + Susut + Trial|. Residual tinggi (>50%) = sebagian besar deviation tidak terjelaskan oleh Waste/Susut/Trial. Klik bar/badge untuk lihat Pareto 80% — item penyebab terbesar."
            example="Deviasi 60K = Waste 8K + Susut 6K + Trial 4K + Residual 42K (70%)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'RESIDUAL_LOSS_WARN_PCT', label: 'Ambang Peringatan Residual', dataType: 'percent', min: 0, max: 1, step: 0.05 },
              { key: 'RESIDUAL_LOSS_HIGH_PCT', label: 'Ambang Kritis Residual', dataType: 'percent', min: 0, max: 1, step: 0.05 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">QTY Deviasi composition — klik kategori untuk detail Pareto 80%</p>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" className="opacity-60" />
              <XAxis dataKey="name" fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4, stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
                formatter={(v: number | string, _n: string, p: { payload?: { pct?: number; name?: string } }) => [`${Number(v).toLocaleString()} (${p.payload?.pct?.toFixed(1) ?? '0'}%)`, p.payload?.name ?? '']}
                contentStyle={getTooltipStyle()}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48} onClick={(d: { key?: string }) => d.key && setExpanded(expanded === d.key ? null : d.key)} cursor="pointer">
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Category badges — clickable to expand Pareto detail */}
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          {chartData.map((d) => {
            const top = getTopDriver(d.key);
            const isExpanded = expanded === d.key;
            const panelId = `devbreak-pareto-${d.key}`;
            return (
              <button
                key={d.key}
                onClick={() => setExpanded(isExpanded ? null : d.key)}
                aria-expanded={isExpanded}
                aria-controls={panelId}
                className={`flex items-center justify-between gap-2 rounded-md border px-2 py-2 min-h-[36px] text-xs transition-colors ${
                  isExpanded ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : 'border-border hover:bg-muted/50'
                }`}
              >
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
                  <span className="text-muted-foreground font-medium">{d.name}</span>
                </span>
                {top ? (
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="truncate max-w-[140px] text-foreground/80" title={top.name}>{top.name}</span>
                    <Badge variant="outline" className="text-[11px] h-4 px-1 shrink-0">
                      {top.share.toFixed(0)}%
                    </Badge>
                  </span>
                ) : (
                  <span className="text-muted-foreground/50">—</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Residual warning badge */}
        {b.residual / total > 0.5 && (
          <div className="mt-2">
            <Badge variant="destructive" className="text-xs h-5 font-medium">
              Residual {((b.residual / total) * 100).toFixed(0)}% — sebagian besar deviation tidak terjelaskan
            </Badge>
          </div>
        )}

        {/* Pareto 80% detail — expandable */}
        {expanded && drivers.length > 0 && (() => {
          const cd = drivers.find(d => d.category === expanded);
          if (!cd) return null;
          const catRow = chartData.find(c => c.key === expanded);
          const catColor = catRow?.color || '#71717a';
          const panelId = `devbreak-pareto-${expanded}`;
          return (
            <div id={panelId} role="region" aria-label={`${cd.label} Pareto 80% detail`} className="mt-3 rounded-lg border p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: catColor }} />
                  {cd.label} — {catRow ? formatQty(catRow.value) : '—'}
                  <span className="text-muted-foreground font-normal">
                    ({catRow ? catRow.pct.toFixed(1) : '0'}% dari total)
                  </span>
                </p>
                <button onClick={() => setExpanded(null)} aria-label="Tutup panel Pareto" className="text-xs text-muted-foreground hover:text-foreground">
                  ✕ Tutup
                </button>
              </div>

              {cd.drivers.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-2">Tidak ada data untuk kategori ini</p>
              ) : (
                <>
                  <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                    80% Pareto ({cd.drivers.length} item)
                  </p>
                  <div className="space-y-1">
                    {cd.drivers.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-4 text-muted-foreground">{i + 1}.</span>
                        <span className="flex-1 min-w-0 break-words leading-tight" title={d.item}>{d.item}</span>
                        <div className="w-20 h-2 rounded-full bg-muted overflow-hidden shrink-0">
                          <div className="h-full" style={{ width: `${Math.min(100, d.sharePct)}%`, background: catColor }} />
                        </div>
                        <span className="w-14 text-right tabular-nums font-medium shrink-0" title={formatRp(d.nominal)}>
                          {formatQty(d.qty)}
                        </span>
                        <span className="w-10 text-right tabular-nums text-muted-foreground">{d.sharePct.toFixed(0)}%</span>
                        <span className="w-10 text-right tabular-nums text-muted-foreground/60">{d.cumPct.toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                  {cd.remainderCount > 0 && (
                    <p className="text-[11px] text-muted-foreground/60 pl-6">
                      Sisa {cd.remainderPct.toFixed(0)}%: {cd.remainderCount} item kecil
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
});
