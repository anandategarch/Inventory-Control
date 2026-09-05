'use client';

// ============================================================
//  PeerComparison — main component (thin wrapper)
//
//  Adds 8 analysis features above/below the existing peer table:
//   #1 Ranking Summary, #2 Gap Analysis, #3 Item-Level Comparison,
//   #4 Scatter Plot, #5 Anomaly Flags, #6 Trend Chart,
//   #7 Efficiency Score, #9 Correlation Insight
//
//  Sub-components live in ./peer-comparison/*.
// ============================================================

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, Loader2, BarChart3, RotateCcw } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

import type {
  PeerRow, MetricDef, ItemComparisonResponse, TrendResponse, PeerAverages,
} from './peer-comparison/types';
import { COLUMNS, colorCell } from './peer-comparison/helpers';
import {
  EfficiencyScoreCard,
  GapAnalysisCard,
  ScatterPlotCard,
  RankingSummaryCard,
  AnomalyFlags,
} from '@/components/dashboard/shared/peer-comparison-cards';
import type { GapRow, RankItem, ScatterPoint, AnomalyFlag } from '@/components/dashboard/shared/peer-comparison-cards';
import { ItemLevelComparison } from './peer-comparison/items-table';
import { TrendChartCard } from './peer-comparison/trend-chart';
import { CorrelationInsightCard } from './peer-comparison/correlation-insight-card';

// Re-export shared types so callers importing from this file still work.
export type {
  PeerRow, MetricDef, ItemComparisonResponse, TrendResponse, PeerAverages,
};

// ------------------------------------------------------------
//  Pre-compute helpers — Peer Tab-specific card value computation.
//  Each caller (Peer Tab + Item Trend Tab) computes its own values
//  from its own row type, then passes them to the shared
//  presentational cards (see shared/peer-comparison-cards).
// ------------------------------------------------------------

/** Peer Tab efficiency score — composite 0-100 based on target vs peer avg.
 *  Penalty: devBom (50pts) + totalLoss (25pts) + residualQty (15pts) + sales (10pts). */
function computePeerEfficiencyScore(target: PeerRow, peerAvg: PeerAverages): number {
  const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
  const avg = (k: string) => peerAvg[k] as number;
  const devBomPenalty = Math.min(50, safeDiv(target.devBom - avg('devBom'), avg('devBom')) * 25);
  const lossPenalty = Math.min(25, safeDiv(target.totalLoss - avg('totalLoss'), avg('totalLoss')) * 12.5);
  const residualPenalty = Math.min(15, safeDiv(target.residualQty - avg('residualQty'), avg('residualQty')) * 7.5);
  const salesPenalty = Math.min(10, Math.max(0, safeDiv(avg('sales') - target.sales, avg('sales')) * 10));
  const raw = 100 - (devBomPenalty + lossPenalty + residualPenalty + salesPenalty);
  return Math.max(0, Math.min(100, raw));
}

/** Peer Tab gap rows — Dev/BOM, Total LOSS, Residual, Sales.
 *  Best = min for bad metrics, max for Sales. */
function computePeerGapRows(target: PeerRow, peers: PeerRow[]): GapRow[] {
  const gapMetrics: Array<{ key: keyof PeerRow; label: string; format: (v: number) => string; higherBetter: boolean }> = [
    { key: 'devBom',      label: 'Dev/BOM',     format: (v) => fmtPctAbs(v), higherBetter: false },
    { key: 'totalLoss',   label: 'Total LOSS',  format: fmtIDR,              higherBetter: false },
    { key: 'residualQty', label: 'Residual',    format: fmtNum,              higherBetter: false },
    { key: 'sales',       label: 'Sales',       format: fmtIDR,              higherBetter: true  },
  ];
  return gapMetrics.map(m => {
    const targetVal = target[m.key] as number;
    const values = peers.map(p => p[m.key] as number);
    const bestVal = m.higherBetter ? Math.max(...values) : Math.min(...values);
    const gap = targetVal - bestVal;
    const pctAboveBest = bestVal !== 0 ? (gap / Math.abs(bestVal)) * 100 : 0;
    return {
      label: m.label,
      targetVal,
      bestVal,
      pctAboveBest,
      format: m.format,
      higherBetter: m.higherBetter,
    };
  });
}

