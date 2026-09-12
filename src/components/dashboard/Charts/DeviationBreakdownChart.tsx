'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { fmtHeatmapCompact, fmtIDR, fmtNum, fmtPct, formatByPreset } from '@/lib/format';
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
    // FIX (BUG-HUNT B7/BUG-3-03): FIX #23 established --chart-susut (#0891b2 cyan)
    // and --chart-trial (#ca8a04 amber-600) as the official tokens, but zero
    // components consumed them — this chart still hardcoded the pre-FIX-#23
    // violet #7c3aed / lime #65a30d. Swap to the tokens (§5.4: chart colors
    // come from --chart-* vars only).
    { name: 'Susut', value: b.susut, pct: (b.susut / total) * 100, color: 'var(--chart-susut)', key: 'susut' },
    { name: 'Trial', value: b.trial, pct: (b.trial / total) * 100, color: 'var(--chart-trial)', key: 'trial' },
    { name: 'Residual', value: b.residual, pct: (b.residual / total) * 100, color: b.residual / total > 0.5 ? 'var(--chart-loss)' : 'var(--chart-residual)', key: 'residual' },
  ];

  // VH-3: local formatters delegate to lib/format (Indonesian suffixes +
  // comma decimals — replaces the old dot-decimal "K" copies, closing the
  // H-14-a mixed-decimal finding in this file).
  const formatQty = (v: number) => fmtNum(v, '');
  const formatRp = (v: number) => fmtIDR(v);

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
              <YAxis tickFormatter={(v) => (v === 0 ? '0' : fmtHeatmapCompact(v))} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4, stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
                formatter={(v: number | string, _n: string, p: { payload?: { pct?: number; name?: string } }) => [`${formatByPreset(Number(v), 'num0')} (${p.payload?.pct != null ? fmtPct(p.payload.pct / 100, false, 1) : '0%'})`, p.payload?.name ?? '']}
                contentStyle={getTooltipStyle()}
              />
              {/* PERF (AUDIT-FE): isAnimationActive={false} — ~1.5s entrance animation
                  replays on every Radix tab re-entry (tab content unmounts) and on every
                  period-change refetch; the double-fetch fix removed the second replay. */}
              <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} onClick={(d: { key?: string }) => d.key && setExpanded(expanded === d.key ? null : d.key)} cursor="pointer">
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

        {/* Residual warning badge */}
        {b.residual / total > 0.5 && (
          <div className="mt-2">
            <Badge variant="destructive" className="text-xs h-5 font-medium">
              Residual {fmtPct(b.residual / total, false, 0)} — sebagian besar deviation tidak terjelaskan
            </Badge>
          </div>
        )}

        {/* Pareto 80% detail — expandable */}
        {expanded && drivers.length > 0 && (() => {
          const cd = drivers.find(d => d.category === expanded);
          if (!cd) return null;
          const catRow = chartData.find(c => c.key === expanded);
          const catColor = catRow?.color || 'var(--chart-residual)';
          const panelId = `devbreak-pareto-${expanded}`;
          return (
            <div id={panelId} role="region" aria-label={`${cd.label} Pareto 80% detail`} className="mt-3 rounded-lg border p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: catColor }} />
                  {cd.label} — {catRow ? formatQty(catRow.value) : '—'}
                  <span className="text-muted-foreground font-normal tabular-nums">
                    ({catRow ? fmtPct(catRow.pct / 100, false, 1) : '0'} dari total)
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
                        <span className="w-10 text-right tabular-nums text-muted-foreground">{fmtPct(d.sharePct / 100, false, 0)}</span>
                        <span className="w-10 text-right tabular-nums text-muted-foreground/60">{fmtPct(d.cumPct / 100, false, 0)}</span>
                      </div>
                    ))}
                  </div>
                  {cd.remainderCount > 0 && (
                    <p className="text-[11px] text-muted-foreground/60 pl-6">
                      Sisa {fmtPct(cd.remainderPct / 100, false, 0)}: {cd.remainderCount} item kecil
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
