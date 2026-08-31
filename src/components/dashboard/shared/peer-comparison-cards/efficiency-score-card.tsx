'use client';

// ============================================================
//  Efficiency Score Card — presentational
//  --------------------------------------------------------
//  Renders a 0-100 composite efficiency score with a colored
//  progress bar + baseline marker. Pure presentational — the
//  caller computes the score (different formulas per consumer).
// ============================================================

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Gauge } from 'lucide-react';

export interface EfficiencyScoreCardProps {
  /** 0-100 composite score, pre-computed by caller. */
  score: number;
  /** Baseline peer-avg marker (default 100 — peer has zero deviation from itself). */
  peerAvgScore?: number;
  /** Footnote text shown below the progress bar (explains the formula). */
  footnote?: string;
}

export const EfficiencyScoreCard = memo(function EfficiencyScoreCard({
  score,
  peerAvgScore = 100,
  footnote,
}: EfficiencyScoreCardProps) {
  const color = score > 70 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';
  const textColor = score > 70 ? 'text-emerald-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  const label = score > 70 ? 'Di atas peer average' : score >= 50 ? 'Sekitar peer average' : 'Di bawah peer average';

  // Marker position: peerAvgScore=100 → right edge (100%).
  const markerRightPct = Math.max(0, Math.min(100, 100 - peerAvgScore));

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
            <div className="text-muted-foreground tabular-nums">Peer Avg: {peerAvgScore}/100 (baseline)</div>
            <div className={`font-medium ${textColor}`}>{label}</div>
          </div>
        </div>
        <div
          className="relative h-3 w-full rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${score}%` }} />
          {/* Peer average marker */}
          <div
            className="absolute top-0 h-full w-0.5 bg-foreground/40"
            style={{ right: `${markerRightPct}%` }}
            title={`Peer avg baseline (${peerAvgScore})`}
          />
        </div>
        {footnote && (
          <p className="text-xs text-muted-foreground">{footnote}</p>
        )}
      </CardContent>
    </Card>
  );
});
