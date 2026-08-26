'use client';

// ============================================================
//  RestoAnalysis — main component
//  Shows: outlet header + Priority Summary + Resto Profile (6
//  cards) + Menu Analysis + Bahan Analysis (3 rankings) +
//  Ranking Nasional + Item Detail Modal.
//
//  Phase 3 split: sub-components live in ./resto-analysis/*
//  This file re-exports types for backward compatibility.
// ============================================================

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Activity, Calendar, Gauge, ShieldAlert } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { clickableRowProps } from '@/lib/a11y';
import { fmtIDR, fmtNum, fmtPct } from '@/lib/format';
import { PrioritySummaryCard } from '@/components/dashboard/PrioritySummaryCard';
import { useState } from 'react';
import type { AnalysisData } from '@/hooks/useAnalysis';

import type {
  OutletItemsResponse, RecommendationResponse,
  RestoProfile, ItemRow, ItemHistoryTimelineRow, ItemHistoryResponse,
} from './resto-analysis/types';
import {
  fmtGrowth, growthColor, priorityColor, priorityBg, directionColor, Row,
} from './resto-analysis/helpers';
import { MenuAnalysis } from './resto-analysis/menu-analysis';
import { RankingNasionalCard } from './resto-analysis/ranking-nasional';
import { ItemDetailModal } from './resto-analysis/item-detail-modal';

// Backward-compat re-exports (no external file imports types from here today,
// but keep them exported so future imports don't break).
export type {
  OutletItemsResponse, RecommendationResponse,
  RestoProfile, ItemRow, ItemHistoryTimelineRow, ItemHistoryResponse,
};

