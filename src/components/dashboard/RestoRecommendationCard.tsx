'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Target, Loader2, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';

interface RestoRecommendation {
  outletCode: string;
  outletName: string;
  area: string;
  priorityScore: number;
  priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  signals: {
    devBomRatio: number;
    deviasiGrowth: number | null;
    abnormalCount: number;
    residualRatio: number;
    lossToSales: number;
    directionFlip: boolean;
    trendDeteriorating: boolean;
    itemConcentration: number;
    toleranceBreachCount: number;
    toleranceBreachHighCount: number;
    zScoreAbnormalCount: number;
    overExplainedCount: number;
    highLossItemCount: number;
    noToleranceItems: number;
    benchmarkHighCount: number;
  };
  metrics: {
    sales: number;
    nominalDeviasi: number;
    devBom: number;
    totalLoss: number;
    totalSurplus: number;
    residualQty: number;
    itemCount: number;
    direction: string;
    topItem: string | null;
    topItemNominal: number;
  };
  analysis: string[];
}

export function RestoRecommendationCard() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, pic, setFocusOutlet } = useDashboard();

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['recommendations', monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel!);
      p.set('week', currentWeek!);
      if (comparisonWeek) p.set('prevWeek', comparisonWeek);
      if (comparisonMonth) p.set('prevMonth', comparisonMonth);
      p.set('limit', '5');
      if (area && area !== 'all') p.set('area', area);
      if (outletCode && outletCode !== 'all') p.set('outletCode', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/recommendations?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json();
    },
    enabled: Boolean(monthLabel && currentWeek),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
              <Target className="h-3.5 w-3.5" />
            </span>
            Resto Prioritas Analisa
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
          </CardTitle>
          <p className="text-xs text-muted-foreground ml-9">Memuat rekomendasi...</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                  <div className="space-y-1">
                    <div className="h-3 w-24 bg-muted rounded animate-pulse" />
                    <div className="h-2 w-16 bg-muted rounded animate-pulse" />
                  </div>
                </div>
                <div className="h-6 w-12 bg-muted rounded animate-pulse" />
              </div>
              <div className="flex gap-2">
                <div className="h-2 flex-1 bg-muted rounded animate-pulse" />
                <div className="h-2 flex-1 bg-muted rounded animate-pulse" />
                <div className="h-2 flex-1 bg-muted rounded animate-pulse" />
              </div>
              <div className="space-y-1">
                <div className="h-2 w-full bg-muted rounded animate-pulse" />
                <div className="h-2 w-3/4 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error || !data?.success) {
    return null; // silently fail — don't block dashboard
  }

  const recommendations: RestoRecommendation[] = data.recommendations || [];

  if (recommendations.length === 0) return null;

  const levelColor = (level: string) => {
    if (level === 'TINGGI') return 'text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-950/40 border-red-300 dark:border-red-800';
    if (level === 'SEDANG') return 'text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800';
    return 'text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800';
  };

  const levelAccent = (level: string) => {
    if (level === 'TINGGI') return 'bg-red-500';
    if (level === 'SEDANG') return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  const rankBg = (level: string) => {
    if (level === 'TINGGI') return 'bg-gradient-to-br from-red-500 to-red-600 text-white';
    if (level === 'SEDANG') return 'bg-gradient-to-br from-amber-500 to-amber-600 text-white';
    return 'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white';
  };

  const scoreColor = (score: number) => {
    if (score >= 60) return 'text-red-600 dark:text-red-400';
    if (score >= 35) return 'text-amber-600 dark:text-amber-400';
    return 'text-emerald-600 dark:text-emerald-400';
  };

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Resto Prioritas Analisa
          {isFetching && !isLoading && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Top <span className="font-medium tabular-nums">{recommendations.length}</span> resto dengan Priority Score tertinggi — klik untuk deep dive
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {recommendations.map((r, i) => (
          <div
            key={r.outletCode}
            className={`relative rounded-xl border p-3 pl-4 cursor-pointer hover:shadow-lg dark:hover:shadow-black/30 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden shadow-sm ${
              r.priorityLevel === 'TINGGI' ? 'border-red-200/80 dark:border-red-900/60 bg-gradient-to-br from-red-50/40 to-transparent dark:from-red-950/20' :
              r.priorityLevel === 'SEDANG' ? 'border-amber-200/80 dark:border-amber-900/60 bg-gradient-to-br from-amber-50/40 to-transparent dark:from-amber-950/20' :
              'border-border bg-gradient-to-br from-emerald-50/40 to-transparent dark:from-emerald-950/20'
            }`}
            {...clickableRowProps(() => setFocusOutlet(r.outletCode))}
          >
            {/* Left accent bar by priority */}
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${levelAccent(r.priorityLevel)}`} aria-hidden />

            {/* Header row */}
            <div className="flex items-start justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Rank badge with gradient */}
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-bold shrink-0 shadow-sm ${rankBg(r.priorityLevel)}`}>
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate leading-tight">{r.outletName}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{r.outletCode} · {r.area}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="text-right">
                  <p className={`text-xl font-bold leading-none tabular-nums ${scoreColor(r.priorityScore)}`}>{r.priorityScore}</p>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider mt-0.5">Priority</p>
                </div>
                <Badge variant="outline" className={`text-[10px] font-semibold border ${levelColor(r.priorityLevel)}`}>
                  {r.priorityLevel}
                </Badge>
              </div>
            </div>

            {/* Quick metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2 text-[11px]">
              <div className="rounded-md border bg-background/60 px-2 py-1">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Dev/BOM</p>
                <p className="font-mono font-semibold tabular-nums">{fmtPctAbs(r.metrics.devBom)}</p>
              </div>
              <div className="rounded-md border bg-background/60 px-2 py-1">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Nominal</p>
                <p className={`font-mono font-semibold tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtIDR(r.metrics.nominalDeviasi)}</p>
              </div>
              <div className="rounded-md border bg-background/60 px-2 py-1">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Items</p>
                <p className="font-mono font-semibold tabular-nums">{r.metrics.itemCount}</p>
              </div>
              <div className="rounded-md border bg-background/60 px-2 py-1 min-w-0">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Top Item</p>
                <p className="font-medium truncate" title={r.metrics.topItem || ''}>{r.metrics.topItem || '—'}</p>
              </div>
            </div>

            {/* Analysis bullets — show all signals (1-15), compact text */}
            <div className="space-y-0.5 mb-2">
              {r.analysis.map((a, j) => (
                <p key={j} className="text-[10px] text-muted-foreground flex items-start gap-1.5 leading-tight">
                  <span className="text-amber-500 mt-1 shrink-0 text-[8px]">●</span>
                  <span>{a}</span>
                </p>
              ))}
            </div>

            {/* Direction + trend indicators */}
            <div className="flex flex-wrap items-center gap-1 mt-2 pt-2 border-t">
              <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">Signals:</span>
              <Badge variant="outline" className={`text-[9px] h-4 ${
                r.metrics.direction === 'LOSS' ? 'text-red-600 border-red-200 dark:text-red-400 dark:border-red-900' :
                r.metrics.direction === 'SURPLUS' ? 'text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900' : ''
              }`}>
                {r.metrics.direction}
              </Badge>
              {r.signals.directionFlip && (
                <Badge variant="outline" className="text-[9px] h-4 text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
                  <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Flip
                </Badge>
              )}
              {r.signals.trendDeteriorating && (
                <Badge variant="outline" className="text-[9px] h-4 text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
                  <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> Memburuk
                </Badge>
              )}
              {r.signals.residualRatio > 0.4 && (
                <Badge variant="outline" className="text-[9px] h-4 text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
                  Residual <span className="tabular-nums ml-0.5">{(r.signals.residualRatio * 100).toFixed(0)}%</span>
                </Badge>
              )}
              {r.signals.toleranceBreachHighCount > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
                  Tol Breach: <span className="tabular-nums ml-0.5">{r.signals.toleranceBreachHighCount}</span>
                </Badge>
              )}
              {r.signals.overExplainedCount > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
                  Anomali: <span className="tabular-nums ml-0.5">{r.signals.overExplainedCount}</span>
                </Badge>
              )}
              {r.signals.highLossItemCount > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
                  High Loss: <span className="tabular-nums ml-0.5">{r.signals.highLossItemCount}</span>
                </Badge>
              )}
              {r.signals.noToleranceItems > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
                  No Tol: <span className="tabular-nums ml-0.5">{r.signals.noToleranceItems}</span>
                </Badge>
              )}
              {r.signals.benchmarkHighCount > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
                  Bench High: <span className="tabular-nums ml-0.5">{r.signals.benchmarkHighCount}</span>
                </Badge>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
