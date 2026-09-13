'use client';

// ============================================================
//  Benchmark Opportunity Card — "Peluang Perbaikan (Rp)"
//  --------------------------------------------------------
//  ANA-1-E (roadmap "Benchmark Opportunity"): turns the PEER
//  benchmark into a MEASURED Rp number — the total Rp that could
//  be suppressed if every outlet's loss dropped to its AREA
//  MEDIAN loss, plus the top outlets driving that gap.
//
//  Presentational — the useQuery lives in PeerComparison.tsx,
//  same pattern as TrendChartCard / ItemLevelComparison (caller
//  fetches, card renders its own loading/error/empty states).
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RotateCcw, Coins } from 'lucide-react';
import { BarList } from '@/components/dashboard/shared/BarList';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { fmtIDR } from '@/lib/format';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';

/** One outlet row of /api/benchmark-opportunity's topOutlets. */
export interface BenchmarkOpportunityOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  lossNominal: number;
  areaMedianLoss: number;
  opportunityRp: number;
  devBom: number;
}

/** Response shape of `/api/benchmark-opportunity`. */
export interface BenchmarkOpportunityResponse {
  success: boolean;
  error?: string;
  period?: { month: string | null; week: string | null };
  totalOpportunityRp: number;
  areaCount: number;
  topOutlets: BenchmarkOpportunityOutlet[];
  cached?: boolean;
  stale?: boolean;
}

export interface BenchmarkOpportunityCardProps {
  data: BenchmarkOpportunityResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  /** Retry handler (TanStack refetch — stable identity, keeps memo effective). */
  onRetry: () => void;
}

export const BenchmarkOpportunityCard = memo(function BenchmarkOpportunityCard({
  data,
  isLoading,
  error,
  onRetry,
}: BenchmarkOpportunityCardProps) {
  // NAVLINK-1 (B1): clicking a bar opens that outlet's Resto deep dive —
  // setFocusOutlet switches to the resto tab with the outlet pre-selected
  // (same pattern as OutletHealthRanking / RestoRecommendationCard rows).
  const setFocusOutlet = useDashboard(useShallow((s) => s.setFocusOutlet));
  // Top 5 for the compact bar list (API returns top 8 — spec: card shows 5).
  // Label = outlet name + area; the full label rides BarList's built-in
  // title tooltip so truncated names stay hover-readable.
  const topBars = useMemo(
    () =>
      (data?.topOutlets || []).slice(0, 5).map((o) => ({
        key: o.outletCode,
        name: `${o.outletName} · ${o.area}`,
        value: o.opportunityRp,
      })),
    [data],
  );

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20 min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Coins className="h-3.5 w-3.5" />
          </span>
          <span className="truncate">Peluang Perbaikan (Rp)</span>
          <InfoTooltip content="Total Rp yang bisa ditekan jika loss setiap resto turun ke median loss areanya. Median = percentile 50% dari loss resto-resto satu area pada periode berjalan (label TERUKUR — dihitung dari data, bukan hipotesis)." />
        </CardTitle>
        {/* VH-7 / §21: module opens with the question it answers. */}
        <p className="text-[11px] text-muted-foreground ml-9">
          Berapa Rp yang bisa ditekan jika tiap resto loss-nya turun ke median areanya?
        </p>
      </CardHeader>
      <CardContent>
        {/* Error first (BUG-HUNT B1/B2-01 convention: error before !data). */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : error ? (
          <div className="py-6 text-center space-y-2">
            <p className="text-xs text-red-600 dark:text-red-400">Gagal memuat peluang perbaikan.</p>
            <Button onClick={onRetry} variant="outline" size="sm">
              <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
            </Button>
          </div>
        ) : !data ? (
          <p className="text-center text-xs text-muted-foreground py-6">Menunggu data periode…</p>
        ) : !data.success ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400 py-6">
            Error: {data.error || 'Unknown'}
          </p>
        ) : data.areaCount === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Tidak ada data outlet pada periode ini.
          </p>
        ) : data.totalOpportunityRp === 0 ? (
          /* Friendly zero-opportunity state — every outlet is at/below its
             area median, so there is nothing left to suppress. */
          <p className="text-center text-xs text-muted-foreground py-6">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">Tidak ada peluang</span>
            {' '}— semua resto sudah di bawah median areanya.
          </p>
        ) : (
          <div className="space-y-2.5 min-w-0">
            {/* Hero — total measured opportunity (compact IDR; full value on hover). */}
            <p
              className="text-3xl font-bold tabular-nums text-amber-600 dark:text-amber-400 truncate"
              title={fmtIDR(data.totalOpportunityRp, false)}
            >
              {fmtIDR(data.totalOpportunityRp)}
            </p>
            {/* Top 5 outlets by opportunityRp — bar length = Rp.
                NAVLINK-1 (B1): row click → Resto deep dive (focusOutlet). */}
            <BarList
              data={topBars}
              valueFormatter={fmtIDR}
              color="amber"
              sortOrder="descending"
              showAnimation
              onValueChange={(b) => { if (typeof b.key === 'string') setFocusOutlet(b.key); }}
            />
            <p className="text-[10px] text-muted-foreground pt-1 border-t">
              <span className="font-semibold uppercase tracking-[0.12em] text-foreground/70">TERUKUR</span>
              {' '}· dibanding median resto satu area ·{' '}
              <span className="tabular-nums">{data.areaCount}</span> area · klik resto untuk buka analisa nya
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
