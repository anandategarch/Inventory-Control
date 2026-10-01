'use client';

// ============================================================
//  LossDecompositionCard — "Dekomomposisi Loss" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Stacked bars per outlet (top by total loss): how much of the
//  loss is EXPLAINED (waste + susut + trial) vs UNEXPLAINED
//  (residual) — the in-app version of the offline report's
//  "Dekomposisi Loss" sheet + stacked chart. Answers: "berapa
//  besar loss yang benar-benar terjelaskan peluruhan vs
//  selisih tak terjelaskan?"
//  Recharts + COLORS from chart-constants (same conventions as the
//  Charts/ family; animations disabled — tab re-mounts).
//
//  W10 (Atribusi + Skenario Sensitivitas Residual) — ADDITIVE
//  collapsible subsection under the chart: "berapa % loss yang
//  terjelaskan, dan seberapa ROBUST kesimpulan saya terhadap asumsi
//  bahwa residual bukan waste tak-tercatat?" Data source: the
//  attribution block is recomputed LOCALLY from the card's existing
//  `monthly` prop by the SAME pure builder the server uses
//  (buildWasteAttribution — deep import of the PURE module; its only
//  imports are type-only, so no Prisma reaches the client bundle).
//  Identical monthly rows + identical pure function ⇒ identical
//  numbers to the API's `attribution` block — zero extra requests,
//  zero wiring debt in WasteTab/index.tsx. Interaction style follows
//  the card's own ghost-button toggle (showAll) — default collapsed.
// ============================================================

import { memo, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BarChart3, Scale } from 'lucide-react';
import { fmtIDR, fmtHeatmapCompact, fmtPct } from '@/lib/format';
import { COLORS } from '@/lib/chart-constants';
import { getTooltipStyle } from '@/lib/chart-constants';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
// W10 — PURE server module (type-only imports inside): recomputes the
// attribution block client-side from the same monthly rows.
import { buildWasteAttribution } from '@/lib/queries/waste/network/attribution';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import type { WasteMonthlyRow } from './types';

const INITIAL_OUTLETS = 10;

// W10 — section-local colors (CSS, dark-mode aware). Segment colors follow
// the chart-constants semantic palette (waste amber / susut violet / trial
// lime / residual zinc) so the subsection reads as part of the same card.
const SEGMENT_CLS: Record<string, string> = {
  waste: 'bg-amber-500 dark:bg-amber-400',
  susut: 'bg-violet-600 dark:bg-violet-400',
  trial: 'bg-lime-600 dark:bg-lime-500',
  residual: 'bg-zinc-400 dark:bg-zinc-500',
};

