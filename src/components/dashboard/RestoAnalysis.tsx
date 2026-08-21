'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Utensils, Activity, Calendar, Gauge, ShieldAlert } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { clickableRowProps } from '@/lib/a11y';
import { fmtIDR, fmtNum, fmtPct } from '@/lib/format';
import { useState, useMemo } from 'react';

interface RestoProfile {
  performance: {
    sales: number; qtyBom: number; qtyDeviasi: number; nominalDeviasi: number;
    nominalLossSurplus: number; devBom: number | null; lossToSales: number | null;
    qtyBomGrowth: number | null; qtyDeviasiGrowth: number | null; nominalDeviasiGrowth: number | null;
  };
  behavior: {
    lossNominal: number; surplusNominal: number; lossPct: number | null; surplusPct: number | null;
    qtyWaste: number; qtySusut: number; qtyTrial: number; qtyLossSurplus: number;
    residualQty: number; residualPct: number | null; explainedPct: number | null;
  };
  historical: {
    bomGrowth: number | null; deviasiGrowth: number | null; nominalGrowth: number | null;
    trend: string;
  };
  benchmark: {
    areaAvgDevBom: number; networkAvgDevBom: number; outletDevBom: number; areaMultiplier: number | null;
  };
  topRisk: {
    byNominal: Array<{ itemName: string; value: number; direction: string }>;
    byDevBom: Array<{ itemName: string; value: number }>;
    byResidual: Array<{ itemName: string; value: number }>;
  };
  investigation: {
    normal: number; warning: number; abnormal: number; total: number; healthScore: number;
  };
}

interface ItemRow {
  rank: number; itemName: string; satuan: string | null;
  qtyBom: number; qtyDeviasi: number | null;
  devBom: number | null; nominalLossSurplus: number | null; absNominalLossSurplus: number;
  direction: string; residualRatio: number | null;
  qtyWaste: number; qtySusut: number; qtyTrial: number;
  historicalTrend: '↑' | '↓' | '→' | '?';
  areaMultiplier: number | null;
  priority: 'P1' | 'P2' | 'P3';
}

function fmtGrowth(v: number | null | undefined): string {
  if (v == null) return '—';
  const pct = (v * 100).toFixed(1);
  return v > 0 ? `+${pct}%` : `${pct}%`;
}

function growthColor(v: number | null | undefined, inverse = false): string {
  if (v == null) return 'text-muted-foreground';
  if (inverse) return v > 0 ? 'text-red-600' : v < 0 ? 'text-emerald-600' : 'text-muted-foreground';
  return v > 0 ? 'text-emerald-600' : v < 0 ? 'text-red-600' : 'text-muted-foreground';
}

function priorityColor(p: string): string {
  return p === 'P1' ? 'text-red-600' : p === 'P2' ? 'text-amber-600' : 'text-emerald-600';
}

function priorityBg(p: string): string {
  return p === 'P1' ? 'bg-red-100 dark:bg-red-950/30' : p === 'P2' ? 'bg-amber-100 dark:bg-amber-950/30' : 'bg-emerald-100 dark:bg-emerald-950/30';
}

function directionColor(d: string): string {
  return d === 'LOSS' ? 'text-red-600' : d === 'SURPLUS' ? 'text-emerald-600' : 'text-muted-foreground';
}

