'use client';

// ============================================================
//  WasteProfileCard — "Profil Waste" per outlet (DEEP-WASTE-2)
//  --------------------------------------------------------
//  The Resto tab's per-outlet waste view — the in-app version
//  of the offline report's "TJPPLU Fokus" sheet: per-month
//  waste/susut/trial/residual + waste/sales over the multi-month
//  same-week window, JOINED with the outlet's rank + z-score
//  inside its dynamic ±10% sales band (/api/waste-peer-zscore).
//  Shows the "paradox" flag when sales grew while waste/sales
//  stayed extreme vs the band (the offline report's TJPPLU
//  case). TWO self-fetching queries (waste-series?outletCode +
//  waste-peer-zscore) — independent of the outlet-items payload,
//  same conventions as the Riwayat Multi-Bulan cards.
// ============================================================

import { memo, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Recycle } from 'lucide-react';
import { fmtIDR, fmtPct, fmtDecimal } from '@/lib/format';
import type { WasteSeriesResponse, WastePeerZScoreResponse, WastePeerZScoreRow, WasteMonthlyRow } from '@/components/dashboard/tabs/WasteTab/types';

interface JoinedRow extends WasteMonthlyRow {
  rankWasteToSales: number | null;
  bandSize: number | null;
  zScore: number | null;
}

function zTone(z: number | null): string {
  if (z == null) return 'text-muted-foreground';
  if (z > 2) return 'text-red-600 dark:text-red-400 font-semibold';
  if (z > 1) return 'text-amber-600 dark:text-amber-400 font-semibold';
  return 'text-foreground';
}

