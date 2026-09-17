'use client';

// PERF (AUDIT-FE): animations disabled — charts re-mount on tab re-entry (Radix unmounts inactive tabs)
//
// UX-PRICE-1 (user request 2025-12): "Harga (AVG)" metric added — the
// national weighted-average implied-price change from the shared
// usePriceEffect hook (same queryKey as PriceEffectCard → ONE request).
// Clicking the bar / badge drills down to the items whose price went UP
// (then down), instead of a Pareto 80% driver list.
//
// UX-TOOLTIP-1: the card header now has exactly ONE info icon — the
// former InfoTooltip + FormulaInfo pair merged into a single simple
// "ini buat apa" tooltip.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtNum, fmtPct, fmtIDR } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { getTooltipStyle } from '@/lib/chart-constants';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, Tags } from 'lucide-react';
import { useState, useMemo, memo } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { clickableRowProps } from '@/lib/a11y';
import { usePriceEffect, type PriceEffectItem } from '@/hooks/usePriceEffect';

/** Color for a price-growth value: up = amber (price pressure), down = emerald. */
function priceGrowthCls(v: number): string {
  return v > 0 ? 'text-amber-600 dark:text-amber-500' : v < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
}

export const GrowthComparison = memo(function GrowthComparison({ data }: { data: AnalysisData }) {
  const g = data.growthComparison;
  const drivers = data.growthDrivers || [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);

  // UX-PRICE-1: shared /api/price-effect fetch — same key as PriceEffectCard
  // (TanStack dedupes), gives the AVG price change + the per-item list for
  // the "which items' prices went up" drill-down.
  const { data: priceData } = usePriceEffect();
  const priceSummary = priceData?.summary != null && priceData.summary.hasCompare ? priceData.summary : null;
  // P3-HYG-7a: pin list identity for the memos below.
  const priceItems = useMemo(() => priceData?.items ?? [], [priceData?.items]);

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

  // §22 AVG PRICE change arrives in PERCENT units (12.5 = +12.5%) — the chart
  // plots ratios like every other growth metric, so /100.
  const priceGrowthRatio = priceSummary?.avgPriceChangePct != null
    ? priceSummary.avgPriceChangePct / 100
    : null;

  const chartData = [
    { name: 'Sales', growth: g.salesGrowth, key: 'sales' },
    { name: 'BOM', growth: g.bomGrowth, key: 'bom' },
    { name: 'QTY Deviasi', growth: g.qtyDeviasiGrowth, key: 'qtyDeviasi' },
    { name: 'Nominal Deviasi', growth: g.nominalDeviasiGrowth, key: 'nominalDeviasi' },
    { name: 'Harga (AVG)', growth: priceGrowthRatio, key: 'price' },
  ].filter((d) => d.growth != null);

  // Items whose implied price went UP / DOWN — the price drill-down lists
  // (top movers by |priceEffect| among the API's top-20-by-|netDelta| items).
  const { priceUp, priceDown, priceUpMax } = useMemo(() => {
    const up = priceItems
      .filter((m) => (m.priceGrowth ?? 0) > 0)
      .sort((a, b) => Math.abs(b.priceEffect) - Math.abs(a.priceEffect));
    const down = priceItems
      .filter((m) => (m.priceGrowth ?? 0) < 0)
      // FIX (BUG-2-a #1): sort DESC by |priceEffect|, mirroring `up` above —
      // was ASC (a − b), so the panel's slice(0, 5) listed the SMALLEST
      // movers and the biggest price-drop items never appeared (the
      // getTopDriver('price') fallback via priceDown[0] also picked the
      // smallest). After the flip, slice(0, 5) + priceDown[0] are correct.
      .sort((a, b) => Math.abs(b.priceEffect) - Math.abs(a.priceEffect));
    const max = up.reduce((mx, m) => Math.max(mx, Math.abs(m.priceEffect)), 0);
    return { priceUp: up, priceDown: down, priceUpMax: max };
  }, [priceItems]);

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
    // UX-PRICE-1: the price metric has no growthDrivers entry — its "top
    // driver" is the item with the biggest |price effect| among price-UP items
    // (falls back to the top price-DOWN item when nothing went up).
    if (metricKey === 'price') {
      const up = priceUp[0];
      if (up && up.priceGrowth != null) return { name: up.item, share: up.priceGrowth * 100, dir: 'up' as const };
      const dn = priceDown[0];
      if (dn && dn.priceGrowth != null) return { name: dn.item, share: dn.priceGrowth * 100, dir: 'down' as const };
      return null;
    }
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

  const toggle = (key: string) => setExpanded((prev) => (prev === key ? null : key));

  const renderPriceRow = (m: PriceEffectItem, i: number, barMax: number) => (
    <div
      key={m.item}
      className="flex items-center gap-2 text-xs cursor-pointer rounded-md -mx-1 px-1 py-0.5 transition-colors hover:bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      title={`${m.item} · harga implisit ${m.pricePrev != null ? fmtIDR(m.pricePrev) : '—'} → ${m.priceCurr != null ? fmtIDR(m.priceCurr) : '—'}${m.priceSharePct != null ? ` · ${fmtPct(m.priceSharePct / 100, false, 0)} dari efek item ini adalah harga` : ''}`}
      {...clickableRowProps(() => setDeepDiveItem({ itemName: m.item, outletCode: null }))}
    >
      <span className="w-4 text-muted-foreground">{i + 1}.</span>
      <span className="flex-1 min-w-0 break-words leading-tight" title={m.item}>{m.item}</span>
      <div className="w-16 h-2 rounded-full bg-muted overflow-hidden shrink-0" aria-hidden>
        <div className="h-full bg-amber-500" style={{ width: `${barMax > 0 ? Math.min(100, (Math.abs(m.priceEffect) / barMax) * 100) : 0}%` }} />
      </div>
      <span className={`w-12 text-right tabular-nums font-medium shrink-0 ${priceGrowthCls(m.priceGrowth ?? 0)}`}>
        {m.priceGrowth != null ? fmtPct(m.priceGrowth, true, 1) : '—'}
      </span>
      <span className={`w-24 text-right tabular-nums shrink-0 ${m.priceEffect > 0 ? 'text-red-600 dark:text-red-400' : m.priceEffect < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
        {fmtIDR(m.priceEffect)}
      </span>
    </div>
  );

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Growth Comparison
          {/* UX-TOOLTIP-1: ONE tooltip, simple "ini buat apa" language.
              NOTE: expression form {'...'} — JSX attribute strings do not
              process \n escapes (JSXText), the expression form does. */}
          <FormulaInfo
            formula="Growth = (Current − Previous) / |Previous| · Harga implisit = |Nominal Deviasi| / |QTY Deviasi|"
            description={'UNTUK APA: melihat seberapa cepat Sales, BOM, dan deviasi berubah dibanding periode pembanding — termasuk pergerakan harga rata-rata (Harga AVG). Naik pada Sales/BOM = pertumbuhan bisnis; naik pada deviasi atau harga = masalah membengkak.\nCARA BACA: klik metric untuk detail — Sales/BOM/Deviasi menampilkan Pareto 80% (penyebab terbesar), Harga menampilkan item yang harganya naik.\nCONTOH: Sales: (5.98B − 3.88B) / 3.88B = +54%'}
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'SALES_DEVIATION_FACTOR', label: 'Faktor Sales vs Deviasi', dataType: 'number', min: 1, max: 10, step: 0.5 },
              { key: 'BOM_DEVIATION_FACTOR', label: 'Faktor BOM vs Deviasi', dataType: 'number', min: 1, max: 10, step: 0.5 },
            ]}
          />
        </CardTitle>
        {/* SPEC-1 (§21): question-first subtitle (anti-pattern #12). */}
        <p className="text-xs text-muted-foreground ml-9"><span className="font-medium text-foreground/70">Seberapa cepat masalah berubah?</span> — pertumbuhan |Dev/BOM| vs periode pembanding</p>
        <p className="text-xs text-muted-foreground ml-9 tabular-nums">
          Current vs {data.period.comparisonWeek
            ? `${data.period.comparisonWeek}${data.period.comparisonMonth && data.period.comparisonMonth !== data.period.monthLabel ? ` ${data.period.comparisonMonth}` : ''}`
            : 'previous'} period — klik metric untuk detail
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
                  <Bar dataKey="growth" radius={[0, 4, 4, 0]} maxBarSize={28} isAnimationActive={false} onClick={(d: { key?: string }) => d.key && toggle(d.key)} cursor="pointer">
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
                      // alarm (unchanged). UX-PRICE-1: price UP is likewise
                      // pressure (amber), never good news.
                      const badWhenUp = d.key === 'qtyDeviasi' || d.key === 'nominalDeviasi' || d.key === 'price';
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
                    onClick={() => toggle(d.key)}
                    aria-expanded={isExpanded}
                    aria-controls={panelId}
                    className={`flex items-center justify-between gap-2 rounded-md border px-2 py-2 min-h-[36px] text-xs transition-colors ${
                      isExpanded ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <span className="text-muted-foreground font-medium">{d.name}</span>
                    {top ? (
                      <span className="flex items-center gap-1 min-w-0">
                        {/* P23 A4: metric-aware driver direction. nominalDeviasi
                            drivers are SUM(|nominalDeviasi|) MAGNITUDES (drivers.ts) —
                            "Naik" = memburuk → red, mirroring the B8 bar cells'
                            badWhenUp for the same metric. qtyDeviasi drivers are
                            SIGNED sums (Naik = toward-surplus) → emerald stays
                            (two semantics documented at the panel below). */}
                        <span className={`truncate max-w-[140px] ${
                          d.key === 'price'
                            ? top.dir === 'up' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                            : d.key === 'nominalDeviasi'
                              ? top.dir === 'up' ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                              : top.dir === 'up' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
                        }`} title={top.name}>
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

            {/* UX-PRICE-1: drill-down for the Harga (AVG) metric — WHICH ITEMS'
                prices went up (then down), from the shared price-effect data. */}
            {expanded === 'price' && (
              <div id="growth-pareto-price" role="region" aria-label="Detail item dengan perubahan harga" className="mt-3 rounded-lg border p-3 space-y-3 bg-muted/20">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold flex items-center gap-1.5">
                    <Tags className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    Harga (AVG) — {priceGrowthRatio != null ? fmtPct(priceGrowthRatio, true, 1) : '—'}
                  </p>
                  <button onClick={() => setExpanded(null)} aria-label="Tutup panel harga" className="text-xs text-muted-foreground hover:text-foreground">
                    ✕ Tutup
                  </button>
                </div>

                {priceSummary == null ? (
                  <p className="text-xs text-muted-foreground text-center py-2">Data harga belum tersedia.</p>
                ) : (
                  <>
                    {/* Harga NAIK — the headline answer */}
                    <div>
                      <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1 flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> Harga naik — {priceUp.length} item
                      </p>
                      <div className="space-y-1">
                        {priceUp.length > 0 ? priceUp.map((m, i) => renderPriceRow(m, i, priceUpMax)) : (
                          <p className="text-xs text-muted-foreground/70 pl-6">Tidak ada item dengan harga naik.</p>
                        )}
                        {priceSummary.itemsPriceUp > priceUp.length && (
                          <p className="text-[11px] text-muted-foreground/60 pl-6">
                            Menampilkan {priceUp.length} dari {priceSummary.itemsPriceUp} item naik — yang berdampak finansial terbesar.
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Harga TURUN */}
                    {priceDown.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 mb-1 flex items-center gap-1">
                          <TrendingDown className="h-3 w-3" /> Harga turun — {priceDown.length} item
                        </p>
                        <div className="space-y-1">
                          {priceDown.slice(0, 5).map((m, i) => renderPriceRow(m, i, Math.max(...priceDown.map((x) => Math.abs(x.priceEffect)), 1)))}
                          {priceDown.length > 5 && (
                            <p className="text-[11px] text-muted-foreground/60 pl-6">
                              Sisa {priceDown.length - 5} item turun tidak ditampilkan.
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                      Harga implisit per item = |Nominal Deviasi| / |QTY Deviasi| (nasional, dirata-ratakan). Kenaikan harga ≠ pemborosan — pisahkan efek harga sebelum menyimpulkan masalah operasional. Klik baris untuk detail item.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* Pareto 80% detail — expandable */}
            {expanded && expanded !== 'price' && drivers.length > 0 && (() => {
              const md = drivers.find(d => d.metric === expanded);
              if (!md) return null;
              const growthVal = chartData.find(c => c.key === expanded)?.growth;
              const panelId = `growth-pareto-${expanded}`;
              // P23 A4: metric-aware panel semantics. The nominalDeviasi
              // drivers are SUM(|nominalDeviasi|) magnitudes — Naik =
              // memburuk (red), Turun = improving (emerald), consistent with
              // the bar cells above (B8 badWhenUp). qtyDeviasi drivers use
              // SIGNED sums (Naik = toward-surplus) — emerald defensible and
              // kept: two documented semantics, signed vs magnitude.
              const badWhenUp = expanded === 'nominalDeviasi';
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
                      <p className={`text-xs font-medium mb-1 flex items-center gap-1 ${badWhenUp ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        <TrendingUp className="h-3 w-3" /> Naik — 80% Pareto ({md.up.drivers.length} item)
                      </p>
                      <div className="space-y-1">
                        {md.up.drivers.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-4 text-muted-foreground">{i + 1}.</span>
                            <span className="flex-1 min-w-0 break-words leading-tight" title={d.item}>{d.item}</span>
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden shrink-0">
                              <div className={`h-full ${badWhenUp ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, d.sharePct)}%` }} />
                            </div>
                            <span className={`w-14 text-right tabular-nums font-medium shrink-0 ${badWhenUp ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
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
                      <p className={`text-xs font-medium mb-1 flex items-center gap-1 ${badWhenUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        <TrendingDown className="h-3 w-3" /> Turun — 80% Pareto ({md.down.drivers.length} item)
                      </p>
                      <div className="space-y-1">
                        {md.down.drivers.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-4 text-muted-foreground">{i + 1}.</span>
                            <span className="flex-1 min-w-0 break-words leading-tight" title={d.item}>{d.item}</span>
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden shrink-0">
                              <div className={`h-full ${badWhenUp ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${Math.min(100, d.sharePct)}%` }} />
                            </div>
                            <span className={`w-14 text-right tabular-nums font-medium shrink-0 ${badWhenUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
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
