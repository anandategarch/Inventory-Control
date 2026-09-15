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
//  SPLIT-B folder split (pure move, no behavior change):
//    ./patternBadge            — Pola classification (pure fn)
//    ./ItemTrendTableHeader    — sortable header row + SortIcon
//    ./ZScoreCell              — Z-Score cell + breakdown tooltip
//    ./FlipCell                — Flip cell + analysis tooltip
//  Coloring helpers (zScoreColor, zScoreStatus) come from
//  ../zScoreHelpers — shared pattern with HistoricalZScoreCard.
// ============================================================

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import type { ItemTrendMetric, ItemTrendPeriod } from '@/hooks/useAnalysis';
import { fmtNum } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { zScoreStatus } from '../zScoreHelpers';
import { periodShortLabel } from '../periodHelpers';
import {
  getFlipForPeriod,
  flipBadge,
  periodKey as flipPeriodKey,
  type FlipAnalysis,
} from '../flipHelpers';
import type { SortKey, SortDir } from '../types';
import { patternBadge } from './patternBadge';
import { ItemTrendTableHeader } from './ItemTrendTableHeader';
import { ZScoreCell } from './ZScoreCell';
import { FlipCell } from './FlipCell';

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

  return (
    <div className="max-h-96 overflow-auto border-t">
      <Table className="min-w-[1040px]">
        <ItemTrendTableHeader sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
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
                <ZScoreCell period={p} metric={metric} status={status} />
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
                <FlipCell flip={flip} flipCat={flipCat} flipCfg={flipCfg} unitLabel={unitLabel} />
                <TableCell className="text-xs px-3 py-2 text-right tabular-nums text-muted-foreground">{p.recordCount}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
