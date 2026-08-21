'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Target, AlertTriangle, TrendingUp, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { fmtIDR, fmtPctAbs } from '@/lib/format';

// ============================================================
//  PrioritySummaryCard — shows WHY this outlet is priority
//  Displays: Priority Score + Level + 8 signal badges + analysis
//  bullets + 15-signal breakdown table
// ============================================================

interface SignalScore {
  name: string;
  score: number;
  weight: number;
  value: string;
}

interface Recommendation {
  outletCode: string;
  outletName: string;
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
  signalScores?: SignalScore[];
}

export function PrioritySummaryCard({ recommendation }: { recommendation: Recommendation | null | undefined }) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  if (!recommendation) return null;

  const r = recommendation;
  const levelColor =
    r.priorityLevel === 'TINGGI'
      ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
      : r.priorityLevel === 'SEDANG'
      ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'
      : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900';

  const scoreColor =
    r.priorityScore >= 55
      ? 'text-red-600 dark:text-red-400'
      : r.priorityScore >= 30
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';

  const scoreBarColor =
    r.priorityScore >= 55 ? 'bg-red-500' : r.priorityScore >= 30 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20 border-amber-200/50 dark:border-amber-900/40">
      <CardHeader className="pb-3 border-b bg-gradient-to-r from-amber-50/50 to-transparent dark:from-amber-950/20">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Priority Summary — Kenapa Resto Ini Prioritas?
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {/* Score + Level + Quick Metrics */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            {/* Priority Score */}
            <div className="text-center">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Priority Score</p>
              <p className={`text-3xl font-bold tabular-nums ${scoreColor}`}>{r.priorityScore}</p>
              <div className="w-24 h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                <div className={`h-full ${scoreBarColor} transition-all duration-500`} style={{ width: `${r.priorityScore}%` }} />
              </div>
            </div>
            {/* Level Badge */}
            <div>
              <Badge variant="outline" className={`text-xs font-semibold ${levelColor}`}>
                {r.priorityLevel}
              </Badge>
              <p className="text-[10px] text-muted-foreground mt-1">
                {r.priorityLevel === 'TINGGI' ? 'Investigasi segera' : r.priorityLevel === 'SEDANG' ? 'Perlu perhatian' : 'Monitor saja'}
              </p>
            </div>
          </div>
          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Dev/BOM</p>
              <p className="text-sm font-semibold tabular-nums">{fmtPctAbs(r.metrics.devBom)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Nominal</p>
              <p className={`text-sm font-semibold tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {fmtIDR(r.metrics.nominalDeviasi)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Items</p>
              <p className="text-sm font-semibold tabular-nums">{r.metrics.itemCount}</p>
            </div>
          </div>
        </div>

        {/* Signal Badges — 8 key signals */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={`text-[10px] ${r.metrics.direction === 'LOSS' ? 'text-red-600 border-red-200 dark:text-red-400 dark:border-red-900' : 'text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900'}`}>
            {r.metrics.direction}
          </Badge>
          {r.signals.directionFlip && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Flip
            </Badge>
          )}
          {r.signals.trendDeteriorating && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> Memburuk
            </Badge>
          )}
          {r.signals.residualRatio > 0.4 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Residual {(r.signals.residualRatio * 100).toFixed(0)}%
            </Badge>
          )}
          {r.signals.toleranceBreachHighCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Tol Breach High: {r.signals.toleranceBreachHighCount}
            </Badge>
          )}
          {r.signals.overExplainedCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Anomali: {r.signals.overExplainedCount}
            </Badge>
          )}
          {r.signals.highLossItemCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              High Loss: {r.signals.highLossItemCount}
            </Badge>
          )}
          {r.signals.noToleranceItems > 0 && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              No Tol: {r.signals.noToleranceItems}
            </Badge>
          )}
          {r.signals.benchmarkHighCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              Bench High: {r.signals.benchmarkHighCount}
            </Badge>
          )}
          {r.signals.zScoreAbnormalCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Z-Score Abnormal: {r.signals.zScoreAbnormalCount}
            </Badge>
          )}
        </div>

        {/* Analysis Bullets — WHY this outlet is priority */}
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Analisa Priority Engine</p>
          {r.analysis.map((a, j) => (
            <p key={j} className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-tight">
              <span className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0">•</span>
              <span>{a}</span>
            </p>
          ))}
        </div>

        {/* Signal Breakdown — collapsible 15-signal table */}
        {r.signalScores && r.signalScores.length > 0 && (
          <div className="border-t pt-3">
            <button
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showBreakdown ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Breakdown 15 Sinyal Priority Score
            </button>
            {showBreakdown && (
              <div className="mt-2 space-y-1">
                {r.signalScores.map((s, i) => {
                  const contribution = Math.round(s.score * s.weight);
                  const scoreBg =
                    s.score >= 50 ? 'bg-red-500' : s.score >= 25 ? 'bg-amber-500' : s.score > 0 ? 'bg-emerald-500' : 'bg-muted';
                  return (
                    <div key={i} className="flex items-center gap-2 text-[10px]">
                      <span className="w-32 truncate text-muted-foreground" title={s.name}>{s.name}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full ${scoreBg} transition-all duration-300`} style={{ width: `${s.score}%` }} />
                      </div>
                      <span className="w-10 text-right tabular-nums text-muted-foreground">{s.score}</span>
                      <span className="w-8 text-right tabular-nums text-muted-foreground/60">{Math.round(s.weight * 100)}%</span>
                      <span className="w-10 text-right tabular-nums font-semibold text-foreground">+{contribution}</span>
                      <span className="w-20 text-right tabular-nums text-muted-foreground/80 truncate" title={s.value}>{s.value}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 text-[10px] pt-1.5 border-t mt-1.5">
                  <span className="w-32 font-semibold text-foreground">Total Priority Score</span>
                  <div className="flex-1" />
                  <span className="w-10" />
                  <span className="w-8" />
                  <span className="w-10 text-right tabular-nums font-bold text-foreground">= {r.priorityScore}</span>
                  <span className="w-20" />
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
