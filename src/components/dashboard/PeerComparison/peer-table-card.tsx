'use client';

// ============================================================
//  PeerComparison — Peer Table card (+ Anomaly Flags, Feature 5)
//  (split from PeerComparison.tsx — SPLIT-G; pure code motion)
//
//  The existing peer table: sticky header, sticky resto column,
//  peer-average row, target highlighting, per-metric cell
//  coloring vs peer average, direction letter, anomaly flag
//  pills, click-to-retarget rows, and the reading footnote.
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, BarChart3, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, memo, useMemo, useState } from 'react';
import type { Dispatch } from 'react';
import { fmtIDR, fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { MetricDef, PeerAverages, PeerRow, PeerTopItemsResponse } from '@/components/dashboard/peer-comparison/types';
import { COLUMNS, colorCell } from '@/components/dashboard/peer-comparison/helpers';
import { computePeerAnomalyFlags } from '@/components/dashboard/peer-computation';
import { AnomalyFlags } from '@/components/dashboard/shared/peer-comparison-cards';

/** Minimal structural slice of the /api/peer-comparison main response used
 *  by this card (success/error gate for the loading/error/empty branches). */
export interface PeerMainDataSlice {
  success?: boolean;
  error?: string;
}

export interface PeerTableCardProps {
  mainData: PeerMainDataSlice | undefined;
  mainLoading: boolean;
  mainFetching: boolean;
  mainError: Error | null;
  peers: PeerRow[];
  otherPeers: PeerRow[];
  peerAverages: PeerAverages;
  targetRow: PeerRow | undefined;
  /** Row click → retarget the comparison (setFocusOutlet). (Dispatch<string>
   *  = (outletCode: string) => void, spelled without a param name — the
   *  repo's base no-unused-vars rule flags type-position param names.) */
  onSelectOutlet: Dispatch<string>;
  onRetryMain: () => void;
  /** PEERTOP-2: /api/peer-comparison/top-items perPeer data driving the
   *  expandable per-outlet top-item rows. Same peer band as the main
   *  query (limit=50), so entries map 1:1 onto these rows. */
  topItemsData: PeerTopItemsResponse | undefined;
  topItemsLoading: boolean;
}

/** Direction letter color — same convention as the Dir column above. */
function dirColor(direction: string | undefined): string {
  if (direction === 'LOSS') return 'text-red-600 dark:text-red-400';
  if (direction === 'SURPLUS') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-muted-foreground';
}

export function PeerTableCard({
  mainData,
  mainLoading,
  mainFetching,
  mainError,
  peers,
  otherPeers,
  peerAverages,
  targetRow,
  onSelectOutlet,
  onRetryMain,
  topItemsData,
  topItemsLoading,
}: PeerTableCardProps) {
  const columns: MetricDef[] = COLUMNS;

  // PEERTOP-2: which outlet row's top-item list is expanded (single-open
  // accordion — opening one row collapses the previous).
  const [expanded, setExpanded] = useState<string | null>(null);

  // code → perPeer top-N entry (peers with ZERO deviation records have no
  // perPeer entry → undefined → "tidak ada item deviasi" branch below).
  const perPeerByCode = useMemo(() => {
    const m = new Map<string, PeerTopItemsResponse['perPeer'][number]>();
    for (const pp of topItemsData?.perPeer || []) m.set(pp.outletCode, pp);
    return m;
  }, [topItemsData]);

  // Expansion row spans the FULL table width: Resto/Area/PIC/TopItem (4)
  // + metric columns + Dir/Flags (2).
  const expansionColSpan = 4 + columns.length + 2;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
            Peer Table
            {otherPeers.length > 0 && <span className="text-muted-foreground text-xs font-normal">dengan Anomaly Flags</span>}
            {mainFetching && !mainLoading && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
            )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {mainLoading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : !mainData && !mainError ? (
          // FIX FE-1: When query is disabled (e.g., no outlet selected), show
          // "waiting" state instead of "Error: Unknown" (!mainData?.success = true)
          <p className="text-center text-muted-foreground py-12 text-sm">
            Pilih outlet untuk melihat peer comparison
          </p>
        ) : mainError || !mainData?.success ? (
          <div className="py-10 text-center">
            <p className="text-red-600 dark:text-red-400 font-medium">Gagal Memuat Data</p>
            <p className="text-xs text-muted-foreground mt-1">{mainError?.message || mainData?.error || 'Unknown'}</p>
            {/* FIX #20: retry button so users can recover from transient errors */}
            <Button onClick={() => onRetryMain()} variant="outline" size="sm" className="mt-3">
              <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
            </Button>
          </div>
        ) : peers.length === 0 ? (
          <div className="text-center text-muted-foreground text-xs py-6 space-y-2">
            <p>Tidak ada peer ditemukan untuk outlet ini.</p>
            <p className="text-xs">Kemungkinan outlet tidak memiliki data sales (PENJUALAN) pada periode ini, atau tidak ada resto lain dengan sales ±10%.</p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <Table className="min-w-[1400px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider sticky left-0 bg-muted/40 dark:bg-zinc-900/40 backdrop-blur-sm z-20">Resto</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">Area</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">PIC</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">Top Item</TableHead>
                  {columns.map(col => (
                    <TableHead key={col.key} className="text-xs font-semibold uppercase tracking-wider text-right">{col.label}</TableHead>
                  ))}
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">Dir</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* STRUCTURAL (S-3, opsi b): plain table cells bumped
                    text-[11px] → text-xs (12px floor). Badges + AnomalyFlags
                    pills keep their own independent scale. */}
                {/* Peer Average Row */}
                {otherPeers.length > 0 && (
                  <TableRow className="border-b-2 border-foreground/20 bg-muted/50 dark:bg-zinc-900/50 font-medium">
                    <TableCell className="text-xs font-bold sticky left-0 bg-muted/50 dark:bg-zinc-900/50 z-10">📊 Peer Avg</TableCell>
                    <TableCell className="text-xs text-muted-foreground">—</TableCell>
                    <TableCell className="text-xs text-muted-foreground">—</TableCell>
                    <TableCell className="text-xs text-muted-foreground">—</TableCell>
                    {columns.map(col => (
                      <TableCell key={col.key} className="text-xs text-right text-muted-foreground font-mono tabular-nums">
                        {col.format(peerAverages[col.key] as number)}
                      </TableCell>
                    ))}
                    <TableCell className="text-xs text-center text-muted-foreground">—</TableCell>
                    <TableCell className="text-xs text-center text-muted-foreground">—</TableCell>
                  </TableRow>
                )}
                {/* Outlet Rows */}
                {peers.map((p, i) => (
                  <Fragment key={p.outletCode}>
                  <TableRow
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${p.isTarget ? 'bg-amber-50/60 dark:bg-amber-950/20 border-l-2 border-l-amber-500' : i % 2 === 1 ? 'bg-muted/20' : ''}`}
                    {...clickableRowProps(() => onSelectOutlet(p.outletCode))}
                  >
                    <TableCell className="text-xs font-medium sticky left-0 bg-background z-10">
                      <div className="flex items-center gap-1.5">
                        {/* PEERTOP-2: expand toggle for this outlet's top items.
                            stopPropagation keeps the ROW's click-to-retarget
                            behavior (clickableRowProps) intact. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setExpanded(expanded === p.outletCode ? null : p.outletCode);
                          }}
                          // Keyboard: without this, Enter/Space on the focused
                          // chevron would bubble to the row's clickableRowProps
                          // onKeyDown and RETARGET instead of expanding.
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              e.preventDefault();
                              setExpanded(expanded === p.outletCode ? null : p.outletCode);
                            }
                          }}
                          className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted shrink-0"
                          aria-expanded={expanded === p.outletCode}
                          aria-label={`Lihat top item ${p.outletName}`}
                        >
                          {expanded === p.outletCode ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                        {p.isTarget && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />}
                        <span className="truncate">{p.outletName}</span>
                      </div>
                      {p.isTarget && <Badge variant="default" className="text-[11px] ml-3 h-4 bg-amber-600 hover:bg-amber-600 text-white">TARGET</Badge>}
                      <div className="text-xs text-muted-foreground">{p.outletCode}</div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.area}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.pic || '—'}</TableCell>
                    <TableCell className="text-xs max-w-[160px] truncate" title={p.topItem || ''}>{p.topItem || '—'}</TableCell>
                    {columns.map(col => {
                      const val = p[col.key] as number;
                      const colorClass = p.isTarget ? colorCell(val, peerAverages[col.key] as number, otherPeers.length, col.higherBetter) : '';
                      return (
                        <TableCell key={col.key} className={`text-xs text-right font-mono tabular-nums ${colorClass}`}>
                          {col.format(val)}
                        </TableCell>
                      );
                    })}
                    <TableCell className={`text-xs text-center font-bold ${p.direction === 'LOSS' ? 'text-red-600 dark:text-red-400' : p.direction === 'SURPLUS' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                      {p.direction?.[0] || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-center">
                      <AnomalyFlags flags={computePeerAnomalyFlags(p, peerAverages)} textSize="11px" />
                    </TableCell>
                  </TableRow>
                  {/* PEERTOP-2: expansion row — this outlet's own top-N items
                      (SUM |nominal deviasi| per item, aggregate). A normal row
                      spanning all columns (sticky-column styling unaffected). */}
                  {expanded === p.outletCode && (
                    <TableRow className="bg-muted/5">
                      <TableCell colSpan={expansionColSpan} className="py-2">
                        <PeerTopItemsExpansion
                          outletName={p.outletName}
                          entry={perPeerByCode.get(p.outletCode)}
                          loading={topItemsLoading}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="p-3 text-xs text-muted-foreground border-t bg-muted/20 dark:bg-zinc-900/20">
          💡 Klik baris untuk deep dive ke Resto Analysis. <span className="text-emerald-600 dark:text-emerald-400 font-medium">Hijau</span> = lebih baik dari peer avg, <span className="text-red-600 dark:text-red-400 font-medium">Merah</span> = lebih buruk.
          Sales range: ±10% dari <span className="font-medium tabular-nums">{targetRow ? fmtIDR(targetRow.sales) : 'target'}</span>.
          Klik ▸/▾ di baris untuk lihat top item resto tersebut.
        </div>
      </CardContent>
    </Card>
  );
}

/** PEERTOP-2: compact expandable list of ONE outlet's top-N deviation
 *  items (visual language mirrors ItemComparisonBlock in items-table.tsx). */
const PeerTopItemsExpansion = memo(function PeerTopItemsExpansion({
  outletName,
  entry,
  loading,
}: {
  outletName: string;
  entry: PeerTopItemsResponse['perPeer'][number] | undefined;
  loading: boolean;
}) {
  // No perPeer entry = this outlet has ZERO deviation records in the period
  // (or the top-items query is still in flight).
  if (!entry) {
    return (
      <p className="text-xs text-muted-foreground py-1.5">
        {loading ? 'Memuat top item…' : 'Tidak ada item deviasi pada periode ini.'}
      </p>
    );
  }
  return (
    <div className="rounded-lg border bg-muted/10 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h5 className="text-xs font-semibold">Top item di {outletName}</h5>
        <span className="text-[11px] text-muted-foreground tabular-nums">{entry.items.length} item</span>
      </div>
      <div className="space-y-1">
        {entry.items.map((it, i) => (
          <div key={`${it.itemName}-${i}`} className="flex items-center gap-2 text-xs">
            <span className="w-7 shrink-0 text-right text-muted-foreground tabular-nums">#{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-medium" title={it.itemName}>{it.itemName}</span>
            <span className="shrink-0 text-right font-mono tabular-nums">{fmtIDR(it.absNominal)}</span>
            <span className="w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{fmtPct(it.devBom, false)}</span>
            <span className={`w-4 shrink-0 text-center font-bold ${dirColor(it.direction)}`}>
              {it.direction?.[0] || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
