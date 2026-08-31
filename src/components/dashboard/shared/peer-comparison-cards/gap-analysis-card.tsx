'use client';

// ============================================================
//  Gap Analysis Card — presentational
//  --------------------------------------------------------
//  Renders target vs (optional) peer best vs (optional) peer
//  avg for each row. Pure presentational — caller computes the
//  values from its own row type.
// ============================================================

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target } from 'lucide-react';
import type { GapRow } from './types';

export interface GapAnalysisCardProps {
  /** Pre-computed rows (caller decides which metrics to show). */
  rows: GapRow[];
  /** Subtitle shown below the title (default matches Peer Tab wording). */
  subtitle?: string;
  /** Footer note shown below the grid (optional — Item Tab omits). */
  footerText?: string;
  /** Grid columns: 1 (single col, Item Tab style) or 2 (sm:grid-cols-2, Peer Tab style). Default 2. */
  gridCols?: 1 | 2;
}

export const GapAnalysisCard = memo(function GapAnalysisCard({
  rows,
  subtitle = 'Membandingkan target dengan peer TERBAIK (bukan rata-rata).',
  footerText,
  gridCols = 2,
}: GapAnalysisCardProps) {
  const gridClass = gridCols === 2 ? 'grid gap-2 sm:grid-cols-2' : 'grid gap-2';

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Gap Analysis (vs Peer Best)
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">{subtitle}</p>
      </CardHeader>
      <CardContent>
        <div className={gridClass}>
          {rows.map(r => {
            const gap = r.targetVal - r.bestVal;
            const isWorse = r.higherBetter ? gap < 0 : gap > 0;
            return (
              <div key={r.label} className="rounded-lg border bg-muted/20 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">{r.label}</span>
                  <Badge
                    variant="outline"
                    className={`text-[11px] h-4 font-medium ${
                      isWorse
                        ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30'
                        : 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
                    }`}
                  >
                    {isWorse ? 'di bawah best' : 'di atas best'}
                  </Badge>
                </div>
                <div className="mt-1 text-xs font-mono tabular-nums">
                  <span className="font-semibold">{r.format(r.targetVal)}</span>
                  <span className="text-muted-foreground"> vs best </span>
                  <span className="text-emerald-600 dark:text-emerald-400">{r.format(r.bestVal)}</span>
                  {r.avgVal !== undefined && (
                    <>
                      <span className="text-muted-foreground"> · avg </span>
                      <span className="text-muted-foreground">{r.format(r.avgVal)}</span>
                    </>
                  )}
                </div>
                <div className={`text-[11px] font-semibold tabular-nums ${isWorse ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {gap >= 0 ? '+' : ''}{r.format(gap)}
                  {r.pctAboveBest !== undefined && r.pctAboveBest !== 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({r.pctAboveBest >= 0 ? '+' : ''}{r.pctAboveBest.toFixed(0)}% vs best)
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {footerText && (
          <p className="mt-2 text-xs text-muted-foreground">{footerText}</p>
        )}
      </CardContent>
    </Card>
  );
});