export function RestoAnalysis({ analysisData }: { analysisData?: AnalysisData }) {
  const { focusOutlet, outletCode, monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, pic } = useDashboard();
  // Use focusOutlet (from table click) OR outletCode (from FilterBar dropdown)
  const activeOutlet = focusOutlet || outletCode;
  const [rankingTab, setRankingTab] = useState('financial');
  const [selectedItem, setSelectedItem] = useState<{ outletCode: string; itemName: string } | null>(null);

  const { data, isLoading, isFetching, error } = useQuery<OutletItemsResponse>({
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
      return res.json() as Promise<OutletItemsResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
  });

  // FIX DRILLDOWN: fetch recommendation for this specific outlet to show Priority Summary
  // FIX INT-1: pass area + pic params so Signal 1 (Dev/BOM vs Peer) uses correct network scope
  const { data: recoData } = useQuery<RecommendationResponse>({
    queryKey: ['recommendations', 'single', activeOutlet, monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel!);
      p.set('week', currentWeek!);
      if (comparisonWeek) p.set('prevWeek', comparisonWeek);
      if (comparisonMonth) p.set('prevMonth', comparisonMonth);
      p.set('outletCode', activeOutlet!);
      p.set('limit', '1');
      if (area && area !== 'all') p.set('area', area);
      // FIX (BUG-KELOMPOK-GLOBAL): pass kelompok so single-outlet recommendation
      // is consistent with the global kelompok filter (also affects network benchmark scope)
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/recommendations?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { success: false, recommendations: [] };
      return res.json() as Promise<RecommendationResponse>;
    },
    enabled: Boolean(activeOutlet && monthLabel && currentWeek),
    staleTime: 60_000,
  });
  const recommendation = recoData?.success && recoData.recommendations && recoData.recommendations.length > 0 ? recoData.recommendations[0] : null;

  if (!activeOutlet) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
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
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
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
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
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

  // CRITICAL null guards: server occasionally returns partial payloads (e.g. during
  // ingest race conditions). Without these guards, accessing `data.restoProfile`
  // directly would throw a TypeError that crashes the entire dashboard.
  const profile: RestoProfile = data.restoProfile ?? ({} as RestoProfile);
  const outlet = data.outlet ?? { code: '', name: '', area: '', pic: null };
  const rankings: { financial: ItemRow[]; operational: ItemRow[]; unexplained: ItemRow[] } =
    data.rankings ?? { financial: [], operational: [], unexplained: [] };
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
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
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
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Health Score</p>
                <p className={`text-xs font-semibold ${scoreText}`}>{healthScore < 30 ? 'Kritis' : healthScore < 50 ? 'Perhatian' : healthScore < 70 ? 'Cukup' : 'Sehat'}</p>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* FIX DRILLDOWN: Priority Summary card — shows WHY this outlet is priority
          (score, level, signals, analysis bullets, 15-signal breakdown) */}
      <PrioritySummaryCard recommendation={recommendation} outletItems={data?.allItems || []} />

      {/* Resto Profile — 6 Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* 1. Performance */}
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0"><TrendingUp className="h-3 w-3" /></span>Performance</CardTitle></CardHeader>
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
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0"><Activity className="h-3 w-3" /></span>Behavior</CardTitle></CardHeader>
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
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400 shrink-0"><Calendar className="h-3 w-3" /></span>Historical</CardTitle></CardHeader>
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
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400 shrink-0"><Gauge className="h-3 w-3" /></span>Benchmark</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Outlet Dev/BOM" value={fmtPct(profile.benchmark.outletDevBom)} />
            <Row label="Area Avg Dev/BOM" value={fmtPct(profile.benchmark.areaAvgDevBom)} />
            <Row label="Semua Resto Avg Dev/BOM" value={fmtPct(profile.benchmark.allRestoAvgDevBom)} />
            <Row label="Area Multiplier" value={profile.benchmark.areaMultiplier != null ? `${profile.benchmark.areaMultiplier.toFixed(2)}×` : '—'} />
          </CardContent>
        </Card>

        {/* 5. Top Risk */}
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0"><AlertTriangle className="h-3 w-3" /></span>Top Risk (by Dev/BOM)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            {profile.topRisk.byDevBom.slice(0, 5).map((r, i) => (
              <div key={i} className="flex justify-between items-center gap-2">
                <span className="break-words leading-tight max-w-[180px]" title={r.itemName}>{r.itemName}</span>
                <span className="font-mono font-semibold text-red-600 dark:text-red-400 tabular-nums shrink-0">{fmtPct(r.value)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 6. Investigation */}
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0"><ShieldAlert className="h-3 w-3" /></span>Investigation</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Normal" value={profile.investigation.normal.toString()} />
            <Row label="Warning" value={profile.investigation.warning.toString()} />
            <Row label="Abnormal" value={profile.investigation.abnormal.toString()} />
            <div className="flex gap-1 mt-2">
              <Badge variant="outline" className="text-xs text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 font-medium tabular-nums">P1: {(data.allItems || []).filter((r) => r.priority === 'P1').length}</Badge>
              <Badge variant="outline" className="text-xs text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 font-medium tabular-nums">P2: {(data.allItems || []).filter((r) => r.priority === 'P2').length}</Badge>
              <Badge variant="outline" className="text-xs text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 font-medium tabular-nums">P3: {(data.allItems || []).filter((r) => r.priority === 'P3').length}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Menu Analysis — Phase 3: Group by menu + outlier detection */}
      {activeOutlet && (
        <MenuAnalysis outletCode={activeOutlet} monthLabel={monthLabel || ''} currentWeek={currentWeek || ''} onSelectItem={setSelectedItem} allItemsData={data} />
      )}

      {/* Bahan Analysis — 3 Rankings */}
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            Bahan Analysis
          </CardTitle>
          <p className="text-xs text-muted-foreground ml-9">
            3 ranking: Financial (dampak uang) · Operational (Dev/BOM) · Unexplained (residual ratio)
          </p>
        </CardHeader>
        <CardContent>
          <Tabs value={rankingTab} onValueChange={setRankingTab}>
            {/* FIX M-K (AUDIT-3): operational + unexplained rankings were computed
                server-side but never rendered (only financial tab existed). Added
                the 2 missing tabs so the data is actually usable. */}
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="financial" className="text-xs">A. Financial</TabsTrigger>
              <TabsTrigger value="operational" className="text-xs">B. Operational</TabsTrigger>
              <TabsTrigger value="unexplained" className="text-xs">C. Unexplained</TabsTrigger>
            </TabsList>

            <TabsContent value={rankingTab} className="mt-3">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto border rounded-lg">
                <Table>
                  <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                    <TableRow className="border-b hover:bg-transparent">
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">#</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Nama Bahan</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">BOM</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Deviasi</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Dev/BOM</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Nominal</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-center">Dir</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">W</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">S</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">T</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">Resid%</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-center">Hist</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-right">vs Area</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 text-center">Pri</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentRanking.map((r, idx) => (
                      <TableRow key={r.rank} className={`${priorityBg(r.priority)} cursor-pointer hover:ring-1 hover:ring-foreground/20 transition-all`} {...clickableRowProps(() => setSelectedItem({ outletCode: activeOutlet!, itemName: r.itemName }))}>
                        <TableCell className="text-[11px] py-1.5 font-mono tabular-nums">{r.rank}</TableCell>
                        <TableCell className="text-[11px] py-1.5 font-medium max-w-[200px] whitespace-normal" title={r.itemName}>{r.itemName}</TableCell>
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
              <p className="text-xs text-muted-foreground mt-2">
                W = Waste · S = Susut · T = Trial · Resid% = Residual Ratio · Hist = Historical Trend (↑ memburuk, ↓ membaik) · vs Area = Area Multiplier · Pri = Priority
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Ranking Item Nasional — top 30 deviasi items for this outlet (national rank + peer benchmark) */}
      {activeOutlet && (
        <RankingNasionalCard key={activeOutlet} focusOutlet={activeOutlet} analysisData={analysisData} outletDeviasiRank={data?.topDeviasiRank} />
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
