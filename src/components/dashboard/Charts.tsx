'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtPct } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ComposedChart, Line, Legend, Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, BarChart3, PieChart, Activity } from 'lucide-react';
import { useState } from 'react';

export function GrowthComparison({ data }: { data: AnalysisData }) {
  const g = data.growthComparison;
  const drivers = data.growthDrivers || [];
  const [expanded, setExpanded] = useState<string | null>(null);
  // FIX M-C (AUDIT-2): reset expanded state when period changes (e.g. user picks
  // a different week/month). Uses "adjust state during render" pattern per React docs
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // instead of useEffect to avoid setState-in-effect lint error.
  const periodKey = `${data.period.monthLabel}|${data.period.weekLabel}`;
  const [prevPeriod, setPrevPeriod] = useState(periodKey);
  if (prevPeriod !== periodKey) {
    setPrevPeriod(periodKey);
    setExpanded(null);
  }

  const chartData = [
    { name: 'Sales', growth: g.salesGrowth, key: 'sales' },
    { name: 'BOM', growth: g.bomGrowth, key: 'bom' },
    { name: 'QTY Deviasi', growth: g.qtyDeviasiGrowth, key: 'qtyDeviasi' },
    { name: 'Nominal Deviasi', growth: g.nominalDeviasiGrowth, key: 'nominalDeviasi' },
  ].filter((d) => d.growth != null);

  // FIX H9 (AUDIT-2): mismatch badge was `salesGrowth > 0 && nominalDeviasiGrowth > 2*salesGrowth`
  // — missed the worst case: sales SHRINKING while deviation magnitude GROWS. New condition:
  // flag whenever deviation grows faster than sales, regardless of sales sign. Also catches
  // negative-sales + positive-deviation (the most alarming divergence).
  const mismatchSales = g.salesGrowth != null && g.nominalDeviasiGrowth != null &&
    g.nominalDeviasiGrowth > 0 &&
    (g.salesGrowth < g.nominalDeviasiGrowth / 2);
  const mismatchBom = g.bomGrowth != null && g.qtyDeviasiGrowth != null &&
    g.qtyDeviasiGrowth > 0 &&
    (g.bomGrowth < g.qtyDeviasiGrowth / 2);

  const getTopDriver = (metricKey: string) => {
    const md = drivers.find(d => d.metric === metricKey);
    if (!md) return null;
    const upTop = md.up.drivers[0];
    const downTop = md.down.drivers[0];
    if (upTop && (!downTop || Math.abs(upTop.delta) > Math.abs(downTop.delta))) {
      return { name: upTop.item, share: upTop.sharePct, dir: 'up' as const };
    }
    if (downTop) return { name: downTop.item, share: downTop.sharePct, dir: 'down' as const };
    return null;
  };

  const formatDelta = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}M`;
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
    return v.toFixed(0);
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Growth Comparison
          <FormulaInfo
            formula="Growth = (Current - Previous) / |Previous|"
            description="Persentase perubahan vs periode pembanding. Klik metric untuk lihat Pareto 80% — item penyebab terbesar."
            example="Sales: (5.98B - 3.88B) / 3.88B = +54%"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'SALES_DEVIATION_FACTOR', label: 'Faktor Sales vs Deviasi', dataType: 'number', min: 1, max: 10, step: 0.5 },
              { key: 'BOM_DEVIATION_FACTOR', label: 'Faktor BOM vs Deviasi', dataType: 'number', min: 1, max: 10, step: 0.5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9 tabular-nums">
          Current vs {data.period.comparisonWeek
            ? `${data.period.comparisonWeek}${data.period.comparisonMonth && data.period.comparisonMonth !== data.period.monthLabel ? ` ${data.period.comparisonMonth}` : ''}`
            : 'previous'} period — klik metric untuk detail Pareto 80%
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">
              No previous period data available. Upload multiple weeks to enable growth analysis.
            </p>
          </div>
        ) : (
          <>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" className="opacity-60" />
                  <XAxis type="number" tickFormatter={(v) => fmtPct(v, true, 0)} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" width={90} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4, stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }} formatter={(v: number | string) => fmtPct(v as number, true, 2)} contentStyle={getTooltipStyle()} />
                  <Bar dataKey="growth" radius={[0, 4, 4, 0]} maxBarSize={28} onClick={(d: { key?: string }) => d.key && setExpanded(expanded === d.key ? null : d.key)} cursor="pointer">
                    {chartData.map((d, i) => {
                      const mismatch =
                        (d.name === 'Sales' && mismatchSales) ||
                        (d.name === 'BOM' && mismatchBom);
                      const devMismatch =
                        (d.name === 'Nominal Deviasi' && mismatchSales) ||
                        (d.name === 'QTY Deviasi' && mismatchBom);
                      return <Cell key={i} fill={mismatch || devMismatch ? 'var(--chart-loss)' : d.growth! >= 0 ? 'var(--chart-surplus)' : 'var(--chart-waste)'} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Top Driver badges — clickable to expand */}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {chartData.map((d) => {
                const top = getTopDriver(d.key);
                const isExpanded = expanded === d.key;
                const panelId = `growth-pareto-${d.key}`;
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
                    <span className="text-muted-foreground font-medium">{d.name}</span>
                    {top ? (
                      <span className="flex items-center gap-1 min-w-0">
                        <span className={`truncate max-w-[140px] ${top.dir === 'up' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`} title={top.name}>
                          {top.name}
                        </span>
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

            {/* Mismatch badges */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {mismatchSales && (
                <Badge variant="destructive" className="text-xs h-5 font-medium">
                  Sales vs Deviasi MISMATCH
                </Badge>
              )}
              {mismatchBom && (
                <Badge variant="destructive" className="text-xs h-5 font-medium">
                  BOM vs Deviasi MISMATCH
                </Badge>
              )}
              {!mismatchSales && !mismatchBom && (
                <Badge variant="secondary" className="text-xs h-5 bg-emerald-100/60 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 font-medium">Growth pattern consistent</Badge>
              )}
            </div>

            {/* Pareto 80% detail — expandable */}
            {expanded && drivers.length > 0 && (() => {
              const md = drivers.find(d => d.metric === expanded);
              if (!md) return null;
              const growthVal = chartData.find(c => c.key === expanded)?.growth;
              const panelId = `growth-pareto-${expanded}`;
              return (
                <div id={panelId} role="region" aria-label={`${md.label} Pareto 80% detail`} className="mt-3 rounded-lg border p-3 space-y-3 bg-muted/20">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold">
                      {md.label} — {growthVal != null ? `${(growthVal * 100).toFixed(1)}%` : '—'}
                    </p>
                    <button onClick={() => setExpanded(null)} aria-label="Tutup panel Pareto" className="text-xs text-muted-foreground hover:text-foreground">
                      ✕ Tutup
                    </button>
                  </div>

                  {/* Up drivers */}
                  {md.up.drivers.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 mb-1 flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> Naik — 80% Pareto ({md.up.drivers.length} item)
                      </p>
                      <div className="space-y-1">
                        {md.up.drivers.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-4 text-muted-foreground">{i + 1}.</span>
                            <span className="flex-1 min-w-0 break-words leading-tight" title={d.item}>{d.item}</span>
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden shrink-0">
                              <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, d.sharePct)}%` }} />
                            </div>
                            <span className="w-12 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-medium shrink-0">
                              +{formatDelta(d.delta)}
                            </span>
                            <span className="w-8 text-right tabular-nums text-muted-foreground">{d.sharePct.toFixed(0)}%</span>
                            <span className="w-10 text-right tabular-nums text-muted-foreground/60">{d.cumPct.toFixed(0)}%</span>
                          </div>
                        ))}
                        {md.up.remainderCount > 0 && (
                          <p className="text-[11px] text-muted-foreground/60 pl-6">
                            Sisa {md.up.remainderPct.toFixed(0)}%: {md.up.remainderCount} item kecil
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Down drivers */}
                  {md.down.drivers.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-red-600 dark:text-red-400 mb-1 flex items-center gap-1">
                        <TrendingDown className="h-3 w-3" /> Turun — 80% Pareto ({md.down.drivers.length} item)
                      </p>
                      <div className="space-y-1">
                        {md.down.drivers.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-4 text-muted-foreground">{i + 1}.</span>
                            <span className="flex-1 min-w-0 break-words leading-tight" title={d.item}>{d.item}</span>
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden shrink-0">
                              <div className="h-full bg-red-500" style={{ width: `${Math.min(100, d.sharePct)}%` }} />
                            </div>
                            <span className="w-12 text-right tabular-nums text-red-600 dark:text-red-400 font-medium shrink-0">
                              {formatDelta(d.delta)}
                            </span>
                            <span className="w-8 text-right tabular-nums text-muted-foreground">{d.sharePct.toFixed(0)}%</span>
                            <span className="w-10 text-right tabular-nums text-muted-foreground/60">{d.cumPct.toFixed(0)}%</span>
                          </div>
                        ))}
                        {md.down.remainderCount > 0 && (
                          <p className="text-[11px] text-muted-foreground/60 pl-6">
                            Sisa {md.down.remainderPct.toFixed(0)}%: {md.down.remainderCount} item kecil
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {md.up.drivers.length === 0 && md.down.drivers.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-2">Tidak ada perubahan signifikan</p>
                  )}
                </div>
              );
            })()}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DeviationBreakdownChart({ data }: { data: AnalysisData }) {
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
        <CardTitle className="text-base flex items-center gap-2.5">
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
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" className="opacity-60" />
              <XAxis dataKey="name" fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4, stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
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
}

