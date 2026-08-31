'use client';

// ============================================================
//  Ranking Summary Card — presentational
//  --------------------------------------------------------
//  Renders a grid of stat boxes — each box has a label + a
//  Badge with pre-formatted content. Pure presentational —
//  caller computes the items (rank, percentile, counts, etc.).
//
//  Two layout styles supported (via gridCols):
//    - 3 cols (Peer Tab): 6 metric ranks.
//    - 2 cols (Item Trend Tab): rank + percentile + loss/surplus counts.
// ============================================================

import { memo } from 'react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Award } from 'lucide-react';
import type { RankItem } from './types';

export interface RankingSummaryCardProps {
  /** Pre-computed stat items (label + badge content). */
  items: RankItem[];
  /** Subtitle shown below the title — must include target name + total. */
  subtitle: ReactNode;
  /** Grid columns: 2 (default, Item Tab style) or 3 (Peer Tab style). */
  gridCols?: 2 | 3;
  /** Per-item layout: horizontal (Peer Tab, label-badge on a row) or
   *  vertical (Item Tab, label on top + badge below). Default horizontal. */
  itemLayout?: 'horizontal' | 'vertical';
}

export const RankingSummaryCard = memo(function RankingSummaryCard({
  items,
  subtitle,
  gridCols = 2,
  itemLayout = 'horizontal',
}: RankingSummaryCardProps) {
  const gridClass = gridCols === 3
    ? 'grid grid-cols-2 sm:grid-cols-3 gap-2'
    : 'grid grid-cols-2 gap-2';
  const itemClass = itemLayout === 'vertical'
    ? 'flex flex-col items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2'
    : 'flex items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2';

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Award className="h-3.5 w-3.5" />
          </span>
          Ranking Summary
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">{subtitle}</p>
      </CardHeader>
      <CardContent>
        <div className={gridClass}>
          {items.map((item, i) => (
            <div
              key={`${item.label}-${i}`}
              className={itemClass}
            >
              <span className="text-[11px] text-muted-foreground">{item.label}</span>
              <Badge
                className={`text-xs h-5 font-medium tabular-nums ${item.badgeClass ?? ''}`}
                variant={item.variant ?? 'secondary'}
              >
                {item.badgeContent}
                {item.star && ' ★'}
                {item.warn && ' ⚠'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
