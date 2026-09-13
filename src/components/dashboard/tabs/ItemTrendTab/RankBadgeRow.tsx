'use client';

// ============================================================
//  RankBadgeRow — Phase 1 national-rank badge row.
//  --------------------------------------------------------
//  REFACTOR-1-b: pure move from ItemTrendTab/index.tsx (no
//  behavior change). Looks up the selected item in
//  `analysisData.topDeviasiRank` (national top-50 per item-outlet
//  pair). Shows:
//    [Rank #N Nasional (Deviasi)] [Rank #M (BOM)] [K outlet terdampak]
//  When the item is not in the top-50, shows a muted "Rank > 50 Nasional" badge.
//
//  Color thresholds:
//    rank 1-5   → red (severe)
//    rank 6-20  → amber (warning)
//    rank > 20  → muted (elevated but not critical)
// ============================================================

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Award } from 'lucide-react';
import type { AnalysisData, DeviasiRankItem } from '@/hooks/useAnalysis';

function rankBadgeClass(rank: number | null): string {
  if (rank == null || rank > 50) return 'text-muted-foreground border-border bg-muted/40';
  if (rank <= 5) return 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30';
  if (rank <= 20) return 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30';
  return 'text-muted-foreground border-border bg-muted/40';
}

export interface RankBadgeRowProps {
  itemName: string;
  analysisData?: AnalysisData;
}

export function RankBadgeRow({ itemName, analysisData }: RankBadgeRowProps) {
  const matches: DeviasiRankItem[] = useMemo(() => {
    if (!analysisData?.topDeviasiRank) return [];
    return analysisData.topDeviasiRank.filter(it => it.itemName === itemName);
  }, [analysisData, itemName]);

  // Best (lowest) rank for the item across all its outlets in top-50.
  // FIX (BUG-1-01): rankBom is now `number | null` — use type predicate to
  // filter nulls so Math.min gets a clean number[].
  const rankNominal = matches.length > 0
    ? Math.min(...matches.map(m => m.rankNominal))
    : null;
  const rankBomCandidates = matches
    .map(m => m.rankBom)
    .filter((r): r is number => r != null && r > 0);
  const rankBom = rankBomCandidates.length > 0
    ? Math.min(...rankBomCandidates)
    : null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs mt-1">
      <Badge
        variant="outline"
        className={`text-[11px] h-5 px-1.5 gap-1 ${rankBadgeClass(rankNominal)}`}
        title={`Rank nasional by |nominal deviasi| (top 50). Best rank across ${matches.length} outlet terdampak.`}
      >
        <Award className="h-3 w-3" />
        {rankNominal != null ? `Rank #${rankNominal} Nasional (Deviasi)` : 'Rank > 50 Nasional'}
      </Badge>
      <Badge
        variant="outline"
        className={`text-[11px] h-5 px-1.5 ${rankBadgeClass(rankBom)}`}
        title="Rank nasional by |QTY BOM| (top 50)"
      >
        {rankBom != null ? `Rank #${rankBom} (BOM)` : 'Rank BOM > 50'}
      </Badge>
      <Badge variant="secondary" className="text-[11px] h-5 px-1.5 tabular-nums">
        {matches.length} outlet terdampak (top 50)
      </Badge>
    </div>
  );
}
