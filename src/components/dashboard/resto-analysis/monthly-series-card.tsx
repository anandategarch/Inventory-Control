'use client';

// ============================================================
//  MonthlySeriesCard — "Deret Bulanan" (DEEP-RESTO-1)
//  --------------------------------------------------------
//  Multi-month SAME-weekLabel series for the focused outlet:
//  sales (MODE) + MoM, QTY BOM, Nominal Deviasi (signed),
//  Dev/BOM %, Total Loss/Surplus, Net Cost Ratio, and the
//  recurrence-style abnormal flag — the in-app version of the
//  "Deret Bulanan" sheet from the offline deep resto analysis.
//  Self-fetching (/api/outlet-monthly-series) — independent of
//  the outlet-items payload, same query conventions as the
//  Resto tab family (5-min staleTime, keepPreviousData).
// ============================================================

import { memo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CalendarRange } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPct, fmtGrowth, growthColor, numberColorNeg } from '@/lib/format';

interface MonthlySeriesRow {
  monthKey: string;
  monthLabel: string;
  sales: number;
  salesMoM: number | null;
  qtyBom: number;
  nominalDeviasi: number;
  devBom: number;
  totalLoss: number;
  totalSurplus: number;
  netCostRatio: number;
  abnormal: boolean;
}

interface MonthlySeriesTotal {
  months: number;
  sales: number;
  qtyBom: number;
  nominalDeviasi: number;
  totalLoss: number;
  totalSurplus: number;
  netCostRatio: number;
  abnormalCount: number;
}

interface MonthlySeriesResponse {
  success: boolean;
  months?: MonthlySeriesRow[];
  total?: MonthlySeriesTotal;
  error?: string;
}

export const MonthlySeriesCard = memo(function MonthlySeriesCard({
  outletCode,
  monthLabel,
  currentWeek,
}: {
  outletCode: string;
  monthLabel: string;
  currentWeek: string;
}) {
  const { data, isLoading, error } = useQuery<MonthlySeriesResponse>({
    queryKey: ['outlet-monthly-series', outletCode, monthLabel, currentWeek],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', outletCode);
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      const res = await fetch(`/api/outlet-monthly-series?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<MonthlySeriesResponse>;
    },
    enabled: Boolean(outletCode && monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const rows = data?.months || [];
  const total = data?.total;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <CalendarRange className="h-3.5 w-3.5" />
          </span>
          Deret Bulanan — Same-Week ({currentWeek})
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Deret {currentWeek} lintas bulan untuk <span className="font-medium text-foreground">{outletCode}</span> — maks. 12 bulan terakhir
          (termasuk bulan berjalan). Minggu bersifat kumulatif (snapshot tgl 1–25), jadi perbandingan antar bulan HANYA valid pada minggu yang sama.
          Net Cost Ratio = (Total Loss − Total Surplus) / Sales.
        </p>
        {total && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            <Badge variant="secondary" className="text-xs tabular-nums font-medium">{total.months} bulan</Badge>
            {total.abnormalCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5 gap-1"
              >
                {total.abnormalCount} bulan abnormal
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
              Σ Sales {fmtIDR(total.sales)}
            </Badge>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat deret bulanan…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Tidak ada data {currentWeek} untuk outlet ini pada bulan-bulan sebelumnya.
          </div>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[1000px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Bulan</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Sales</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">MoM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Dev/BOM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Total Loss</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Total Surplus</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Net Ratio</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.monthKey} className="h-9">
                    <TableCell className="text-xs font-medium">{r.monthLabel}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtIDR(r.sales)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${r.salesMoM != null ? growthColor(r.salesMoM) : 'text-muted-foreground'}`}>
                      {r.salesMoM != null ? fmtGrowth(r.salesMoM) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(r.qtyBom)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums font-semibold ${numberColorNeg(r.nominalDeviasi)}`}>
                      {fmtIDR(r.nominalDeviasi)}
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${r.devBom > 0.1 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}`}>
                      {fmtPct(r.devBom, false)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(r.totalLoss)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-emerald-600 dark:text-emerald-400">{fmtIDR(r.totalSurplus)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(r.netCostRatio)}`}>
                      {fmtPct(r.netCostRatio, false)}
                    </TableCell>
                    <TableCell className="text-center">
                      {r.abnormal ? (
                        <Badge variant="outline" className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5">
                          Abnormal
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
                          Stabil
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {total && (
                  <TableRow className="h-9 bg-muted/50 dark:bg-zinc-800/40 font-semibold border-t-2">
                    <TableCell className="text-xs font-semibold">TOTAL / {total.months} BULAN</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtIDR(total.sales)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(total.qtyBom)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(total.nominalDeviasi)}`}>
                      {fmtIDR(total.nominalDeviasi)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(total.totalLoss)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-emerald-600 dark:text-emerald-400">{fmtIDR(total.totalSurplus)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(total.netCostRatio)}`}>
                      {fmtPct(total.netCostRatio, false)}
                    </TableCell>
                    <TableCell className="text-center text-xs text-muted-foreground">
                      {total.abnormalCount}/{total.months}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
          Abnormal = Dev/BOM &gt; toleransi fallback (5%) ATAU Total Loss &gt; ambang P1 (Rp 50 Jt) — definisi yang sama dengan
          rekurensi outlet (Riwayat/REKUREN). Sales = MODE(nominalSales) per periode.
        </p>
      </CardContent>
    </Card>
  );
});
