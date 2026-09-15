'use client';

// ============================================================
//  FlipRanking — cross-item flip pattern ranking widget.
//  --------------------------------------------------------
//  Phase C of the flip detection feature. Renders at the BOTTOM
//  of the Trend Item Tab (below ItemPeerComparison drill panel).
//
//  Fetches /api/flip-ranking which scans ALL items and ranks
//  them by "flip risk score" — items with the most "sempurna"
//  (balanced reversal, disparity <10%) flips surface to the top.
//  These are suspicious patterns that may indicate:
//    - Periodic adjustment (adjustment at period end, reverse at start)
//    - Stock opname cutoff timing issues
//    - Operational pattern (over-order then return)
//
//  Clicking a row selects that item (setTrendSelectedItem) so the
//  user can drill into its trend + flip details above.
//
//  DRILL-DOWN (FLIP-DRILL):
//  Clicking the chevron in the "Top Flip Pair" cell expands a panel
//  BELOW the row (colSpan=7) that fetches per-outlet breakdowns for
//  BOTH periods from /api/flip-ranking/drilldown. Only ONE drill-down
//  can be open at a time (clicking another closes the previous).
//
//  SPLIT-B folder split (pure move, no behavior change):
//    ./types                    — FlipRankItem / response / sort types
//    ./FlipRankingHeader        — card header (title + tooltip + badges
//                                 + risk summary line)
//    ./FlipRankingStates        — loading / error / empty states
//    ./FlipRankingTableHeader   — sortable table header row + SortIcon
//    ./FlipRankingRow           — ranking row + drill-down panel
//    ../FlipDrillPanel          — per-outlet drill panel (REFACTOR-1-b)
//    ../flip-badges             — shared badge/key helpers (REFACTOR-1-b)
//  This file keeps the query + sorting + summary composition.
// ============================================================

import { memo, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody } from '@/components/ui/table';
import { ChevronRight } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
// SPLIT-B — pure move from this file (no behavior change).
import { FlipRankingHeader } from './FlipRankingHeader';
import {
  FlipRankingLoadingState,
  FlipRankingErrorState,
  FlipRankingEmptyState,
} from './FlipRankingStates';
import { FlipRankingTableHeader } from './FlipRankingTableHeader';
import { FlipRankingRow } from './FlipRankingRow';
import type { FlipRankingResponse, FlipRankingSummary, FlipSortKey, FlipSortDir } from './types';

export const FlipRanking = memo(function FlipRanking() {
  const { monthLabel, currentWeek, area, kelompok, outletCode, pic, trendSelectedItem, setTrendSelectedItem } = useDashboard(
    useShallow((s) => ({
      monthLabel: s.monthLabel,
      currentWeek: s.currentWeek,
      area: s.area,
      kelompok: s.kelompok,
      outletCode: s.outletCode,
      pic: s.pic,
      trendSelectedItem: s.trendSelectedItem,
      setTrendSelectedItem: s.setTrendSelectedItem,
    })),
  );

  const [sortKey, setSortKey] = useState<FlipSortKey>('riskScore');
  const [sortDir, setSortDir] = useState<FlipSortDir>('desc');
  // Drill-down expand/collapse state. Key = `${itemName}|${weekLabel}|${period1Label}`.
  // Only ONE drill-down can be open at a time — clicking another closes the previous.
  const [expandedFlip, setExpandedFlip] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<FlipRankingResponse>({
    // FIX (USER-REQ): include monthLabel in queryKey so ranking respects
    // dashboard month filter. When month is set, only flip pairs involving
    // that month are counted (backend filters P1 or P2 monthLabel match).
    queryKey: ['flip-ranking', monthLabel, currentWeek, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (monthLabel) p.set('month', monthLabel);
      if (currentWeek) p.set('week', currentWeek);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode) p.set('outlet', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/flip-ranking?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Fire when week is set (or even without — week is optional, ranking covers all weeks)
    // Default to enabled=true so the ranking shows even before a week is picked.
    enabled: true,
    staleTime: 5 * 60 * 1000, // 5 min — matches API cache
  });

  const items = data?.items ?? [];

  const sortedItems = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'riskScore':
          cmp = a.riskScore - b.riskScore;
          break;
        case 'sempurnaCount':
          cmp = a.sempurnaCount - b.sempurnaCount;
          break;
        case 'flipCount':
          cmp = a.flipCount - b.flipCount;
          break;
        case 'avgDisparity':
          cmp = a.avgDisparity - b.avgDisparity;
          break;
        case 'itemName':
          cmp = a.itemName.localeCompare(b.itemName);
          break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [items, sortKey, sortDir]);

  const toggleSort = (key: FlipSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'itemName' ? 'asc' : 'desc');
    }
  };

  // Toggle drill-down: clicking the same row closes it, clicking another
  // closes the previous + opens the new one.
  const toggleDrill = (key: string) => {
    setExpandedFlip((cur) => (cur === key ? null : key));
  };

  // Summary stats
  const summary = useMemo(() => {
    if (items.length === 0) return null;
    const highCount = items.filter((i) => i.riskLevel === 'high').length;
    const moderateCount = items.filter((i) => i.riskLevel === 'moderate').length;
    const totalFlips = items.reduce((s, i) => s + i.flipCount, 0);
    const totalSempurna = items.reduce((s, i) => s + i.sempurnaCount, 0);
    return { highCount, moderateCount, totalFlips, totalSempurna };
  }, [items]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <FlipRankingHeader data={data} itemCount={items.length} summary={summary} />

      <CardContent className="p-0">
        {isLoading ? (
          <FlipRankingLoadingState />
        ) : error ? (
          <FlipRankingErrorState message={error.message} onRetry={() => { void refetch(); }} />
        ) : sortedItems.length === 0 ? (
          <FlipRankingEmptyState />
        ) : (
          <div className="max-h-[500px] overflow-auto">
            <Table className="min-w-[900px]">
              <FlipRankingTableHeader sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <TableBody>
                {sortedItems.map((item, i) => (
                  <FlipRankingRow
                    key={`${item.itemName}-${i}`}
                    item={item}
                    index={i}
                    isSelected={item.itemName === trendSelectedItem}
                    expandedFlip={expandedFlip}
                    onToggleDrill={toggleDrill}
                    onSelectItem={setTrendSelectedItem}
                    area={area}
                    kelompok={kelompok}
                    outletCode={outletCode}
                    pic={pic}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {sortedItems.length > 0 && (
          <div className="p-3 text-xs text-muted-foreground border-t bg-muted/20 dark:bg-zinc-900/20">
            💡 Klik baris untuk lihat trend + flip detail item di atas.{' '}
            <span className="text-red-600 dark:text-red-400 font-medium">HIGH risk</span> = ada flip sempurna
            (disparity &lt;10%) — investigasi adjustment/cutoff.{' '}
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">🟢 Sempurna</span> = balanced reversal
            (suspicious).{' '}
            Klik <ChevronRight className="h-3 w-3 inline" /> di kolom Top Flip Pair untuk lihat resto mana saja yang berkontribusi.
          </div>
        )}
      </CardContent>
    </Card>
  );
});
