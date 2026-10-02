'use client';

// ============================================================
//  WasteProfileTable — "Profil Waste Outlet" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Per-outlet waste profile over the multi-month same-week
//  window, ranked by waste/sales (1 = tertinggi): sales, waste,
//  susut, trial, residual, loss, waste/sales + the 4 network
//  detector badges. The in-app version of the offline report's
//  "Profil Waste Outlet" sheet.
//  Long list handling: max-h-96 + overflow-auto (convention).
//  (BUGHUNT-R2: the old comment promised a "custom scrollbar" via the
//  `waste-scroll` class — dead: defined in no stylesheet, removed.)
//
//  W2 (Kronis vs Episodik): +1 kolom "Kelas" (badge KRONIS/EPISODIK/
//  SEHAT/TERBATAS + tooltip "bulan di atas median X/Y" INDIKASI) —
//  data berasal dari field ADDITIF /api/waste-series; respons cache
//  pra-W2 tidak memilikinya → render em-dash (pola kolom Flag).
//
//  W11 (Paritas Susut & Trial): +1 badge detektor "S2σ×n" (susut
//  spike) di kolom Flag — twin metric-swap dari badge 2σ×n waste
//  (susut/sales > mean+2σ riwayat sendiri, bulan sales>0 saja);
//  hanya dirender saat susutSpikeMonths > 0 (field ADDITIF — cache
//  pra-W11 tidak memilikinya).
//  FIX (AUDIT-B M3): tooltip badge S2σ kini membawa baseline n
//  outlet tsb (susutRatioMonths — "dari N bulan ber-sales, min. 3";
//  field ADDITIF, fallback teks lama saat absen agar tidak
//  menampilkan "undefined").
//
//  FIX (WASTE-DRILL): baris outlet kini klik → DrillDownDrawer ter-scope
//  window (drilldown.months = bulan-bulan window same-week dari parent) —
//  menutup temuan findings-DEEPWASTE2-MAIN #4 "0 drilldown wiring dari
//  WasteTab". Keyboard parity via clickableRowProps (konvensi rumah).
// ============================================================

import { memo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Store, ChevronDown, ChevronUp } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useDashboard } from '@/hooks/useDashboard';
import type { WasteOutletRow, WastePersistenceClass } from './types';

const INITIAL_ROWS = 15;

/** W2 class badge color (same palette language as the detector flags + persistence-card). */
function persistenceClassBadgeClass(c: WastePersistenceClass): string {
  switch (c) {
    case 'KRONIS':
      return 'text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30';
    case 'EPISODIK':
      return 'text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30';
    case 'SEHAT':
      return 'text-emerald-600 dark:text-emerald-400 border-emerald-300/70 dark:border-emerald-800/70 bg-emerald-50/60 dark:bg-emerald-950/30';
    default:
      return 'text-zinc-600 dark:text-zinc-300 border-zinc-300/70 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-900/30';
  }
}

