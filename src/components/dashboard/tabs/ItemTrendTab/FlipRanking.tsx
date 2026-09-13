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
//
//  DRILL-DOWN (FLIP-DRILL):
//  Clicking the chevron in the "Top Flip Pair" cell expands a panel
//  BELOW the row (colSpan=7) that fetches per-outlet breakdowns for
//  BOTH periods from /api/flip-ranking/drilldown. Renders two outlet
//  tables (P1 + P2) showing each outlet's signed QTY Deviasi + Nominal
//  + Direction. Only ONE drill-down can be open at a time (clicking
//  another closes the previous).
//
//  REFACTOR-1-b: FlipDrillPanel now lives in ./FlipDrillPanel and the
//  shared badge/key helpers in ./flip-badges (pure move, no behavior
//  change). This file keeps the ranking table + sorting.
// ============================================================

import { memo, useState, useMemo, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  Loader2,
  Shuffle,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtNum, fmtDecimal } from '@/lib/format';
import { clickableRowProps, sortableHeaderProps } from '@/lib/a11y';
// SHADCN-PATTERNS (Pattern 4) — reusable structured EmptyState. Replaces
// the inline `<Shuffle ... /> Tidak ada data flip ...` block.
import { EmptyState } from '@/components/ui/empty-state';
// REFACTOR-1-b — shared badge/key helpers + FlipPair type moved to
// './flip-badges'; the drill-down panel moved to './FlipDrillPanel'.
import { riskBadge, categoryBadge, drillKey, type FlipPair } from './flip-badges';
import { FlipDrillPanel } from './FlipDrillPanel';

// Local types matching /api/flip-ranking response (kept local to avoid
// importing from the API route file — backend types are not exported).
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

  const [sortKey, setSortKey] = useState<SortKey>('riskScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
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

  const toggleSort = (key: SortKey) => {
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
              {data.totalItemsScanned} item di-scan · {items.length} ditampilkan
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

      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
            <span className="ml-2 text-xs text-muted-foreground">Memuat flip ranking...</span>
          </div>
        ) : error ? (
          <div className="text-center text-red-600 dark:text-red-400 text-sm py-8 px-6">
            <p>Gagal memuat flip ranking: {error.message}</p>
            {/* FIX (BUG-HUNT C20/B2-13): recovery affordance — parity with the
                ParetoDashboard / peer-table error states that offer "Coba Lagi". */}
            <button
              type="button"
              onClick={() => { void refetch(); }}
              className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-red-700"
            >
              Coba Lagi
            </button>
          </div>
        ) : sortedItems.length === 0 ? (
          // SHADCN-PATTERNS (Pattern 4) — replaced inline `<Shuffle ... />`
          // block with <EmptyState>. Same copy + Shuffle icon as before.
          <EmptyState
            icon={Shuffle}
            title="Tidak ada data flip"
            description="Butuh minimal 2 periode same-week untuk analisis flip."
          />
        ) : (
          <div className="max-h-[500px] overflow-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="w-12 text-center text-xs font-semibold uppercase tracking-wider h-9">#</TableHead>
                  {/* FIX (BUG-HUNT B12/B2-03): sortable headers were onClick-only —
                      keyboard/screen-reader users could not sort. Shared helper keeps
                      th columnheader semantics + aria-sort; labels localized (B2-12). */}
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('itemName', 'Item', sortKey, sortDir, toggleSort)}
                  >
                    Item <SortIcon active={sortKey === 'itemName'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('flipCount', 'Flip', sortKey, sortDir, toggleSort)}
                  >
                    Flip <SortIcon active={sortKey === 'flipCount'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('sempurnaCount', 'Sempurna', sortKey, sortDir, toggleSort)}
                  >
                    🟢 Sempurna <SortIcon active={sortKey === 'sempurnaCount'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('avgDisparity', 'Disparitas Rata-rata', sortKey, sortDir, toggleSort)}
                  >
                    Disparitas Rata-rata <SortIcon active={sortKey === 'avgDisparity'} dir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('riskScore', 'Skor Risiko', sortKey, sortDir, toggleSort)}
                  >
                    Skor Risiko <SortIcon active={sortKey === 'riskScore'} dir={sortDir} />
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
                  // Drill-down key — only meaningful when there's a topFlip.
                  const dKey = topFlip ? drillKey(item.itemName, topFlip.weekLabel, topFlip.period1Label) : null;
                  const isExpanded = dKey !== null && expandedFlip === dKey;
                  return (
                    <Fragment key={`${item.itemName}-${i}`}>
                      <TableRow
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
                              TERPILIH
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
                          {item.flipCount > 0 ? `${fmtDecimal(item.avgDisparity * 100, 1)}%` : '—'}
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
                          {/* FIX (USER-REQ): show drill-down chevron for HIGH + MODERATE risk items.
                              Only LOW risk items hide the chevron — drill-down is for investigating
                              items with actual flips (HIGH = sempurna flip, MODERATE = other flips). */}
                          {topFlip && cb && dKey && item.riskLevel !== 'low' ? (
                            <div className="flex items-center gap-1">
                              {/* Chevron — toggles drill-down panel */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleDrill(dKey);
                                }}
                                aria-label={isExpanded ? 'Tutup drill-down' : 'Buka drill-down'}
                                aria-expanded={isExpanded}
                                // FIX (UI2-08): h-8 w-8 (32px) — below 44px touch target but usable; was h-5 w-5 (20px) unusable on mobile
                                className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-purple-100 dark:hover:bg-purple-950/40 text-purple-600 dark:text-purple-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center gap-1 cursor-help">
                                    <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${cb.className}`}>
                                      <span aria-hidden>{cb.emoji}</span>
                                      <span className="tabular-nums">{fmtDecimal(topFlip.disparityPct, 1)}%</span>
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
                                      <span className="font-bold tabular-nums">{fmtDecimal(topFlip.disparityPct, 1)}%</span>
                                    </div>
                                    <p className="text-muted-foreground text-[10px] pt-1 border-t">
                                      💡 Klik <ChevronRight className="h-3 w-3 inline" /> untuk per-outlet breakdown
                                    </p>
                                    {item.topFlips.length > 1 && (
                                      <p className="text-muted-foreground text-[10px] pt-1 border-t">
                                        +{item.topFlips.length - 1} flip lainnya
                                      </p>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-[10px]">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {/* Drill-down panel — spans all 7 columns. */}
                      {isExpanded && topFlip && (
                        <TableRow className="border-b hover:bg-transparent">
                          <TableCell colSpan={7} className="p-0">
                            <FlipDrillPanel
                              item={item.itemName}
                              flip={topFlip}
                              area={area}
                              kelompok={kelompok}
                              outletCode={outletCode}
                              pic={pic}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
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
            (suspicious).{' '}
            Klik <ChevronRight className="h-3 w-3 inline" /> di kolom Top Flip Pair untuk lihat resto mana saja yang berkontribusi.
          </div>
        )}
      </CardContent>
    </Card>
  );
});
