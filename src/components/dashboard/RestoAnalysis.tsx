'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, ChevronRight } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
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

function fmtIDR(v: number | null | undefined): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(2)}M`;
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(2)}Jt`;
  if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toFixed(0)}Rb`;
  return `${sign}Rp ${abs.toFixed(0)}`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—';
  return Math.abs(v).toLocaleString('id-ID');
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—';
  return `${(Math.abs(v) * 100).toFixed(digits).replace('.', ',')}%`;
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

export function RestoAnalysis() {
  const { focusOutlet, monthLabel, currentWeek, comparisonWeek, comparisonMonth } = useDashboard();
  const [rankingTab, setRankingTab] = useState('financial');
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['outlet-items', focusOutlet, monthLabel, currentWeek, comparisonWeek, comparisonMonth],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', focusOutlet!);
      p.set('month', monthLabel!);
      p.set('week', currentWeek!);
      if (comparisonWeek) p.set('compareWeek', comparisonWeek);
      if (comparisonMonth) p.set('compareMonth', comparisonMonth);
      const res = await fetch(`/api/outlet-items?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(focusOutlet && monthLabel && currentWeek),
  });

  if (!focusOutlet) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <Target className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>Pilih outlet untuk melihat Resto Analysis</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Memuat Resto Analysis...</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !data?.success) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-red-600">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p className="text-sm">Error: {error?.message || data?.error || 'Unknown'}</p>
        </CardContent>
      </Card>
    );
  }

  const profile: RestoProfile = data.restoProfile;
  const outlet = data.outlet;
  const rankings: { financial: ItemRow[]; operational: ItemRow[]; unexplained: ItemRow[] } = data.rankings;
  const currentRanking = rankings[rankingTab as keyof typeof rankings] || [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Target className="h-5 w-5" />
                {outlet.name} ({outlet.code})
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {outlet.area} {outlet.pic ? `· PIC: ${outlet.pic}` : ''} · {data.period.week} {data.period.month}
                {data.period.prevWeek ? ` vs ${data.period.prevWeek}` : ''}
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{profile.investigation.healthScore}</p>
              <p className="text-[10px] text-muted-foreground uppercase">Health Score</p>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Resto Profile — 6 Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* 1. Performance */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Performance</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
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
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Behavior</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
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
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Historical</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            <Row label="BOM Growth" value={fmtGrowth(profile.historical.bomGrowth)} growthColor={growthColor(profile.historical.bomGrowth)} />
            <Row label="Deviasi Growth" value={fmtGrowth(profile.historical.deviasiGrowth)} growthColor={growthColor(profile.historical.deviasiGrowth, true)} />
            <Row label="Nominal Growth" value={fmtGrowth(profile.historical.nominalGrowth)} growthColor={growthColor(profile.historical.nominalGrowth, true)} />
            <div className="flex items-center gap-2 pt-1">
              {profile.historical.trend === 'DETERIORATING' && <TrendingUp className="h-4 w-4 text-red-600" />}
              {profile.historical.trend === 'IMPROVING' && <TrendingDown className="h-4 w-4 text-emerald-600" />}
              {profile.historical.trend === 'STABLE' && <Minus className="h-4 w-4 text-muted-foreground" />}
              <span className={`font-semibold ${profile.historical.trend === 'DETERIORATING' ? 'text-red-600' : profile.historical.trend === 'IMPROVING' ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {profile.historical.trend}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 4. Benchmark */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Benchmark</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            <Row label="Outlet Dev/BOM" value={fmtPct(profile.benchmark.outletDevBom)} />
            <Row label="Area Avg Dev/BOM" value={fmtPct(profile.benchmark.areaAvgDevBom)} />
            <Row label="Network Avg Dev/BOM" value={fmtPct(profile.benchmark.networkAvgDevBom)} />
            <Row label="Area Multiplier" value={profile.benchmark.areaMultiplier != null ? `${profile.benchmark.areaMultiplier.toFixed(2)}×` : '—'} />
          </CardContent>
        </Card>

        {/* 5. Top Risk */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Top Risk (by Dev/BOM)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            {profile.topRisk.byDevBom.slice(0, 5).map((r, i) => (
              <div key={i} className="flex justify-between">
                <span className="truncate max-w-[140px]">{r.itemName}</span>
                <span className="font-mono font-semibold text-red-600">{fmtPct(r.value)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 6. Investigation */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Investigation</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            <Row label="Normal" value={profile.investigation.normal.toString()} />
            <Row label="Warning" value={profile.investigation.warning.toString()} />
            <Row label="Abnormal" value={profile.investigation.abnormal.toString()} />
            <div className="flex gap-1 mt-2">
              <Badge variant="outline" className="text-[10px] text-red-600 border-red-300">P1: {currentRanking.filter(r => r.priority === 'P1').length}</Badge>
              <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">P2: {currentRanking.filter(r => r.priority === 'P2').length}</Badge>
              <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300">P3: {currentRanking.filter(r => r.priority === 'P3').length}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bahan Analysis — 3 Rankings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Bahan Analysis — 3 Rankings
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Financial (dampak uang) · Operational (abnormal vs volume) · Unexplained (residual tinggi)
          </p>
        </CardHeader>
        <CardContent>
          <Tabs value={rankingTab} onValueChange={setRankingTab}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="financial" className="text-xs">A. Financial Impact</TabsTrigger>
              <TabsTrigger value="operational" className="text-xs">B. Operational (Dev/BOM)</TabsTrigger>
              <TabsTrigger value="unexplained" className="text-xs">C. Unexplained (Residual)</TabsTrigger>
            </TabsList>

            <TabsContent value={rankingTab} className="mt-3">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="text-[11px] h-8">#</TableHead>
                      <TableHead className="text-[11px] h-8">Nama Bahan</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">BOM</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">Deviasi</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">Dev/BOM</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">Nominal</TableHead>
                      <TableHead className="text-[11px] h-8 text-center">Dir</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">W</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">S</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">T</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">Resid%</TableHead>
                      <TableHead className="text-[11px] h-8 text-center">Hist</TableHead>
                      <TableHead className="text-[11px] h-8 text-right">vs Area</TableHead>
                      <TableHead className="text-[11px] h-8 text-center">Pri</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentRanking.map((r) => (
                      <TableRow key={r.rank} className={`${priorityBg(r.priority)} cursor-pointer hover:ring-1 hover:ring-primary/30`} onClick={() => setSelectedItem(r.itemName)}>
                        <TableCell className="text-[11px] py-1.5 font-mono">{r.rank}</TableCell>
                        <TableCell className="text-[11px] py-1.5 font-medium max-w-[180px] truncate" title={r.itemName}>{r.itemName}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtNum(r.qtyBom)}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtNum(r.qtyDeviasi)}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono font-semibold text-red-600">{fmtPct(r.devBom)}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono">{fmtIDR(r.nominalLossSurplus)}</TableCell>
                        <TableCell className={`text-[11px] py-1.5 text-center font-semibold ${directionColor(r.direction)}`}>{r.direction === 'LOSS' ? 'L' : r.direction === 'SURPLUS' ? 'S' : '-'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground">{r.qtyWaste > 0 ? fmtNum(r.qtyWaste) : '—'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground">{r.qtySusut > 0 ? fmtNum(r.qtySusut) : '—'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono text-muted-foreground">{r.qtyTrial > 0 ? fmtNum(r.qtyTrial) : '—'}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono">{r.residualRatio != null ? fmtPct(r.residualRatio) : '—'}</TableCell>
                        <TableCell className={`text-[11px] py-1.5 text-center font-bold ${r.historicalTrend === '↑' ? 'text-red-600' : r.historicalTrend === '↓' ? 'text-emerald-600' : 'text-muted-foreground'}`}>{r.historicalTrend}</TableCell>
                        <TableCell className="text-[11px] py-1.5 text-right font-mono">
                          {r.areaMultiplier != null ? (
                            <span className={r.areaMultiplier > 1.5 ? 'text-red-600 font-semibold' : ''}>
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

      {/* Item Detail Modal — Phase 2: Historical + Benchmark per bahan */}
      {selectedItem && focusOutlet && (
        <ItemDetailModal
          outletCode={focusOutlet}
          itemName={selectedItem}
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
