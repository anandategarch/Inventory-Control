'use client';

// ============================================================
//  PeerTrackRecordCard — "Track-Record Rank Peer" (DEEP-RESTO-1)
//  --------------------------------------------------------
//  Per-month rank of the focused outlet inside its DYNAMIC ±10%
//  sales band (band recomputed per month — same semantics as the
//  Peer tab): rank net deviation (1 = TERBURUK), rank total loss
//  (1 = terbesar), band size, median loss band, and the gap vs
//  that median. The in-app version of the "Peer Comparison"
//  track-record sheet from the offline deep resto analysis.
//  Self-fetching (/api/peer-track-record).
// ============================================================

import { memo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Medal } from 'lucide-react';
import { fmtIDR, numberColorNeg, fmtDecimal } from '@/lib/format';

interface PeerTrackRecordRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number;
  nominalDeviasi: number;
  totalLoss: number;
  rankNetDev: number;
  rankLoss: number;
  bandSize: number;
  medianLoss: number;
}

interface PeerTrackRecordSummary {
  monthsTracked: number;
  avgRankNetDev: number | null;
  avgRankLoss: number | null;
  monthsWorstNetDev: number;
  monthsWorstLoss: number;
  lastMonthLabel: string | null;
  lastRankNetDev: number | null;
  lastRankLoss: number | null;
  lastBandSize: number | null;
}

interface PeerTrackRecordResponse {
  success: boolean;
  records?: PeerTrackRecordRow[];
  summary?: PeerTrackRecordSummary;
  error?: string;
}

/** Rank cell coloring: #1 (worst side) red, best side emerald, else muted. */
function rankTone(rank: number, bandSize: number): string {
  if (bandSize <= 1) return 'text-muted-foreground';
  if (rank === 1) return 'text-red-600 dark:text-red-400 font-semibold';
  if (rank === bandSize) return 'text-emerald-600 dark:text-emerald-400 font-semibold';
  return 'text-foreground';
}

export const PeerTrackRecordCard = memo(function PeerTrackRecordCard({
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
  const { data, isLoading, error } = useQuery<PeerTrackRecordResponse>({
    // kelompok scopes the peer set (same param semantics as the Peer tab).
    queryKey: ['peer-track-record', outletCode, monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', outletCode);
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (kelompok) p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-track-record?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<PeerTrackRecordResponse>;
    },
    enabled: Boolean(outletCode && monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const rows = data?.records || [];
  const summary = data?.summary;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Medal className="h-3.5 w-3.5" />
          </span>
          Track-Record Rank Peer — Band Sales Setara (±10%)
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Posisi <span className="font-medium text-foreground">{outletCode}</span> di antara resto dengan sales ±10% dari sales-nya pada bulan itu
          (band dinamis per bulan, {currentWeek}). Rank Net Dev: 1 = deviasi neto paling negatif (terburuk). Rank Loss: 1 = total loss terbesar.
          Bulan tanpa band (sales kosong) tidak ditampilkan.
          {kelompok ? ` Peer dibatasi kelompok ${kelompok}.` : ''}
        </p>
        {summary && summary.monthsTracked > 0 && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            <Badge variant="secondary" className="text-xs tabular-nums font-medium">{summary.monthsTracked} bulan ber-band</Badge>
            {summary.avgRankNetDev != null && (
              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5 tabular-nums">
                {/* FIX (BUGHUNT-R2 / VH-7): comma decimal — was
                    avgRankNetDev.toFixed(1) → "3.5". */}
                Rata-rata Rank Net #{fmtDecimal(summary.avgRankNetDev, 1)}
              </Badge>
            )}
            {summary.monthsWorstNetDev > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5"
              >
                {summary.monthsWorstNetDev}× terburuk net dev di band
              </Badge>
            )}
            {summary.monthsWorstLoss > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5"
              >
                {summary.monthsWorstLoss}× loss terbesar di band
              </Badge>
            )}
            {summary.lastMonthLabel && summary.lastRankNetDev != null && summary.lastBandSize != null && (
              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5 tabular-nums">
                {summary.lastMonthLabel}: net #{summary.lastRankNetDev}/{summary.lastBandSize}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat track-record peer…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Tidak ada bulan dengan band sales setara (butuh sales &gt; 0 pada {currentWeek} di bulan-bulan terpantau).
          </div>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Bulan</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Sales Outlet</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Band</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Rank Net Dev</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Rank Loss</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Total Loss</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Median Loss Band</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Gap vs Median</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const gap = r.totalLoss - r.medianLoss;
                  return (
                    <TableRow key={r.monthKey} className="h-9">
                      <TableCell className="text-xs font-medium">{r.monthLabel}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtIDR(r.targetSales)}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums text-muted-foreground">{r.bandSize} resto</TableCell>
                      <TableCell className={`text-center text-xs tabular-nums ${rankTone(r.rankNetDev, r.bandSize)}`}>
                        #{r.rankNetDev}/{r.bandSize}
                      </TableCell>
                      <TableCell className={`text-center text-xs tabular-nums ${rankTone(r.rankLoss, r.bandSize)}`}>
                        #{r.rankLoss}/{r.bandSize}
                      </TableCell>
                      <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(r.nominalDeviasi)}`}>
                        {fmtIDR(r.nominalDeviasi)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-red-600 dark:text-red-400">{fmtIDR(r.totalLoss)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtIDR(r.medianLoss)}</TableCell>
                      <TableCell className={`text-right text-xs tabular-nums ${gap > 0 ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {gap >= 0 ? '+' : ''}{fmtIDR(gap)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
          Median Loss Band = median total loss resto-resto sebanding bulan itu (ukuran dampak yang wajar untuk dibandingkan). Gap positif (merah) =
          loss outlet di atas median band.
        </p>
      </CardContent>
    </Card>
  );
});
