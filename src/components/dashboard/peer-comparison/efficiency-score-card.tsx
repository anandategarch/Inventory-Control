'use client';

// ============================================================
//  Feature 7: Efficiency Score — composite 0-100
// ============================================================

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Gauge } from 'lucide-react';
import type { PeerRow, PeerAverages } from './types';

export function EfficiencyScoreCard({
  target,
  peerAvg,
}: {
  target: PeerRow;
  peerAvg: PeerAverages;
}) {
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
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
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
        <p className="text-xs text-muted-foreground">
          Komposit dari Dev/BOM (50%), LOSS (25%), Residual (15%), Sales (10%). Higher = better.
        </p>
      </CardContent>
    </Card>
  );
}