/** Peer Tab scatter points — X=sales, Y=devBom*100.
 *  FIX (PATTERN-2): add "vs peer avg" Dev/BOM comparison to tooltip. */
function computePeerScatterPoints(peers: PeerRow[], targetCode: string | undefined, peerAvg: PeerAverages): ScatterPoint[] {
  return peers.map(p => ({
    x: p.sales,
    y: p.devBom * 100, // convert ratio → %
    label: p.outletName,
    isTarget: p.outletCode === targetCode,
    tooltipLines: [
      { label: 'Sales', value: fmtIDR(p.sales) },
      { label: 'Dev/BOM', value: `${(p.devBom * 100).toFixed(1)}%` },
      // FIX (PATTERN-2): add vs peer avg comparison (downIsGood for Dev/BOM).
      {
        label: 'vs peer avg',
        value: peerAvg.devBom !== 0
          ? `${p.devBom > peerAvg.devBom ? '+' : ''}${((p.devBom - peerAvg.devBom) / Math.abs(peerAvg.devBom) * 100).toFixed(1)}%`
          : '—',
      },
    ],
  }));
}

/** Peer Tab ranking items — ranks for sales, devBom, totalLoss, residualQty,
 *  nominalDeviasi, qtyWaste. Rank 1 = best, N = worst. */
