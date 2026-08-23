'use client';

// ============================================================
//  Feature 1: Ranking Summary — target's rank per metric
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Award } from 'lucide-react';
import type { PeerRow, MetricDef } from './types';

export function RankingSummaryCard({
  target,
  peers,
  columns,
}: {
  target: PeerRow;
  peers: PeerRow[];
  columns: MetricDef[];
}) {
  // For each metric, rank all peers (1 = best, N = worst)
  const total = peers.length;
  const ranks = columns.map(col => {
    const sorted = [...peers].sort((a, b) => {
      const av = a[col.key] as number;
      const bv = b[col.key] as number;
      // For higherBetter: highest = best = rank 1 → sort descending
      // For bad metrics (lower better): lowest = best = rank 1 → sort ascending
      return col.higherBetter ? bv - av : av - bv;
    });
    const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
    const worst = rank === total;
    const best = rank === 1;
    return { col, rank, total, worst, best };
  });

  // Show only the most important metrics in the compact summary
  const keyMetrics = ['sales', 'devBom', 'totalLoss', 'residualQty', 'nominalDeviasi', 'qtyWaste'];
  const keyRanks = ranks.filter(r => keyMetrics.includes(r.col.key as string));

  const rankColor = (rank: number, total: number) => {
    if (rank === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
    if (rank === total) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
    if (rank <= total / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
    return 'bg-muted text-muted-foreground';
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Award className="h-3.5 w-3.5" />
          </span>
          Ranking Summary
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          <span className="font-medium text-foreground">{target.outletName}</span> ranked di antara <span className="font-medium tabular-nums">{total}</span> resto (1 = terbaik, <span className="tabular-nums">{total}</span> = terburuk).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {keyRanks.map(({ col, rank, total: t, worst, best }) => (
            <div key={col.key as string} className="flex items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2">
              <span className="text-[11px] text-muted-foreground">{col.label}</span>
              <Badge className={`text-xs h-5 font-medium tabular-nums ${rankColor(rank, t)}`} variant="secondary">
                #{rank}/{t}
                {best && ' ★'}
                {worst && ' ⚠'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
