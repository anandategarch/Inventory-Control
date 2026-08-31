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
import { fmtNum, fmtIDR } from '@/lib/format';
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

// Local types matching /api/flip-ranking/drilldown response.
interface FlipDrillOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  qtyDeviasiSigned: number;
  nominalDeviasi: number;
  absNominalDeviasi: number;
  direction: string;
}

interface FlipDrillPeriod {
  monthLabel: string;
  outlets: FlipDrillOutlet[];
}

interface FlipDrilldownResponse {
  success: boolean;
  item: { itemName: string };
  weekLabel: string;
  period1: FlipDrillPeriod;
  period2: FlipDrillPeriod;
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

/**
 * Build the drill-down cache key — `${itemName}|${weekLabel}|${period1Label}`.
 * Used as the `expandedFlip` state value so toggling the same row closes it
 * and toggling a different row closes the previous + opens the new one.
 */
function drillKey(itemName: string, weekLabel: string, period1Label: string): string {
  return `${itemName}|${weekLabel}|${period1Label}`;
}

/**
 * Extract the month prefix from a short period label like "Jul W4" → "Jul".
 * The drill-down API accepts either a full label ("Juli 2026") or a short
 * prefix ("Jul") and matches via ILIKE. Sending the short prefix is simplest
 * — it's already what FlipPair.period1Label contains.
 */
function monthPrefix(periodLabel: string): string {
  // "Jul W4" → "Jul", "Juli 2026 W4" → "Juli" (handle both shapes defensively).
  // Take everything before the FIRST space.
  const idx = periodLabel.indexOf(' ');
  return idx > 0 ? periodLabel.slice(0, idx) : periodLabel;
}

// ------------------------------------------------------------
//  FlipDrillPanel — renders BELOW the row when expanded.
//  Fetches per-outlet breakdown for both P1 + P2 from
//  /api/flip-ranking/drilldown and renders two outlet tables.
// ------------------------------------------------------------

interface FlipDrillPanelProps {
  item: string;
  flip: FlipPair;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
}

function directionBadgeClass(direction: string): string {
  switch (direction) {
    case 'LOSS':
      return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'SURPLUS':
      return 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/60 dark:border-emerald-800 dark:text-emerald-400';
    default:
      return 'text-muted-foreground bg-muted/50 border-border';
  }
}

function FlipDrillPanel({ item, flip, area, kelompok, outletCode, pic }: FlipDrillPanelProps) {
  // Pull the month prefix from each short label. The drill-down API uses
  // ILIKE prefix matching so "Jul" matches "Juli 2026".
  const month1 = monthPrefix(flip.period1Label);
  const month2 = monthPrefix(flip.period2Label);

  const { data, isLoading, error } = useQuery<FlipDrilldownResponse>({
    queryKey: ['flip-drilldown', item, flip.weekLabel, month1, month2, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('item', item);
      p.set('week', flip.weekLabel);
      p.set('month1', month1);
      p.set('month2', month2);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode) p.set('outlet', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/flip-ranking/drilldown?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: true, // parent only renders this component when expanded
    staleTime: 5 * 60 * 1000, // 5 min — matches API cache
  });

  // Category display name for the subline (e.g. "Dominan").
  const categoryDisplay = flip.category.charAt(0).toUpperCase() + flip.category.slice(1);
  const cb = categoryBadge(flip.category);

  return (
    <div className="bg-purple-50/40 dark:bg-purple-950/10 border-t border-purple-200/60 dark:border-purple-900/40 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-purple-700 dark:text-purple-400 flex items-center gap-1.5">
          <Shuffle className="h-3.5 w-3.5" />
          Flip Drill-down: <span className="text-foreground">{item}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-foreground tabular-nums">{flip.weekLabel}</span>
        </span>
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
      </div>
      {/* Subline: P1 (signed) → P2 (signed) · Disparity X% (category) */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="tabular-nums font-medium">
          <span className="text-muted-foreground">{flip.period1Label}</span>{' '}
          <span className={flip.qtyP1 < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
            ({fmtNum(flip.qtyP1, '', false)})
          </span>
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="tabular-nums font-medium">
          <span className="text-muted-foreground">{flip.period2Label}</span>{' '}
          <span className={flip.qtyP2 < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
            ({fmtNum(flip.qtyP2, '', false)})
          </span>
        </span>
        <span className="text-muted-foreground">·</span>
        <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${cb.className}`}>
          <span aria-hidden>{cb.emoji}</span>
          Disparity {flip.disparityPct.toFixed(1)}% ({categoryDisplay})
        </span>
      </div>

      {/* Body: loading / error / both period tables */}
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
          <span className="ml-2 text-xs text-muted-foreground">Memuat per-outlet breakdown...</span>
        </div>
      ) : error ? (
        <div className="text-center text-red-600 dark:text-red-400 text-xs py-4">
          Gagal memuat drill-down: {error.message}
        </div>
      ) : !data ? null : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <FlipDrillPeriodTable
            label="Period 1"
            period={data.period1}
            weekLabel={flip.weekLabel}
          />
          <FlipDrillPeriodTable
            label="Period 2"
            period={data.period2}
            weekLabel={flip.weekLabel}
          />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  FlipDrillPeriodTable — per-outlet table for ONE period.
// ------------------------------------------------------------

interface FlipDrillPeriodTableProps {
  label: string;
  period: FlipDrillPeriod;
  weekLabel: string;
}

function FlipDrillPeriodTable({ label, period, weekLabel }: FlipDrillPeriodTableProps) {
  const totalQty = period.outlets.reduce((s, o) => s + o.qtyDeviasiSigned, 0);
  const totalNominal = period.outlets.reduce((s, o) => s + o.nominalDeviasi, 0);

  return (
    <div className="rounded-md border border-purple-200/60 dark:border-purple-900/40 bg-background/80 dark:bg-zinc-950/40 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-purple-200/60 dark:border-purple-900/40 bg-purple-50/40 dark:bg-purple-950/20 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold text-purple-700 dark:text-purple-400">
          {label}:{' '}
          <span className="text-foreground">{period.monthLabel}</span>{' '}
          <span className="text-muted-foreground tabular-nums">{weekLabel}</span>
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          ({period.outlets.length} outlet berkontribusi)
        </span>
      </div>
      <div className="px-2.5 py-1 text-[10px] text-muted-foreground border-b border-purple-200/40 dark:border-purple-900/30 flex items-center gap-3 flex-wrap tabular-nums">
        <span>
          Total QTY:{' '}
          <span className={totalQty < 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-emerald-600 dark:text-emerald-400 font-medium'}>
            {fmtNum(totalQty, '', false)}
          </span>
        </span>
        <span>
          Total Nominal:{' '}
          <span className={totalNominal < 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-emerald-600 dark:text-emerald-400 font-medium'}>
            {fmtIDR(totalNominal, false)}
          </span>
        </span>
      </div>
      {period.outlets.length === 0 ? (
        <div className="text-center text-muted-foreground text-xs py-4 px-3">
          Tidak ada outlet dengan deviasi untuk periode ini.
        </div>
      ) : (
        <div className="max-h-[280px] overflow-auto">
          <Table className="min-w-[480px]">
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Area</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">QTY Dev</TableHead>
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">Nominal</TableHead>
                <TableHead className="text-center text-[10px] font-semibold uppercase tracking-wider h-8">Dir</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {period.outlets.map((o, i) => {
                const isLoss = o.qtyDeviasiSigned < 0;
                const isSurplus = o.qtyDeviasiSigned > 0;
                return (
                  <TableRow
                    key={`${o.outletCode}-${i}`}
                    className={i % 2 === 1 ? 'bg-muted/20 hover:bg-muted/40' : 'hover:bg-muted/40'}
                  >
                    <TableCell className="py-1.5">
                      <div className="flex flex-col leading-tight">
                        <span className="text-[11px] font-medium tabular-nums">{o.outletCode}</span>
                        <span className="text-[10px] text-muted-foreground truncate max-w-[140px]" title={o.outletName}>
                          {o.outletName}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-[10px] text-muted-foreground py-1.5 tabular-nums">{o.area || '—'}</TableCell>
                    <TableCell className="text-[10px] text-muted-foreground py-1.5">{o.pic || '—'}</TableCell>
                    <TableCell
                      className={`text-right text-[11px] py-1.5 tabular-nums font-medium ${
                        isLoss ? 'text-red-600 dark:text-red-400' : isSurplus ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                      }`}
                    >
                      {fmtNum(o.qtyDeviasiSigned, '', false)}
                    </TableCell>
                    <TableCell
                      className={`text-right text-[11px] py-1.5 tabular-nums ${
                        o.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : o.nominalDeviasi > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                      }`}
                    >
                      {fmtIDR(o.nominalDeviasi, false)}
                    </TableCell>
                    <TableCell className="text-center py-1.5">
                      <Badge variant="outline" className={`text-[9px] h-4 px-1 font-medium ${directionBadgeClass(o.direction)}`}>
                        {o.direction}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
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
  // Drill-down expand/collapse state. Key = `${itemName}|${weekLabel}|${period1Label}`.
  // Only ONE drill-down can be open at a time — clicking another closes the previous.
  const [expandedFlip, setExpandedFlip] = useState<string | null>(null);

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
                          {topFlip && cb && dKey ? (
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
                                className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-purple-100 dark:hover:bg-purple-950/40 text-purple-600 dark:text-purple-400 transition-colors"
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
