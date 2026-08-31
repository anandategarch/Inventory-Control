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
//  Layout:
//    1. Header with title + risk summary
//    2. Sortable table: Rank | Item | Flips | Sempurna | Avg Disparity
//       | Risk Score | Top Flip Pair
//    3. Selected item highlighted if present in the ranking
//
//  Clicking a row selects that item (setTrendSelectedItem) so the
//  user can drill into its trend + flip details above.
// ============================================================

import { memo, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Loader2, Shuffle, AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtNum } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';

// Local types matching /api/flip-ranking response (kept local to avoid
// importing from the API route file — backend types are not exported).
interface FlipPair {
  period1Label: string;
  period2Label: string;
  weekLabel: string;
  qtyP1: number;
  qtyP2: number;
  net: number;
  disparityPct: number;
  category: string;
}

interface FlipRankItem {
  itemName: string;
  totalPairs: number;
  flipCount: number;
  sempurnaCount: number;
  dominanCount: number;
  parsialCount: number;
  konsistenCount: number;
  avgDisparity: number;
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'high';
  topFlips: FlipPair[];
}

interface FlipRankingResponse {
  success: boolean;
  items: FlipRankItem[];
  totalItemsScanned: number;
  durationMs?: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

type SortKey = 'riskScore' | 'sempurnaCount' | 'flipCount' | 'avgDisparity' | 'itemName';
type SortDir = 'asc' | 'desc';

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return dir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

function riskBadge(level: 'low' | 'moderate' | 'high'): { className: string; label: string } {
  switch (level) {
    case 'high':
      return {
        className: 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400',
        label: 'HIGH',
      };
    case 'moderate':
      return {
        className: 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400',
        label: 'MODERATE',
      };
    case 'low':
      return {
        className: 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/60 dark:border-emerald-800 dark:text-emerald-400',
        label: 'LOW',
      };
  }
}

function categoryBadge(category: string): { emoji: string; className: string } {
  switch (category) {
    case 'sempurna':
      return { emoji: '🟢', className: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' };
    case 'dominan':
      return { emoji: '🟡', className: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30' };
    case 'parsial':
      return { emoji: '🔴', className: 'text-red-600 bg-red-50 dark:bg-red-950/30' };
    default:
      return { emoji: '⚪', className: 'text-muted-foreground bg-muted/40' };
  }
}

export const FlipRanking = memo(function FlipRanking() {
  const { currentWeek, area, kelompok, outletCode, pic, trendSelectedItem, setTrendSelectedItem } = useDashboard(
    useShallow((s) => ({
      currentWeek: s.currentWeek,
      area: s.area,
      kelompok: s.kelompok,
      outletCode: s.outletCode,
      pic: s.pic,
      trendSelectedItem: s.trendSelectedItem,
      setTrendSelectedItem: s.setTrendSelectedItem,
    })),
  );

  const [sortKey, setSortKey] = useState<SortKey>('riskScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data, isLoading, error } = useQuery<FlipRankingResponse>({
    queryKey: ['flip-ranking', currentWeek, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
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

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'itemName' ? 'asc' : 'desc');
    }
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
            </TooltipContent>
          </Tooltip>
          {data?.cached && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
              cached
            </Badge>
          )}
          {data?.stale && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              stale
            </Badge>
          )}
          {data && (
            <span className="text-xs text-muted-foreground font-normal ml-auto">
              {data.totalItemsScanned} item di-scan · {items.length} ditampilkan
            </span>
          )}
        </CardTitle>
        {summary && (
          <p className="text-xs text-muted-foreground ml-9 flex items-center gap-3 flex-wrap">
            <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">
              {summary.highCount} HIGH risk
            </span>
            <span>·</span>
            <span className="text-amber-600 dark:text-amber-400 font-medium tabular-nums">
              {summary.moderateCount} moderate
            </span>
            <span>·</span>
            <span className="tabular-nums">{summary.totalFlips} total flips</span>
            <span>·</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">
              {summary.totalSempurna} sempurna
            </span>
          </p>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
            <span className="ml-2 text-xs text-muted-foreground">Memuat flip ranking...</span>
          </div>
        ) : error ? (
          <div className="text-center text-red-600 dark:text-red-400 text-sm py-8 px-6">
            Gagal memuat flip ranking: {error.message}
          </div>
        ) : sortedItems.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8 px-6">
            <Shuffle className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
            Tidak ada data flip. Butuh minimal 2 periode same-week untuk analisis flip.
          </div>
        ) : (
          <div className="max-h-[500px] overflow-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="w-12 text-center text-xs font-semibold uppercase tracking-wider h-9">#</TableHead>
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40"
                    onClick={() => toggleSort('itemName')}
                  >
                    Item <SortIcon active={sortKey === 'itemName'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40"
                    onClick={() => toggleSort('flipCount')}
                  >
                    Flips <SortIcon active={sortKey === 'flipCount'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40"
                    onClick={() => toggleSort('sempurnaCount')}
                  >
                    🟢 Sempurna <SortIcon active={sortKey === 'sempurnaCount'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40"
                    onClick={() => toggleSort('avgDisparity')}
                  >
                    Avg Disparity <SortIcon active={sortKey === 'avgDisparity'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40"
                    onClick={() => toggleSort('riskScore')}
                  >
                    Risk Score <SortIcon active={sortKey === 'riskScore'} dir={sortDir} />
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-9">Top Flip Pair</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedItems.map((item, i) => {
                  const isSelected = item.itemName === trendSelectedItem;
                  const topFlip = item.topFlips[0];
                  const rb = riskBadge(item.riskLevel);
                  const cb = topFlip ? categoryBadge(topFlip.category) : null;
                  return (
                    <TableRow
                      key={`${item.itemName}-${i}`}
                      className={`cursor-pointer hover:bg-muted/40 transition-colors border-b ${
                        isSelected
                          ? 'bg-amber-50/60 dark:bg-amber-950/20 border-l-2 border-l-amber-500'
                          : i % 2 === 1
                            ? 'bg-muted/20'
                            : ''
                      }`}
                      {...clickableRowProps(() => setTrendSelectedItem(item.itemName))}
                    >
                      <TableCell className="text-center text-xs text-muted-foreground tabular-nums py-2">{i + 1}</TableCell>
                      <TableCell className="text-xs py-2">
                        <div className="font-medium truncate max-w-[200px]" title={item.itemName}>
                          {item.itemName}
                        </div>
                        {isSelected && (
                          <Badge variant="default" className="text-[10px] ml-1 h-4 bg-amber-600 hover:bg-amber-600 text-white">
                            SELECTED
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums">
                        {item.flipCount}
                        <span className="text-muted-foreground text-[10px]"> / {item.totalPairs}</span>
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                        {item.sempurnaCount > 0 ? item.sempurnaCount : '—'}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums text-muted-foreground">
                        {item.flipCount > 0 ? `${(item.avgDisparity * 100).toFixed(1)}%` : '—'}
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          {item.riskLevel === 'high' && <AlertTriangle className="h-3 w-3 text-red-500" />}
                          <Badge variant="outline" className={`text-[10px] h-5 px-1.5 font-medium tabular-nums ${rb.className}`}>
                            {rb.label} {item.riskScore}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2">
                        {topFlip && cb ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1 cursor-help">
                                <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${cb.className}`}>
                                  <span aria-hidden>{cb.emoji}</span>
                                  <span className="tabular-nums">{topFlip.disparityPct.toFixed(1)}%</span>
                                </span>
                                <span className="text-muted-foreground text-[10px] tabular-nums">
                                  {topFlip.period1Label} → {topFlip.period2Label}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="text-xs p-3 max-w-xs">
                              <div className="space-y-1">
                                <p className="font-semibold">
                                  {topFlip.period1Label} → {topFlip.period2Label} ({topFlip.weekLabel})
                                </p>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted-foreground">P1 (signed):</span>
                                  <span className={`font-medium tabular-nums ${topFlip.qtyP1 < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                    {fmtNum(topFlip.qtyP1, '', false)}
                                  </span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted-foreground">P2 (signed):</span>
                                  <span className={`font-medium tabular-nums ${topFlip.qtyP2 < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                    {fmtNum(topFlip.qtyP2, '', false)}
                                  </span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted-foreground">Net (P1+P2):</span>
                                  <span className="font-medium tabular-nums">{fmtNum(topFlip.net, '', false)}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted-foreground">Disparity:</span>
                                  <span className="font-bold tabular-nums">{topFlip.disparityPct.toFixed(1)}%</span>
                                </div>
                                {item.topFlips.length > 1 && (
                                  <p className="text-muted-foreground text-[10px] pt-1 border-t">
                                    +{item.topFlips.length - 1} flip lainnya
                                  </p>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
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
            (suspicious).
          </div>
        )}
      </CardContent>
    </Card>
  );
});
