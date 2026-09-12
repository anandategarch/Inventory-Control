'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtNum, fmtPct } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useState, memo } from 'react';

export const GrowthComparison = memo(function GrowthComparison({ data }: { data: AnalysisData }) {
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

  // VH-3: delegates to lib/format fmtNum (Indonesian suffixes + comma
  // decimals — normalizes the old dot-decimal local copy, closing the
  // H-14-a mixed-decimal finding in this file).
  const formatDelta = (v: number) => fmtNum(v);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Growth Comparison
          <InfoTooltip content="Perbandingan pertumbuhan |Dev/BOM| vs periode sebelumnya. Naik = memburuk (deviasi makin besar). Turun = membaik." />
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
              {/* FIX (BUG-HUNT C15/BUG-3-11): EN copy in an otherwise Indonesian card. */}
              Belum ada data periode sebelumnya. Unggah beberapa minggu untuk mengaktifkan analisis pertumbuhan.
            </p>
          </div>
        ) : (
          <>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" className="opacity-60" />
                  <XAxis type="number" tickFormatter={(v) => fmtPct(v, true, 0)} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" width={90} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4, stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }} formatter={(v: number | string) => fmtPct(v as number, true, 2)} contentStyle={getTooltipStyle()} />
                  {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance animation
                      replays on every Radix tab re-entry (tab content unmounts) and on every
                      period-change refetch; the double-fetch fix removed the second replay. */}
                  <Bar dataKey="growth" radius={[0, 4, 4, 0]} maxBarSize={28} isAnimationActive={false} onClick={(d: { key?: string }) => d.key && setExpanded(expanded === d.key ? null : d.key)} cursor="pointer">
                    {chartData.map((d, i) => {
                      const mismatch =
                        (d.name === 'Sales' && mismatchSales) ||
                        (d.name === 'BOM' && mismatchBom);
                      const devMismatch =
                        (d.name === 'Nominal Deviasi' && mismatchSales) ||
                        (d.name === 'QTY Deviasi' && mismatchBom);
                      // FIX (BUG-HUNT B8/BUG-3-04): for the deviasi metrics
                      // growth UP is BAD (the card's own tooltip says "Naik =
                      // memburuk"), so positive bars must not render emerald.
                      // Semantics now: emerald = movement in the good direction,
                      // amber = movement in the bad direction, red = mismatch
                      // alarm (unchanged).
                      const badWhenUp = d.key === 'qtyDeviasi' || d.key === 'nominalDeviasi';
                      // Rows are pre-filtered to growth != null above; the ?? 0
                      // only satisfies TS without stacking non-null assertions.
                      const g = d.growth ?? 0;
                      const good = badWhenUp ? g < 0 : g >= 0;
                      return <Cell key={i} fill={mismatch || devMismatch ? 'var(--chart-loss)' : good ? 'var(--chart-surplus)' : 'var(--chart-waste)'} />;
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
                        <Badge variant="outline" className="text-[11px] h-4 px-1 shrink-0 tabular-nums">
                          {fmtPct(top.share / 100, false, 0)}
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
                      {md.label} — {growthVal != null ? fmtPct(growthVal, true, 1) : '—'}
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
                            <span className="w-14 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-medium shrink-0">
                              +{formatDelta(d.delta)}
                            </span>
                            <span className="w-9 text-right tabular-nums text-muted-foreground">{fmtPct(d.sharePct / 100, false, 0)}</span>
                            <span className="w-10 text-right tabular-nums text-muted-foreground/60">{fmtPct(d.cumPct / 100, false, 0)}</span>
                          </div>
                        ))}
                        {md.up.remainderCount > 0 && (
                          <p className="text-[11px] text-muted-foreground/60 pl-6">
                            Sisa {fmtPct(md.up.remainderPct / 100, false, 0)}: {md.up.remainderCount} item kecil
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
                            <span className="w-14 text-right tabular-nums text-red-600 dark:text-red-400 font-medium shrink-0">
                              {formatDelta(d.delta)}
                            </span>
                            <span className="w-9 text-right tabular-nums text-muted-foreground">{fmtPct(d.sharePct / 100, false, 0)}</span>
                            <span className="w-10 text-right tabular-nums text-muted-foreground/60">{fmtPct(d.cumPct / 100, false, 0)}</span>
                          </div>
                        ))}
                        {md.down.remainderCount > 0 && (
                          <p className="text-[11px] text-muted-foreground/60 pl-6">
                            Sisa {fmtPct(md.down.remainderPct / 100, false, 0)}: {md.down.remainderCount} item kecil
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
});