function computePeerRankItems(target: PeerRow, peers: PeerRow[]): { items: RankItem[]; total: number } {
  const total = peers.length;
  const keyMetrics: Array<{ key: keyof PeerRow; label: string; higherBetter: boolean }> = [
    { key: 'sales',          label: 'Sales',          higherBetter: true  },
    { key: 'devBom',         label: 'Dev/BOM',        higherBetter: false },
    { key: 'totalLoss',      label: 'Total LOSS',     higherBetter: false },
    { key: 'residualQty',    label: 'Residual',       higherBetter: false },
    { key: 'nominalDeviasi', label: 'Nominal Deviasi', higherBetter: false },
    { key: 'qtyWaste',       label: 'QTY Waste',      higherBetter: false },
  ];
  const rankColor = (rank: number, t: number) => {
    if (rank === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
    if (rank === t) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
    if (rank <= t / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
    return 'bg-muted text-muted-foreground';
  };
  const items: RankItem[] = keyMetrics.map(m => {
    const sorted = [...peers].sort((a, b) => {
      const av = a[m.key] as number;
      const bv = b[m.key] as number;
      // For higherBetter: highest = best = rank 1 → sort descending.
      // For bad metrics (lower better): lowest = best = rank 1 → sort ascending.
      return m.higherBetter ? bv - av : av - bv;
    });
    const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
    const best = rank === 1;
    const worst = rank === total;
    return {
      label: m.label,
      badgeContent: `#${rank}/${total}`,
      badgeClass: rankColor(rank, total),
      variant: 'secondary',
      star: best,
      warn: worst,
    };
  });
  return { items, total };
}

/** Peer Tab anomaly flags per row — checks devBom, totalLoss, residualQty, sales.
 *  Returns the pre-computed AnomalyFlag[] for the shared AnomalyFlags component. */
function computePeerAnomalyFlags(row: PeerRow, peerAvg: PeerAverages): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const avgVal = (k: keyof PeerRow) => peerAvg[k as string] as number;
  const checkRatio = (targetVal: number, avg: number) => (avg > 0 ? targetVal / avg : 0);

  if (checkRatio(row.devBom, avgVal('devBom')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Dev/BOM tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.totalLoss, avgVal('totalLoss')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'LOSS tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.residualQty, avgVal('residualQty')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Residual tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.sales, avgVal('sales')) < 0.8 && avgVal('sales') > 0) {
    flags.push({ emoji: '🟡', text: 'Sales rendah', color: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30' });
  }

  const allNormal =
    flags.length === 0 &&
    Math.abs(row.devBom - avgVal('devBom')) <= avgVal('devBom') * 0.2 &&
    Math.abs(row.totalLoss - avgVal('totalLoss')) <= avgVal('totalLoss') * 0.2 &&
    Math.abs(row.residualQty - avgVal('residualQty')) <= avgVal('residualQty') * 0.2 &&
    Math.abs(row.sales - avgVal('sales')) <= avgVal('sales') * 0.2;

  if (allNormal) {
    flags.push({ emoji: '🟢', text: 'Normal', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' });
  }

  return flags;
}

export function PeerComparison() {
  const { focusOutlet, outletCode, monthLabel, currentWeek, setFocusOutlet, kelompok } = useDashboard(useShallow((s) => ({
    focusOutlet: s.focusOutlet,
    outletCode: s.outletCode,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    setFocusOutlet: s.setFocusOutlet,
    kelompok: s.kelompok,
  })));
  const activeOutlet = focusOutlet || outletCode;
  // Fixed: mode='week' (follows currentWeek from main FilterBar), peerLimit=50.
  // No dropdowns — peer scope is always top 50 by sales proximity for the
  // selected week.
  const mode: 'week' | 'month' = 'week';
  const peerLimit = 50;

  // ============================================================
  //  P1 PARALLEL QUERIES — all 3 useQuery hooks fire on mount.
  //  Previously the items + trend sub-components were gated by
  //  `targetRow &&` (only mounted AFTER the main query resolved),
  //  creating a 3-stage waterfall: main → items → trend.
  //  Now: main + items fire in parallel (independent inputs:
  //  outlet/month/week/mode); trend waits for peerCodes from main
  //  (stable peer set across weeks requires the main query's peer
  //  list — `enabled` waits for peerCodes to avoid a wasted first
  //  fetch with empty peers that would auto-compute per-week and
  //  then immediately refetch).
  // ============================================================
  const { data: mainData, isLoading: mainLoading, isFetching: mainFetching, error: mainError, refetch: refetchMain } = useQuery({
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok added to queryKey so TanStack
    // refetches when kelompok changes. Without this, switching kelompok would
    // show stale (unfiltered) peer data.
    queryKey: ['peer-comparison', activeOutlet, monthLabel, currentWeek, peerLimit, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('limit', String(peerLimit));
      // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): pass kelompok so peer scope respects the global filter.
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json();
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
    // FIX #20: keepPreviousData so switching outlet shows smooth transition
    // (old peers stay visible) instead of a full loading skeleton flash.
    placeholderData: keepPreviousData,
  });

  // Derive peer set from main query result (empty while loading).
  // `peerCodes` is consumed by the trend query below for a stable
  // peer set across weeks (avoids per-week auto-compute drift).
  // FIX (AUDIT-FRONTEND-V2): memoize derived state — was recomputed on every render.
  const peers: PeerRow[] = useMemo(() => mainData?.peers || [], [mainData]);
  const targetRow = useMemo(() => peers.find((p) => p.isTarget), [peers]);
  const otherPeers = useMemo(() => peers.filter((p) => !p.isTarget), [peers]);
  const peerCodes = useMemo(() => otherPeers.map((p) => p.outletCode), [otherPeers]);
  const peerCodesKey = useMemo(() => peerCodes.join(','), [peerCodes]);

  // Items query — independent inputs, fires in parallel with main.
  const { data: itemsData, isLoading: itemsLoading, error: itemsError } = useQuery({
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok added to queryKey + URL params.
    queryKey: ['peer-comparison', 'items', activeOutlet, monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('topItems', '5');
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison/items?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<ItemComparisonResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
  });

  // Trend query — depends on peerCodes from main for stable peer
  // set across weeks. `enabled` waits for peerCodes.
  const { data: trendData, isLoading: trendLoading, error: trendError } = useQuery({
    // FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok added to queryKey + URL params.
    // peerCodesKey already changes when kelompok changes (main query refetches
    // → peerCodes recomputed), but adding kelompok explicitly makes the cache
    // key stable + explicit.
    queryKey: ['peer-comparison', 'trend', activeOutlet, monthLabel, peerCodesKey, kelompok],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (peerCodes.length > 0) p.set('peers', peerCodes.slice(0, 20).join(','));
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/peer-comparison/trend?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<TrendResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && peerCodes.length > 0),
  });

  // Peer averages object (used by subcomponents) — memoized
  // FIX (rules-of-hooks): moved BEFORE early return so hooks are called unconditionally.
  const peerAverages: PeerAverages = useMemo(() => {
    const cnt = otherPeers.length;
    const avg = (field: keyof PeerRow) =>
      cnt > 0 ? otherPeers.reduce((s, p) => s + (p[field] as number), 0) / cnt : 0;
    return {
      sales: avg('sales'),
      nominalDeviasi: avg('nominalDeviasi'),
      devBom: avg('devBom'),
      totalLoss: avg('totalLoss'),
      totalSurplus: avg('totalSurplus'),
      qtyWaste: avg('qtyWaste'),
      qtySusut: avg('qtySusut'),
      qtyTrial: avg('qtyTrial'),
      qtyLossSurplus: avg('qtyLossSurplus'),
      residualQty: avg('residualQty'),
      itemCount: avg('itemCount'),
    };
  }, [otherPeers]);

  // Pre-computed card values — memoized to preserve original performance
  // characteristics (the old EfficiencyScoreCard memoized internally).
  // Hooks are unconditional — safe to compute even when targetRow is null
  // (the JSX guards against rendering with null target).
  const efficiencyScore = useMemo(
    () => targetRow ? computePeerEfficiencyScore(targetRow, peerAverages) : 0,
    [targetRow, peerAverages],
  );
  const gapRows = useMemo(
    () => targetRow ? computePeerGapRows(targetRow, otherPeers) : [],
    [targetRow, otherPeers],
  );
  // scatterPoints + rankData use `peers` directly (the JSX guards the render
  // with `otherPeers.length > 0`, so we don't need to gate inside useMemo —
  // when peers is empty, the result is just an empty array / null).
  const scatterPoints = useMemo(
    () => computePeerScatterPoints(peers, targetRow?.outletCode, peerAverages),
    [peers, targetRow, peerAverages],
  );
  const rankData = useMemo(
    () => targetRow ? computePeerRankItems(targetRow, peers) : null,
    [targetRow, peers],
  );

  if (!activeOutlet) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="py-16 text-center">
          <div className="flex flex-col items-center">
            <div className="relative mb-4">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-200/30 to-emerald-200/30 dark:from-amber-900/20 dark:to-emerald-900/20 blur-xl" aria-hidden />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50">
                <Users className="h-7 w-7" />
              </div>
            </div>
            <p className="text-sm font-medium text-muted-foreground">Pilih outlet untuk melihat Peer Comparison</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Sistem akan mencari resto dengan sales ±10% sebagai peer group</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const columns: MetricDef[] = COLUMNS;

  return (
    <div className="space-y-4">
      {/* ============ 1. HEADER + EXISTING TABLE ============ */}
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-start gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
                <Users className="h-3.5 w-3.5" />
              </span>
              <div>
                <CardTitle className="text-sm flex items-center gap-2">
                  Peer Comparison
                  <InfoTooltip content="Target outlet dibandingkan dengan peer set (top 50 by sales proximity, ±10% sales). Metrics: Sales, Dev/BOM, Nominal, QTY, Gross/Net Loss/Surplus. Klik baris untuk ganti target." />
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                  <span className="font-medium text-foreground">{activeOutlet}</span> vs <span className="font-medium tabular-nums">{otherPeers.length}</span> resto dengan sales ±10%{currentWeek ? ` (WEEK ${currentWeek})` : ''}
                </p>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* ============ 2-5. ANALYSIS CARDS (grid 2 cols on desktop) ============ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {targetRow && otherPeers.length > 0 && (
          <EfficiencyScoreCard
            score={efficiencyScore}
            footnote="Komposit dari Dev/BOM (50%), LOSS (25%), Residual (15%), Sales (10%). Higher = better."
          />
        )}
        {targetRow && otherPeers.length > 0 && (
          <GapAnalysisCard
            rows={gapRows}
            footerText='Untuk metrik "buruk" (Dev/BOM, LOSS, Residual), peer best = nilai terendah. Untuk Sales, peer best = nilai tertinggi.'
            gridCols={2}
          />
        )}
        {targetRow && otherPeers.length > 0 && rankData && (
          <RankingSummaryCard
            items={rankData.items}
            subtitle={
              <>
                <span className="font-medium text-foreground">{targetRow.outletName}</span> ranked di antara{' '}
                <span className="font-medium tabular-nums">{rankData.total}</span> resto (1 = terbaik,{' '}
                <span className="tabular-nums">{rankData.total}</span> = terburuk).
              </>
            }
            gridCols={3}
            itemLayout="horizontal"
          />
        )}
        {otherPeers.length > 0 && (
          <ScatterPlotCard
            points={scatterPoints}
            title="Sales vs Dev/BOM"
            subtitle="Setiap titik = 1 resto. Target ditandai merah. Posisi kanan-bawah = sales tinggi & deviasi rendah (ideal)."
            height={280}
            xLabel="Sales"
            yLabel="Dev/BOM"
            yUnit="%"
            formatX={fmtIDR}
            formatY={(v: number) => String(v)}
            colorMode="target-only"
            legend={[
              { label: 'Target', color: 'bg-red-600' },
              { label: 'Peer', color: 'bg-zinc-500' },
            ]}
          />
        )}
      </div>

      {/* ============ 6. PEER TABLE + ANOMALY FLAGS (Feature 5) ============ */}
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
              <BarChart3 className="h-3.5 w-3.5" />
            </span>
            Peer Table
            {otherPeers.length > 0 && <span className="text-muted-foreground text-xs font-normal">dengan Anomaly Flags</span>}
            {mainFetching && !mainLoading && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {mainLoading ? (
            <div className="py-12 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            </div>
          ) : !mainData && !mainError ? (
            // FIX FE-1: When query is disabled (e.g., no outlet selected), show
            // "waiting" state instead of "Error: Unknown" (!mainData?.success = true)
            <p className="text-center text-muted-foreground py-12 text-sm">
              Pilih outlet untuk melihat peer comparison
            </p>
          ) : mainError || !mainData?.success ? (
            <div className="py-10 text-center">
              <p className="text-red-600 dark:text-red-400 font-medium">Gagal Memuat Data</p>
              <p className="text-xs text-muted-foreground mt-1">{mainError?.message || mainData?.error || 'Unknown'}</p>
              {/* FIX #20: retry button so users can recover from transient errors */}
              <Button onClick={() => refetchMain()} variant="outline" size="sm" className="mt-3">
                <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
              </Button>
            </div>
          ) : peers.length === 0 ? (
            <div className="text-center text-muted-foreground text-xs py-6 space-y-2">
              <p>Tidak ada peer ditemukan untuk outlet ini.</p>
              <p className="text-xs">Kemungkinan outlet tidak memiliki data sales (PENJUALAN) pada periode ini, atau tidak ada resto lain dengan sales ±10%.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <Table className="min-w-[1400px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-xs font-semibold uppercase tracking-wider sticky left-0 bg-muted/40 dark:bg-zinc-900/40 backdrop-blur-sm z-20">Resto</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider">Area</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider">PIC</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider">Top Item</TableHead>
                    {columns.map(col => (
                      <TableHead key={col.key} className="text-xs font-semibold uppercase tracking-wider text-right">{col.label}</TableHead>
                    ))}
                    <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">Dir</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Peer Average Row */}
                  {otherPeers.length > 0 && (
                    <TableRow className="border-b-2 border-foreground/20 bg-muted/50 dark:bg-zinc-900/50 font-medium">
                      <TableCell className="text-[11px] font-bold sticky left-0 bg-muted/50 dark:bg-zinc-900/50 z-10">📊 Peer Avg</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">—</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">—</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">—</TableCell>
                      {columns.map(col => (
                        <TableCell key={col.key} className="text-[11px] text-right text-muted-foreground font-mono tabular-nums">
                          {col.format(peerAverages[col.key] as number)}
                        </TableCell>
                      ))}
                      <TableCell className="text-[11px] text-center text-muted-foreground">—</TableCell>
                      <TableCell className="text-[11px] text-center text-muted-foreground">—</TableCell>
                    </TableRow>
                  )}
                  {/* Outlet Rows */}
                  {peers.map((p, i) => (
                    <TableRow
                      key={p.outletCode}
                      className={`cursor-pointer hover:bg-muted/40 transition-colors ${p.isTarget ? 'bg-amber-50/60 dark:bg-amber-950/20 border-l-2 border-l-amber-500' : i % 2 === 1 ? 'bg-muted/20' : ''}`}
                      {...clickableRowProps(() => setFocusOutlet(p.outletCode))}
                    >
                      <TableCell className="text-[11px] font-medium sticky left-0 bg-background z-10">
                        <div className="flex items-center gap-1.5">
                          {p.isTarget && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />}
                          <span className="truncate">{p.outletName}</span>
                        </div>
                        {p.isTarget && <Badge variant="default" className="text-[11px] ml-3 h-4 bg-amber-600 hover:bg-amber-600 text-white">TARGET</Badge>}
                        <div className="text-xs text-muted-foreground">{p.outletCode}</div>
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{p.area}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{p.pic || '—'}</TableCell>
                      <TableCell className="text-[11px] max-w-[160px] truncate" title={p.topItem || ''}>{p.topItem || '—'}</TableCell>
                      {columns.map(col => {
                        const val = p[col.key] as number;
                        const colorClass = p.isTarget ? colorCell(val, peerAverages[col.key] as number, otherPeers.length, col.higherBetter) : '';
                        return (
                          <TableCell key={col.key} className={`text-[11px] text-right font-mono tabular-nums ${colorClass}`}>
                            {col.format(val)}
                          </TableCell>
                        );
                      })}
                      <TableCell className={`text-[11px] text-center font-bold ${p.direction === 'LOSS' ? 'text-red-600 dark:text-red-400' : p.direction === 'SURPLUS' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {p.direction?.[0] || '—'}
                      </TableCell>
                      <TableCell className="text-[11px] text-center">
                        <AnomalyFlags flags={computePeerAnomalyFlags(p, peerAverages)} textSize="11px" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="p-3 text-xs text-muted-foreground border-t bg-muted/20 dark:bg-zinc-900/20">
            💡 Klik baris untuk deep dive ke Resto Analysis. <span className="text-emerald-600 dark:text-emerald-400 font-medium">Hijau</span> = lebih baik dari peer avg, <span className="text-red-600 dark:text-red-400 font-medium">Merah</span> = lebih buruk.
            Sales range: ±10% dari <span className="font-medium tabular-nums">{targetRow ? fmtIDR(targetRow.sales) : 'target'}</span>.
          </div>
        </CardContent>
      </Card>

      {/* ============ 7. ITEM-LEVEL COMPARISON (Feature 3) ============ */}
      {/* Always mounted (P1) — fires its query in parallel with the
          main query. Own loading/error states inside. */}
      <ItemLevelComparison
        data={itemsData}
        isLoading={itemsLoading}
        error={itemsError}
      />

      {/* ============ 8. TREND CHART (Feature 6) ============ */}
      {/* Always mounted (P1) — fires once peerCodes from main are
          available (stable peer set across weeks). Own loading/error. */}
      <TrendChartCard
        data={trendData}
        isLoading={trendLoading}
        error={trendError}
      />

      {/* ============ 9. CORRELATION INSIGHT (Feature 9) ============ */}
      {targetRow && otherPeers.length > 0 && (
        <CorrelationInsightCard target={targetRow} peers={otherPeers} peerAvg={peerAverages} />
      )}
    </div>
  );
}
