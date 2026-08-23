'use client';

// ============================================================
//  Feature 2: Gap Analysis — target vs peer BEST (not avg)
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import type { PeerRow, MetricDef } from './types';

export function GapAnalysisCard({
  target,
  peers,
  columns: _columns,
}: {
  target: PeerRow;
  peers: PeerRow[];
  columns: MetricDef[];
}) {
  // Metrics to show in gap analysis (focus on the bad ones + sales)
  const gapMetrics: Array<{ key: keyof PeerRow; label: string; format: (v: number) => string; higherBetter: boolean }> = [
    { key: 'devBom',      label: 'Dev/BOM',     format: (v) => fmtPctAbs(v), higherBetter: false },
    { key: 'totalLoss',   label: 'Total LOSS',  format: fmtIDR,              higherBetter: false },
    { key: 'residualQty', label: 'Residual',    format: fmtNum,              higherBetter: false },
    { key: 'sales',       label: 'Sales',       format: fmtIDR,              higherBetter: true  },
  ];

  const rows = gapMetrics.map(m => {
    const targetVal = target[m.key] as number;
    const values = peers.map(p => p[m.key] as number);
    // For bad metrics: best = min. For good metrics: best = max.
    const bestVal = m.higherBetter ? Math.max(...values) : Math.min(...values);
    const gap = targetVal - bestVal;
    // % above best — for bad metrics, gap > 0 = worse than best
    const pctAboveBest = bestVal !== 0 ? (gap / Math.abs(bestVal)) * 100 : 0;
    const isWorse = m.higherBetter ? gap < 0 : gap > 0;
    return { ...m, targetVal, bestVal, gap, pctAboveBest, isWorse };
  });

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Gap Analysis (vs Peer Best)
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">Membandingkan target dengan peer TERBAIK (bukan rata-rata).</p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map(r => (
            <div key={r.key as string} className="rounded-lg border bg-muted/20 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">{r.label}</span>
                <Badge variant="outline" className={`text-[11px] h-4 font-medium ${r.isWorse ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30' : 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'}`}>
                  {r.isWorse ? 'di bawah best' : 'di atas best'}
                </Badge>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums">
                <span className="font-semibold">{r.format(r.targetVal)}</span>
                <span className="text-muted-foreground"> vs best </span>
                <span className="text-emerald-600 dark:text-emerald-400">{r.format(r.bestVal)}</span>
              </div>
              <div className={`text-[11px] font-semibold tabular-nums ${r.isWorse ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {r.gap >= 0 ? '+' : ''}{r.format(r.gap)}
                {r.pctAboveBest !== 0 && (
                  <span className="text-xs text-muted-foreground ml-1">
                    ({r.pctAboveBest >= 0 ? '+' : ''}{r.pctAboveBest.toFixed(0)}% vs best)
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Untuk metrik &quot;buruk&quot; (Dev/BOM, LOSS, Residual), peer best = nilai terendah.
          Untuk Sales, peer best = nilai tertinggi.
        </p>
      </CardContent>
    </Card>
  );
}
