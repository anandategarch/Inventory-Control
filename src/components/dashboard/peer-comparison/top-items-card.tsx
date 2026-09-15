'use client';

// ============================================================
//  PEERTOP-2 — "Top Items Across Peers" card
//  --------------------------------------------------------
//  Answers the inverse question of Item-Level Comparison
//  (items-table.tsx): instead of "MY top items vs peer
//  averages", it shows the cross-peer UNION of every peer's
//  own top-N items — which items are a SHARED problem (top
//  in many peers → possibly systemic, check BOM/resep) vs a
//  LOCAL one (top only at the target), plus blind spots
//  (top at peers but absent at the target).
//
//  Data source: GET /api/peer-comparison/top-items (PEERTOP-1
//  backend — queryPeerTopItems). `items` arrives SERVER-SORTED
//  (peerTopCount desc → target absNominal desc →
//  peerMaxAbsNominal desc → name asc) — no client-side sorting.
//  Peer averages are on the ABSOLUTE basis (master-context
//  terminology: "Rata-Rata Absolute").
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Layers } from 'lucide-react';
import { fmtIDR } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { PeerTopItemsResponse } from './types';

export interface TopItemsAcrossPeersProps {
  data: PeerTopItemsResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  /** Non-target peer count (from the main query's peers[]) — the
   *  denominator of the "Top di" column. */
  totalPeers: number;
  /** Per-outlet top-N used by the backend (5 — mirrors the query's
   *  `topN` param). */
  topN: number;
}

export const TopItemsAcrossPeers = memo(function TopItemsAcrossPeers({
  data,
  isLoading,
  error,
  totalPeers,
  topN,
}: TopItemsAcrossPeersProps) {
  // code → outletName map for the "Top di" cell tooltip. Peers with ZERO
  // deviation records have no perPeer entry → fall back to the raw code.
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const pp of data?.perPeer || []) m.set(pp.outletCode, pp.outletName);
    return m;
  }, [data]);

  return (
    <Card className="overflow-visible shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Layers className="h-3.5 w-3.5" />
          </span>
          Top Items Across Peers
          <InfoTooltip content="Top item = SUM |nominal deviasi| per item (agregat) di tiap resto dengan sales ±10%. 'Top di' = berapa resto setara yang juga punya item ini di top-nya. Rata-rata peer dihitung ABSOLUTE." />
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Top {topN} item di tiap resto setara — masalah bersama vs khusus resto kamu.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          </div>
        ) : !data && !error ? (
          // FIX FE-2 convention (items-table): when the query is disabled
          // (no outlet selected), show the waiting state — not "Error: Unknown".
          <p className="text-center text-xs text-muted-foreground py-6">
            Pilih outlet untuk melihat top item peer
          </p>
        ) : error || !data?.success ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400 py-6">
            Error: {error?.message || data?.error || 'Unknown'}
          </p>
        ) : !data.items || data.items.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-6">
            Tidak ada item deviasi pada periode ini.
          </p>
        ) : (
          <div className="max-h-[500px] overflow-y-auto pr-1">
            <Table>
              <TableHeader>
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-7">Item</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-center">Top di</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-center">Rank di Target</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-right">Nominal (Target)</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-right">Rata-Rata Absolute</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-7 text-center">Dir</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Server pre-sorted (peerTopCount desc → target absNominal
                    desc → peerMaxAbsNominal desc → name) — no client sort. */}
                {data.items.map((item) => {
                  const inTargetTop = item.target != null && item.target.rank <= topN;
                  const peerNames = item.peerTopCodes
                    .map((c) => nameByCode.get(c) ?? c)
                    .join(', ');
                  return (
                    <TableRow key={item.itemId} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="text-xs py-1.5 font-medium max-w-[220px] truncate" title={item.itemName}>
                        {item.itemName}
                      </TableCell>
                      <TableCell
                        className="text-xs py-1.5 text-center font-mono tabular-nums"
                        title={peerNames || undefined}
                      >
                        {item.peerTopCount}/{totalPeers}
                      </TableCell>
                      <TableCell className="text-xs py-1.5 text-center font-mono tabular-nums">
                        {item.target == null ? (
                          <span title="Tidak ada di resto kamu">—</span>
                        ) : item.target.rank <= topN ? (
                          <span title={`#${item.target.rank} di resto kamu`}>#{item.target.rank}</span>
                        ) : (
                          <span className="text-muted-foreground" title="Di luar top-N resto kamu">
                            &gt; {topN}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={`text-xs py-1.5 text-right font-mono tabular-nums ${inTargetTop ? 'font-semibold' : 'text-muted-foreground'}`}>
                        {item.target == null ? '—' : fmtIDR(item.target.absNominal)}
                      </TableCell>
                      <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">
                        {item.peerTopCount === 0 ? '—' : fmtIDR(item.peerAvgAbsNominal)}
                      </TableCell>
                      <TableCell
                        className={`text-xs py-1.5 text-center font-bold ${
                          item.target?.direction === 'LOSS'
                            ? 'text-red-600 dark:text-red-400'
                            : item.target?.direction === 'SURPLUS'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-muted-foreground'
                        }`}
                      >
                        {item.target?.direction?.[0] || '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-3 pt-3 border-t">
          💡 Baris atas = item yang jadi top deviasi di banyak resto setara (kemungkinan masalah sistemik — cek BOM/resep). &apos;—&apos; = item tidak ada di resto kamu (blind spot).
        </p>
      </CardContent>
    </Card>
  );
});
