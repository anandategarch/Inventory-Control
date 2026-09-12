'use client';

// ============================================================
//  ItemTrendTable — Sortable Data Table
//  --------------------------------------------------------
//  Per-period data table with 9 sortable columns:
//    Period | QTY BOM | QTY Deviasi signed | Z-Score | Status |
//    Outlets | Pola (Pattern) | Flip | Records
//
//  Phase 1 additions:
//    - "Pola" (Pattern) column — classifies the period's blast radius
//      by outlet count (Massal ≥10 / Regional ≥5 / Lokal ≥2 / Tunggal =1).
//    - `onRowClick` prop — row click invokes callback with the period,
//      powering the Phase 2 drill-down into ItemPeerComparison.
//    - `drillPeriod` prop — when set, the matching row gets a highlighted
//      background (visual indicator of the currently drilled period).
//
//  Phase A+B (FLIP-FE) additions:
//    - "Flip" column — shows whether the period's signed qtyDeviasi
//      flipped direction vs its same-week predecessor (W4 Jul → W4 Agu).
//      Categories: sempurna / dominan / parsial / konsisten-naik /
//      konsisten-turun / stagnan / first.
//    - `flips` prop — array of FlipAnalysis from computeFlipAnalyses()
//      (passed down from the parent who memoizes it once per item).
//    - 'flip' sort key — sorts rows by disparityPct (null/non-flip
//      rows sort to the bottom on desc).
//
//  Parent owns sort state (sortKey/sortDir/toggleSort) and the
//  already-sorted rows array. Z-Score cells get a tooltip with
//  the full breakdown (current value, mean, stdDev, sampleSize,
//  nominal).
//
//  Coloring helpers (zScoreColor, zScoreStatus) come from
//  ./zScoreHelpers — shared pattern with HistoricalZScoreCard.
// ============================================================

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import type { ItemTrendMetric, ItemTrendPeriod } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtDecimal } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { zScoreColor, zScoreStatus } from './zScoreHelpers';
import { periodShortLabel } from './periodHelpers';
import {
  getFlipForPeriod,
  flipBadge,
  formatDisparity,
  periodKey as flipPeriodKey,
  type FlipAnalysis,
} from './flipHelpers';
import { METRICS, type SortKey, type SortDir } from './types';

export interface ItemTrendTableProps {
  sortedRows: ItemTrendPeriod[];
  sortKey: SortKey;
  sortDir: SortDir;
  toggleSort: (key: SortKey) => void;
  metric: ItemTrendMetric;
  /** Row click handler — invokes callback with the clicked period.
   *  Powers the Phase 2 drill-down into ItemPeerComparison. */
  onRowClick?: (period: ItemTrendPeriod) => void;
  /** When set, the row matching this period (monthLabel + weekLabel)
   *  gets a highlighted background indicating it is the currently
   *  drilled period. */
  drillPeriod?: { month: string; week: string } | null;
  /** Flip analyses for the item (Phase A+B / FLIP-FE). Each row looks
   *  up its flip pair (vs same-week predecessor) via getFlipForPeriod.
   *  Optional — when omitted, the Flip column renders muted "—" cells. */
  flips?: FlipAnalysis[];
  /** FIX (SATUAN-BUG): item's unit of measure (e.g. "KG", "PCS", "LTR").
   *  Used in Flip column tooltips to display the correct unit. Was hardcoded
   *  "kg" which was wrong for non-KG items. */
  satuan?: string | null;
}

