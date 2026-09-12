'use client';

// ============================================================
//  PrioritySummaryCard — shows WHY this outlet is priority
//  Displays: Priority Score + Level + 8 signal badges + analysis
//  bullets.
//
//  UX-DRILLDOWN-1 (user request 2025-12): per-signal drill-down
//  charts removed — breakdown became a static list.
//  UX-BREAKDOWN-2 (user follow-up, 2026-09): the ENTIRE
//  "Breakdown 15 Sinyal Priority Score" section (toggle +
//  static list + top contributors) is REMOVED per explicit
//  user request ("masih ada... aku suruh hapus drill down itu").
//  Dead shared modules constants.ts + helpers.ts deleted;
//  types.ts survives (Recommendation/OutletItem re-exports).
//  The signal computation in the Priority Engine is untouched.
//
//  Phase 3 split: types live in ./priority-summary/types.ts
//  This file is a thin component that re-exports types for
//  backward compatibility (RestoAnalysis.tsx imports
//  Recommendation + OutletItem).
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target, AlertTriangle, TrendingUp } from 'lucide-react';
import { memo } from 'react';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import type { Recommendation, OutletItem } from './priority-summary/types';

// Backward-compat re-exports — RestoAnalysis.tsx imports these from here.
export type { Recommendation, OutletItem };

export const PrioritySummaryCard = memo(function PrioritySummaryCard({
  recommendation,
}: {
  recommendation: Recommendation | null | undefined;
  outletItems?: OutletItem[];
}) {
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
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20 border-amber-200/50 dark:border-amber-900/40">
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
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Priority Score</p>
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
              <p className="text-xs text-muted-foreground mt-1">
                {r.priorityLevel === 'TINGGI' ? 'Investigasi segera' : r.priorityLevel === 'SEDANG' ? 'Perlu perhatian' : 'Monitor saja'}
              </p>
            </div>
          </div>
          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Dev/BOM</p>
              <p className="text-sm font-semibold tabular-nums">{fmtPctAbs(r.metrics.devBom)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Nominal</p>
              <p className={`text-sm font-semibold tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {fmtIDR(r.metrics.nominalDeviasi)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Items</p>
              <p className="text-sm font-semibold tabular-nums">{r.metrics.itemCount}</p>
            </div>
          </div>
        </div>

        {/* Signal Badges — 8 key signals */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={`text-xs ${r.metrics.direction === 'LOSS' ? 'text-red-600 border-red-200 dark:text-red-400 dark:border-red-900' : 'text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900'}`}>
            {r.metrics.direction}
          </Badge>
          {r.signals.directionFlip && (
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Flip
            </Badge>
          )}
          {r.signals.trendDeteriorating && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> Memburuk
            </Badge>
          )}
          {r.signals.residualRatio > 0.4 && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Residual {(r.signals.residualRatio * 100).toFixed(0)}%
            </Badge>
          )}
          {r.signals.toleranceBreachHighCount > 0 && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Tol Breach High: {r.signals.toleranceBreachHighCount}
            </Badge>
          )}
          {r.signals.overExplainedCount > 0 && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Anomali: {r.signals.overExplainedCount}
            </Badge>
          )}
          {r.signals.highLossItemCount > 0 && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              High Loss: {r.signals.highLossItemCount}
            </Badge>
          )}
          {r.signals.noToleranceItems > 0 && (
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              Tanpa Tol: {r.signals.noToleranceItems}
            </Badge>
          )}
          {r.signals.benchmarkHighCount > 0 && (
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              Bench Tinggi: {r.signals.benchmarkHighCount}
            </Badge>
          )}
          {r.signals.highDevBomCount > 0 && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              {/* H-13: honest label — this count is a fixed |Dev/BOM| > 50% threshold,
                  not a z-score (badge formerly read "Z-Score Abnormal"). */}
              Deviasi &gt;50% BOM: {r.signals.highDevBomCount}
            </Badge>
          )}
        </div>

        {/* Analysis Bullets — WHY this outlet is priority */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Analisa Priority Engine</p>
          {r.analysis.map((a, j) => (
            <p key={j} className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-tight">
              <span className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0">•</span>
              <span>{a}</span>
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
