'use client';

// ============================================================
//  WastePersistenceCard — "Kronis vs Episodik" (W2)
//  --------------------------------------------------------
//  Outlet-level waste PERSISTENCE over the multi-month same-week
//  window: which outlets are CHRONICALLY above the network median
//  month after month (systemic) vs which only spike episodically
//  (one-off incidents)? The in-app version of the W2 candidate
//  from findings-DEEPWASTE2-B §2 (top-5 readiness-A #1).
//
//  Everything rendered here is computed by the PURE builder
//  src/lib/queries/waste/network/persistence.ts (server, additive
//  fields on /api/waste-series) — this card only formats:
//    - class distribution (KRONIS / EPISODIK / SEHAT / TERBATAS)
//    - 2×2 month-over-month transition matrix + persistence ratio
//      + two-sided Fisher exact p (rendered "p < 0,001" style)
//    - per-outlet table: class badge, monthsAboveMedian/activeMonths,
//      aboveMedianShare, spike count — sorted KRONIS first then
//      share DESC
//  Props-driven (parent WasteTab owns the /api/waste-series query —
//  same pattern as WasteAnomalyCard). All W2 fields are OPTIONAL on
//  the wire (additive API, stale pre-W2 cache may lack them) — every
//  read below guards undefined.
//  Epistemic disclosure: every class is INDIKASI — a strong measured
//  PATTERN, not proof of cause (house convention from lib/insights.ts).
//
//  FIX (WASTE-DRILL): baris outlet kini klik → DrillDownDrawer ter-scope
//  window (drilldown.months dari parent) — 0 wiring drilldown dari WasteTab
//  (findings-DEEPWASTE2-MAIN #4) ditutup juga di kartu ini. Keyboard parity
//  via clickableRowProps.
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Repeat } from 'lucide-react';
import { fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useDashboard } from '@/hooks/useDashboard';
import type { WasteOutletRow, WastePersistenceBlock, WastePersistenceClass } from './types';

/** Sort order: KRONIS first, TERBATAS last (insufficient data = least interesting). */
const CLASS_ORDER: Record<WastePersistenceClass, number> = {
  KRONIS: 0, EPISODIK: 1, SEHAT: 2, TERBATAS: 3,
};

function classBadgeClass(c: WastePersistenceClass): string {
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

/** Fisher p-value, Indonesian decimal comma, "p < 0,001" style for tiny values. */
function fmtPValue(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p < 0.001) return 'p < 0,001';
  return `p = ${p.toFixed(3).replace('.', ',')}`;
}

/** Persistence ratio as a ×-multiplier (null → em-dash, never ±Infinity on the wire). */
function fmtRatio(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return '—';
  return `${r.toFixed(2).replace('.', ',')}×`;
}

/** Native-tooltip text per class — the "bulan di atas median X/Y" INDIKASI disclosure. */
function classTooltip(o: WasteOutletRow): string {
  const above = o.monthsAboveMedian ?? 0;
  const active = o.activeMonths ?? 0;
  const base = `${o.persistenceClass} (INDIKASI) — ${above}/${active} bulan aktif di atas median network bulan tersebut`;
  if (o.persistenceClass === 'TERBATAS') {
    return `${base} (data terbatas: ${active} bulan aktif < 6 — belum bisa diklasifikasi)`;
  }
  return base;
}