export const WasteProfileTable = memo(function WasteProfileTable({
  outlets,
  months,
}: {
  outlets: WasteOutletRow[];
  /** FIX (WASTE-DRILL): window month labels (parent's data.months) — the
   *  drill scope so the drawer's records match the row's window aggregate.
   *  Optional: absent (stale payload / parent not loaded) → the drawer falls
   *  back to the current month only. */
  months?: string[];
}) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? outlets : outlets.slice(0, INITIAL_ROWS);

  // FIX (WASTE-DRILL): row → outlet-scoped window drill. months passed only
  // when non-empty (undefined keeps the drawer's legacy current-month scope).
  const handleRowDrill = (outletCode: string) => {
    setDrilldown({
      outletCode,
      itemName: null,
      months: months && months.length > 0 ? months : undefined,
    });
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Store className="h-3.5 w-3.5" />
          </span>
          Profil Waste Outlet — Rank Waste/Sales
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Ranking {outlets.length} outlet pada scope filter aktif — rank 1 = rasio waste/sales tertinggi di window.
          Waste = ΣABS nominalWaste; Residual = bagian loss yang TIDAK dijelaskan waste/susut/trial.
          Kelas (W2) = persistensi waste terhadap median network per bulan — lihat kartu Kronis vs Episodik.
          <span className="font-medium text-foreground/70"> Klik baris outlet untuk drill-down data sumber (window same-week).</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {outlets.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada data waste pada scope ini.</div>
        ) : (
          <>
            {/* FIX (BUGHUNT-R2): dropped dead `waste-scroll` class — defined
                in no stylesheet (grep: 0 CSS hits); max-h-96/overflow-auto
                wrapper kept. */}
            <div className="max-h-96 overflow-auto">
              <Table className="min-w-[1160px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">#</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Area</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Sales</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Susut</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Trial</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Residual</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Total Loss</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste/Sales</TableHead>
                    <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Kelas</TableHead>
                    <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Flag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => (
                    <TableRow
                      key={o.outletCode}
                      className="h-9 cursor-pointer hover:bg-muted/50 dark:hover:bg-zinc-800/40"
                      {...clickableRowProps(() => handleRowDrill(o.outletCode))}
                    >
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{o.rankWasteToSales}</TableCell>
                      <TableCell className="text-xs font-medium">
                        {o.outletCode}
                        <span className="text-muted-foreground font-normal"> · {o.outletName}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[140px] truncate" title={o.area}>{o.area}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtIDR(o.sales)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">{fmtIDR(o.waste)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(o.susut)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(o.trial)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">{fmtIDR(o.residual)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(o.totalLoss)}</TableCell>
                      <TableCell className={`text-right text-xs tabular-nums ${o.wasteToSales > 0.02 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}`}>
                        {fmtPct(o.wasteToSales, false, 2)}
                      </TableCell>
                      {/* W2 (Kronis vs Episodik) — additive field; em-dash when
                          absent (stale pre-W2 cached response). Tooltip carries
                          the "bulan di atas median X/Y" INDIKASI disclosure. */}
                      <TableCell className="text-center">
                        {o.persistenceClass ? (
                          <Badge
                            variant="outline"
                            title={`${o.persistenceClass} (INDIKASI) — ${o.monthsAboveMedian ?? 0}/${o.activeMonths ?? 0} bulan aktif di atas median network bulan tersebut`}
                            className={`text-[9px] font-semibold h-4 px-1.5 cursor-help ${persistenceClassBadgeClass(o.persistenceClass)}`}
                          >
                            {o.persistenceClass}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1 flex-wrap">
                          {o.zeroWasteBigLoss && (
                            <Badge variant="outline" className="text-[9px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-4 px-1.5">
                              W0
                            </Badge>
                          )}
                          {o.spikeMonths > 0 && (
                            <Badge variant="outline" className="text-[9px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-4 px-1.5">
                              2σ×{o.spikeMonths}
                            </Badge>
                          )}
                          {/* W11 (Paritas Susut & Trial) — additive badge: the
                              metric-swap twin of the waste 2σ spike, computed
                              server-side as a pure pass over the same monthly
                              rows. Only rendered when > 0 (absent field =
                              pre-W11 cached response → treated as 0). */}
                          {(o.susutSpikeMonths ?? 0) > 0 && (
                            <Badge
                              variant="outline"
                              title={`${o.susutSpikeMonths} bulan lonjakan SUSUT/sales > mean + 2σ vs riwayat window sendiri (${o.susutRatioMonths != null ? `dari ${o.susutRatioMonths} bulan ber-sales, min. 3` : 'bulan sales > 0 saja, min. 3 bulan'}) — twin metric-swap dari detektor spike waste; indikasi masalah penyimpanan/cold-chain, bukan bukti`}
                              className="text-[9px] font-normal text-sky-700 dark:text-sky-400 border-sky-300/70 dark:border-sky-800/70 bg-sky-50/60 dark:bg-sky-950/30 h-4 px-1.5 cursor-help"
                            >
                              S2σ×{o.susutSpikeMonths}
                            </Badge>
                          )}
                          {o.underRecording && (
                            <Badge variant="outline" className="text-[9px] font-normal text-yellow-700 dark:text-yellow-400 border-yellow-300/70 dark:border-yellow-800/70 bg-yellow-50/60 dark:bg-yellow-950/30 h-4 px-1.5">
                              UR
                            </Badge>
                          )}
                          {o.residualDominant && (
                            <Badge variant="outline" className="text-[9px] font-normal text-zinc-600 dark:text-zinc-300 border-zinc-300/70 dark:border-zinc-700 h-4 px-1.5">
                              RD
                            </Badge>
                          )}
                          {!o.zeroWasteBigLoss && o.spikeMonths === 0 && (o.susutSpikeMonths ?? 0) === 0 && !o.underRecording && !o.residualDominant && (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {outlets.length > INITIAL_ROWS && (
              <div className="p-2 border-t flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                >
                  {expanded
                    ? <><ChevronUp className="h-3.5 w-3.5 mr-1" />Tampilkan lebih sedikit</>
                    : <><ChevronDown className="h-3.5 w-3.5 mr-1" />Tampilkan semua {outlets.length} outlet</>}
                </Button>
              </div>
            )}
            <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
              Flag: W0 = waste ≈ 0 dengan loss &gt; ambang P1 · 2σ×n = n bulan lonjakan waste/sales &gt; 2σ vs riwayat window sendiri ·
              S2σ×n = n bulan lonjakan SUSUT/sales &gt; 2σ vs riwayat window sendiri (metric-swap detektor waste — indikasi penyimpanan/cold-chain) ·
              UR = waste/sales &lt; 0,1% (≥ 2 bulan, under-recording) · RD = residual &gt; 80% loss dan waste menjelaskan &lt; 10%.
              Kelas (W2, INDIKASI): KRONIS = ≥ 60% bulan aktif di atas median network per bulan (min. 6 bulan aktif) ·
              EPISODIK = ada lonjakan 2σ tanpa persistensi kronis · SEHAT = lainnya · TERBATAS = &lt; 6 bulan aktif —
              bulan DQ-error/tanpa sales dikecualikan dari perhitungan.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
});
