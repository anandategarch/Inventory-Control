'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import {
  fmtIDR, fmtNum, fmtPct, fmtPctAbs, directionColor, priorityColor,
} from '@/lib/format';
import { useDashboard } from '@/hooks/useDashboard';
import { useStatus } from '@/hooks/useAnalysis';
import type { AnalysisData, OutletHealthRanking } from '@/hooks/useAnalysis';
import {
  Activity, TrendingDown, TrendingUp, ShieldAlert, Package,
  AlertTriangle, Beaker, Boxes, FileSearch, Target, Trash2, Lightbulb,
  Scale, History, ChevronDown, ChevronRight, Zap, Bug,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell, PieChart, Pie,
} from 'recharts';

// ============================================================
//  Types — mirror of API response shape
// ============================================================
interface ItemAnomaly {
  itemName: string;
  satuan: string | null;
  qtyBom: number | null;
  qtyDeviasi: number | null;
  nominalDeviasi: number | null;
  direction: string | null;
  devBom: number | null;
  tolerance: number | null;
  toleranceRaw: string | null;
  residualQty: number | null;
  residualRatio: number | null;
  zScore: number | null;
  historicalAvg: number | null;
  isAbnormal: boolean;
  isCritical: boolean;
  vsAreaAvg: number | null;
  vsNetworkAvg: number | null;
  issues: string[];
  possibleCause: string;
}

interface WorklistEntry {
  priority: 'P1' | 'P2' | 'P3';
  itemName: string;
  issue: string;
  evidence: string;
  metric: string;
  benchmark: string;
  possibleCause: string;
  recommendedAction: string;
}

interface TimelinePoint {
  weekLabel: string;
  monthLabel: string;
  sales: number;
  nominal: number;
  devBom: number;
  status: string;
  topIssue: string | null;
}

interface DQIssue {
  severity: string;
  code: string;
  message: string;
  rowNumber: number | null;
}

interface OutletFocusData {
  success: boolean;
  period: { monthLabel: string; weekLabel: string; prevMonthLabel: string | null; prevWeekLabel: string | null };
  outlet: {
    code: string; name: string; area: string; pic: string | null;
    healthScore: number; rank: number; totalOutlets: number;
    sales: number; absNominal: number; devBom: number; residualPct: number | null;
    lossToSales: number | null;
    normal: number; warning: number; abnormal: number;
    salesPrev: number | null; nominalDeviasiPrev: number | null;
    growthSales: number | null; growthNominal: number | null;
    totalLoss: number; totalSurplus: number;
    wasteNominal: number; susutNominal: number; trialNominal: number; residualNominal: number;
  };
  timeline: TimelinePoint[];
  itemAnomalies: ItemAnomaly[];
  wasteAnalysis: {
    totalWaste: number; totalSusut: number; totalTrial: number; totalResidual: number;
    wastePctOfBom: number; susutPctOfBom: number; trialPctOfBom: number; residualPct: number;
    wasteNominal: number; susutNominal: number; trialNominal: number; residualNominal: number;
    overExplainedItems: Array<{ itemName: string; explained: number; deviasi: number; overPct: number }>;
    highResidualItems: Array<{ itemName: string; residualQty: number | null; residualPct: number | null }>;
  };
  menuAnalysis: Array<{
    prefix: string; itemCount: number; totalDeviation: number; avgDeviation: number;
    items: Array<{ itemName: string; nominalDeviasi: number | null; devBom: number | null; direction: string | null }>;
    outliers: Array<{ itemName: string; nominalDeviasi: number | null; devBom: number | null; direction: string | null }>;
  }>;
  dqIssues: DQIssue[];
  benchmarks: {
    areaAvgDevBom: number; networkAvgDevBom: number;
    areaAvgLossToSales: number | null; networkAvgLossToSales: number | null;
    aboveArea: boolean; aboveNetwork: boolean;
  };
  newItems: Array<{ itemName: string; nominalDeviasi: number | null }>;
  disappearedItems: Array<{ itemName: string; previousNominal: number | null }>;
  directionReversals: Array<{ itemName: string; prevDirection: string; currDirection: string; change: string }>;
  worklist: WorklistEntry[];
  durationMs: number;
  cached?: boolean;
  message?: string;
}

// ============================================================
//  Helpers
// ============================================================
function healthScoreColor(score: number): string {
  if (score < 30) return 'text-red-600';
  if (score < 50) return 'text-amber-600';
  if (score < 70) return 'text-yellow-600';
  return 'text-emerald-600';
}

function healthScoreBg(score: number): string {
  if (score < 30) return 'bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-900';
  if (score < 50) return 'bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900';
  if (score < 70) return 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950/40 dark:border-yellow-900';
  return 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900';
}

const ISSUE_LABELS: Record<string, string> = {
  TOLERANCE_BREACH: 'Toleransi Dilanggar',
  RESIDUAL_HIGH: 'Residual Tinggi',
  HISTORICAL_ABNORMAL: 'Anomali Historis',
  OVER_EXPLAINED: 'Over-Explained',
  NEW_ITEM: 'Item Baru',
  DIRECTION_REVERSAL: 'Arah Berbalik',
  HIGH_NOMINAL: 'Nominal Besar',
  ABOVE_AREA: 'Above Area',
  ABOVE_NETWORK: 'Above Network',
};

function issueBadgeClass(code: string): string {
  switch (code) {
    case 'TOLERANCE_BREACH':
    case 'OVER_EXPLAINED':
    case 'HISTORICAL_ABNORMAL':
      return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'RESIDUAL_HIGH':
    case 'HIGH_NOMINAL':
    case 'ABOVE_AREA':
    case 'ABOVE_NETWORK':
      return 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400';
    case 'NEW_ITEM':
    case 'DIRECTION_REVERSAL':
      return 'text-sky-700 bg-sky-100 border-sky-300 dark:bg-sky-950/60 dark:border-sky-800 dark:text-sky-400';
    default:
      return 'text-muted-foreground bg-muted/50 border-border';
  }
}