export const WastePersistenceCard = memo(function WastePersistenceCard({
  outlets,
  persistence,
  months,
}: {
  outlets: WasteOutletRow[];
  persistence?: WastePersistenceBlock;
  /** FIX (WASTE-DRILL): window month labels (parent's data.months) — the
   *  drill scope. Optional: absent → the drawer falls back to the current
   *  month only. */
  months?: string[];
}) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const summary = persistence?.summary;

  // FIX (WASTE-DRILL): row → outlet-scoped window drill (same contract as
  // profile-table). months passed only when non-empty.
  const handleRowDrill = (outletCode: string) => {
    setDrilldown({
      outletCode,
      itemName: null,
      months: months && months.length > 0 ? months : undefined,
    });
  };

  // KRONIS first, then aboveMedianShare DESC; outlets without W2 fields
  // (stale cache) sort last and render an em-dash class.
  const sorted = useMemo(() => {
    const classRank = (o: WasteOutletRow): number =>
      o.persistenceClass ? CLASS_ORDER[o.persistenceClass] : CLASS_ORDER.TERBATAS + 1;
    const share = (o: WasteOutletRow): number => o.aboveMedianShare ?? -1;
    return [...outlets].sort(
      (a, b) => classRank(a) - classRank(b)
        || share(b) - share(a)
        || a.outletCode.localeCompare(b.outletCode),
    );
  }, [outlets]);

  const monthsCount = persistence?.medians.length ?? 0;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Repeat className="h-3.5 w-3.5" />
          </span>
          Kronis vs Episodik — Persistensi Waste Outlet
          <Badge variant="outline" className="text-[10px] font-normal text-zinc-600 dark:text-zinc-300 border-zinc-300/70 dark:border-zinc-700 h-5 shrink-0">
            INDIKASI
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Outlet yang waste/sales-nya KRONIS di atas median network bulan demi bulan (sistemik) vs yang hanya
          lonjakan sesaat (episodik). Median dihitung per bulan atas outlet aktif scope — kontrol musiman;
          bulan DQ-error dihitung terpisah sebagai bulan tak valid.
          Window same-week{monthsCount > 0 ? `: ${monthsCount} bulan tersedia (maks. 12)` : ': maks. 12 bulan'} —
          minggu bersifat kumulatif sehingga perbandingan antar bulan HANYA valid pada minggu yang sama.
          <span className="font-medium text-foreground/70"> Klik baris outlet untuk drill-down data sumber (window same-week).</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {outlets.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada data waste pada scope ini.</div>
        ) : (
          <>
            {/* Summary strip: class distribution + transition statistics.
                FIX (AUDIT-A F3): when the persistence block is absent
                (stale pre-W2 5-min cache / old payload) the strip used to
                render "0 KRONIS … 0 TERBATAS" — an absolute zero that reads
                as a MEASURED class distribution. Guarded the same way as
                the transition-stats grid below: summary missing → one
                concise fallback line, never zeroed badges. */}
            <div className="p-4 border-b space-y-3">
              {summary ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-[10px] font-semibold h-5 ${classBadgeClass('KRONIS')}`}>
                    {summary.classDistribution.kronis} KRONIS
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] font-semibold h-5 ${classBadgeClass('EPISODIK')}`}>
                    {summary.classDistribution.episodik} EPISODIK
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] font-semibold h-5 ${classBadgeClass('SEHAT')}`}>
                    {summary.classDistribution.sehat} SEHAT
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] font-semibold h-5 ${classBadgeClass('TERBATAS')}`}>
                    {summary.classDistribution.terbatas} TERBATAS
                  </Badge>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Data persistensi belum tersedia pada payload ini (cache 5 menit pra-pembaruan) — muat ulang
                  setelah beberapa saat.
                </p>
              )}
              {summary ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-lg border bg-muted/30 dark:bg-zinc-800/30 px-3 py-2 min-w-0 space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Rasio Persistensi Transisi</p>
                    <p className="text-sm font-semibold tabular-nums">{fmtRatio(summary.persistenceRatio)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      P(tinggi bulan depan | bulan ini tinggi) {fmtPct(summary.pHighNextGivenHigh, false, 1)} vs
                      P(tinggi | rendah) {fmtPct(summary.pHighNextGivenLow, false, 1)} — uji Fisher exact dua sisi{' '}
                      {fmtPValue(summary.fisherP)} atas {summary.transitionPairs} pasangan bulan berurutan.
                      Rasio &gt; 1× = persisten (kronis); &lt; 1× = cepat turun (episodik / mean-reversion).
                    </p>
                  </div>
                  {/* 2×2 transition matrix mini-table (raw <table> — same
                      convention as matrix-card for compact grids). */}
                  <div className="rounded-lg border bg-muted/30 dark:bg-zinc-800/30 px-3 py-2 min-w-0 overflow-x-auto">
                    <table className="border-collapse text-xs w-full">
                      <caption className="sr-only">
                        Matriks transisi bulan-ke-bulan 2×2 (pasangan bulan berurutan per outlet; tinggi = di atas
                        median bulan tersebut)
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className="text-left font-semibold text-[10px] uppercase tracking-wider text-muted-foreground px-1 py-1">
                            Bulan t → t+1
                          </th>
                          <th scope="col" className="text-center font-semibold text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1">
                            t+1 Tinggi
                          </th>
                          <th scope="col" className="text-center font-semibold text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1">
                            t+1 Rendah
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <th scope="row" className="text-left text-muted-foreground px-1 py-1 whitespace-nowrap font-normal">t Tinggi</th>
                          <td className="text-center tabular-nums px-2 py-1 font-semibold text-red-600 dark:text-red-400">{summary.transitionHH}</td>
                          <td className="text-center tabular-nums px-2 py-1">{summary.transitionHL}</td>
                        </tr>
                        <tr>
                          <th scope="row" className="text-left text-muted-foreground px-1 py-1 whitespace-nowrap font-normal">t Rendah</th>
                          <td className="text-center tabular-nums px-2 py-1">{summary.transitionLH}</td>
                          <td className="text-center tabular-nums px-2 py-1 text-emerald-600 dark:text-emerald-400">{summary.transitionLL}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Ringkasan transisi jaringan belum tersedia pada respons ini (cache pra-W2) — muat ulang data
                  untuk memuatnya. Tabel per-outlet di bawah tetap menampilkan kolom Kelas bila tersedia.
                </p>
              )}
            </div>
            {/* Per-outlet table — long list convention: max-h-96 overflow-auto
                (the custom `waste-scroll` class was dead code removed in
                BUGHUNT-R2; siblings use the plain wrapper). */}
            <div className="max-h-96 overflow-auto">
              <Table className="min-w-[640px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead scope="col" className="text-xs font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                    <TableHead scope="col" className="text-center text-xs font-semibold uppercase tracking-wider h-8">Kelas</TableHead>
                    <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8">Di Atas Median</TableHead>
                    <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8">Share</TableHead>
                    <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8">Lonjakan 2σ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((o) => (
                    <TableRow
                      key={o.outletCode}
                      className="h-9 cursor-pointer hover:bg-muted/50 dark:hover:bg-zinc-800/40"
                      {...clickableRowProps(() => handleRowDrill(o.outletCode))}
                    >
                      <TableCell className="text-xs font-medium">
                        {o.outletCode}
                        <span className="text-muted-foreground font-normal"> · {o.outletName}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        {o.persistenceClass ? (
                          <Badge
                            variant="outline"
                            title={classTooltip(o)}
                            className={`text-[9px] font-semibold h-4 px-1.5 cursor-help ${classBadgeClass(o.persistenceClass)}`}
                          >
                            {o.persistenceClass}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {o.monthsAboveMedian ?? 0}/{o.activeMonths ?? 0}
                        {(o.invalidMonths ?? 0) + (o.zeroSalesMonths ?? 0) > 0 && (
                          <span
                            className="text-muted-foreground"
                            title={`${o.invalidMonths ?? 0} bulan DQ-error (tak valid) + ${o.zeroSalesMonths ?? 0} bulan tanpa sales — dikecualikan dari perhitungan`}
                          >
                            {' '}({(o.invalidMonths ?? 0) + (o.zeroSalesMonths ?? 0)}≠)
                          </span>
                        )}
                      </TableCell>
                      {/* FIX (AUDIT-A F2): red-bold is gated on the KRONIS
                          class, not on share ≥ 60% alone — the class
                          definition already encodes share ≥ 60% ∧ ≥ 6
                          active months, so an ungated threshold painted 82
                          TERBATAS outlets live (48 of them at share 100%,
                          < 6 active months — "not yet classifiable") in the
                          chronic style. The NUMBER stays the same
                          (fmtPct unchanged); only the affordance narrows. */}
                      <TableCell className={`text-right text-xs tabular-nums ${o.persistenceClass === 'KRONIS' ? 'text-red-600 dark:text-red-400 font-semibold' : ''}`}>
                        {fmtPct(o.aboveMedianShare ?? 0, false, 0)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {(o.activeSpikeMonths ?? 0) > 0
                          ? <span className="text-amber-600 dark:text-amber-400">{o.activeSpikeMonths}</span>
                          : <span className="text-muted-foreground">0</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
              Metode: &quot;di atas median&quot; = waste/sales strictly di atas median PER BULAN outlet aktif scope
              (kontrol musiman; termasuk outlet sendiri — benchmark jaringan, bukan peer-exclusion). Bulan DQ-error
              dihitung terpisah sebagai bulan tak valid; bulan sales = 0 dikecualikan (rasio tak terdefinisi).
              KRONIS = ≥ 60% bulan aktif di atas median (min. 6 bulan aktif) · EPISODIK = ada lonjakan 2σ tanpa
              persistensi kronis · SEHAT = lainnya · TERBATAS = &lt; 6 bulan aktif. (≠ = bulan tak valid/tanpa
              sales yang dikecualikan.) Semua kelas INDIKASI — pola terukur, bukan bukti penyebab; intervensi
              tetap perlu verifikasi dokumen per outlet.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
});
