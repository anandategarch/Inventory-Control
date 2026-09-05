'use client';

// ============================================================
//  Gap Analysis Card — presentational
//  --------------------------------------------------------
//  Renders target vs (optional) peer best vs (optional) peer
//  avg for each row. Pure presentational — caller computes the
//  values from its own row type.
//
//  FIX (PATTERN-2): now uses TargetComparison component for each
//  row's delta display, eliminating manual gap/pct calculation
//  + color logic. The card itself still manages layout (grid,
//  header, footer) — only the per-row comparison display is
//  delegated to TargetComparison.
// ============================================================

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target } from 'lucide-react';
import { TargetComparison } from '@/components/dashboard/shared/TargetComparison';
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
            // FIX (PATTERN-2): use TargetComparison for delta display.
            // downIsGood = !higherBetter (for Dev/BOM, Loss, Residual —
            // higher value = worse → downIsGood=true so decrease shows green).
            // For Sales (higherBetter=true) — downIsGood=false (up = good).
            const downIsGood = !r.higherBetter;
            const isWorse = r.higherBetter ? gap < 0 : gap > 0;

            // Map the row's format function to a preset code.
            // The row.format is a closure that already handles formatting
            // (fmtIDR, fmtNum, fmtPctAbs, etc). We use it for display + pass
            // a compatible preset to TargetComparison for the delta.
            // Since the format function is caller-specific, we pass a generic
            // preset that matches the formatter's output style.
            const preset = r.format === fmtIDRRef ? 'idr0' :
                          r.format === fmtNumRef ? 'num0' :
                          r.format === fmtPctAbsRef ? 'pct1abs' : 'num0';

            return (
              <div key={r.label} className="rounded-lg border bg-muted/20 p-2.5">
                <div className="flex items-center justify-between mb-1">
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

                {/* FIX (PATTERN-2): TargetComparison handles delta + color + arrow. */}
                <TargetComparison
                  current={r.targetVal}
                  baseline={r.bestVal}
                  displayType="pct"
                  formatPreset={preset}
                  downIsGood={downIsGood}
                  showArrow
                  showBaseline
                  size="sm"
                  label=""
                />

                {/* Show avg separately (TargetComparison only shows current vs baseline). */}
                {r.avgVal !== undefined && (
                  <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                    avg: {r.format(r.avgVal)}
                  </div>
                )}
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

// References to the format functions for preset mapping.
// These are imported by the callers (PeerComparison.tsx, ItemPeerComparison.tsx)
// and passed as the `format` field in GapRow. We check identity here to
// pick the right preset for TargetComparison's delta display.
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
const fmtIDRRef = fmtIDR;
const fmtNumRef = fmtNum;
const fmtPctAbsRef = fmtPctAbs;