const DQ_FIXES: Record<string, { title: string; action: string }> = {
  MISSING_BOM: { title: 'QTY BOM kosong/0', action: 'Cek master data BOM untuk item tersebut. Item tanpa BOM tidak bisa dihitung Dev/BOM-nya.' },
  TOLERANCE_NOT_SET: { title: 'Toleransi belum diset', action: 'Set toleransi di master data atau lewat Pengaturan untuk item ini.' },
  BOM_POSITIVE: { title: 'QTY BOM positif', action: 'Konvensi: QTY BOM harus negatif (konsumsi). Cek tanda di Excel.' },
  OVER_EXPLAINED: { title: 'WASTE+SUSUT+TRIAL > DEVIASI', action: 'Cek pencatatan — kemungkinan double-counting waste/susut/trial atau salah input SPV.' },
  MISSING_OUTLET: { title: 'RESTO kosong', action: 'Cek baris tersebut di Excel, pastikan kolom RESTO terisi dengan kode outlet.' },
  MISSING_ITEM: { title: 'NAMA BAHAN kosong', action: 'Cek baris tersebut di Excel, pastikan kolom NAMA BAHAN terisi.' },
  INVALID_NUMBER: { title: 'Angka tidak valid', action: 'Cek format angka di kolom tersebut. Pastikan tidak ada teks atau karakter aneh.' },
  DUPLICATE: { title: 'Baris duplikat', action: 'Cek apakah ada baris dengan kombinasi Outlet+Item+Week+Akun yang sama. Hapus duplikat di Excel.' },
  ZERO_DEVIATION: { title: 'QTY DEVIASI = 0', action: 'Tidak ada deviasi (normal). Hanya info, tidak perlu tindakan.' },
};

function deviationBreakdownColor(pct: number): string {
  if (pct > 0.5) return '#dc2626';
  if (pct > 0.3) return '#f59e0b';
  return '#10b981';
}

// ============================================================
//  TipPayload type for Recharts tooltips
// ============================================================
type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

