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
import { Loader2, BarChart3, RotateCcw } from 'lucide-react';
import type { Dispatch } from 'react';
import { fmtIDR } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { MetricDef, PeerAverages, PeerRow } from '@/components/dashboard/peer-comparison/types';
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
}: PeerTableCardProps) {
  const columns: MetricDef[] = COLUMNS;

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
                  <TableRow
                    key={p.outletCode}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${p.isTarget ? 'bg-amber-50/60 dark:bg-amber-950/20 border-l-2 border-l-amber-500' : i % 2 === 1 ? 'bg-muted/20' : ''}`}
                    {...clickableRowProps(() => onSelectOutlet(p.outletCode))}
                  >
                    <TableCell className="text-xs font-medium sticky left-0 bg-background z-10">
                      <div className="flex items-center gap-1.5">
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
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="p-3 text-xs text-muted-foreground border-t bg-muted/20 dark:bg-zinc-900/20">
          💡 Klik baris untuk deep dive ke Resto Analysis. <span className="text-emerald-600 dark:text-emerald-400 font-medium">Hijau</span> = lebih baik dari peer avg, <span className="text-red-600 dark:text-red-400 font-medium">Merah</span> = lebih buruk.
          Sales range: ±10% dari <span className="font-medium tabular-nums">{targetRow ? fmtIDR(targetRow.sales) : 'target'}</span>.
        </div>
      </CardContent>
    </Card>
  );
}