export function LossVsSurplusChart({ data }: { data: AnalysisData }) {
  const l = data.lossVsSurplus;
  // FIX: l.loss/l.surplus are RECORD COUNTS, not QTY sums.
  // Label was "qty" (misleading) — changed to "records" for clarity.
  const chartData = [
    { name: 'LOSS', records: l.loss, nominal: l.lossNominal, color: 'var(--chart-loss)' },
    { name: 'SURPLUS', records: l.surplus, nominal: l.surplusNominal, color: 'var(--chart-surplus)' },
  ];

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Loss vs Surplus
          <FormulaInfo
            formula="LOSS: NET Deviation > 0 (actual > SOC)  |  SURPLUS: NET Deviation < 0 (actual < SOC)"
            description="Direction split berdasarkan tanda NET Deviation (qtyLossSurplus). Jumlah record LOSS vs SURPLUS. Nominal = |NET Deviasi × Price|."
            example="qtyLossSurplus = +50 → LOSS  |  qtyLossSurplus = -30 → SURPLUS"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Direction split (magnitude)</p>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" className="opacity-60" />
              <XAxis dataKey="name" fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4, stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }} formatter={(v: number | string) => Number(v).toLocaleString()} contentStyle={getTooltipStyle()} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="records" name="Jumlah Record" radius={[4, 4, 0, 0]} maxBarSize={56}>
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border bg-red-50/40 dark:bg-red-950/20 px-3 py-1.5">
            <span className="text-muted-foreground">LOSS nominal:</span>{' '}
            <span className="font-semibold text-red-600 dark:text-red-400 tabular-nums">Rp {(l.lossNominal / 1_000_000).toFixed(2)}Jt</span>
          </div>
          <div className="rounded-md border bg-emerald-50/40 dark:bg-emerald-950/20 px-3 py-1.5">
            <span className="text-muted-foreground">SURPLUS nominal:</span>{' '}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">Rp {(l.surplusNominal / 1_000_000).toFixed(2)}Jt</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function TrendChart({ data }: { data: AnalysisData }) {
  const trend = data.trend;
  if (!trend || trend.length === 0) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
              <Activity className="h-3.5 w-3.5" />
            </span>
            Weekly Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Activity className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No trend data</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <Activity className="h-3.5 w-3.5" />
          </span>
          Weekly Trend
          <FormulaInfo
            formula="Dev/BOM % = |QTY Deviasi| / |QTY BOM| × 100%"
            description="Rasio deviation terhadap BOM per periode (semua outlet). Garis merah = Dev/BOM % (sumbu kiri). Garis kuning = Nominal Deviasi dalam Rupiah (sumbu kanan). Trend naik = deviation makin besar proporsinya terhadap BOM."
            example="Deviasi 60K / BOM 425K = 14.1%"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Deviation/BOM % &amp; Nominal Deviasi over weeks</p>
      </CardHeader>
      <CardContent>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trend} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" className="opacity-60" />
              <XAxis dataKey="weekLabel" fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis yAxisId="left" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => {
              const abs = Math.abs(v);
              if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace('.', ',')}M`;
              if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}Jt`;
              if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
              return v.toFixed(0);
            }} fontSize={11} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
                formatter={(v: number | string, n: string) => n === 'Dev/BOM' ? `${(Number(v) * 100).toFixed(2)}%` : Number(v).toLocaleString()}
                contentStyle={getTooltipStyle()}
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="devBom" name="Dev/BOM" stroke="var(--chart-loss)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--chart-loss)' }} activeDot={{ r: 5 }} />
              <Line yAxisId="right" type="monotone" dataKey="nominal" name="Nominal Deviasi" stroke="var(--chart-waste)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--chart-waste)' }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
