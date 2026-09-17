'use client';

// ============================================================
//  RestoAnalysis — Resto Profile (6 sections grid)
//  (split from RestoAnalysis.tsx — SPLIT-G; pure code motion)
//
//  Performance / Behavior / Historical / Benchmark / Top Risk /
//  Investigation. FIX (BUG-2-a #2): the 6 profile cards only
//  render with a full restoProfile — on a partial payload
//  (ingest race) a partial-state notice takes their place
//  instead of the old `as`-cast TypeError that killed the
//  whole Resto tab.
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Activity, Calendar, Gauge, ShieldAlert } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPct, fmtDecimal } from '@/lib/format';
import type { OutletItem, RestoProfile } from '@/components/dashboard/resto-analysis/types';
import { fmtGrowth, growthColor, Row } from '@/components/dashboard/resto-analysis/helpers';

export interface ProfileCardsProps {
  profile: RestoProfile | null;
  allItems: OutletItem[] | undefined;
}

export function ProfileCards({ profile, allItems }: ProfileCardsProps) {
  return profile ? (
      <div className="grid grid-cols-3 gap-3">
        {/* 1. Performance */}
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0"><TrendingUp className="h-3 w-3" /></span>Performance</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            <Row label="Sales" value={fmtIDR(profile.performance.sales)} />
            {/* FIX (BUG-INT-03): QTY BOM is volume metric (up=good, more sales), not inverse.
                Pass explicit growthColor without inverse=true (was using Row default which assumes inverse). */}
            <Row label="QTY BOM" value={fmtNum(profile.performance.qtyBom)} growth={profile.performance.qtyBomGrowth} growthColor={growthColor(profile.performance.qtyBomGrowth)} />
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
              {/* P23 C7: trend colors were light-mode-only — add dark: variants. */}
              {profile.historical.trend === 'DETERIORATING' && <TrendingUp className="h-4 w-4 text-red-600 dark:text-red-400" />}
              {profile.historical.trend === 'IMPROVING' && <TrendingDown className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
              {profile.historical.trend === 'STABLE' && <Minus className="h-4 w-4 text-muted-foreground" />}
              <span className={`font-semibold text-xs ${profile.historical.trend === 'DETERIORATING' ? 'text-red-600 dark:text-red-400' : profile.historical.trend === 'IMPROVING' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
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
            <Row label="Area Multiplier" value={profile.benchmark.areaMultiplier != null ? `${fmtDecimal(profile.benchmark.areaMultiplier, 2)}×` : '—'} />
          </CardContent>
        </Card>

        {/* 5. Top Risk */}
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2 border-b"><CardTitle className="text-sm flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-md border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0"><AlertTriangle className="h-3 w-3" /></span>Top Risk (by Dev/BOM)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs pt-3">
            {/* FIX (BUG-HUNT C8/B2-15): index keys on a dynamic list — itemName
                is the stable identity here (unique per outlet slice). */}
            {profile.topRisk.byDevBom.slice(0, 5).map((r) => (
              <div key={r.itemName} className="flex justify-between items-center gap-2">
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
              <Badge variant="outline" className="text-xs text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 font-medium tabular-nums">P1: {(allItems || []).filter((r) => r.priority === 'P1').length}</Badge>
              <Badge variant="outline" className="text-xs text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 font-medium tabular-nums">P2: {(allItems || []).filter((r) => r.priority === 'P2').length}</Badge>
              <Badge variant="outline" className="text-xs text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 font-medium tabular-nums">P3: {(allItems || []).filter((r) => r.priority === 'P3').length}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
      ) : (
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardContent className="py-8 text-center">
            <div className="flex flex-col items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 mb-3">
                <Gauge className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Profil outlet belum tersedia untuk periode ini</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">Data analisa resto lain di bawah (Bahan Analysis, Menu Analysis, Ranking Nasional) tetap ditampilkan.</p>
            </div>
          </CardContent>
        </Card>
      );
}
