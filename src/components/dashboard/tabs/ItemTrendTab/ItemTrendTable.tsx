'use client';

// ============================================================
//  ItemTrendTable — Sortable Data Table
//  --------------------------------------------------------
//  Per-period data table with 8 sortable columns:
//    Period | QTY BOM | QTY Deviasi signed | Z-Score | Status |
//    Outlets | Pola (Pattern) | Records
//
//  Phase 1 additions:
//    - "Pola" (Pattern) column — classifies the period's blast radius
//      by outlet count (Massal ≥10 / Regional ≥5 / Lokal ≥2 / Tunggal =1).
//    - `onRowClick` prop — row click invokes callback with the period,
//      powering the Phase 2 drill-down into ItemPeerComparison.
//    - `drillPeriod` prop — when set, the matching row gets a highlighted
//      background (visual indicator of the currently drilled period).
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
import { fmtIDR, fmtNum } from '@/lib/format';
import { zScoreColor, zScoreStatus } from './zScoreHelpers';
import { periodShortLabel } from './periodHelpers';
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
}: ItemTrendTableProps) {
  return (
    <div className="max-h-96 overflow-auto border-t">
      <Table className="min-w-[940px]">
        <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
          <TableRow className="border-b hover:bg-transparent">
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40"
              onClick={() => toggleSort('period')}
            >
              Periode <SortIcon col="period" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
              onClick={() => toggleSort('qtyBom')}
            >
              QTY BOM <SortIcon col="qtyBom" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
              onClick={() => toggleSort('qtyDeviasiSigned')}
            >
              QTY Deviasi <SortIcon col="qtyDeviasiSigned" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
              onClick={() => toggleSort('zScore')}
            >
              Z-Score <SortIcon col="zScore" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">
              Status
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
              onClick={() => toggleSort('outletCount')}
            >
              Outlets <SortIcon col="outletCount" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            {/* Phase 1 — Pattern column. Not sortable (classification derived
                from outletCount which already has its own sortable column). */}
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">
              Pola
            </TableHead>
            <TableHead
              className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
              onClick={() => toggleSort('recordCount')}
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
                onClick={onRowClick ? () => onRowClick(p) : undefined}
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
                        {z == null ? '—' : z > 0 ? `+${z.toFixed(2)}` : z.toFixed(2)}
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
                              {z > 0 ? '+' : ''}{z.toFixed(2)} ({status.label})
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
                <TableCell className="text-xs px-3 py-2 text-right tabular-nums text-muted-foreground">{p.recordCount}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