// ============================================================
//  Sub-components
// ============================================================
function MetricCard({
  label, value, sub, color, icon,
}: { label: string; value: string; sub?: string; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
        {icon}
      </div>
      <p className={`text-base font-bold ${color || ''}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Tab1Overview({ data, ranking }: { data: OutletFocusData; ranking: OutletHealthRanking[] }) {
  const o = data.outlet;
  const sortedRanking = ranking.slice().sort((a, b) => a.healthScore - b.healthScore);
  const rank = sortedRanking.findIndex((r) => r.outletCode === o.code) + 1;

  const timelineData = data.timeline.map((t) => ({
    label: `${t.weekLabel.split(' ')[0]} ${t.monthLabel.split(' ')[0]?.slice(0, 3)}`,
    sales: t.sales / 1_000_000,
    nominal: t.nominal / 1_000_000,
    devBom: t.devBom * 100,
  }));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className={`rounded-lg border p-4 ${healthScoreBg(o.healthScore)}`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Skor Kondisi Outlet</p>
            <p className={`text-4xl font-bold ${healthScoreColor(o.healthScore)}`}>{o.healthScore}</p>
            <p className="text-xs text-muted-foreground">dari 100</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ranking</p>
            <p className="text-2xl font-bold">#{rank > 0 ? rank : '—'}</p>
            <p className="text-xs text-muted-foreground">dari {o.totalOutlets} outlet</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">PIC</p>
            <p className="text-base font-bold">{o.pic || '—'}</p>
            <p className="text-xs text-muted-foreground">{o.area}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total Item</p>
            <p className="text-2xl font-bold">{o.normal + o.warning + o.abnormal}</p>
            <p className="text-xs text-muted-foreground">
              <span className="text-emerald-600">{o.normal} normal</span>
              {' · '}
              <span className="text-amber-600">{o.warning} warning</span>
              {' · '}
              <span className="text-red-600">{o.abnormal} abnormal</span>
            </p>
          </div>
        </div>
      </div>

      {/* 4-metric grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="Dev / BOM"
          value={fmtPctAbs(o.devBom)}
          sub={data.benchmarks.aboveArea ? `Area ${fmtPctAbs(data.benchmarks.areaAvgDevBom)} (di atas)` : `Area ${fmtPctAbs(data.benchmarks.areaAvgDevBom)}`}
          color={o.devBom > 0.1 ? 'text-red-600' : o.devBom > 0.05 ? 'text-amber-600' : 'text-emerald-600'}
        />
        <MetricCard
          label="Residual %"
          value={fmtPctAbs(o.residualPct)}
          sub="tidak terjelaskan"
          color={o.residualPct != null && o.residualPct > 0.5 ? 'text-red-600' : 'text-foreground'}
        />
        <MetricCard
          label="Loss / Penjualan"
          value={fmtPctAbs(o.lossToSales)}
          sub={data.benchmarks.areaAvgLossToSales != null ? `Area ${fmtPctAbs(data.benchmarks.areaAvgLossToSales)}` : undefined}
          color={o.lossToSales != null && o.lossToSales > 0.1 ? 'text-red-600' : o.lossToSales != null && o.lossToSales > 0.05 ? 'text-amber-600' : 'text-emerald-600'}
        />
        <MetricCard
          label="Jumlah Anomali"
          value={String(o.abnormal)}
          sub={`${o.warning} warning · ${o.normal} normal`}
          color="text-red-600"
        />
      </div>

      {/* Sales + Deviation Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
            Penjualan & Deviasi — {data.period.weekLabel} {data.period.monthLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Penjualan</p>
              <Badge variant="outline" className={`text-xs ${o.growthSales != null && o.growthSales > 0 ? 'text-emerald-700' : o.growthSales != null && o.growthSales < 0 ? 'text-red-700' : ''}`}>
                {o.growthSales != null ? `${o.growthSales > 0 ? '+' : ''}${(o.growthSales * 100).toFixed(1).replace('.', ',')}%` : '—'}
              </Badge>
            </div>
            <p className="text-lg font-bold">{fmtIDR(o.sales)}</p>
            <p className="text-xs text-muted-foreground">vs prev: {fmtIDR(o.salesPrev)}</p>
          </div>
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">|Nominal Deviasi|</p>
              <Badge variant="outline" className={`text-xs ${o.growthNominal != null && o.growthNominal > 0 ? 'text-red-700' : o.growthNominal != null && o.growthNominal < 0 ? 'text-emerald-700' : ''}`}>
                {o.growthNominal != null ? `${o.growthNominal > 0 ? '+' : ''}${(o.growthNominal * 100).toFixed(1).replace('.', ',')}%` : '—'}
              </Badge>
            </div>
            <p className="text-lg font-bold">{fmtIDR(o.absNominal)}</p>
            <p className="text-xs text-muted-foreground">vs prev: {fmtIDR(o.nominalDeviasiPrev)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total LOSS</p>
            <p className="text-base font-bold text-red-600">{fmtIDR(o.totalLoss)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total SURPLUS</p>
            <p className="text-base font-bold text-emerald-600">{fmtIDR(o.totalSurplus)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Timeline chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            Timeline Multi-Periode (Sales + Deviasi)
          </CardTitle>
          <p className="text-xs text-muted-foreground">{data.timeline.length} periode tersedia</p>
        </CardHeader>
        <CardContent>
          {timelineData.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data historis</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={timelineData} margin={{ left: 0, right: 20, top: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" fontSize={11} />
                  <YAxis yAxisId="left" fontSize={11} tickFormatter={(v) => `${v.toFixed(0)}M`} />
                  <YAxis yAxisId="right" orientation="right" fontSize={11} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                  <Tooltip
                    content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                      active && payload && payload.length
                        ? (
                          <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                            <p className="font-medium">{label}</p>
                            <p className="text-muted-foreground">Penjualan: {fmtIDR((payload[0]?.payload?.sales ?? 0) * 1_000_000)}</p>
                            <p className="text-muted-foreground">|Deviasi|: {fmtIDR((payload[0]?.payload?.nominal ?? 0) * 1_000_000)}</p>
                            <p className="text-muted-foreground">Dev/BOM: {((payload[0]?.payload?.devBom ?? 0)).toFixed(2).replace('.', ',')}%</p>
                          </div>
                        )
                        : null
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="sales" name="Penjualan (Jt)" fill="#0284c7" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="left" dataKey="nominal" name="|Deviasi| (Jt)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="devBom" name="Dev/BOM (%)" stroke="#dc2626" strokeWidth={2} dot={{ r: 4 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Timeline table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Detail Timeline</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-56">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs h-7 px-2">Periode</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Penjualan</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">|Deviasi|</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Dev/BOM</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.timeline.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs px-2 py-1">{t.weekLabel} {t.monthLabel}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtIDR(t.sales)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtIDR(t.nominal)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtPctAbs(t.devBom)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-center">
                      <Badge variant="outline" className={`text-[10px] ${t.status === 'ABNORMAL' ? 'text-red-700 bg-red-50 border-red-200' : t.status === 'WARNING' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>
                        {t.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function Tab2AnomaliItem({ data }: { data: OutletFocusData }) {
  const { setFocusOutlet, setDeepDiveItem } = useDashboard();
  const [sortBy, setSortBy] = useState<'nominal' | 'devBom' | 'zScore'>('nominal');
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'abnormal' | 'warning' | 'withIssues'>('withIssues');

  const filtered = useMemo(() => {
    let rows = data.itemAnomalies;
    if (filterSeverity === 'abnormal') rows = rows.filter((a) => a.isAbnormal);
    else if (filterSeverity === 'warning') rows = rows.filter((a) => !a.isAbnormal && a.issues.length > 0);
    else if (filterSeverity === 'withIssues') rows = rows.filter((a) => a.issues.length > 0);

    const sorted = [...rows].sort((a, b) => {
      if (sortBy === 'nominal') return Math.abs(b.nominalDeviasi ?? 0) - Math.abs(a.nominalDeviasi ?? 0);
      if (sortBy === 'devBom') return Math.abs(b.devBom ?? 0) - Math.abs(a.devBom ?? 0);
      if (sortBy === 'zScore') return Math.abs(b.zScore ?? 0) - Math.abs(a.zScore ?? 0);
      return 0;
    });
    return sorted;
  }, [data.itemAnomalies, sortBy, filterSeverity]);

  return (
    <div className="space-y-3">
      {/* Filter + Sort controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {(['withIssues', 'all', 'abnormal', 'warning'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filterSeverity === f ? 'default' : 'outline'}
              className="h-7 text-xs px-2"
              onClick={() => setFilterSeverity(f)}
            >
              {f === 'withIssues' ? 'Berissue' : f === 'all' ? 'Semua' : f === 'abnormal' ? 'Abnormal' : 'Warning'}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-muted-foreground">Urutkan:</span>
          {(['nominal', 'devBom', 'zScore'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={sortBy === s ? 'default' : 'outline'}
              className="h-7 text-xs px-2"
              onClick={() => setSortBy(s)}
            >
              {s === 'nominal' ? '|Nominal|' : s === 'devBom' ? 'Dev/BOM' : 'Z-Score'}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <ScrollArea className="h-[65vh]">
          <Table className="min-w-full">
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-xs h-7 px-2">Item</TableHead>
                <TableHead className="text-xs h-7 px-2 text-center">Dir</TableHead>
                <TableHead className="text-xs h-7 px-2 text-right">QTY Dev</TableHead>
                <TableHead className="text-xs h-7 px-2 text-right">Nominal</TableHead>
                <TableHead className="text-xs h-7 px-2 text-right">Dev/BOM</TableHead>
                <TableHead className="text-xs h-7 px-2 text-right">Tol</TableHead>
                <TableHead className="text-xs h-7 px-2 text-right">Z-Score</TableHead>
                <TableHead className="text-xs h-7 px-2 text-right">vs Area</TableHead>
                <TableHead className="text-xs h-7 px-2">Issues</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center text-xs text-muted-foreground py-6">Tidak ada item dengan issue</TableCell></TableRow>
              ) : filtered.map((a, i) => (
                <TableRow
                  key={i}
                  className={`cursor-pointer hover:bg-muted/50 ${a.isCritical ? 'bg-red-50/40 dark:bg-red-950/10' : a.isAbnormal ? 'bg-red-50/20 dark:bg-red-950/5' : ''}`}
                  onClick={() => {
                    // Close focus mode, switch to dashboard tab, then open deep dive
                    setFocusOutlet(null);
                    setDeepDiveItem({ itemName: a.itemName, outletCode: data.outlet.code });
                  }}
                >
                  <TableCell className="text-xs px-2 py-1">
                    <div className="font-medium leading-tight whitespace-normal max-w-[300px]" title={a.itemName}>{a.itemName}</div>
                    {a.satuan && <div className="text-[10px] text-muted-foreground">{a.satuan}</div>}
                  </TableCell>
                  <TableCell className={`text-xs px-2 py-1 text-center font-semibold ${directionColor(a.direction)}`}>{a.direction?.[0]}</TableCell>
                  <TableCell className="text-xs px-2 py-1 text-right">{fmtNum(a.qtyDeviasi)}</TableCell>
                  <TableCell className="text-xs px-2 py-1 text-right font-semibold">{fmtIDR(a.nominalDeviasi)}</TableCell>
                  <TableCell className={`text-xs px-2 py-1 text-right font-semibold ${a.devBom != null && Math.abs(a.devBom) > 0.1 ? 'text-red-600' : a.devBom != null && Math.abs(a.devBom) > 0.05 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {fmtPctAbs(a.devBom)}
                  </TableCell>
                  <TableCell className="text-xs px-2 py-1 text-right text-muted-foreground" title={a.toleranceRaw || ''}>
                    {a.tolerance != null ? fmtPctAbs(a.tolerance) : a.toleranceRaw ? <span className="text-amber-600 text-[10px]">{a.toleranceRaw}</span> : '—'}
                  </TableCell>
                  <TableCell className={`text-xs px-2 py-1 text-right ${a.zScore != null && a.zScore > 2 ? 'text-red-600 font-bold' : a.zScore != null && a.zScore > 1 ? 'text-amber-600' : ''}`}>
                    {a.zScore != null ? a.zScore.toFixed(2) : '—'}
                  </TableCell>
                  <TableCell className={`text-xs px-2 py-1 text-right ${a.vsAreaAvg != null && a.vsAreaAvg > 0 ? 'text-red-600' : a.vsAreaAvg != null && a.vsAreaAvg < 0 ? 'text-emerald-600' : ''}`}>
                    {a.vsAreaAvg != null ? `${a.vsAreaAvg > 0 ? '+' : ''}${(a.vsAreaAvg * 100).toFixed(1).replace('.', ',')}%` : '—'}
                  </TableCell>
                  <TableCell className="text-xs px-2 py-1">
                    <div className="flex flex-wrap gap-1 max-w-[300px]">
                      {a.issues.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      ) : a.issues.slice(0, 3).map((code) => (
                        <Badge key={code} variant="outline" className={`text-[10px] px-1 py-0 ${issueBadgeClass(code)}`}>
                          {ISSUE_LABELS[code] || code}
                        </Badge>
                      ))}
                      {a.issues.length > 3 && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">+{a.issues.length - 3}</Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>

      {/* Detail Record — semua item dengan tolerance */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Package className="h-4 w-4 text-muted-foreground" />
            Detail Record — Semua Item ({data.itemAnomalies.length})
          </CardTitle>
          <p className="text-xs text-muted-foreground">Tampilkan semua item dengan tolerance, Dev/BOM, dan status</p>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[50vh]">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs h-7 px-2">Item</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-center">Dir</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">QTY BOM</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">QTY Dev</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Nominal</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Dev/BOM</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Tol (Pct)</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Tol (Raw)</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Residual</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.itemAnomalies.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center text-xs text-muted-foreground py-6">Tidak ada data</TableCell></TableRow>
                ) : data.itemAnomalies.map((a, i) => (
                  <TableRow key={i} className={a.isCritical ? 'bg-red-50/40 dark:bg-red-950/10' : a.isAbnormal ? 'bg-red-50/20 dark:bg-red-950/5' : ''}>
                    <TableCell className="text-xs px-2 py-1 font-medium whitespace-normal max-w-[300px]" title={a.itemName}>{a.itemName}</TableCell>
                    <TableCell className={`text-xs px-2 py-1 text-center font-semibold ${directionColor(a.direction)}`}>{a.direction?.[0]}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right text-muted-foreground">{fmtNum(a.qtyBom)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtNum(a.qtyDeviasi)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right font-semibold">{fmtIDR(a.nominalDeviasi)}</TableCell>
                    <TableCell className={`text-xs px-2 py-1 text-right font-semibold ${a.devBom != null && Math.abs(a.devBom) > 0.1 ? 'text-red-600' : a.devBom != null && Math.abs(a.devBom) > 0.05 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {fmtPctAbs(a.devBom)}
                    </TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right text-muted-foreground">
                      {a.tolerance != null ? fmtPctAbs(a.tolerance) : '—'}
                    </TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right text-muted-foreground" title={a.toleranceRaw || ''}>
                      {a.toleranceRaw ? (
                        a.toleranceRaw.toUpperCase().includes('BELUM') ? <span className="text-amber-600 text-[10px]">BELUM</span> : <span className="text-[10px]">{a.toleranceRaw}</span>
                      ) : '—'}
                    </TableCell>
                    <TableCell className={`text-xs px-2 py-1 text-right ${a.residualRatio != null && a.residualRatio > 0.5 ? 'text-red-600 font-semibold' : ''}`}>
                      {a.residualRatio != null ? fmtPctAbs(a.residualRatio) : '—'}
                    </TableCell>
                    <TableCell className="text-xs px-2 py-1 text-center">
                      {a.isCritical ? <Badge variant="destructive" className="text-[10px] px-1">Kritis</Badge>
                        : a.isAbnormal ? <Badge className="text-[10px] px-1 bg-red-100 text-red-700 border-red-300">Abnormal</Badge>
                        : <Badge variant="secondary" className="text-[10px] px-1">Normal</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Benchmark comparison summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Scale className="h-3.5 w-3.5 text-muted-foreground" />
            Benchmark Area & Jaringan
          </CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border p-2.5">
            <p className="text-xs text-muted-foreground uppercase">vs Area ({data.outlet.area})</p>
            <p className={`text-base font-bold ${data.benchmarks.aboveArea ? 'text-red-600' : 'text-emerald-600'}`}>
              {fmtPctAbs(data.outlet.devBom)} <span className="text-xs font-normal text-muted-foreground">vs {fmtPctAbs(data.benchmarks.areaAvgDevBom)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {data.benchmarks.aboveArea
                ? `${(data.outlet.devBom / Math.max(data.benchmarks.areaAvgDevBom, 0.0001)).toFixed(1)}× lebih buruk dari rata-rata area`
                : `Lebih baik dari rata-rata area`}
            </p>
          </div>
          <div className="rounded-md border p-2.5">
            <p className="text-xs text-muted-foreground uppercase">vs Jaringan</p>
            <p className={`text-base font-bold ${data.benchmarks.aboveNetwork ? 'text-red-600' : 'text-emerald-600'}`}>
              {fmtPctAbs(data.outlet.devBom)} <span className="text-xs font-normal text-muted-foreground">vs {fmtPctAbs(data.benchmarks.networkAvgDevBom)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {data.benchmarks.aboveNetwork
                ? `${(data.outlet.devBom / Math.max(data.benchmarks.networkAvgDevBom, 0.0001)).toFixed(1)}× lebih buruk dari rata-rata jaringan`
                : `Lebih baik dari rata-rata jaringan`}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Tab3Waste({ data }: { data: OutletFocusData }) {
  const w = data.wasteAnalysis;
  const totalNominal = w.wasteNominal + w.susutNominal + w.trialNominal + w.residualNominal || 1;
  const pieData = [
    { name: 'Waste', value: w.wasteNominal, pct: w.wasteNominal / totalNominal, color: '#f59e0b' },
    { name: 'Susut', value: w.susutNominal, pct: w.susutNominal / totalNominal, color: '#8b5cf6' },
    { name: 'Trial', value: w.trialNominal, pct: w.trialNominal / totalNominal, color: '#06b6d4' },
    { name: 'Residual', value: w.residualNominal, pct: w.residualNominal / totalNominal, color: w.residualNominal / totalNominal > 0.5 ? '#dc2626' : '#64748b' },
  ];

  return (
    <div className="space-y-4">
      {/* 4-card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-md border p-3 bg-amber-50/50 dark:bg-amber-950/10">
          <p className="text-xs text-muted-foreground uppercase">WASTE</p>
          <p className="text-base font-bold text-amber-600">{fmtIDR(w.wasteNominal)}</p>
          <p className="text-xs text-muted-foreground">{fmtPctAbs(w.wastePctOfBom)} dari BOM</p>
        </div>
        <div className="rounded-md border p-3 bg-purple-50/50 dark:bg-purple-950/10">
          <p className="text-xs text-muted-foreground uppercase">SUSUT</p>
          <p className="text-base font-bold text-purple-600">{fmtIDR(w.susutNominal)}</p>
          <p className="text-xs text-muted-foreground">{fmtPctAbs(w.susutPctOfBom)} dari BOM</p>
        </div>
        <div className="rounded-md border p-3 bg-cyan-50/50 dark:bg-cyan-950/10">
          <p className="text-xs text-muted-foreground uppercase">TRIAL</p>
          <p className="text-base font-bold text-cyan-600">{fmtIDR(w.trialNominal)}</p>
          <p className="text-xs text-muted-foreground">{fmtPctAbs(w.trialPctOfBom)} dari BOM</p>
        </div>
        <div className={`rounded-md border p-3 ${w.residualPct > 0.5 ? 'bg-red-50/50 dark:bg-red-950/10' : ''}`}>
          <p className="text-xs text-muted-foreground uppercase">RESIDUAL</p>
          <p className={`text-base font-bold ${w.residualPct > 0.5 ? 'text-red-600' : 'text-foreground'}`}>{fmtIDR(w.residualNominal)}</p>
          <p className="text-xs text-muted-foreground">{fmtPctAbs(w.residualPct)} tidak terjelaskan</p>
        </div>
      </div>

      {/* Deviation breakdown chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Beaker className="h-3.5 w-3.5 text-muted-foreground" />
            Dekomposisi Deviasi (Nominal)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData.filter((d) => d.value > 0)}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ name, percent }: { name?: string; percent?: number }) =>
                    name && percent != null ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                  }
                  labelLine={false}
                >
                  {pieData.filter((d) => d.value > 0).map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: any) => fmtIDR(v as number)}
                  contentStyle={{ fontSize: 11 }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Over-explained items */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
            Item Over-Explained (W+S+T &gt; Deviasi)
          </CardTitle>
          <p className="text-xs text-muted-foreground">Indikasi salah input SPV atau double-counting</p>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-56">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs h-7 px-2">Item</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">W+S+T</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">|Deviasi|</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Over %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {w.overExplainedItems.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4">Tidak ada item over-explained</TableCell></TableRow>
                ) : w.overExplainedItems.map((it, i) => (
                  <TableRow key={i} className="bg-red-50/30 dark:bg-red-950/5">
                    <TableCell className="text-xs px-2 py-1 font-medium whitespace-normal max-w-[300px]" title={it.itemName}>{it.itemName}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtNum(it.explained)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtNum(it.deviasi)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right font-bold text-red-600">+{(it.overPct * 100).toFixed(1).replace('.', ',')}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* High residual items */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
            Item Residual Tinggi (&gt;50%)
          </CardTitle>
          <p className="text-xs text-muted-foreground">Sebagian besar deviasi tidak terjelaskan Waste/Susut/Trial</p>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-56">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs h-7 px-2">Item</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Residual Qty</TableHead>
                  <TableHead className="text-xs h-7 px-2 text-right">Residual %</TableHead>
                  <TableHead className="text-xs h-7 px-2">Severity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {w.highResidualItems.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4">Tidak ada item residual tinggi</TableCell></TableRow>
                ) : w.highResidualItems.map((it, i) => (
                  <TableRow key={i} className="bg-amber-50/30 dark:bg-amber-950/5">
                    <TableCell className="text-xs px-2 py-1 font-medium whitespace-normal max-w-[300px]" title={it.itemName}>{it.itemName}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right">{fmtNum(it.residualQty)}</TableCell>
                    <TableCell className="text-xs px-2 py-1 text-right font-bold text-amber-600">{fmtPctAbs(it.residualPct)}</TableCell>
                    <TableCell className="text-xs px-2 py-1">
                      <Badge variant="outline" className={`text-[10px] ${(it.residualPct ?? 0) > 0.8 ? 'text-red-700 bg-red-50 border-red-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
                        {(it.residualPct ?? 0) > 0.8 ? 'KRITIS' : 'WARNING'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function Tab4Menu({ data }: { data: OutletFocusData }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (prefix: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
            Analisis Menu & BOM (Group by Prefix)
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Item dikelompokkan berdasarkan kata pertama (prefix). Outlier = deviasi &gt; avg+2σ dalam grup.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[50vh]">
            <div className="divide-y">
              {data.menuAnalysis.map((g) => {
                const isOpen = expanded.has(g.prefix);
                return (
                  <div key={g.prefix} className="p-2.5">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 text-left hover:bg-muted/30 px-1.5 py-1 rounded"
                      onClick={() => toggle(g.prefix)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span className="text-xs font-semibold whitespace-normal">{g.prefix}</span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0">{g.itemCount} item</Badge>
                        {g.outliers.length > 0 && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 text-red-700 bg-red-50 border-red-200">
                            {g.outliers.length} outlier
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                        <span>Σ {fmtIDR(g.totalDeviation)}</span>
                        <span>Avg {fmtPctAbs(g.avgDeviation)}</span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="mt-2 space-y-1.5 pl-5">
                        {g.outliers.length > 0 && (
                          <div className="rounded-md border border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900 p-2">
                            <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1 flex items-center gap-1">
                              <Zap className="h-3 w-3" /> OUTLIER
                            </p>
                            {g.outliers.map((o, i) => (
                              <div key={i} className="flex items-center justify-between text-xs py-0.5">
                                <span className="font-medium whitespace-normal max-w-[300px]" title={o.itemName}>{o.itemName}</span>
                                <span className="text-red-700 dark:text-red-400 font-semibold">
                                  {fmtPctAbs(o.devBom)} ({fmtIDR(o.nominalDeviasi)})
                                </span>
                              </div>
                            ))}
                            <p className="text-xs text-muted-foreground mt-1">
                              Item ini naik signifikan vs item lain di menu sama yang stabil → investigasi per item.
                            </p>
                          </div>
                        )}
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs h-6 px-2">Item</TableHead>
                              <TableHead className="text-xs h-6 px-2 text-right">Nominal</TableHead>
                              <TableHead className="text-xs h-6 px-2 text-right">Dev/BOM</TableHead>
                              <TableHead className="text-xs h-6 px-2 text-center">Dir</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {g.items.map((it, i) => (
                              <TableRow key={i} className={g.outliers.some((o) => o.itemName === it.itemName) ? 'bg-red-50/30 dark:bg-red-950/10' : ''}>
                                <TableCell className="text-xs px-2 py-0.5 font-medium whitespace-normal max-w-[300px]" title={it.itemName}>{it.itemName}</TableCell>
                                <TableCell className="text-xs px-2 py-0.5 text-right">{fmtIDR(it.nominalDeviasi)}</TableCell>
                                <TableCell className="text-xs px-2 py-0.5 text-right">{fmtPctAbs(it.devBom)}</TableCell>
                                <TableCell className={`text-xs px-2 py-0.5 text-center font-semibold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                );
              })}
              {data.menuAnalysis.length === 0 && (
                <div className="py-6 text-center text-xs text-muted-foreground">Tidak ada data menu</div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function Tab5DQ({ data }: { data: OutletFocusData }) {
  const counts = data.dqIssues.reduce(
    (acc, i) => {
      if (i.severity === 'ERROR') acc.error++;
      else if (i.severity === 'WARNING') acc.warning++;
      else acc.info++;
      return acc;
    },
    { error: 0, warning: 0, info: 0 },
  );

  // Group by code
  const byCode = new Map<string, DQIssue[]>();
  for (const i of data.dqIssues) {
    const arr = byCode.get(i.code) || [];
    arr.push(i);
    byCode.set(i.code, arr);
  }

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border p-3 bg-red-50/50 dark:bg-red-950/10">
          <p className="text-xs text-muted-foreground uppercase">ERROR</p>
          <p className="text-xl font-bold text-red-600">{counts.error}</p>
        </div>
        <div className="rounded-md border p-3 bg-amber-50/50 dark:bg-amber-950/10">
          <p className="text-xs text-muted-foreground uppercase">WARNING</p>
          <p className="text-xl font-bold text-amber-600">{counts.warning}</p>
        </div>
        <div className="rounded-md border p-3 bg-sky-50/50 dark:bg-sky-950/10">
          <p className="text-xs text-muted-foreground uppercase">INFO</p>
          <p className="text-xl font-bold text-sky-600">{counts.info}</p>
        </div>
      </div>

      {/* DQ issues grouped by code */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Bug className="h-3.5 w-3.5 text-muted-foreground" />
            Data Quality Issues per Kategori
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[48vh]">
            <div className="divide-y">
              {Array.from(byCode.entries()).length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">Tidak ada DQ issue untuk outlet ini</div>
              ) : Array.from(byCode.entries()).map(([code, issues]) => {
                const fix = DQ_FIXES[code] || { title: code, action: 'Tidak ada saran tersedia.' };
                return (
                  <div key={code} className={`rounded-md border m-2 p-2.5 ${issues[0].severity === 'ERROR' ? 'border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900' : issues[0].severity === 'WARNING' ? 'border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900' : 'border-sky-200 bg-sky-50/50 dark:bg-sky-950/20 dark:border-sky-900'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="outline" className={`text-[10px] shrink-0 ${issues[0].severity === 'ERROR' ? 'text-red-700 border-red-300' : issues[0].severity === 'WARNING' ? 'text-amber-700 border-amber-300' : 'text-sky-700 border-sky-300'}`}>
                          {issues[0].severity}
                        </Badge>
                        <span className="text-xs font-medium whitespace-normal">{fix.title}</span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{code}</Badge>
                        <span className="text-xs text-muted-foreground shrink-0">×{issues.length}</span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{issues[0].message}</p>
                    <div className="mt-1.5 flex items-start gap-1.5">
                      <span className="text-xs font-semibold text-foreground shrink-0">Tindakan:</span>
                      <span className="text-xs text-muted-foreground">{fix.action}</span>
                    </div>
                    {issues.length > 1 && (
                      <details className="mt-1.5">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">Lihat semua {issues.length} instance</summary>
                        <div className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
                          {issues.slice(0, 30).map((i, idx) => (
                            <div key={idx} className="text-xs text-muted-foreground">• {i.message}</div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function Tab6Investigasi({ data }: { data: OutletFocusData }) {
  const [status, setStatus] = useState<Record<string, 'OPEN' | 'INVESTIGATING' | 'RESOLVED'>>({});

  const setItemStatus = (itemName: string, s: 'OPEN' | 'INVESTIGATING' | 'RESOLVED') => {
    setStatus((prev) => ({ ...prev, [itemName]: s }));
  };

  const grouped = {
    P1: data.worklist.filter((w) => w.priority === 'P1'),
    P2: data.worklist.filter((w) => w.priority === 'P2'),
    P3: data.worklist.filter((w) => w.priority === 'P3'),
  };

  const statusBadge = (itemName: string) => {
    const s = status[itemName] || 'OPEN';
    const cls = s === 'RESOLVED'
      ? 'text-emerald-700 bg-emerald-100 border-emerald-300'
      : s === 'INVESTIGATING'
        ? 'text-sky-700 bg-sky-100 border-sky-300'
        : 'text-muted-foreground bg-muted/50 border-border';
    return cls;
  };

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border p-3 bg-red-50/50 dark:bg-red-950/10">
          <p className="text-xs text-muted-foreground uppercase">P1 Kritis</p>
          <p className="text-xl font-bold text-red-600">{grouped.P1.length}</p>
        </div>
        <div className="rounded-md border p-3 bg-amber-50/50 dark:bg-amber-950/10">
          <p className="text-xs text-muted-foreground uppercase">P2 Penting</p>
          <p className="text-xl font-bold text-amber-600">{grouped.P2.length}</p>
        </div>
        <div className="rounded-md border p-3 bg-sky-50/50 dark:bg-sky-950/10">
          <p className="text-xs text-muted-foreground uppercase">P3 Investigasi</p>
          <p className="text-xl font-bold text-sky-600">{grouped.P3.length}</p>
        </div>
      </div>

      {/* New / Disappeared / Reversals */}
      <div className="grid sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Package className="h-3 w-3 text-sky-600" />
              Item Baru ({data.newItems.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-32">
              {data.newItems.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Tidak ada</p>
              ) : (
                <div className="space-y-0.5 p-2">
                  {data.newItems.slice(0, 20).map((it, i) => (
                    <div key={i} className="text-xs flex items-center justify-between">
                      <span className="whitespace-normal" title={it.itemName}>{it.itemName}</span>
                      <span className="text-muted-foreground">{fmtIDR(it.nominalDeviasi)}</span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Trash2 className="h-3 w-3 text-muted-foreground" />
              Item Hilang ({data.disappearedItems.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-32">
              {data.disappearedItems.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Tidak ada</p>
              ) : (
                <div className="space-y-0.5 p-2">
                  {data.disappearedItems.slice(0, 20).map((it, i) => (
                    <div key={i} className="text-xs flex items-center justify-between">
                      <span className="whitespace-normal" title={it.itemName}>{it.itemName}</span>
                      <span className="text-muted-foreground">{fmtIDR(it.previousNominal)}</span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <History className="h-3 w-3 text-amber-600" />
              Arah Berbalik ({data.directionReversals.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-32">
              {data.directionReversals.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Tidak ada</p>
              ) : (
                <div className="space-y-0.5 p-2">
                  {data.directionReversals.slice(0, 20).map((it, i) => (
                    <div key={i} className="text-xs flex items-center justify-between gap-2">
                      <span className="whitespace-normal" title={it.itemName}>{it.itemName}</span>
                      <span className="text-muted-foreground whitespace-nowrap">{it.change}</span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Worklist */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <FileSearch className="h-3.5 w-3.5 text-muted-foreground" />
            Worklist Investigasi
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[48vh]">
            <div className="space-y-2 p-2">
              {data.worklist.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">Tidak ada item dalam worklist</p>
              ) : data.worklist.map((w, i) => (
                <div
                  key={i}
                  className={`rounded-md border p-2.5 ${
                    w.priority === 'P1' ? 'border-red-200 bg-red-50/30 dark:bg-red-950/10 dark:border-red-900'
                      : w.priority === 'P2' ? 'border-amber-200 bg-amber-50/30 dark:bg-amber-950/10 dark:border-amber-900'
                        : 'border-sky-200 bg-sky-50/30 dark:bg-sky-950/10 dark:border-sky-900'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${priorityColor(w.priority)}`}>
                        {w.priority}
                      </Badge>
                      <span className="text-xs font-medium whitespace-normal" title={w.itemName}>{w.itemName}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {(['OPEN', 'INVESTIGATING', 'RESOLVED'] as const).map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant="ghost"
                          className={`h-6 text-[10px] px-1.5 ${(status[w.itemName] || 'OPEN') === s ? `border ${statusBadge(w.itemName)}` : 'text-muted-foreground'}`}
                          onClick={() => setItemStatus(w.itemName, s)}
                        >
                          {s === 'OPEN' ? 'OPEN' : s === 'INVESTIGATING' ? 'INV' : 'DONE'}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-1.5 text-xs">
                    <div>
                      <span className="font-semibold text-foreground">Issue: </span>
                      <span className="text-muted-foreground">{w.issue}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-foreground">Metric: </span>
                      <span className="text-muted-foreground">{w.metric}</span>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="font-semibold text-foreground">Evidence: </span>
                      <span className="text-muted-foreground">{w.evidence}</span>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="font-semibold text-foreground">Benchmark: </span>
                      <span className="text-muted-foreground">{w.benchmark}</span>
                    </div>
                    <div className="sm:col-span-2 rounded bg-amber-50/70 dark:bg-amber-950/20 p-1.5">
                      <span className="font-semibold text-amber-900 dark:text-amber-300">Kemungkinan Penyebab: </span>
                      <span className="text-amber-800 dark:text-amber-400">{w.possibleCause}</span>
                    </div>
                    <div className="sm:col-span-2 rounded bg-emerald-50/70 dark:bg-emerald-950/20 p-1.5">
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-1">
                        <Lightbulb className="h-3 w-3" /> Tindakan:
                      </span>
                      <span className="text-emerald-800 dark:text-emerald-400">{w.recommendedAction}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
//  Main OutletFocusMode component
// ============================================================
export function OutletFocusMode({ data }: { data: AnalysisData | undefined }) {
  const {
    focusOutlet, setFocusOutlet, setScorecardOutlet,
    monthLabel, currentWeek, setDeepDiveItem,
  } = useDashboard();
  const { data: status } = useStatus();
  const [tab, setTab] = useState('overview');

  // Find ranking entry for this outlet (for rank info)
  const ranking = data?.outletHealthRanking || [];

  // Outlet list from status
  const outlets = (status?.outlets || []).map((o) => ({
    value: o.code,
    label: `${o.code} · ${o.name}`,
    description: o.area,
  }));

  const focusQuery = useQuery({
    queryKey: ['outlet-focus', focusOutlet, monthLabel, currentWeek],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('outletCode', focusOutlet!);
      params.set('month', monthLabel!);
      params.set('week', currentWeek!);
      const res = await fetch(`/api/outlet-focus?${params.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        throw new Error(`Server error (HTTP ${res.status})`);
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({ message: 'Request failed' }));
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      return res.json() as Promise<OutletFocusData>;
    },
    enabled: Boolean(focusOutlet && monthLabel && currentWeek),
    staleTime: 60_000,
  });

  const outletName = ranking.find((r) => r.outletCode === focusOutlet)?.outletName || focusOutlet || 'Outlet';

  // No outlet selected — show selector prompt
  if (!focusOutlet) {
    return (
      <Card>
        <CardContent className="p-8">
          <div className="flex flex-col items-center justify-center text-center space-y-4">
            <Target className="h-12 w-12 text-muted-foreground/40" />
            <div>
              <h3 className="text-lg font-semibold">Pilih Outlet untuk Focus Mode</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Pilih outlet untuk analisis anomali mendalam — timeline, item anomaly, waste, menu/BOM, data quality, dan auto-generated worklist.
              </p>
            </div>
            <div className="w-full max-w-md">
              <SearchableComboBox
                options={outlets}
                value={focusOutlet}
                onValueChange={setFocusOutlet}
                placeholder="Cari outlet (kode/nama)..."
                searchPlaceholder="Ketik kode atau nama outlet..."
                emptyText="Outlet tidak ditemukan."
                allOptionLabel={`Semua Outlet (${outlets.length})`}
                buttonClassName="w-full"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Outlet Selector Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-[280px] flex-1 max-w-md">
          <SearchableComboBox
            options={outlets}
            value={focusOutlet}
            onValueChange={setFocusOutlet}
            placeholder="Cari outlet..."
            searchPlaceholder="Ketik kode atau nama outlet..."
            emptyText="Outlet tidak ditemukan."
            allOptionLabel={`Semua Outlet (${outlets.length})`}
            buttonClassName="w-full"
          />
        </div>
        {focusQuery.data && (
          <Badge variant="outline" className="text-xs">
            {focusQuery.data.outlet.code} · {focusQuery.data.outlet.area}
          </Badge>
        )}
        {focusQuery.data && (
          <Badge variant="outline" className="text-xs">
            {focusQuery.data.durationMs}ms{focusQuery.data.cached ? ' (cache)' : ''}
          </Badge>
        )}
        <div className="flex-1" />
        {focusQuery.data && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setFocusOutlet(null);
              setScorecardOutlet(focusOutlet);
            }}
          >
            <Activity className="h-3.5 w-3.5 mr-1" />
            Scorecard
          </Button>
        )}
      </div>

        {/* Body — no overflow-hidden (tab mode, page already scrolls) */}
        <div className="space-y-4">
          {focusQuery.isLoading ? (
            <div className="flex-1 p-4 space-y-3">
              <Skeleton className="h-24" />
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
              </div>
              <Skeleton className="h-64" />
              <Skeleton className="h-48" />
            </div>
          ) : focusQuery.error ? (
            <div className="flex-1 p-6">
              <Card className="border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900">
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-1">Gagal Memuat Focus Mode</h3>
                  <p className="text-xs text-red-600 dark:text-red-400/90">{focusQuery.error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3 h-7 text-xs" onClick={() => focusQuery.refetch()}>
                    Coba lagi
                  </Button>
                </CardContent>
              </Card>
            </div>
          ) : !focusQuery.data ? (
            <div className="flex-1 p-6 text-center text-sm text-muted-foreground">Tidak ada data</div>
          ) : focusQuery.data.success === false ? (
            <div className="flex-1 p-6">
              <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
                <CardContent className="p-4">
                  <p className="text-xs text-amber-700 dark:text-amber-400">{focusQuery.data.message || 'Outlet tidak ditemukan'}</p>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col overflow-hidden gap-0">
              <div className="border-b px-2 py-1.5 shrink-0 overflow-x-auto">
                <TabsList className="h-auto">
                  <TabsTrigger value="overview" className="text-xs px-2.5">
                    <Activity className="h-3 w-3 mr-1" /> Overview
                  </TabsTrigger>
                  <TabsTrigger value="anomali" className="text-xs px-2.5">
                    <ShieldAlert className="h-3 w-3 mr-1" /> Anomali Item
                    {focusQuery.data.itemAnomalies.length > 0 && (
                      <Badge variant="secondary" className="text-[10px] ml-1 px-1 py-0 h-3.5">{focusQuery.data.itemAnomalies.length}</Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="waste" className="text-xs px-2.5">
                    <Beaker className="h-3 w-3 mr-1" /> Waste & Residual
                  </TabsTrigger>
                  <TabsTrigger value="menu" className="text-xs px-2.5">
                    <Boxes className="h-3 w-3 mr-1" /> Menu & BOM
                  </TabsTrigger>
                  <TabsTrigger value="dq" className="text-xs px-2.5">
                    <Bug className="h-3 w-3 mr-1" /> Data Quality
                    {focusQuery.data.dqIssues.length > 0 && (
                      <Badge variant="secondary" className="text-[10px] ml-1 px-1 py-0 h-3.5">{focusQuery.data.dqIssues.length}</Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="investigasi" className="text-xs px-2.5">
                    <FileSearch className="h-3 w-3 mr-1" /> Investigasi
                    {focusQuery.data.worklist.length > 0 && (
                      <Badge variant="secondary" className="text-[10px] ml-1 px-1 py-0 h-3.5">{focusQuery.data.worklist.length}</Badge>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <TabsContent value="overview" className="mt-0">
                  <Tab1Overview data={focusQuery.data} ranking={ranking} />
                </TabsContent>
                <TabsContent value="anomali" className="mt-0">
                  <Tab2AnomaliItem data={focusQuery.data} />
                </TabsContent>
                <TabsContent value="waste" className="mt-0">
                  <Tab3Waste data={focusQuery.data} />
                </TabsContent>
                <TabsContent value="menu" className="mt-0">
                  <Tab4Menu data={focusQuery.data} />
                </TabsContent>
                <TabsContent value="dq" className="mt-0">
                  <Tab5DQ data={focusQuery.data} />
                </TabsContent>
                <TabsContent value="investigasi" className="mt-0">
                  <Tab6Investigasi data={focusQuery.data} />
                </TabsContent>
              </div>
            </Tabs>
          )}
      </div>
    </div>
  );
}