// ------------------------------------------------------------
//  Pattern classification — classifies the blast radius of a
//  period by outlet count. Used by the new "Pola" column.
//  Thresholds: Massal ≥10 / Regional ≥5 / Lokal ≥2 / Tunggal =1.
// ------------------------------------------------------------
function patternBadge(outletCount: number): { emoji: string; label: string; className: string } {
  if (outletCount >= 10) {
    return {
      emoji: '🔴',
      label: 'Massal',
      className: 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30',
    };
  }
  if (outletCount >= 5) {
    return {
      emoji: '🟡',
      label: 'Regional',
      className: 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30',
    };
  }
  if (outletCount >= 2) {
    return {
      emoji: '⚪',
      label: 'Lokal',
      className: 'text-muted-foreground border-border bg-muted/40',
    };
  }
  // FIX (BUG-1-02): outletCount=0 is semantically "no data", not "Tunggal" (single).
  // FIX (BUG-1-03): use distinct emoji for Tunggal (was same ⚪ as Lokal).
  if (outletCount === 1) {
    return {
      emoji: '📍',
      label: 'Tunggal',
      className: 'text-muted-foreground border-border bg-muted/40',
    };
  }
  // outletCount === 0 (shouldn't happen — item has records but no outlets?)
  return {
    emoji: '—',
    label: 'N/A',
    className: 'text-muted-foreground/50 border-border bg-muted/20',
  };
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return sortDir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

export function ItemTrendTable({
  sortedRows,
  sortKey,
  sortDir,
  toggleSort,
  metric,
  onRowClick,
  drillPeriod,
  flips,
  satuan,
}: ItemTrendTableProps) {
  // FIX (SATUAN-BUG): use item's actual satuan, fallback to empty string
  // (no unit suffix) when null/unknown. Was hardcoded "kg" which was wrong
  // for non-KG items like PCS, LTR, etc.
  const unitLabel = satuan || '';

  // FIX (UI2-01 P1): sortable headers must be keyboard-accessible.
  // Wrap toggleSort with role/tabIndex/onKeyDown so keyboard + screen reader
  // users can sort via Enter/Space. Returns spread props for <TableHead>.
  const sortHeaderProps = (key: SortKey) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `Sort by ${key}`,
    'aria-sort': (sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') as 'ascending' | 'descending' | 'none',
    onClick: () => toggleSort(key),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSort(key);
      }
    },
  });

  return (
    <div className="max-h-96 overflow-auto border-t">
      <Table className="min-w-[1040px]">
        <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
          <TableRow className="border-b hover:bg-transparent">
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('period')}
            >
              Periode <SortIcon col="period" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('qtyBom')}
            >
              QTY BOM <SortIcon col="qtyBom" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('qtyDeviasiSigned')}
            >
              QTY Deviasi <SortIcon col="qtyDeviasiSigned" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('zScore')}
            >
              Z-Score <SortIcon col="zScore" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">
              Status
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('outletCount')}
            >
              Outlets <SortIcon col="outletCount" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            {/* Phase 1 — Pattern column. Not sortable (classification derived
                from outletCount which already has its own sortable column). */}
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">
              Pola
            </TableHead>
            {/* Phase A+B (FLIP-FE) — Flip column. Sortable by disparityPct
                (rows with no flip pair, i.e. `first`, sort to bottom on desc). */}
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('flip')}
            >
              Flip <SortIcon col="flip" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              {...sortHeaderProps('recordCount')}
            >
              Records <SortIcon col="recordCount" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((p, i) => {
            const z = p.zScore;
            const status = zScoreStatus(z);
            const isLoss = p.qtyDeviasiSigned < 0;
            const pattern = patternBadge(p.outletCount);
            // Phase A+B (FLIP-FE) — look up the flip pair (vs same-week
            // predecessor). Null when this period has no predecessor
            // (first same-week period → category 'first').
            const flip = flips ? getFlipForPeriod(flips, flipPeriodKey(p)) : null;
            const flipCat = flip?.category ?? 'first';
            const flipCfg = flipBadge(flipCat);
            const isDrillRow = Boolean(
              drillPeriod &&
              drillPeriod.month === p.monthLabel &&
              drillPeriod.week === p.weekLabel,
            );
            return (
              <TableRow
                key={`${p.monthKey}-${p.weekLabel}-${i}`}
                className={`transition-colors border-b ${
                  onRowClick ? 'cursor-pointer' : ''
                } ${
                  isDrillRow
                    ? 'bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-950/30'
                    : 'hover:bg-muted/40'
                }`}
                // FIX (UI2-03): use clickableRowProps from lib/a11y.ts so the
                // clickable row is keyboard-accessible (Tab focus + Enter/Space
                // activates the click handler). Was previously onClick-only,
                // which locked out keyboard + screen reader users.
                {...(onRowClick ? clickableRowProps(() => onRowClick(p)) : {})}
              >
                <TableCell className="text-xs px-3 py-2">
                  <div className="font-medium leading-tight">{periodShortLabel(p)}</div>
                  <div className="text-[10px] text-muted-foreground">{p.monthLabel} · {p.weekLabel}</div>
                </TableCell>
                <TableCell className="text-xs px-3 py-2 text-right tabular-nums">
                  {fmtNum(p.qtyBom)}
                </TableCell>
                <TableCell className={`text-xs px-3 py-2 text-right tabular-nums font-medium ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {p.qtyDeviasiSigned.toLocaleString('id-ID', { maximumFractionDigits: 1 })}
                </TableCell>
                {/* Z-Score with tooltip — SIGNED coloring */}
                <TableCell className={`text-xs px-3 py-2 text-right tabular-nums ${z != null ? zScoreColor(z) : 'text-muted-foreground'}`}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center justify-end gap-1.5 cursor-help">
                        {z != null && (
                          <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden" aria-hidden>
                            <div
                              className={`h-full ${
                                z > 3 ? 'bg-red-500' :
                                z > 2 ? 'bg-amber-500' :
                                z > 1 ? 'bg-yellow-500' :
                                z < -2 ? 'bg-emerald-500' :
                                z < -1 ? 'bg-emerald-400' :
                                'bg-muted-foreground/40'
                              }`}
                              style={{ width: `${Math.min(Math.abs(z) / 5 * 100, 100)}%` }}
                            />
                          </div>
                        )}
                        {z == null ? '—' : z > 0 ? `+${fmtDecimal(z, 2)}` : fmtDecimal(z, 2)}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs p-3 max-w-xs">
                      <div className="space-y-1">
                        <p className="font-semibold">Z-Score Breakdown</p>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Current |{METRICS.find(m => m.value === metric)?.shortLabel ?? 'Deviasi'}|:</span>
                          <span className="font-medium tabular-nums">{fmtNum(Math.abs(metric === 'qtyDeviasi' ? p.qtyDeviasiSigned : metric === 'qtyWaste' ? p.qtyWaste : metric === 'qtySusut' ? p.qtySusut : p.qtyTrial))}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Historical Mean:</span>
                          <span className="font-medium tabular-nums">{fmtNum(p.historicalMean)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Std Dev:</span>
                          <span className="font-medium tabular-nums">{fmtNum(p.historicalStdDev)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Sample Size:</span>
                          <span className="font-medium tabular-nums">{p.sampleSize} weeks</span>
                        </div>
                        {z != null && (
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Z-Score:</span>
                            <span className={`font-bold tabular-nums ${zScoreColor(z)}`}>
                              {z > 0 ? '+' : ''}{fmtDecimal(z, 2)} ({status.label})
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">|Nominal|:</span>
                          <span className="font-medium tabular-nums">{fmtIDR(p.nominalDeviasi)}</span>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-xs px-3 py-2 text-center">
                  <Badge variant={status.variant} className="text-[11px] h-5 px-1.5 font-medium">
                    {status.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{p.outletCount}</TableCell>
                {/* Phase 1 — Pattern (Pola) column */}
                <TableCell className="text-xs px-3 py-2 text-center">
                  <Badge
                    variant="outline"
                    className={`text-[10px] h-5 px-1.5 font-medium gap-0.5 ${pattern.className}`}
                    title={`${pattern.label} — ${p.outletCount} outlet terdampak`}
                  >
                    <span aria-hidden>{pattern.emoji}</span>
                    <span>{pattern.label}</span>
                  </Badge>
                </TableCell>
                {/* Phase A+B (FLIP-FE) — Flip column. Shows whether the
                    period's signed qtyDeviasi flipped direction vs its
                    same-week predecessor (W4 Jul → W4 Agu). */}
                <TableCell className="text-xs px-3 py-2 text-center">
                  {flip == null ? (
                    <span className="text-muted-foreground/60">—</span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className={`text-[10px] h-5 px-1.5 font-medium gap-0.5 cursor-help ${flipCfg.className}`}
                        >
                          <span aria-hidden>{flipCfg.emoji}</span>
                          <span>
                            {flip.isFlip
                              ? `Flip ${formatDisparity(flip)}`
                              : flipCat === 'konsisten-naik'
                                ? '↑ Konsisten'
                                : flipCat === 'konsisten-turun'
                                  ? '↓ Konsisten'
                                  : 'Stagnan'}
                          </span>
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-xs p-3 max-w-xs">
                        <div className="space-y-1">
                          <p className="font-semibold">🔀 Flip Analysis</p>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">vs Predecessor:</span>
                            <span className="font-medium">{flip.period1Label}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">P1 (signed):</span>
                            <span className={`font-medium tabular-nums ${flip.qtyP1 < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                              {flip.qtyP1.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                            </span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">P2 (signed):</span>
                            <span className={`font-medium tabular-nums ${flip.qtyP2 < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                              {flip.qtyP2.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                            </span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Net (P1+P2):</span>
                            <span className="font-medium tabular-nums">
                              {flip.net.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                            </span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Disparity:</span>
                            <span className="font-bold tabular-nums">{formatDisparity(flip)}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Category:</span>
                            <span className="font-medium">{flipCfg.label || '—'} {flip.isFlip ? `(risk: ${flip.riskLevel})` : ''}</span>
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell className="text-xs px-3 py-2 text-right tabular-nums text-muted-foreground">{p.recordCount}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
