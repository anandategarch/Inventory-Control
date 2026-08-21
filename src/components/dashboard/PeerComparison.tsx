'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, Loader2, Lightbulb, TrendingUp, Target, BarChart3, Award, Gauge, Sparkles } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useState, useMemo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
  LineChart, Line, Legend,
} from 'recharts';

// ============================================================
//  Types
// ============================================================
interface PeerRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  sales: number;
  nominalDeviasi: number;
  devBom: number;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  totalLoss: number;
  totalSurplus: number;
  residualQty: number;
  itemCount: number;
  topItem: string | null;
  topItemNominal: number;
  direction: string;
  isTarget: boolean;
}

interface MetricDef {
  key: keyof PeerRow;
  label: string;
  format: (v: number) => string;
  higherBetter: boolean;
}

// ============================================================
//  Peer Comparison — main component
//  Adds 8 analysis features above/below the existing peer table:
//   #1 Ranking Summary, #2 Gap Analysis, #3 Item-Level Comparison,
//   #4 Scatter Plot, #5 Anomaly Flags, #6 Trend Chart,
//   #7 Efficiency Score, #9 Correlation Insight
// ============================================================
export function PeerComparison() {
  const { focusOutlet, outletCode, monthLabel, currentWeek, setFocusOutlet } = useDashboard();
  const activeOutlet = focusOutlet || outletCode;
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [peerLimit, setPeerLimit] = useState(10);

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
  const { data: mainData, isLoading: mainLoading, isFetching: mainFetching, error: mainError } = useQuery({
    queryKey: ['peer-comparison', activeOutlet, monthLabel, currentWeek, mode, peerLimit],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (mode === 'week' && currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('limit', String(peerLimit));
      const res = await fetch(`/api/peer-comparison?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json();
    },
    enabled: Boolean(activeOutlet && monthLabel && (mode === 'month' || currentWeek)),
  });

  // Derive peer set from main query result (empty while loading).
  // `peerCodes` is consumed by the trend query below for a stable
  // peer set across weeks (avoids per-week auto-compute drift).
  const peers: PeerRow[] = mainData?.peers || [];
  const targetRow = peers.find((p) => p.isTarget);
  const otherPeers = peers.filter((p) => !p.isTarget);
  const peerCodes = otherPeers.map((p) => p.outletCode);

  // Items query — independent inputs, fires in parallel with main.
  const { data: itemsData, isLoading: itemsLoading, error: itemsError } = useQuery({
    queryKey: ['peer-comparison', 'items', activeOutlet, monthLabel, currentWeek, mode],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (mode === 'week' && currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('topItems', '5');
      const res = await fetch(`/api/peer-comparison/items?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<ItemComparisonResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && (mode === 'month' || currentWeek)),
  });

  // Trend query — depends on peerCodes from main for stable peer
  // set across weeks. `enabled` waits for peerCodes.
  const { data: trendData, isLoading: trendLoading, error: trendError } = useQuery({
    queryKey: ['peer-comparison', 'trend', activeOutlet, monthLabel, peerCodes.join(',')],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (peerCodes.length > 0) p.set('peers', peerCodes.slice(0, 20).join(','));
      const res = await fetch(`/api/peer-comparison/trend?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<TrendResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && peerCodes.length > 0),
  });

  if (!activeOutlet) {
    return (
      <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
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

  // Compute peer averages (excluding target)
  const peerCount = otherPeers.length;
  const avg = (field: keyof PeerRow) =>
    peerCount > 0 ? otherPeers.reduce((s, p) => s + (p[field] as number), 0) / peerCount : 0;

  const avgSales = avg('sales');
  const avgNominalDeviasi = avg('nominalDeviasi');
  const avgDevBom = avg('devBom');
  const avgTotalLoss = avg('totalLoss');
  const avgTotalSurplus = avg('totalSurplus');
  const avgQtyWaste = avg('qtyWaste');
  const avgQtySusut = avg('qtySusut');
  const avgQtyTrial = avg('qtyTrial');
  const avgQtyLossSurplus = avg('qtyLossSurplus');
  const avgResidualQty = avg('residualQty');
  const avgItemCount = avg('itemCount');

  const colorCell = (targetVal: number, avgVal: number, higherIsBetter: boolean = false) => {
    if (peerCount === 0) return '';
    const diff = targetVal - avgVal;
    if (Math.abs(diff) < 0.001) return 'text-muted-foreground';
    const isBetter = higherIsBetter ? diff > 0 : diff < 0;
    return isBetter ? 'text-emerald-600 font-semibold' : 'text-red-600 font-semibold';
  };

  const columns: MetricDef[] = [
    { key: 'sales', label: 'Sales', format: fmtIDR, higherBetter: true },
    { key: 'nominalDeviasi', label: 'Nominal Deviasi', format: fmtIDR, higherBetter: false },
    { key: 'devBom', label: 'Dev/BOM', format: (v: number) => fmtPctAbs(v), higherBetter: false },
    { key: 'totalLoss', label: 'Total LOSS', format: fmtIDR, higherBetter: false },
    { key: 'totalSurplus', label: 'Total SURPLUS', format: fmtIDR, higherBetter: true },
    { key: 'qtyWaste', label: 'QTY Waste', format: fmtNum, higherBetter: false },
    { key: 'qtySusut', label: 'QTY Susut', format: fmtNum, higherBetter: false },
    { key: 'qtyTrial', label: 'QTY Trial', format: fmtNum, higherBetter: false },
    { key: 'qtyLossSurplus', label: 'QTY LS', format: fmtNum, higherBetter: false },
    { key: 'residualQty', label: 'Residual', format: fmtNum, higherBetter: false },
    { key: 'itemCount', label: 'Item Count', format: (v: number) => String(v), higherBetter: true },
  ];

  // Peer averages object (used by subcomponents)
  const peerAverages = {
    sales: avgSales,
    nominalDeviasi: avgNominalDeviasi,
    devBom: avgDevBom,
    totalLoss: avgTotalLoss,
    totalSurplus: avgTotalSurplus,
    qtyWaste: avgQtyWaste,
    qtySusut: avgQtySusut,
    qtyTrial: avgQtyTrial,
    qtyLossSurplus: avgQtyLossSurplus,
    residualQty: avgResidualQty,
    itemCount: avgItemCount,
  };

  return (
    <div className="space-y-4">
      {/* ============ 1. HEADER + EXISTING TABLE ============ */}
      <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-start gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
                <Users className="h-3.5 w-3.5" />
              </span>
              <div>
                <CardTitle className="text-base">Peer Comparison</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                  <span className="font-medium text-foreground">{activeOutlet}</span> vs <span className="font-medium tabular-nums">{peerCount}</span> resto dengan sales ±10% ({mode === 'week' ? `WEEK ${currentWeek}` : 'Bulan'})
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'week' | 'month')}
                className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
                aria-label="Mode periode"
              >
                <option value="week">Per Week</option>
                <option value="month">Per Bulan</option>
              </select>
              <select
                value={String(peerLimit)}
                onChange={(e) => setPeerLimit(parseInt(e.target.value))}
                className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
                aria-label="Jumlah peer"
              >
                <option value="5">Top 5</option>
                <option value="10">Top 10</option>
                <option value="20">Top 20</option>
                <option value="50">Top 50</option>
              </select>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* ============ 2-5. ANALYSIS CARDS (grid 2 cols on desktop) ============ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {targetRow && peerCount > 0 && (
          <EfficiencyScoreCard target={targetRow} peerAvg={peerAverages} />
        )}
        {targetRow && peerCount > 0 && (
          <GapAnalysisCard target={targetRow} peers={otherPeers} columns={columns} />
        )}
        {targetRow && peerCount > 0 && (
          <RankingSummaryCard target={targetRow} peers={peers} columns={columns} />
        )}
        {peerCount > 0 && (
          <ScatterPlotCard peers={peers} targetCode={targetRow?.outletCode} />
        )}
      </div>

      {/* ============ 6. PEER TABLE + ANOMALY FLAGS (Feature 5) ============ */}
      <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
              <BarChart3 className="h-3.5 w-3.5" />
            </span>
            Peer Table
            {peerCount > 0 && <span className="text-muted-foreground text-xs font-normal">dengan Anomaly Flags</span>}
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
            </div>
          ) : peers.length === 0 ? (
            <div className="text-center text-muted-foreground text-xs py-6 space-y-2">
              <p>Tidak ada peer ditemukan untuk outlet ini.</p>
              <p className="text-[10px]">Kemungkinan outlet tidak memiliki data sales (PENJUALAN) pada periode ini, atau tidak ada resto lain dengan sales ±10%.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <Table className="min-w-[1400px]">
                <TableHeader className="sticky top-0 bg-muted/40 dark:bg-zinc-900/40 backdrop-blur-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider sticky left-0 bg-muted/40 dark:bg-zinc-900/40 backdrop-blur-sm z-20">Resto</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Area</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider">PIC</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Top Item</TableHead>
                    {columns.map(col => (
                      <TableHead key={col.key} className="text-[10px] font-semibold uppercase tracking-wider text-right">{col.label}</TableHead>
                    ))}
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-center">Dir</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-center">Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Peer Average Row */}
                  {peerCount > 0 && (
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
                        {p.isTarget && <Badge variant="default" className="text-[9px] ml-3 h-4 bg-amber-600 hover:bg-amber-600 text-white">TARGET</Badge>}
                        <div className="text-[10px] text-muted-foreground">{p.outletCode}</div>
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{p.area}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{p.pic || '—'}</TableCell>
                      <TableCell className="text-[11px] max-w-[120px] truncate" title={p.topItem || ''}>{p.topItem || '—'}</TableCell>
                      {columns.map(col => {
                        const val = p[col.key] as number;
                        const colorClass = p.isTarget ? colorCell(val, peerAverages[col.key] as number, col.higherBetter) : '';
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
                        <AnomalyFlags row={p} peerAvg={peerAverages} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="p-3 text-[10px] text-muted-foreground border-t bg-muted/20 dark:bg-zinc-900/20">
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
      {targetRow && peerCount > 0 && (
        <CorrelationInsightCard target={targetRow} peers={otherPeers} peerAvg={peerAverages} />
      )}
    </div>
  );
}

// ============================================================
//  Feature 7: Efficiency Score — composite 0-100
// ============================================================
function EfficiencyScoreCard({ target, peerAvg }: { target: PeerRow; peerAvg: Record<string, number> }) {
  const score = useMemo(() => {
    const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
    const devBomPenalty = Math.min(50, safeDiv(target.devBom - peerAvg.devBom, peerAvg.devBom) * 25);
    const lossPenalty = Math.min(25, safeDiv(target.totalLoss - peerAvg.totalLoss, peerAvg.totalLoss) * 12.5);
    const residualPenalty = Math.min(15, safeDiv(target.residualQty - peerAvg.residualQty, peerAvg.residualQty) * 7.5);
    const salesPenalty = Math.min(10, Math.max(0, safeDiv(peerAvg.sales - target.sales, peerAvg.sales) * 10));
    const raw = 100 - (devBomPenalty + lossPenalty + residualPenalty + salesPenalty);
    return Math.max(0, Math.min(100, raw));
  }, [target, peerAvg]);

  const peerAvgScore = 50; // peer avg by definition sits at ~50 (no penalty no bonus)
  const color = score > 70 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';
  const textColor = score > 70 ? 'text-emerald-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  const label = score > 70 ? 'Di atas peer average' : score >= 50 ? 'Sekitar peer average' : 'Di bawah peer average';

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0">
            <Gauge className="h-3.5 w-3.5" />
          </span>
          Efficiency Score
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-end justify-between">
          <div>
            <span className={`text-3xl font-bold tabular-nums ${textColor}`}>{score.toFixed(0)}</span>
            <span className="text-sm text-muted-foreground ml-0.5">/100</span>
          </div>
          <div className="text-right text-xs">
            <div className="text-muted-foreground tabular-nums">Peer Avg: ~{peerAvgScore}/100</div>
            <div className={`font-medium ${textColor}`}>{label}</div>
          </div>
        </div>
        <div className="relative h-3 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${score}%` }} />
          {/* Peer average marker */}
          <div className="absolute top-0 h-full w-0.5 bg-foreground/40" style={{ left: '50%' }} title="Peer avg ~50" />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Komposit dari Dev/BOM (50%), LOSS (25%), Residual (15%), Sales (10%). Higher = better.
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  Feature 2: Gap Analysis — target vs peer BEST (not avg)
// ============================================================
function GapAnalysisCard({
  target,
  peers,
  columns,
}: {
  target: PeerRow;
  peers: PeerRow[];
  columns: MetricDef[];
}) {
  // Metrics to show in gap analysis (focus on the bad ones + sales)
  const gapMetrics: Array<{ key: keyof PeerRow; label: string; format: (v: number) => string; higherBetter: boolean }> = [
    { key: 'devBom', label: 'Dev/BOM', format: (v) => fmtPctAbs(v), higherBetter: false },
    { key: 'totalLoss', label: 'Total LOSS', format: fmtIDR, higherBetter: false },
    { key: 'residualQty', label: 'Residual', format: fmtNum, higherBetter: false },
    { key: 'sales', label: 'Sales', format: fmtIDR, higherBetter: true },
  ];

  const rows = gapMetrics.map(m => {
    const targetVal = target[m.key] as number;
    const values = peers.map(p => p[m.key] as number);
    // For bad metrics: best = min. For good metrics: best = max.
    const bestVal = m.higherBetter ? Math.max(...values) : Math.min(...values);
    const gap = targetVal - bestVal;
    // % above best — for bad metrics, gap > 0 = worse than best
    const pctAboveBest = bestVal !== 0 ? (gap / Math.abs(bestVal)) * 100 : 0;
    const isWorse = m.higherBetter ? gap < 0 : gap > 0;
    return { ...m, targetVal, bestVal, gap, pctAboveBest, isWorse };
  });

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Gap Analysis (vs Peer Best)
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">Membandingkan target dengan peer TERBAIK (bukan rata-rata).</p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map(r => (
            <div key={r.key as string} className="rounded-lg border bg-muted/20 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">{r.label}</span>
                <Badge variant="outline" className={`text-[9px] h-4 font-medium ${r.isWorse ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30' : 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'}`}>
                  {r.isWorse ? 'di bawah best' : 'di atas best'}
                </Badge>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums">
                <span className="font-semibold">{r.format(r.targetVal)}</span>
                <span className="text-muted-foreground"> vs best </span>
                <span className="text-emerald-600 dark:text-emerald-400">{r.format(r.bestVal)}</span>
              </div>
              <div className={`text-[11px] font-semibold tabular-nums ${r.isWorse ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {r.gap >= 0 ? '+' : ''}{r.format(r.gap)}
                {r.pctAboveBest !== 0 && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    ({r.pctAboveBest >= 0 ? '+' : ''}{r.pctAboveBest.toFixed(0)}% vs best)
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Untuk metrik &quot;buruk&quot; (Dev/BOM, LOSS, Residual), peer best = nilai terendah.
          Untuk Sales, peer best = nilai tertinggi.
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  Feature 1: Ranking Summary — target's rank per metric
// ============================================================
function RankingSummaryCard({
  target,
  peers,
  columns,
}: {
  target: PeerRow;
  peers: PeerRow[];
  columns: MetricDef[];
}) {
  // For each metric, rank all peers (1 = best, N = worst)
  const total = peers.length;
  const ranks = columns.map(col => {
    const sorted = [...peers].sort((a, b) => {
      const av = a[col.key] as number;
      const bv = b[col.key] as number;
      // For higherBetter: highest = best = rank 1 → sort descending
      // For bad metrics (lower better): lowest = best = rank 1 → sort ascending
      return col.higherBetter ? bv - av : av - bv;
    });
    const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
    const worst = rank === total;
    const best = rank === 1;
    return { col, rank, total, worst, best };
  });

  // Show only the most important metrics in the compact summary
  const keyMetrics = ['sales', 'devBom', 'totalLoss', 'residualQty', 'nominalDeviasi', 'qtyWaste'];
  const keyRanks = ranks.filter(r => keyMetrics.includes(r.col.key as string));

  const rankColor = (rank: number, total: number) => {
    if (rank === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
    if (rank === total) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
    if (rank <= total / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
    return 'bg-muted text-muted-foreground';
  };

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Award className="h-3.5 w-3.5" />
          </span>
          Ranking Summary
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          <span className="font-medium text-foreground">{target.outletName}</span> ranked di antara <span className="font-medium tabular-nums">{total}</span> resto (1 = terbaik, <span className="tabular-nums">{total}</span> = terburuk).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {keyRanks.map(({ col, rank, total: t, worst, best }) => (
            <div key={col.key as string} className="flex items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2">
              <span className="text-[11px] text-muted-foreground">{col.label}</span>
              <Badge className={`text-[10px] h-5 font-medium tabular-nums ${rankColor(rank, t)}`} variant="secondary">
                #{rank}/{t}
                {best && ' ★'}
                {worst && ' ⚠'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  Feature 4: Scatter Plot — Sales (X) vs Dev/BOM (Y)
// ============================================================
function ScatterPlotCard({ peers, targetCode }: { peers: PeerRow[]; targetCode?: string }) {
  const data = peers.map(p => ({
    sales: p.sales,
    devBom: p.devBom * 100, // convert ratio → %
    outletName: p.outletName,
    isTarget: p.outletCode === targetCode,
  }));

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          Sales vs Dev/BOM
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Setiap titik = 1 resto. Target ditandai merah. Posisi kanan-bawah = sales tinggi &amp; deviasi rendah (ideal).
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 16, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" className="opacity-60" />
              <XAxis
                type="number"
                dataKey="sales"
                name="Sales"
                tickFormatter={(v) => fmtIDR(v)}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                tickLine={false}
                axisLine={false}
              >
              </XAxis>
              <YAxis
                type="number"
                dataKey="devBom"
                name="Dev/BOM"
                unit="%"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <RTooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as any;
                  return (
                    <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg">
                      <div className="font-semibold border-b pb-1 mb-1">{d.outletName}</div>
                      <div className="text-muted-foreground tabular-nums">Sales: {fmtIDR(d.sales)}</div>
                      <div className="text-muted-foreground tabular-nums">Dev/BOM: {d.devBom.toFixed(1)}%</div>
                      {d.isTarget && <div className="text-red-600 dark:text-red-400 font-semibold mt-1">TARGET</div>}
                    </div>
                  );
                }}
              />
              <Scatter data={data}>
                {data.map((entry, i) => (
                  <Cell
                    key={`cell-${i}`}
                    fill={entry.isTarget ? '#dc2626' : '#71717a'}
                    r={entry.isTarget ? 7 : 4}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-4 text-[10px] text-muted-foreground mt-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600" /> Target
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" /> Peer
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  Feature 5: Anomaly Flags — per-resto badges
// ============================================================
function AnomalyFlags({ row, peerAvg }: { row: PeerRow; peerAvg: Record<string, number> }) {
  const flags: Array<{ emoji: string; text: string; color: string }> = [];
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

  if (flags.length === 0) {
    return <span className="text-muted-foreground text-[10px]">—</span>;
  }

  return (
    <div className="flex flex-col items-center gap-0.5">
      {flags.map((f, i) => (
        <span key={i} className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium ${f.color}`} title={f.text}>
          <span>{f.emoji}</span>
          <span className="sr-only">{f.text}</span>
        </span>
      ))}
    </div>
  );
}