export const LossDecompositionCard = memo(function LossDecompositionCard({
  monthly,
}: {
  monthly: WasteMonthlyRow[];
}) {
  const [showAll, setShowAll] = useState(false);
  // W10 — default COLLAPSED (the chart above is the primary view; the
  // scenario subsection is the analyst drill-down). Same ghost-toggle
  // interaction as showAll above.
  const [showAttribution, setShowAttribution] = useState(false);

  const { chartData, totalOutlets } = useMemo(() => {
    const byOutlet = new Map<string, { waste: number; susut: number; trial: number; residual: number; totalLoss: number }>();
    for (const r of monthly) {
      const agg = byOutlet.get(r.outletCode) ?? { waste: 0, susut: 0, trial: 0, residual: 0, totalLoss: 0 };
      agg.waste += r.waste;
      agg.susut += r.susut;
      agg.trial += r.trial;
      agg.residual += r.residual;
      agg.totalLoss += r.totalLoss;
      byOutlet.set(r.outletCode, agg);
    }
    const sorted = [...byOutlet.entries()]
      .map(([code, v]) => ({ name: code, ...v }))
      .sort((a, b) => b.totalLoss - a.totalLoss);
    const sliced = showAll ? sorted : sorted.slice(0, INITIAL_OUTLETS);
    // FIX (BUGHUNT-R2): expose sorted.length — the expand button below must
    // show the TOTAL outlet count, not the sliced list's (was "Tampilkan
    // semua outlet (10)" with 343 outlets), and must hide when there is
    // nothing to expand (sibling cards gate on fullLength > INITIAL_ROWS).
    // FIX (UIUX-C T1): the totalExplained/totalResidual window aggregates are
    // REMOVED — the subtitle below now reads attribution.explainedShare
    // (denominator totalLoss, the SAME value as the W10 meter); the old
    // W+S+T÷(W+S+T+residual) share was a second "loss terjelaskan" number
    // in this card (33,0% vs 49,3% live — "two truths").
    return { chartData: sliced, totalOutlets: sorted.length };
  }, [monthly, showAll]);

  // ------------------------------------------------------------
  // W10 — Skenario Atribusi Residual: rebuild the network attribution
  // block from the SAME monthly rows (window aggregates per outlet +
  // the 6 KPI sums — exactly what buildWasteKpis/buildWasteOutlets
  // aggregate server-side), then run the SHARED pure builder. Pure
  // useMemo — no fetch, memoized on monthly like the chart above.
  // ------------------------------------------------------------
  const attribution = useMemo(() => {
    const perOutlet = new Map<string, { sales: number; waste: number; residual: number }>();
    let sales = 0;
    let waste = 0;
    let susut = 0;
    let trial = 0;
    let residual = 0;
    let totalLoss = 0;
    for (const r of monthly) {
      sales += r.sales;
      waste += r.waste;
      susut += r.susut;
      trial += r.trial;
      residual += r.residual;
      totalLoss += r.totalLoss;
      const agg = perOutlet.get(r.outletCode) ?? { sales: 0, waste: 0, residual: 0 };
      agg.sales += r.sales;
      agg.waste += r.waste;
      agg.residual += r.residual;
      perOutlet.set(r.outletCode, agg);
    }
    return buildWasteAttribution(
      { waste, susut, trial, residual, totalLoss, sales },
      [...perOutlet.entries()].map(([outletCode, v]) => ({ outletCode, ...v })),
    );
  }, [monthly]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Dekomposisi Loss — Terjelaskan vs Residual
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Loss yang terjelaskan peluruhan (waste + susut + trial) vs residual (tak terjelaskan) per outlet —
          {showAll ? ` semua ${chartData.length} outlet` : ` ${Math.min(INITIAL_OUTLETS, chartData.length)} outlet dengan loss terbesar`}.
          {/* FIX (UIUX-C T1): subtitle pakai explainedShare (denominator totalLoss) — konsisten meter W10. */}
          Window: {fmtPctId(attribution.explainedShare)} loss terjelaskan.
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada loss pada scope ini.</div>
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" className="opacity-60" />
                  <XAxis dataKey="name" fontSize={10} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} interval={0} angle={-35} textAnchor="end" height={52} />
                  <YAxis tickFormatter={(v) => (v === 0 ? '0' : fmtHeatmapCompact(v))} fontSize={11} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} width={54} />
                  <Tooltip
                    cursor={{ fill: 'var(--muted)', opacity: 0.4, stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    formatter={(v: number | string, name: string) => [fmtIDR(Number(v)), name]}
                    contentStyle={getTooltipStyle()}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="waste" name="Waste" stackId="loss" fill={COLORS.waste} maxBarSize={44} isAnimationActive={false} />
                  <Bar dataKey="susut" name="Susut" stackId="loss" fill={COLORS.susut} maxBarSize={44} isAnimationActive={false} />
                  <Bar dataKey="trial" name="Trial" stackId="loss" fill={COLORS.trial} maxBarSize={44} isAnimationActive={false} />
                  <Bar dataKey="residual" name="Residual" stackId="loss" fill={COLORS.residual} maxBarSize={44} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* FIX (BUGHUNT-R2): gate on the FULL sorted length (was
                monthly.length > 0 — rendered a no-op toggle when ≤ 10 outlets)
                and label with totalOutlets instead of the sliced list's
                chartData.length. */}
            {totalOutlets > INITIAL_OUTLETS && (
              <div className="mt-2 flex justify-center">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? 'Tampilkan top outlet saja' : `Tampilkan semua outlet (${totalOutlets})`}
                </Button>
              </div>
            )}

            {/* ====== W10 — Skenario Atribusi Residual (default collapsed;
                    ghost-toggle = the card's own interaction style). Hidden
                    when the scope has no loss — nothing to attribute. ====== */}
            {attribution.totalLoss > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => setShowAttribution((v) => !v)}
                    aria-expanded={showAttribution}
                    aria-controls="waste-attribution-section"
                  >
                    <Scale className="h-3.5 w-3.5" />
                    Skenario Atribusi Residual
                  </Button>
                  {/* Epistemic guard (spec W10): the scenarios are HYPOTHESES,
                      not measurements — badge kept visible even collapsed. */}
                  <span
                    title="Skenario p mengasumsikan p × residual adalah waste tak tercatat — angka hasil asumsi, bukan pengukuran."
                    className="inline-flex items-center rounded-full bg-amber-100/80 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                  >
                    HIPOTESIS
                  </span>
                </div>

                {showAttribution && (
                  <div id="waste-attribution-section" className="mt-3 space-y-3">
                    {/* ---- Komposisi loss (TERUKUR): explainedShare bar.
                         Two meters share the 0–100% axis = % of total loss.
                         They deliberately do NOT stack: W/S/T explain the
                         GROSS deviation while the residual IS the NET loss
                         (see the disclosure footer) — fusing them into one
                         bar would imply shares that sum to 100%. ---- */}
                    <div>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-medium text-foreground">Loss terjelaskan W/S/T</span>
                        <span className="tabular-nums text-muted-foreground">
                          {fmtPct(attribution.explainedShare, false, 1)} · {fmtIDR(attribution.explainedNominal)}
                        </span>
                      </div>
                      {/* Segments = each component's share of loss; they sum to
                          explainedShare exactly (0–100% axis). */}
                      <div
                        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
                        role="img"
                        aria-label={`Loss terjelaskan W/S/T ${fmtPct(attribution.explainedShare, false, 1)} dari total loss: Waste ${fmtPct(attribution.components[0]?.shareOfLoss ?? 0, false, 1)}, Susut ${fmtPct(attribution.components[1]?.shareOfLoss ?? 0, false, 1)}, Trial ${fmtPct(attribution.components[2]?.shareOfLoss ?? 0, false, 1)}`}
                      >
                        {attribution.components.map((c) => (
                          <div
                            key={c.key}
                            className={SEGMENT_CLS[c.key]}
                            style={{ width: `${Math.max(0, Math.min(1, c.shareOfLoss)) * 100}%` }}
                            title={`${c.label} ${fmtPct(c.shareOfLoss, false, 1)} dari total loss · ${fmtIDR(c.nominal)} (TERUKUR)`}
                          />
                        ))}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Waste {fmtPct(attribution.components[0]?.shareOfLoss ?? 0, false, 1)} · Susut {fmtPct(attribution.components[1]?.shareOfLoss ?? 0, false, 1)} · Trial {fmtPct(attribution.components[2]?.shareOfLoss ?? 0, false, 1)} (dari total loss, TERUKUR)
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-medium text-foreground">Residual (= NET loss, secara konstruksi)</span>
                        <span className="tabular-nums text-muted-foreground">
                          {fmtPct(attribution.residualShare, false, 1)} · {fmtIDR(attribution.residual)}
                        </span>
                      </div>
                      <div
                        className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
                        role="img"
                        aria-label={`Residual ${fmtPct(attribution.residualShare, false, 1)} dari total loss — identik dengan NET loss secara konstruksi`}
                      >
                        <div
                          className={SEGMENT_CLS.residual}
                          style={{ width: `${Math.max(0, Math.min(1, attribution.residualShare)) * 100}%` }}
                          title={`Residual ${fmtPct(attribution.residualShare, false, 1)} dari total loss (TERUKUR)`}
                        />
                      </div>
                    </div>

                    {/* ---- Tabel skenario p (HIPOTESIS) ---- */}
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] text-xs">
                        <caption className="sr-only">
                          Tabel skenario atribusi residual (HIPOTESIS): true waste, waste/sales implisit, share of loss implisit, dan jumlah outlet yang berganti decile bila p × residual dihitung sebagai waste tak tercatat.
                        </caption>
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th scope="col" className="py-1.5 pr-2 font-medium">Asumsi p (residual = waste tak tercatat)</th>
                            <th scope="col" className="py-1.5 pr-2 text-right font-medium">True waste</th>
                            <th scope="col" className="py-1.5 pr-2 text-right font-medium">Waste/sales implisit</th>
                            <th scope="col" className="py-1.5 pr-2 text-right font-medium">Share of loss implisit</th>
                            <th scope="col" className="py-1.5 text-right font-medium">Pindah decile</th>
                          </tr>
                        </thead>
                        <tbody className="tabular-nums">
                          {attribution.scenarios.map((s) => (
                            <tr key={s.p} className="border-b border-border/60 last:border-0">
                              <td className="py-1.5 pr-2">
                                <span className="font-semibold">{fmtPct(s.p, false, 0)}</span>
                                {s.p === attribution.decile.p && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">sensitivitas</span>}
                              </td>
                              <td className="py-1.5 pr-2 text-right">{fmtIDR(s.trueWaste)}</td>
                              <td className="py-1.5 pr-2 text-right">{fmtPct(s.impliedWasteToSales, false, 2)}</td>
                              <td className="py-1.5 pr-2 text-right">{fmtPct(s.impliedWasteShareOfLoss, false, 1)}</td>
                              <td className="py-1.5 text-right">{s.decileShifts}/{attribution.decile.outletsRanked} outlet</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* ---- Disclosure wajib (identitas struktural residual) +
                         FormulaInfo — DoD W10: "residual ≈ NET loss secara
                         konstruksi — lihat FormulaInfo". ---- */}
                    <div className="flex items-start gap-1.5 rounded-md border border-amber-200/70 bg-amber-50/60 px-2.5 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
                      <p className="flex-1 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                        {attribution.disclosure}
                        {attribution.decile.outletsExcluded > 0 && (
                          <> Decile dihitung atas {attribution.decile.outletsRanked} outlet ber-sales &gt; 0 ({attribution.decile.outletsExcluded} outlet sales = 0 dikecualikan — rasio tak terdefinisi).</>
                        )}
                      </p>
                      <FormulaInfo
                        formula="residual = sign(dev) × max(0, |dev| − (|W|+|S|+|T|)) · trueWaste(p) = W + p × residual"
                        description={
                          'UNTUK APA: menguji seberapa robust kesimpulan "loss terjelaskan W/S/T" terhadap asumsi bahwa residual BUKAN waste tak tercatat.\n' +
                          'CARA BACA: p = 0 berarti seluruh residual bukan waste (waste tercatat = waste sebenarnya); p = 50% berarti separuh residual dianggap waste tak tercatat. Kolom "pindah decile" = berapa outlet berpindah ≥ 1 decile ranking waste/sales bila asumsi p benar — makin kecil, makin robust prioritas anti-waste Anda.\n' +
                          'CONTOH: bila p = 50% hanya menggeser 12/344 outlet, daftar prioritas waste Anda hampir tidak berubah walau asumsi residual salah separuh.\n' +
                          'ACTION: jangan menuduh outlet berdasarkan skenario — triangulasi dulu dengan audit screen keteraturan entri (W9) sebelum kesimpulan.'
                        }
                        example="W = Rp 16,4 M, residual = Rp 96,2 M → p = 50%: true waste = Rp 64,5 M"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
});

/** Local pct formatter (no sign, 1 digit). */
function fmtPctId(v: number): string {
  return `${(v * 100).toFixed(1).replace('.', ',')}%`;
}