export function RestoAnalysis({ analysisData }: { analysisData?: any }) {
  const { focusOutlet, outletCode, monthLabel, currentWeek, comparisonWeek, comparisonMonth } = useDashboard();
  // Use focusOutlet (from table click) OR outletCode (from FilterBar dropdown)
  const activeOutlet = focusOutlet || outletCode;
  const [rankingTab, setRankingTab] = useState('financial');
  const [selectedItem, setSelectedItem] = useState<{ outletCode: string; itemName: string } | null>(null);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['outlet-items', activeOutlet, monthLabel, currentWeek, comparisonWeek, comparisonMonth],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      p.set('week', currentWeek!);
      if (comparisonWeek) p.set('compareWeek', comparisonWeek);
      if (comparisonMonth) p.set('compareMonth', comparisonMonth);
      const res = await fetch(`/api/outlet-items?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
  });

  if (!activeOutlet) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="py-16 text-center">
          <div className="flex flex-col items-center">
            <div className="relative mb-4">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-200/30 to-red-200/30 dark:from-amber-900/20 dark:to-red-900/20 blur-xl" aria-hidden />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50">
                <Target className="h-7 w-7" />
              </div>
            </div>
            <p className="text-sm font-medium text-muted-foreground">Pilih outlet untuk melihat Resto Analysis</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Klik baris di Resto Prioritas atau tabel peer untuk deep dive</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Bug 6.9 fix: show "select period" message instead of error when week not selected
  if (!monthLabel || !currentWeek) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="py-16 text-center">
          <div className="flex flex-col items-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50 mb-4">
              <Target className="h-7 w-7" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">Pilih bulan dan minggu untuk melihat Resto Analysis</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="py-16 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          <span className="ml-2.5 text-sm text-muted-foreground font-medium">Memuat Resto Analysis...</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !data?.success) {
    return (
      <Card className="overflow-hidden border-red-200/70 dark:border-red-900/60">
        <CardContent className="py-12 text-center">
          <div className="flex flex-col items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 mb-3">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <p className="text-sm text-red-700 dark:text-red-400 font-medium">Gagal Memuat Data</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">{error?.message || data?.error || 'Unknown'}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const profile: RestoProfile = data.restoProfile;
  const outlet = data.outlet;
  const rankings: { financial: ItemRow[]; operational: ItemRow[]; unexplained: ItemRow[] } = data.rankings;
  const currentRanking = rankings[rankingTab as keyof typeof rankings] || [];

  // Health score ring color
  const healthScore = profile.investigation.healthScore;
  const scoreRing = healthScore < 30 ? 'stroke-red-500' : healthScore < 50 ? 'stroke-amber-500' : healthScore < 70 ? 'stroke-yellow-500' : 'stroke-emerald-500';
  const scoreText = healthScore < 30 ? 'text-red-600 dark:text-red-400' : healthScore < 50 ? 'text-amber-600 dark:text-amber-400' : healthScore < 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-emerald-600 dark:text-emerald-400';
  const radius = 26;
  const circ = 2 * Math.PI * radius;
  const dash = (healthScore / 100) * circ;

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
                <Target className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-lg flex items-center gap-2">
                  <span className="truncate">{outlet.name}</span>
                  <span className="text-muted-foreground font-normal text-sm shrink-0">({outlet.code})</span>
                  {isFetching && !isLoading && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  {outlet.area} {outlet.pic ? `· PIC: ${outlet.pic}` : ''} · {data.period.week} {data.period.month}
                  {data.period.prevWeek ? ` vs ${data.period.prevWeek}` : ''}
                </p>
              </div>
            </div>
            {/* Health Score ring */}
            <div className="flex items-center gap-3 shrink-0">
              <div className="relative h-14 w-14 rounded-full bg-muted/30 ring-2 ring-foreground/10 flex items-center justify-center">
                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64" aria-hidden>
                  <circle cx="32" cy="32" r={radius} className="fill-none stroke-muted/50" strokeWidth="4" />
                  <circle cx="32" cy="32" r={radius} className={`fill-none ${scoreRing}`} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} />
                </svg>
                <span className={`text-sm font-bold tabular-nums ${scoreText}`}>{healthScore}</span>
              </div>
              <div>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Health Score</p>
                <p className={`text-xs font-semibold ${scoreText}`}>{healthScore < 30 ? 'Kritis' : healthScore < 50 ? 'Perhatian' : healthScore < 70 ? 'Cukup' : 'Sehat'}</p>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Resto Profile — 6 Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* 1. Performance */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />Performance</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Sales" value={fmtIDR(profile.performance.sales)} />
            <Row label="QTY BOM" value={fmtNum(profile.performance.qtyBom)} growth={profile.performance.qtyBomGrowth} />
            <Row label="QTY Deviasi" value={fmtNum(profile.performance.qtyDeviasi)} growth={profile.performance.qtyDeviasiGrowth} growthColor={growthColor(profile.performance.qtyDeviasiGrowth, true)} />
            <Row label="Nominal Deviasi" value={fmtIDR(profile.performance.nominalDeviasi)} growth={profile.performance.nominalDeviasiGrowth} growthColor={growthColor(profile.performance.nominalDeviasiGrowth, true)} />
            <Row label="Net Loss/Surplus" value={fmtIDR(profile.performance.nominalLossSurplus)} />
            <Row label="Dev/BOM" value={fmtPct(profile.performance.devBom)} />
            <Row label="Loss/Sales" value={fmtPct(profile.performance.lossToSales)} />
          </CardContent>
        </Card>

        {/* 2. Behavior */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><Activity className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />Behavior</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Total LOSS" value={fmtIDR(profile.behavior.lossNominal)} sub={fmtPct(profile.behavior.lossPct)} />
            <Row label="Total SURPLUS" value={fmtIDR(profile.behavior.surplusNominal)} sub={fmtPct(profile.behavior.surplusPct)} />
            <Row label="Waste" value={fmtNum(profile.behavior.qtyWaste)} />
            <Row label="Susut" value={fmtNum(profile.behavior.qtySusut)} />
            <Row label="Trial" value={fmtNum(profile.behavior.qtyTrial)} />
            <Row label="Residual" value={fmtNum(profile.behavior.residualQty)} sub={fmtPct(profile.behavior.residualPct)} />
            <Row label="Explained %" value={fmtPct(profile.behavior.explainedPct)} />
          </CardContent>
        </Card>

        {/* 3. Historical */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><Calendar className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400" />Historical</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="BOM Growth" value={fmtGrowth(profile.historical.bomGrowth)} growthColor={growthColor(profile.historical.bomGrowth)} />
            <Row label="Deviasi Growth" value={fmtGrowth(profile.historical.deviasiGrowth)} growthColor={growthColor(profile.historical.deviasiGrowth, true)} />
            <Row label="Nominal Growth" value={fmtGrowth(profile.historical.nominalGrowth)} growthColor={growthColor(profile.historical.nominalGrowth, true)} />
            <div className="flex items-center gap-2 pt-1.5 mt-1.5 border-t">
              {profile.historical.trend === 'DETERIORATING' && <TrendingUp className="h-4 w-4 text-red-600" />}
              {profile.historical.trend === 'IMPROVING' && <TrendingDown className="h-4 w-4 text-emerald-600" />}
              {profile.historical.trend === 'STABLE' && <Minus className="h-4 w-4 text-muted-foreground" />}
              <span className={`font-semibold text-[11px] ${profile.historical.trend === 'DETERIORATING' ? 'text-red-600' : profile.historical.trend === 'IMPROVING' ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {profile.historical.trend}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 4. Benchmark */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><Gauge className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400" />Benchmark</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Outlet Dev/BOM" value={fmtPct(profile.benchmark.outletDevBom)} />
            <Row label="Area Avg Dev/BOM" value={fmtPct(profile.benchmark.areaAvgDevBom)} />
            <Row label="Network Avg Dev/BOM" value={fmtPct(profile.benchmark.networkAvgDevBom)} />
            <Row label="Area Multiplier" value={profile.benchmark.areaMultiplier != null ? `${profile.benchmark.areaMultiplier.toFixed(2)}×` : '—'} />
          </CardContent>
        </Card>

        {/* 5. Top Risk */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />Top Risk (by Dev/BOM)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            {profile.topRisk.byDevBom.slice(0, 5).map((r, i) => (
              <div key={i} className="flex justify-between items-center gap-2">
                <span className="truncate max-w-[140px]" title={r.itemName}>{r.itemName}</span>
                <span className="font-mono font-semibold text-red-600 dark:text-red-400 tabular-nums shrink-0">{fmtPct(r.value)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 6. Investigation */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />Investigation</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Normal" value={profile.investigation.normal.toString()} />
            <Row label="Warning" value={profile.investigation.warning.toString()} />
            <Row label="Abnormal" value={profile.investigation.abnormal.toString()} />
            <div className="flex gap-1 mt-2">
              <Badge variant="outline" className="text-[10px] text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 font-medium tabular-nums">P1: {(data.allItems || []).filter((r: any) => r.priority === 'P1').length}</Badge>
              <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 font-medium tabular-nums">P2: {(data.allItems || []).filter((r: any) => r.priority === 'P2').length}</Badge>
              <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 font-medium tabular-nums">P3: {(data.allItems || []).filter((r: any) => r.priority === 'P3').length}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Menu Analysis — Phase 3: Group by menu + outlier detection */}
      {activeOutlet && (
        <MenuAnalysis outletCode={activeOutlet} monthLabel={monthLabel || ''} currentWeek={currentWeek || ''} onSelectItem={setSelectedItem} allItemsData={data} />
      )}

      {/* Bahan Analysis — 3 Rankings */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            Bahan Analysis — Financial Impact
          </CardTitle>
          <p className="text-xs text-muted-foreground ml-9">
            Financial Impact (dampak uang)
          </p>
        </CardHeader>
        <CardContent>
          <Tabs value={rankingTab} onValueChange={setRankingTab}>
            <TabsList className="grid w-full grid-cols-1">
              <TabsTrigger value="financial" className="text-xs">A. Financial Impact</TabsTrigger>
            </TabsList>

            <TabsContent value={rankingTab} className="mt-3">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto border rounded-lg">
                <Table>
                  <TableHeader className="sticky top-0 bg-muted/40 dark:bg-zinc-900/40 backdrop-blur-sm z-10">
                    <TableRow className="border-b hover:bg-transparent">
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">#</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Nama Bahan</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">BOM</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">Deviasi</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">Dev/BOM</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">Nominal</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-center">Dir</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">W</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">S</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">T</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">Resid%</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-center">Hist</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-right">vs Area</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8 text-center">Pri</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentRanking.map((r, idx) => (
                      <TableRow key={r.rank} className={`${priorityBg(r.priority)} cursor-pointer hover:ring-1 hover:ring-foreground/20 transition-all ${idx % 2 === 1 ? 'bg-muted/10' : ''}`} {...clickableRowProps(() => setSelectedItem({ outletCode: activeOutlet!, itemName: r.itemName }))}>
                        <TableCell className="text-[11px] py-1.5 font-mono tabular-nums">{r.rank}</TableCell>
                        <TableCell className="text-[11px] py-1.5 font-medium max-w-[180px] truncate" title={r.itemName}>{r.itemName}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono tabular-nums">{fmtNum(r.qtyBom)}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono tabular-nums">{fmtNum(r.qtyDeviasi)}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono font-semibold text-red-600 dark:text-red-400 tabular-nums">{fmtPct(r.devBom)}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono tabular-nums">{fmtIDR(r.nominalLossSurplus)}</TableCell>
                        <TableCell className={`text-[11px] py-1.5 text-center font-bold ${directionColor(r.direction)}`}>{r.direction === 'LOSS' ? 'L' : r.direction === 'SURPLUS' ? 'S' : '-'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground tabular-nums">{r.qtyWaste > 0 ? fmtNum(r.qtyWaste) : '—'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground tabular-nums">{r.qtySusut > 0 ? fmtNum(r.qtySusut) : '—'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground tabular-nums">{r.qtyTrial > 0 ? fmtNum(r.qtyTrial) : '—'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono tabular-nums">{r.residualRatio != null ? fmtPct(r.residualRatio) : '—'}</TableCell>
                        <TableCell className={`text-[11px] py-1.5 text-center font-bold ${r.historicalTrend === '↑' ? 'text-red-600 dark:text-red-400' : r.historicalTrend === '↓' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>{r.historicalTrend}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono tabular-nums">
                          {r.areaMultiplier != null ? (
                            <span className={r.areaMultiplier > 1.5 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}>
                              {r.areaMultiplier.toFixed(1)}×
                            </span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className={`text-[11px] py-1.5 text-center font-bold ${priorityColor(r.priority)}`}>{r.priority}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                W = Waste · S = Susut · T = Trial · Resid% = Residual Ratio · Hist = Historical Trend (↑ memburuk, ↓ membaik) · vs Area = Area Multiplier · Pri = Priority
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Ranking Item Nasional — new section */}
      {activeOutlet && (
        <RankingNasionalCard key={activeOutlet} focusOutlet={activeOutlet} analysisData={analysisData} />
      )}

      {/* Item Detail Modal — Phase 2: Historical + Benchmark per bahan */}
      {selectedItem && (
        <ItemDetailModal
          outletCode={selectedItem.outletCode}
          itemName={selectedItem.itemName}
          month={monthLabel || ''}
          week={currentWeek || ''}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}

// ============================================================
//  ItemDetailModal — Historical timeline + Benchmark per bahan
// ============================================================
function ItemDetailModal({ outletCode, itemName, month, week, onClose }: {
  outletCode: string; itemName: string; month: string; week: string; onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['item-history', outletCode, itemName, month, week],
    queryFn: async () => {
      const p = new URLSearchParams({ outletCode, itemName, month, week });
      const res = await fetch(`/api/item-history?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <Dialog open={true} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[800px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5" />
            {itemName}
            {data?.outlet && <span className="text-muted-foreground text-sm">— {data.outlet.name} ({data.outlet.code})</span>}
            {data?.priority && (
              <Badge variant="outline" className={`text-[10px] ${priorityColor(data.priority)} border-current`}>
                {data.priority}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Historical timeline + benchmark per bahan
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Memuat historical...</span>
          </div>
        ) : error || !data?.success ? (
          <div className="py-8 text-center text-red-600 text-sm">
            Error: {error?.message || data?.error || 'Unknown'}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <SummaryCard label="Dev/BOM" value={fmtPct(data.current?.devBom)} sub={data.historical?.zScore != null ? `zScore: ${data.historical.zScore.toFixed(2)}` : ''} color={data.current?.devBom != null && Math.abs(data.current.devBom) > 0.10 ? 'text-red-600' : ''} />
              <SummaryCard label="Nominal" value={fmtIDR(data.current?.nominalLossSurplus)} color={directionColor(data.current?.direction || '')} />
              <SummaryCard label="Residual%" value={fmtPct(data.current?.residualRatio)} sub={data.current?.residualRatio != null && data.current.residualRatio > 0.5 ? 'TINGGI' : ''} color={data.current?.residualRatio != null && data.current.residualRatio > 0.5 ? 'text-red-600' : ''} />
              <SummaryCard label="Trend" value={data.historical?.trend || '—'} color={data.historical?.trend === 'DETERIORATING' ? 'text-red-600' : data.historical?.trend === 'IMPROVING' ? 'text-emerald-600' : ''} />
            </div>

            {/* Benchmark */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Benchmark (Current Period)</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <Row label="Outlet Dev/BOM" value={fmtPct(data.benchmark?.outletDevBom)} />
                <Row label="Area Avg Dev/BOM" value={fmtPct(data.benchmark?.areaAvgDevBom)} />
                <Row label="Network Avg" value={fmtPct(data.benchmark?.networkAvgDevBom)} />
                <Row label="Best Outlet" value={fmtPct(data.benchmark?.bestDevBom)} />
                <Row label="Area Multiplier" value={data.benchmark?.areaMultiplier != null ? `${data.benchmark.areaMultiplier.toFixed(2)}×` : '—'} />
                <Row label="Network Multiplier" value={data.benchmark?.networkMultiplier != null ? `${data.benchmark.networkMultiplier.toFixed(2)}×` : '—'} />
                <Row label="Area Outlets" value={String(data.benchmark?.areaOutletCount ?? 0)} />
                <Row label="Network Outlets" value={String(data.benchmark?.networkOutletCount ?? 0)} />
              </CardContent>
            </Card>

            {/* Historical Timeline */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Historical Timeline</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto max-h-[300px] overflow-y-auto border rounded-md">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10">
                      <TableRow>
                        <TableHead className="text-[11px] h-8">Periode</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">BOM</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">Deviasi</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">Dev/BOM</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">Nominal</TableHead>
                        <TableHead className="text-[11px] h-8 text-center">Dir</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">W</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">S</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">T</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">Resid%</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.timeline?.map((t: any, i: number) => (
                        <TableRow key={i} className={t.isCurrent ? 'bg-primary/5 font-semibold' : ''}>
                          <TableCell className="text-[11px] py-1.5 whitespace-nowrap">
                            {t.weekLabel} {t.monthLabel?.split(' ')[0]?.slice(0, 3)}
                            {t.isCurrent && <span className="ml-1 text-[9px] text-primary">●</span>}
                          </TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtNum(t.qtyBom)}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtNum(t.qtyDeviasi)}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono text-red-600">{fmtPct(t.devBom)}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtIDR(t.nominalLossSurplus)}</TableCell>
                          <TableCell className={`text-[11px] py-1.5 text-center ${directionColor(t.direction)}`}>{t.direction === 'LOSS' ? 'L' : t.direction === 'SURPLUS' ? 'S' : '-'}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground">{t.qtyWaste > 0 ? fmtNum(t.qtyWaste) : '—'}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground">{t.qtySusut > 0 ? fmtNum(t.qtySusut) : '—'}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground">{t.qtyTrial > 0 ? fmtNum(t.qtyTrial) : '—'}</TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtPct(t.residualRatio)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">
                  Historical mean: {fmtPct(data.historical?.mean)} · StdDev: {fmtPct(data.historical?.stdDev)} · zScore: {data.historical?.zScore?.toFixed(2) || '—'} · Sample: {data.historical?.sampleSize || 0} periods
                </p>
              </CardContent>
            </Card>

            {/* Investigation Checklist */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Possible Investigation</CardTitle></CardHeader>
              <CardContent>
                <ol className="text-xs space-y-1 list-decimal list-inside text-muted-foreground">
                  <li>Cek actual portion vs SOC</li>
                  <li>Cek timbang bahan (sampling fisik)</li>
                  <li>Cek waste recording (apakah akurat?)</li>
                  <li>Cek susut (apakah wajar?)</li>
                  <li>Cek quality issue (bahan rusak?)</li>
                  <li>Cek receiving (apakah sesuai?)</li>
                  <li>Cek transfer antar outlet</li>
                  <li>Cek UOM conversion</li>
                  <li>Cek administrasi transaksi</li>
                  <li>Cek stock opname timing</li>
                </ol>
                <p className="text-[10px] text-muted-foreground mt-2 italic">
                  ⚠ "Possible Investigation" bukan "Root Cause" — sistem belum melakukan observasi fisik.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border p-2 text-center">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold ${color || ''}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ============================================================
//  MenuAnalysis — Phase 3: Group by menu prefix + outlier detection
//  Groups items by first word of itemName (menu name)
//  Detects items where Dev growth >> BOM growth (outlier within menu)
// ============================================================
function MenuAnalysis({ outletCode, monthLabel, currentWeek, onSelectItem, allItemsData }: {
  outletCode: string; monthLabel: string; currentWeek: string;
  onSelectItem: (item: { outletCode: string; itemName: string }) => void;
  allItemsData: any;
}) {
  // Bug 6.10 fix: use parent's data instead of duplicate query
  const outletData = allItemsData;

  const menuGroups = useMemo<Array<{
    menuName: string; itemCount: number; avgDevBom: number;
    stdDev: number; threshold: number; outlierCount: number;
    items: Array<any>;
  }>>(() => {
    if (!outletData?.allItems && !outletData?.rankings?.financial) return [];
    // Bug fix: use allItems (complete list) instead of rankings (only top 20)
    const allItemsArray = outletData.allItems || [];
    if (allItemsArray.length === 0) return [];
    const allItems = new Map<string, any>();
    for (const item of allItemsArray) {
      allItems.set(item.itemName, item);
    }

    // Group by first word (menu name)
    const groups = new Map<string, any[]>();
    for (const item of allItems.values()) {
      const menuName = (item.itemName || 'LAINNYA').split(/\s+/)[0].toUpperCase();
      if (!groups.has(menuName)) groups.set(menuName, []);
      groups.get(menuName)!.push(item);
    }

    // For each group, compute avg Dev/BOM and flag outliers
    const result: Array<{
      menuName: string; itemCount: number; avgDevBom: number;
      stdDev: number; threshold: number; outlierCount: number;
      items: Array<any>;
    }> = [];
    for (const [menuName, items] of groups) {
      if (items.length < 2) continue; // Skip single-item groups

      const devBomValues = items
        .map(i => Math.abs(i.devBom ?? 0))
        .filter(v => v > 0);
      if (devBomValues.length === 0) continue;

      const avgDevBom = devBomValues.reduce((a, b) => a + b, 0) / devBomValues.length;
      const stdDev = devBomValues.length > 1
        ? Math.sqrt(devBomValues.reduce((a, b) => a + (b - avgDevBom) ** 2, 0) / (devBomValues.length - 1))
        : 0;
      const threshold = avgDevBom + 2 * stdDev; // outlier = > avg + 2σ

      const itemsWithFlag = items.map(item => ({
        ...item,
        isOutlier: Math.abs(item.devBom ?? 0) > threshold && Math.abs(item.devBom ?? 0) > avgDevBom * 1.5,
        outlierMultiple: avgDevBom > 0 ? Math.abs(item.devBom ?? 0) / avgDevBom : null,
      }));

      const outlierCount = itemsWithFlag.filter(i => i.isOutlier).length;

      result.push({
        menuName,
        itemCount: items.length,
        avgDevBom,
        stdDev,
        threshold,
        outlierCount,
        items: itemsWithFlag.sort((a, b) => Math.abs(b.devBom ?? 0) - Math.abs(a.devBom ?? 0)),
      });
    }

    return result.sort((a, b) => b.outlierCount - a.outlierCount || b.avgDevBom - a.avgDevBom);
  }, [outletData]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0">
            <Utensils className="h-3.5 w-3.5" />
          </span>
          Menu Analysis — Outlier Detection
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Group by menu (kata pertama nama bahan) — deteksi bahan yang deviation tidak proporsional vs bahan lain di menu yang sama
        </p>
      </CardHeader>
      <CardContent>
        {menuGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Utensils className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada data menu.</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {menuGroups.map(group => (
              <div key={group.menuName} className="rounded-lg border overflow-hidden">
                <div className="flex items-center justify-between mb-2 px-3 py-2 border-b bg-muted/30 dark:bg-zinc-900/30">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{group.menuName}</span>
                    <Badge variant="outline" className="text-[10px] font-medium tabular-nums">{group.itemCount} bahan</Badge>
                    {group.outlierCount > 0 && (
                      <Badge variant="outline" className="text-[10px] text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 font-medium tabular-nums">
                        {group.outlierCount} outlier
                      </Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    Avg Dev/BOM: <span className="font-medium">{fmtPct(group.avgDevBom)}</span> · Threshold: <span className="font-medium">{fmtPct(group.threshold)}</span>
                  </span>
                </div>
                <div className="space-y-0.5 p-2">
                  {group.items.map((item: any) => (
                    <div
                      key={item.itemName}
                      className={`flex items-center justify-between text-xs py-1.5 px-2 rounded cursor-pointer hover:bg-muted/40 transition-colors ${item.isOutlier ? 'bg-red-50/60 dark:bg-red-950/20' : ''}`}
                      {...clickableRowProps(() => onSelectItem({ outletCode, itemName: item.itemName }))}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {item.isOutlier && <span className="text-red-600 dark:text-red-400 font-bold text-[10px]">⚠</span>}
                        <span className="truncate max-w-[160px]" title={item.itemName}>{item.itemName}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="font-mono text-muted-foreground tabular-nums">BOM: {fmtNum(item.qtyBom)}</span>
                        <span className={`font-mono font-semibold tabular-nums ${item.isOutlier ? 'text-red-600 dark:text-red-400' : ''}`}>
                          Dev/BOM: {fmtPct(item.devBom)}
                        </span>
                        {item.outlierMultiple != null && item.outlierMultiple > 1 && (
                          <span className={`text-[10px] tabular-nums ${item.isOutlier ? 'text-red-600 dark:text-red-400 font-bold' : 'text-muted-foreground'}`}>
                            {item.outlierMultiple.toFixed(1)}× avg
                          </span>
                        )}
                        <span className={`text-[10px] ${directionColor(item.direction)}`}>{item.direction === 'LOSS' ? 'L' : 'S'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground mt-2">
          ⚠ Outlier = Dev/BOM &gt; (avg + 2σ) DAN &gt; 1.5× avg menu · Klik bahan untuk lihat Investigation Card
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, growth, sub, growthColor: gc }: {
  label: string; value: string; growth?: number | null; sub?: string; growthColor?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="font-mono font-semibold">{value}</span>
        {growth != null && (
          <span className={`text-[10px] ${gc || growthColor(growth, true)}`}>{fmtGrowth(growth)}</span>
        )}
        {sub && <span className="text-[10px] text-muted-foreground">({sub})</span>}
      </div>
    </div>
  );
}

// ============================================================
//  Ranking Nasional Card — Top Items by Deviasi Rank
//  Shows after resto is selected. Custom Top N selector.
// ============================================================
function RankingNasionalCard({ focusOutlet, analysisData }: { focusOutlet: string; analysisData?: any }) {
  const [topN, setTopN] = useState<string>('50');
  const [filterPic, setFilterPic] = useState<string>('all');
  // Auto-filter by focusOutlet — ranking hanya menampilkan item untuk resto yang dipilih
  // User can still override via dropdown. Sync happens via key prop on component
  // (component remounts when focusOutlet changes → initial state resets).
  const [filterResto, setFilterResto] = useState<string>(focusOutlet || 'all');

  const allItems: any[] = analysisData?.topDeviasiRank || [];
  const picOptions = [...new Set(allItems.map((it: any) => it.pic).filter(Boolean))].sort() as string[];
  const restoOptions = [...new Set(allItems.map((it: any) => it.outletCode))].sort() as string[];

  const items = allItems
    .filter((it: any) => filterPic === 'all' || it.pic === filterPic)
    .filter((it: any) => filterResto === 'all' || it.outletCode === filterResto)
    .slice(0, topN === 'all' ? 9999 : parseInt(topN));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Ranking Item Nasional (Deviasi)
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Ranking item per resto. Negatif (merah) = rugi. Positif (hijau) = untung.
          AVG Dev By BOM = rata-rata |QTY Deviasi| item yang sama di resto lain dengan BOM ±50%.
        </p>
        {/* Top N + Filters */}
        <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
          <select
            value={topN}
            onChange={(e) => setTopN(e.target.value)}
            className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="10">Top 10</option>
            <option value="20">Top 20</option>
            <option value="50">Top 50</option>
            <option value="100">Top 100</option>
            <option value="all">Semua</option>
          </select>
          <select
            value={filterPic}
            onChange={(e) => setFilterPic(e.target.value)}
            className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="all">Semua PIC</option>
            {picOptions.map((pic: string) => <option key={pic} value={pic}>{pic}</option>)}
          </select>
          <select
            value={filterResto}
            onChange={(e) => setFilterResto(e.target.value)}
            className="h-7 text-xs border rounded-md px-2 bg-background hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="all">Semua Resto</option>
            {restoOptions.map((resto: string) => <option key={resto} value={resto}>{resto}</option>)}
          </select>
          {(filterPic !== 'all' || filterResto !== 'all') && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setFilterPic('all'); setFilterResto('all'); }}>
              Reset
            </Button>
          )}
          <Badge variant="secondary" className="text-[10px] ml-auto tabular-nums font-medium">{items.length} item</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-auto">
          <Table className="min-w-[1200px]">
            <TableHeader className="sticky top-0 bg-muted/40 dark:bg-zinc-900/40 backdrop-blur-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider h-8">Rank Nas</TableHead>
                <TableHead className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider h-8">Rank BOM</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Item</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Resto</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY Deviasi</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY Waste</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY LS</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">%LS to BOM</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">AVG Dev By BOM</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground text-xs py-8">Tidak ada data</TableCell></TableRow>
              ) : items.map((it: any, i: number) => (
                <TableRow key={`${it.itemName}-${it.outletCode}-${i}`} className={`hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}>
                  <TableCell className="text-center text-xs font-bold tabular-nums">{it.rankNominal}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground tabular-nums">{it.rankBom != null ? it.rankBom : '—'}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[150px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.pic || '—'}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyDeviasi)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyWaste < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyWaste)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyLossSurplus < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyLossSurplus)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.pctLossSurplusToBom != null && it.pctLossSurplusToBom < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {it.pctLossSurplusToBom != null ? `${Math.abs(it.pctLossSurplusToBom * 100).toFixed(2)}%` : '—'}
                  </TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${it.qtyBom < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtNum(it.qtyBom)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {it.avgDeviasiByBom != null ? fmtNum(it.avgDeviasiByBom) : '—'}
                  </TableCell>
                  <TableCell className={`text-right font-semibold text-xs tabular-nums ${it.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {fmtIDR(it.nominalDeviasi)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