// ============================================================
//  Feature 3: Item-Level Peer Comparison
// ============================================================
interface ItemComparisonResponse {
  success: boolean;
  error?: string;
  items: Array<{
    itemId: number;
    itemName: string;
    target: { qtyDeviasi: number; devBom: number; nominal: number };
    peerAvg: { qtyDeviasi: number; devBom: number; nominal: number };
    peerBest: { qtyDeviasi: number; devBom: number; nominal: number };
    gap: { qtyDeviasi: number; devBom: number; nominal: number; nominalPctAboveBest: number };
    peerCount: number;
    peers: Array<{
      outletCode: string;
      outletName: string;
      isTarget: boolean;
      qtyDeviasi: number;
      devBom: number;
      nominal: number;
      missing: boolean;
    }>;
  }>;
}

function ItemLevelComparison({
  data,
  isLoading,
  error,
}: {
  data: ItemComparisonResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Item-Level Comparison
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Top 5 item di target outlet, dibandingkan dengan peer avg &amp; peer best.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : !data && !error ? (
          // FIX FE-2: When query is disabled (no outlet selected), show waiting state
          // instead of "Error: Unknown" (!data?.success = true when data=undefined)
          <p className="text-center text-xs text-muted-foreground py-6">
            Pilih outlet untuk melihat item-level comparison
          </p>
        ) : error || !data?.success ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400 py-6">
            Error: {error?.message || data?.error || 'Unknown'}
          </p>
        ) : !data.items || data.items.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Tidak ada item dengan deviasi signifikan pada periode ini.
          </p>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {data.items.map((item) => (
              <ItemComparisonBlock key={item.itemId} item={item} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ItemComparisonBlock({
  item,
}: {
  item: ItemComparisonResponse['items'][number];
}) {
  const fmtPctRatio = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
  const rows = [
    { label: 'QTY Deviasi', target: item.target.qtyDeviasi, avg: item.peerAvg.qtyDeviasi, best: item.peerBest.qtyDeviasi, gap: item.gap.qtyDeviasi, format: fmtNum },
    { label: 'Dev/BOM', target: item.target.devBom, avg: item.peerAvg.devBom, best: item.peerBest.devBom, gap: item.gap.devBom, format: fmtPctRatio },
    { label: 'Nominal', target: item.target.nominal, avg: item.peerAvg.nominal, best: item.peerBest.nominal, gap: item.gap.nominal, format: fmtIDR },
  ];

  return (
    <div className="rounded-lg border bg-muted/10 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30 dark:bg-zinc-900/30">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <span className="text-zinc-500 dark:text-zinc-400">📦</span>
          <span className="truncate" title={item.itemName}>{item.itemName}</span>
        </h4>
        <Badge variant="outline" className="text-[9px] h-4 tabular-nums font-medium">{item.peerCount} peer</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="border-b hover:bg-transparent">
            <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7">Metric</TableHead>
            <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7 text-right">Target</TableHead>
            <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7 text-right">Peer Avg</TableHead>
            <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7 text-right">Peer Best</TableHead>
            <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7 text-right">Gap</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(r => {
            // FIX FE-26: isWorse logic must account for signed values (qtyDeviasi, nominal can be negative=LOSS)
            // For signed metrics: "worse" = more negative (bigger loss). Compare ABS magnitudes.
            // For Dev/BOM (always positive ratio): higher = worse.
            const isSigned = r.label === 'QTY Deviasi' || r.label === 'Nominal';
            const isWorse = isSigned
              ? Math.abs(r.target) > Math.abs(r.best)  // bigger magnitude = worse
              : r.gap > 0;  // positive metric: gap > 0 = worse
            return (
              <TableRow key={r.label} className="hover:bg-muted/30 transition-colors">
                <TableCell className="text-[10px] py-1 font-medium">{r.label}</TableCell>
                <TableCell className="text-[10px] py-1 text-right font-mono font-semibold tabular-nums">{r.format(r.target)}</TableCell>
                <TableCell className="text-[10px] py-1 text-right font-mono text-muted-foreground tabular-nums">{r.format(r.avg)}</TableCell>
                <TableCell className="text-[10px] py-1 text-right font-mono text-emerald-600 dark:text-emerald-400 tabular-nums">{r.format(r.best)}</TableCell>
                <TableCell className={`text-[10px] py-1 text-right font-mono font-semibold tabular-nums ${isWorse ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {r.gap >= 0 ? '+' : ''}{r.format(r.gap)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================
//  Feature 6: Trend Chart — Dev/BOM across weeks
// ============================================================
interface TrendResponse {
  success: boolean;
  error?: string;
  weeks: Array<{
    weekLabel: string;
    devBomTarget: number;
    devBomPeerAvg: number;
  }>;
}

function TrendChartCard({
  data,
  isLoading,
  error,
}: {
  data: TrendResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const chartData = (data?.weeks || []).map(w => ({
    week: w.weekLabel,
    target: +(w.devBomTarget * 100).toFixed(2),
    peerAvg: +(w.devBomPeerAvg * 100).toFixed(2),
  }));

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Trend Dev/BOM — Target vs Peer Avg
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Perbandingan Dev/BOM target vs rata-rata peer di setiap minggu bulan ini.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : !data ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Menunggu peer data...
          </p>
        ) : error || !data?.success ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400 py-6">
            Error: {error?.message || data?.error || 'Unknown'}
          </p>
        ) : chartData.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Tidak ada data mingguan pada bulan ini.
          </p>
        ) : (
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" className="opacity-60" />
                <XAxis dataKey="week" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} stroke="hsl(var(--border))" tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  unit="%"
                />
                <RTooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    return (
                      <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg">
                        <div className="font-semibold mb-1 border-b pb-1">{label}</div>
                        {payload.map((pl, i) => (
                          <div key={i} style={{ color: pl.color }} className="tabular-nums">
                            {pl.name}: {(pl.value as number).toFixed(2)}%
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="target"
                  name="Target"
                  stroke="#dc2626"
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: '#dc2626' }}
                  activeDot={{ r: 6 }}
                />
                <Line
                  type="monotone"
                  dataKey="peerAvg"
                  name="Peer Avg"
                  stroke="#71717a"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 3, fill: '#71717a' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  Feature 9: Correlation Insight — auto-detected rules
// ============================================================
function CorrelationInsightCard({
  target,
  peers,
  peerAvg,
}: {
  target: PeerRow;
  peers: PeerRow[];
  peerAvg: Record<string, number>;
}) {
  const insights = useMemo(() => {
    const out: Array<{ type: 'warn' | 'good' | 'info'; text: string }> = [];
    const avgVal = (k: keyof PeerRow) => peerAvg[k as string] as number;
    const safeRatio = (a: number, b: number) => (b > 0 ? a / b : 0);

    // 1. Outlier detection: Dev/BOM > 1.5× peer avg
    const devBomRatio = safeRatio(target.devBom, avgVal('devBom'));
    if (devBomRatio > 1.5) {
      const pctAbove = ((devBomRatio - 1) * 100).toFixed(0);
      out.push({
        type: 'warn',
        text: `Dev/BOM ${(target.devBom * 100).toFixed(1)}% adalah ${pctAbove}% di atas peer average — outlier.`,
      });
    }

    // 2. Best practice detection: lowest Dev/BOM among peers (excluding target)
    if (peers.length > 0) {
      const bestPeer = peers.reduce((best, p) => (p.devBom < best.devBom ? p : best), peers[0]);
      out.push({
        type: 'info',
        text: `${bestPeer.outletName} adalah best practice: Dev/BOM ${(bestPeer.devBom * 100).toFixed(1)}% (terendah di peer group).`,
      });
    }

    // 3. Sales vs Deviation correlation: peers with high sales but low deviasi
    const highSalesLowDev = peers.filter(
      p => p.sales > avgVal('sales') && p.devBom < avgVal('devBom')
    );
    if (highSalesLowDev.length > 0) {
      out.push({
        type: 'good',
        text: `${highSalesLowDev.length} peer dengan sales tinggi tapi deviasi rendah — kemungkinan practice yang bisa direplikasi.`,
      });
    }

    // 4. Residual red flag: > 2× peer avg
    const residualRatio = safeRatio(target.residualQty, avgVal('residualQty'));
    if (residualRatio > 2) {
      out.push({
        type: 'warn',
        text: `Residual ${target.residualQty} adalah ${residualRatio.toFixed(1)}× peer average — potensi data entry error atau fraud.`,
      });
    }

    // 5. LOSS severity
    const lossRatio = safeRatio(target.totalLoss, avgVal('totalLoss'));
    if (lossRatio > 1.5) {
      out.push({
        type: 'warn',
        text: `Total LOSS ${fmtIDR(target.totalLoss)} adalah ${((lossRatio - 1) * 100).toFixed(0)}% di atas peer average — investigasi penyebab utama.`,
      });
    }

    // 6. Sales underperformance
    const salesRatio = safeRatio(target.sales, avgVal('sales'));
    if (salesRatio < 0.9 && salesRatio > 0) {
      out.push({
        type: 'info',
        text: `Sales ${fmtIDR(target.sales)} adalah ${((1 - salesRatio) * 100).toFixed(0)}% di bawah peer average — walaupun dalam ±10% band, target ada di sisi bawah.`,
      });
    }

    // 7. Best in class detection
    if (target.devBom === Math.min(...peers.map(p => p.devBom), target.devBom)) {
      out.push({
        type: 'good',
        text: `Target adalah best in class untuk Dev/BOM — pertahankan practice saat ini.`,
      });
    }

    return out;
  }, [target, peers, peerAvg]);

  if (insights.length === 0) {
    return null;
  }

  const colorByType = (t: string) =>
    t === 'warn'
      ? 'border-l-red-500 bg-red-50/60 dark:bg-red-950/20'
      : t === 'good'
        ? 'border-l-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20'
        : 'border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20';

  const iconByType = (t: string) =>
    t === 'warn'
      ? '⚠️'
      : t === 'good'
        ? '✅'
        : '💡';

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Lightbulb className="h-3.5 w-3.5" />
          </span>
          Correlation Insight
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Insight otomatis berdasarkan pola data peer group.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {insights.map((ins, i) => (
            <li key={i} className={`text-xs rounded-md border-l-4 px-3 py-2 ${colorByType(ins.type)}`}>
              <span className="mr-1">{iconByType(ins.type)}</span>
              <span className="text-foreground">{ins.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