export const WasteProfileCard = memo(function WasteProfileCard({
  outletCode,
  monthLabel,
  currentWeek,
  kelompok,
}: {
  outletCode: string;
  monthLabel: string;
  currentWeek: string;
  kelompok: string | null;
}) {
  const series = useQuery<WasteSeriesResponse>({
    queryKey: ['waste-series', monthLabel, currentWeek, null, null, null, outletCode],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      p.set('outletCode', outletCode);
      const res = await fetch(`/api/waste-series?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WasteSeriesResponse>;
    },
    enabled: Boolean(outletCode && monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const zScoreQuery = useQuery<WastePeerZScoreResponse>({
    queryKey: ['waste-peer-zscore', outletCode, monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', outletCode);
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (kelompok) p.set('kelompok', kelompok);
      const res = await fetch(`/api/waste-peer-zscore?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WastePeerZScoreResponse>;
    },
    enabled: Boolean(outletCode && monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Join monthly rows ← z-score rows on monthKey (LEFT: z rows only exist
  // for months with a band — no sales that month = no band).
  const joined = useMemo<JoinedRow[]>(() => {
    const monthly = series.data?.monthly || [];
    const zByMonth = new Map<string, WastePeerZScoreRow>();
    for (const z of zScoreQuery.data?.records || []) zByMonth.set(z.monthKey, z);
    return monthly.map((r) => {
      const z = zByMonth.get(r.monthKey);
      return {
        ...r,
        rankWasteToSales: z?.rankWasteToSales ?? null,
        bandSize: z?.bandSize ?? null,
        zScore: z?.zScore ?? null,
      };
    });
  }, [series.data, zScoreQuery.data]);

  const zSummary = zScoreQuery.data?.summary;
  const profile = series.data?.outlets?.[0] ?? null;

  const totals = useMemo(() => {
    return joined.reduce((a, r) => ({
      sales: a.sales + r.sales,
      waste: a.waste + r.waste,
      susut: a.susut + r.susut,
      trial: a.trial + r.trial,
      residual: a.residual + r.residual,
      totalLoss: a.totalLoss + r.totalLoss,
      months: a.months + 1,
      spikes: a.spikes + (r.spike ? 1 : 0),
    }), { sales: 0, waste: 0, susut: 0, trial: 0, residual: 0, totalLoss: 0, months: 0, spikes: 0 });
  }, [joined]);

  const isLoading = series.isLoading;
  const error = series.error || zScoreQuery.error;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Recycle className="h-3.5 w-3.5" />
          </span>
          Profil Waste — Same-Week ({currentWeek})
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Deret waste <span className="font-medium text-foreground">{outletCode}</span> per bulan (maks. 12 bulan) + posisi vs resto
          sales setara (band dinamis ±10%{kelompok ? `, peer dibatasi kelompok ${kelompok}` : ''}). Rank 1 = waste/sales tertinggi di band.
          z-score = posisi rasio waste/sales outlet vs rata-rata band (hanya saat band ≥ 3 member).
        </p>
        {zSummary && zSummary.monthsTracked > 0 && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            <Badge variant="secondary" className="text-xs tabular-nums font-medium">{zSummary.monthsTracked} bulan ber-band</Badge>
            {zSummary.avgZ != null && (
              <Badge variant="outline" className={`text-[10px] font-normal h-5 tabular-nums ${zSummary.avgZ > 1 ? 'text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30' : 'text-muted-foreground'}`}>
                rata-rata z {fmtDecimal(zSummary.avgZ, 2)}
                {/* FIX (BUGHUNT-R2 / VH-7): comma decimal — was avgZ.toFixed(2) → "2.08". */}
              </Badge>
            )}
            {zSummary.monthsHighestWaste > 0 && (
              <Badge variant="outline" className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5">
                {zSummary.monthsHighestWaste}× waste tertinggi di band
              </Badge>
            )}
            {zSummary.paradox && (
              <Badge variant="outline" className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5">
                Paradox: sales tumbuh {zSummary.salesGrowth != null ? fmtPct(zSummary.salesGrowth) : ''} + waste ekstrem
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat profil waste…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{(error as Error).message}</div>
        ) : joined.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Tidak ada data waste {currentWeek} untuk outlet ini pada bulan-bulan sebelumnya.
          </div>
        ) : (
          <div className="max-h-96 overflow-auto">
            {/* FIX (BUGHUNT-R2): dropped dead `waste-scroll` class — referenced
                here but defined in no stylesheet (grep: 0 CSS hits). */}
            <Table className="min-w-[880px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Bulan</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Sales</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Susut</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Trial</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Residual</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Total Loss</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Waste/Sales</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Rank Band</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">z-Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {joined.map((r) => (
                  <TableRow key={r.monthKey} className="h-9">
                    <TableCell className="text-xs font-medium">
                      {r.monthLabel}
                      {r.spike && (
                        <Badge variant="outline" className="ml-1.5 text-[9px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-4 px-1.5">
                          2σ
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtIDR(r.sales)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">{fmtIDR(r.waste)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(r.susut)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(r.trial)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">{fmtIDR(r.residual)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(r.totalLoss)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${r.wasteToSales > 0.02 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}`}>
                      {fmtPct(r.wasteToSales, false, 2)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {r.rankWasteToSales != null && r.bandSize != null
                        ? `${r.rankWasteToSales}/${r.bandSize}`
                        : '—'}
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${zTone(r.zScore)}`}>
                      {/* FIX (BUGHUNT-R2 / VH-7): comma decimal — was zScore.toFixed(2). */}
                      {r.zScore != null ? fmtDecimal(r.zScore, 2) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="h-9 bg-muted/50 dark:bg-zinc-800/40 font-semibold border-t-2">
                  {/* FIX (BUGHUNT-R2): the 2σ spike tally now rides the Bulan
                      TOTAL label — it used to sit in the 9th cell, under the
                      "Rank Band" column (a rank column), where it made no
                      sense; the per-row 2σ badges live in this Bulan column. */}
                  <TableCell className="text-xs font-semibold">
                    TOTAL / {totals.months} BULAN{totals.spikes > 0 ? ` · ${totals.spikes}× 2σ` : ''}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtIDR(totals.sales)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">{fmtIDR(totals.waste)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(totals.susut)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(totals.trial)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">{fmtIDR(totals.residual)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(totals.totalLoss)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {totals.sales > 0 ? fmtPct(totals.waste / totals.sales, false, 2) : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
        {profile && (
          <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
            Window: sales {fmtIDR(profile.sales)} · waste {fmtIDR(profile.waste)} · residual {fmtIDR(profile.residual)}
            {profile.residualShare > 0 ? ` (${fmtPct(profile.residualShare, false, 0)} dari loss)` : ''}
            {profile.underRecording ? ' · waste/sales &lt; 0,1% (under-recording)' : ''}
            {profile.zeroWasteBigLoss ? ' · waste ≈ 0 dengan loss besar' : ''}.
            2σ = lonjakan waste/sales &gt; mean + 2σ riwayat window sendiri.
          </p>
        )}
      </CardContent>
    </Card>
  );
});
