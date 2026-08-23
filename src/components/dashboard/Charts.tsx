'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtPct } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
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

  const chartData = [
    { name: 'Sales', growth: g.salesGrowth, key: 'sales' },
    { name: 'BOM', growth: g.bomGrowth, key: 'bom' },
    { name: 'QTY Deviasi', growth: g.qtyDeviasiGrowth, key: 'qtyDeviasi' },
    { name: 'Nominal Deviasi', growth: g.nominalDeviasiGrowth, key: 'nominalDeviasi' },
  ].filter((d) => d.growth != null);

  const mismatchSales = g.salesGrowth != null && g.nominalDeviasiGrowth != null &&
    g.nominalDeviasiGrowth > 2 * (g.salesGrowth > 0 ? g.salesGrowth : 0) && g.salesGrowth > 0;
  const mismatchBom = g.bomGrowth != null && g.qtyDeviasiGrowth != null &&
    g.qtyDeviasiGrowth > 2 * (g.bomGrowth > 0 ? g.bomGrowth : 0) && g.bomGrowth > 0;

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
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
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
                  <Tooltip cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }} formatter={(v: number | string) => fmtPct(v as number, true, 2)} contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }} />
                  <Bar dataKey="growth" radius={[0, 4, 4, 0]} maxBarSize={28} onClick={(d: { key?: string }) => d.key && setExpanded(expanded === d.key ? null : d.key)} cursor="pointer">
                    {chartData.map((d, i) => {
                      const mismatch =
                        (d.name === 'Sales' && mismatchSales) ||
                        (d.name === 'BOM' && mismatchBom);
                      const devMismatch =
                        (d.name === 'Nominal Deviasi' && mismatchSales) ||
                        (d.name === 'QTY Deviasi' && mismatchBom);
                      return <Cell key={i} fill={mismatch || devMismatch ? '#dc2626' : d.growth! >= 0 ? '#10b981' : '#f59e0b'} />;
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
                return (
                  <button
                    key={d.key}
                    onClick={() => setExpanded(isExpanded ? null : d.key)}
                    className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-[10px] transition-colors ${
                      isExpanded ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <span className="text-muted-foreground font-medium">{d.name}</span>
                    {top ? (
                      <span className="flex items-center gap-1 min-w-0">
                        <span className={`truncate max-w-[80px] ${top.dir === 'up' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                          {top.name}
                        </span>
                        <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
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
                <Badge variant="destructive" className="text-[10px] h-5 font-medium">
                  Sales vs Deviasi MISMATCH
                </Badge>
              )}
              {mismatchBom && (
                <Badge variant="destructive" className="text-[10px] h-5 font-medium">
                  BOM vs Deviasi MISMATCH
                </Badge>
              )}
              {!mismatchSales && !mismatchBom && (
                <Badge variant="secondary" className="text-[10px] h-5 bg-emerald-100/60 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 font-medium">Growth pattern consistent</Badge>
              )}
            </div>

            {/* Pareto 80% detail — expandable */}
            {expanded && drivers.length > 0 && (() => {
              const md = drivers.find(d => d.metric === expanded);
              if (!md) return null;
              const growthVal = chartData.find(c => c.key === expanded)?.growth;
              return (
                <div className="mt-3 rounded-lg border p-3 space-y-3 bg-muted/20">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold">
                      {md.label} — {growthVal != null ? `${(growthVal * 100).toFixed(1)}%` : '—'}
                    </p>
                    <button onClick={() => setExpanded(null)} className="text-[10px] text-muted-foreground hover:text-foreground">
                      ✕ Tutup
                    </button>
                  </div>

                  {/* Up drivers */}
                  {md.up.drivers.length > 0 && (
                    <div>
                      <p className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 mb-1 flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> Naik — 80% Pareto ({md.up.drivers.length} item)
                      </p>
                      <div className="space-y-1">
                        {md.up.drivers.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px]">
                            <span className="w-4 text-muted-foreground">{i + 1}.</span>
                            <span className="flex-1 truncate" title={d.item}>{d.item}</span>
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
                              <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, d.sharePct)}%` }} />
                            </div>
                            <span className="w-12 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                              +{formatDelta(d.delta)}
                            </span>
                            <span className="w-8 text-right tabular-nums text-muted-foreground">{d.sharePct.toFixed(0)}%</span>
                            <span className="w-10 text-right tabular-nums text-muted-foreground/60">{d.cumPct.toFixed(0)}%</span>
                          </div>
                        ))}
                        {md.up.remainderCount > 0 && (
                          <p className="text-[9px] text-muted-foreground/60 pl-6">
                            Sisa {md.up.remainderPct.toFixed(0)}%: {md.up.remainderCount} item kecil
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Down drivers */}
                  {md.down.drivers.length > 0 && (
                    <div>
                      <p className="text-[10px] font-medium text-red-600 dark:text-red-400 mb-1 flex items-center gap-1">
                        <TrendingDown className="h-3 w-3" /> Turun — 80% Pareto ({md.down.drivers.length} item)
                      </p>
                      <div className="space-y-1">
                        {md.down.drivers.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px]">
                            <span className="w-4 text-muted-foreground">{i + 1}.</span>
                            <span className="flex-1 truncate" title={d.item}>{d.item}</span>
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
                              <div className="h-full bg-red-500" style={{ width: `${Math.min(100, d.sharePct)}%` }} />
                            </div>
                            <span className="w-12 text-right tabular-nums text-red-600 dark:text-red-400 font-medium">
                              {formatDelta(d.delta)}
                            </span>
                            <span className="w-8 text-right tabular-nums text-muted-foreground">{d.sharePct.toFixed(0)}%</span>
                            <span className="w-10 text-right tabular-nums text-muted-foreground/60">{d.cumPct.toFixed(0)}%</span>
                          </div>
                        ))}
                        {md.down.remainderCount > 0 && (
                          <p className="text-[9px] text-muted-foreground/60 pl-6">
                            Sisa {md.down.remainderPct.toFixed(0)}%: {md.down.remainderCount} item kecil
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {md.up.drivers.length === 0 && md.down.drivers.length === 0 && (
                    <p className="text-[10px] text-muted-foreground text-center py-2">Tidak ada perubahan signifikan</p>
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
  const total = b.total || 1;
  const chartData = [
    { name: 'Waste', value: b.waste, pct: (b.waste / total) * 100, color: '#f59e0b', key: 'waste' },
    { name: 'Susut', value: b.susut, pct: (b.susut / total) * 100, color: '#a16207', key: 'susut' },
    { name: 'Trial', value: b.trial, pct: (b.trial / total) * 100, color: '#65a30d', key: 'trial' },
    { name: 'Residual', value: b.residual, pct: (b.residual / total) * 100, color: b.residual / total > 0.5 ? '#dc2626' : '#71717a', key: 'residual' },
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
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
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
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                formatter={(v: number | string, _n: string, p: { payload?: { pct?: number; name?: string } }) => [`${Number(v).toLocaleString()} (${p.payload?.pct?.toFixed(1) ?? '0'}%)`, p.payload?.name ?? '']}
                contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
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
            return (
              <button
                key={d.key}
                onClick={() => setExpanded(isExpanded ? null : d.key)}
                className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-[10px] transition-colors ${
                  isExpanded ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : 'border-border hover:bg-muted/50'
                }`}
              >
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
                  <span className="text-muted-foreground font-medium">{d.name}</span>
                </span>
                {top ? (
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="truncate max-w-[80px] text-foreground/80">{top.name}</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
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
            <Badge variant="destructive" className="text-[10px] h-5 font-medium">
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
          return (
            <div className="mt-3 rounded-lg border p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: catColor }} />
                  {cd.label} — {catRow ? formatQty(catRow.value) : '—'}
                  <span className="text-muted-foreground font-normal">
                    ({catRow ? catRow.pct.toFixed(1) : '0'}% dari total)
                  </span>
                </p>
                <button onClick={() => setExpanded(null)} className="text-[10px] text-muted-foreground hover:text-foreground">
                  ✕ Tutup
                </button>
              </div>

              {cd.drivers.length === 0 ? (
                <p className="text-[10px] text-muted-foreground text-center py-2">Tidak ada data untuk kategori ini</p>
              ) : (
                <>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                    80% Pareto ({cd.drivers.length} item)
                  </p>
                  <div className="space-y-1">
                    {cd.drivers.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px]">
                        <span className="w-4 text-muted-foreground">{i + 1}.</span>
                        <span className="flex-1 truncate" title={d.item}>{d.item}</span>
                        <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
                          <div className="h-full" style={{ width: `${Math.min(100, d.sharePct)}%`, background: catColor }} />
                        </div>
                        <span className="w-14 text-right tabular-nums font-medium" title={formatRp(d.nominal)}>
                          {formatQty(d.qty)}
                        </span>
                        <span className="w-10 text-right tabular-nums text-muted-foreground">{d.sharePct.toFixed(0)}%</span>
                        <span className="w-10 text-right tabular-nums text-muted-foreground/60">{d.cumPct.toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                  {cd.remainderCount > 0 && (
                    <p className="text-[9px] text-muted-foreground/60 pl-6">
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
    { name: 'LOSS', records: l.loss, nominal: l.lossNominal, color: '#dc2626' },
    { name: 'SURPLUS', records: l.surplus, nominal: l.surplusNominal, color: '#10b981' },
  ];

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
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
              <Tooltip cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }} formatter={(v: number | string) => Number(v).toLocaleString()} contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="records" name="Jumlah Record" radius={[4, 4, 0, 0]} maxBarSize={56}>
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border bg-red-50/40 dark:bg-red-950/20 px-2 py-1">
            <span className="text-muted-foreground">LOSS nominal:</span>{' '}
            <span className="font-semibold text-red-600 dark:text-red-400 tabular-nums">Rp {(l.lossNominal / 1_000_000).toFixed(2)}Jt</span>
          </div>
          <div className="rounded-md border bg-emerald-50/40 dark:bg-emerald-950/20 px-2 py-1">
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
      <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
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
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
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
                contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="devBom" name="Dev/BOM" stroke="#dc2626" strokeWidth={2.5} dot={{ r: 3, fill: '#dc2626' }} activeDot={{ r: 5 }} />
              <Line yAxisId="right" type="monotone" dataKey="nominal" name="Nominal Deviasi" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 3, fill: '#f59e0b' }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
