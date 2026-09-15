'use client';

// ============================================================
//  FlipRankingHeader — card header for the flip ranking widget
//  --------------------------------------------------------
//  SPLIT-B (pure move from FlipRanking.tsx — no behavior change):
//  purple Shuffle icon + title + "ⓘ" tooltip (flip pattern
//  detection explainer) + cache/stale badges + scanned-count
//  line + the risk summary line (N risiko TINGGI · N sedang ·
//  N total flip · N sempurna).
// ============================================================

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Shuffle, ChevronRight } from 'lucide-react';
import type { FlipRankingResponse, FlipRankingSummary } from './types';

interface FlipRankingHeaderProps {
  /** Raw /api/flip-ranking response — drives the cache/stale badges + scanned count. */
  data: FlipRankingResponse | undefined;
  /** Number of items currently displayed (data.items ?? []).length. */
  itemCount: number;
  /** Summary stats (null when there are no items). */
  summary: FlipRankingSummary | null;
}

export function FlipRankingHeader({ data, itemCount, summary }: FlipRankingHeaderProps) {
  return (
    <CardHeader className="pb-3">
      <CardTitle className="text-sm flex items-center gap-2.5 flex-wrap">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 shrink-0">
          <Shuffle className="h-3.5 w-3.5" />
        </span>
        Flip Ranking — Cross-Item
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-muted-foreground/60 text-xs">ⓘ</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm text-xs p-3">
            <p className="font-semibold mb-1">Flip Pattern Detection</p>
            <p className="text-muted-foreground">
              Mendeteksi item dengan pola &ldquo;balanced reversal&rdquo; — deviasi flip arah antar same-week period
              (W4 Jul vs W4 Agu). Flip &ldquo;sempurna&rdquo; (disparity &lt;10%) adalah pola suspicious yang mungkin
              menandakan: adjustment periodik, stock opname cutoff, atau operational pattern (over-order lalu return).
            </p>
            <p className="text-muted-foreground mt-1">
              Disparity = |net| / MAX(|P1|, |P2|). 0% = flip sempurna balanced.
            </p>
            <p className="text-muted-foreground mt-1">
              💡 Klik ikon <ChevronRight className="h-3 w-3 inline" /> di kolom &ldquo;Top Flip Pair&rdquo; untuk lihat per-outlet breakdown.
            </p>
          </TooltipContent>
        </Tooltip>
        {data?.cached && (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
            cache
          </Badge>
        )}
        {data?.stale && (
          <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
            stale
          </Badge>
        )}
        {data && (
          <span className="text-xs text-muted-foreground font-normal ml-auto">
            {data.totalItemsScanned} item di-scan · {itemCount} ditampilkan
          </span>
        )}
      </CardTitle>
      {summary && (
        <p className="text-xs text-muted-foreground ml-9 flex items-center gap-3 flex-wrap">
          {/* FIX (BUG-HUNT C6/B2-12): EN fragments in an Indonesian summary line. */}
          <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">
            {summary.highCount} risiko TINGGI
          </span>
          <span>·</span>
          <span className="text-amber-600 dark:text-amber-400 font-medium tabular-nums">
            {summary.moderateCount} sedang
          </span>
          <span>·</span>
          <span className="tabular-nums">{summary.totalFlips} total flip</span>
          <span>·</span>
          <span className="text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">
            {summary.totalSempurna} sempurna
          </span>
        </p>
      )}
    </CardHeader>
  );
}
