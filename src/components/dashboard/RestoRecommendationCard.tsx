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

  const { data, isLoading, error } = useQuery({
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
      <Card>
        <CardContent className="py-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
    if (level === 'TINGGI') return 'text-red-600 bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900 dark:text-red-400';
    if (level === 'SEDANG') return 'text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-400';
    return 'text-emerald-600 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-400';
  };

  const scoreColor = (score: number) => {
    if (score >= 60) return 'text-red-600';
    if (score >= 35) return 'text-amber-600';
    return 'text-emerald-600';
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="h-4 w-4" />
          Resto Prioritas Analisa
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Top {recommendations.length} resto dengan Priority Score tertinggi — klik untuk deep dive
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {recommendations.map((r, i) => (
          <div
            key={r.outletCode}
            className={`rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors ${
              r.priorityLevel === 'TINGGI' ? 'border-red-200 dark:border-red-900' :
              r.priorityLevel === 'SEDANG' ? 'border-amber-200 dark:border-amber-900' :
              'border-muted'
            }`}
            {...clickableRowProps(() => setFocusOutlet(r.outletCode))}
          >
            {/* Header row */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{r.outletName}</p>
                  <p className="text-[10px] text-muted-foreground">{r.outletCode} · {r.area}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-lg font-bold ${scoreColor(r.priorityScore)}`}>{r.priorityScore}</span>
                <Badge variant="outline" className={`text-[10px] ${levelColor(r.priorityLevel)}`}>
                  {r.priorityLevel}
                </Badge>
              </div>
            </div>

            {/* Quick metrics */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground mb-2">
              <span>Dev/BOM: <span className="font-mono font-semibold text-foreground">{fmtPctAbs(r.metrics.devBom)}</span></span>
              <span>Nominal: <span className={`font-mono font-semibold ${r.metrics.nominalDeviasi < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtIDR(r.metrics.nominalDeviasi)}</span></span>
              <span>Items: <span className="font-mono font-semibold text-foreground">{r.metrics.itemCount}</span></span>
              {r.metrics.topItem && (
                <span className="truncate max-w-[150px]">Top: <span className="font-medium text-foreground">{r.metrics.topItem}</span></span>
              )}
            </div>

            {/* Analysis bullets — show all signals (1-15), compact text */}
            <div className="space-y-0.5">
              {r.analysis.map((a, j) => (
                <p key={j} className="text-[10px] text-muted-foreground flex items-start gap-1 leading-tight">
                  <span className="text-primary mt-0.5 shrink-0">•</span>
                  <span>{a}</span>
                </p>
              ))}
            </div>

            {/* Direction + trend indicators */}
            <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t">
              <Badge variant="outline" className={`text-[9px] ${
                r.metrics.direction === 'LOSS' ? 'text-red-600 border-red-200' :
                r.metrics.direction === 'SURPLUS' ? 'text-emerald-600 border-emerald-200' : ''
              }`}>
                {r.metrics.direction}
              </Badge>
              {r.signals.directionFlip && (
                <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-200">
                  <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Flip
                </Badge>
              )}
              {r.signals.trendDeteriorating && (
                <Badge variant="outline" className="text-[9px] text-red-600 border-red-200">
                  <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> Memburuk
                </Badge>
              )}
              {r.signals.residualRatio > 0.4 && (
                <Badge variant="outline" className="text-[9px] text-red-600 border-red-200">
                  Residual {(r.signals.residualRatio * 100).toFixed(0)}%
                </Badge>
              )}
              {r.signals.toleranceBreachHighCount > 0 && (
                <Badge variant="outline" className="text-[9px] text-red-600 border-red-200">
                  Tol Breach High: {r.signals.toleranceBreachHighCount}
                </Badge>
              )}
              {r.signals.overExplainedCount > 0 && (
                <Badge variant="outline" className="text-[9px] text-red-600 border-red-200">
                  Anomali: {r.signals.overExplainedCount}
                </Badge>
              )}
              {r.signals.highLossItemCount > 0 && (
                <Badge variant="outline" className="text-[9px] text-red-600 border-red-200">
                  High Loss: {r.signals.highLossItemCount}
                </Badge>
              )}
              {r.signals.noToleranceItems > 0 && (
                <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-200">
                  No Tol: {r.signals.noToleranceItems}
                </Badge>
              )}
              {r.signals.benchmarkHighCount > 0 && (
                <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-200">
                  Bench High: {r.signals.benchmarkHighCount}
                </Badge>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
