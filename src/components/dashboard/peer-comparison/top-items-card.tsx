'use client';

// ============================================================
//  PEERTOP-2 — "Top Items Across Peers" card
//  PEERTOP-R1 (user feedback) — column set revised:
//    - "Top di" now shows the NAMES of the resto setara where the
//      item is top (was "m/n" count; user: "TOP DI ganti jadi Nama
//      Resto nya & TOP Di").
//    - "Rank di Target" replaced by "Ranking Resto di antara Resto
//      yang Selevel per Item" (#peringkat/total — the target's rank
//      among ALL band outlets recording this item, by |nominal
//      deviasi| desc; user wording kept verbatim).
//    - NEW "QTY Deviasi" column — kuantiti deviasi NILAI ASLI
//      (signed); minus = kekurangan → red.
//    - "Rata-Rata Absolute" now on the |qty deviasi| basis (user:
//      "pakai kuantiti deviasi aja diabsolute").
//    - "Dir" column REMOVED (user: "ARAH gak perlu ... jika nilai
//      minus merah") — direction rides on the signed QTY value.
//
//  Data source: GET /api/peer-comparison/top-items (PEERTOP-1
//  backend — queryPeerTopItems). `items` arrives SERVER-SORTED
//  (peerTopCount desc → target absNominal desc →
//  peerMaxAbsNominal desc → name asc) — no client-side sorting.
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Layers } from 'lucide-react';
import { fmtIDR, fmtNum } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { PeerTopItemsResponse } from './types';

export interface TopItemsAcrossPeersProps {
  data: PeerTopItemsResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  /** Non-target peer count (from the main query's peers[]) — shown in
   *  the card subtitle ("N resto setara"). */
  totalPeers: number;
  /** Per-outlet top-N used by the backend (5 — mirrors the query's
   *  `topN` param; drives the bold/muted nominal styling). */
  topN: number;
}

export const TopItemsAcrossPeers = memo(function TopItemsAcrossPeers({
  data,
  isLoading,
  error,
  totalPeers,
  topN,
}: TopItemsAcrossPeersProps) {
  // code → outletName map for the "Top di" cell. Peers with ZERO
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
          <InfoTooltip content="Top item = SUM |nominal deviasi| per item (agregat) di tiap resto setara (sales ±10%). 'Top di' = nama resto setara yang juga punya item ini di top-nya. 'Ranking' = peringkat resto kamu di antara resto selevel yang mencatat deviasi item ini (urut |nominal deviasi| terbesar). Rata-rata peer dihitung ABSOLUTE dari |kuantiti deviasi|. Angka minus = kekurangan (merah)." />
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Top {topN} item di tiap resto setara{totalPeers > 0 ? ` (${totalPeers} resto)` : ''} — masalah bersama vs khusus resto kamu.
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
                {/* No fixed header height — the long "Ranking Resto di
                    antara Resto yang Selevel per Item" header wraps to
                    multiple lines (PEERTOP-R1 user label, verbatim). */}
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">Item</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider min-w-[120px]">Top di</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider min-w-[130px] leading-snug">
                    Ranking Resto di antara Resto yang Selevel per Item
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">Nominal (Target)</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">QTY Deviasi</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">Rata-Rata Absolute (QTY)</TableHead>
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
                  const qtyDev = item.target?.qtyDeviasi ?? null;
                  return (
                    <TableRow key={item.itemId} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="text-xs py-1.5 font-medium max-w-[220px] truncate" title={item.itemName}>
                        {item.itemName}
                      </TableCell>
                      {/* PEERTOP-R1: resto NAMES where the item is top
                          (was "m/n" count). Full list in the tooltip. */}
                      <TableCell
                        className="text-xs py-1.5 max-w-[200px] truncate"
                        title={item.peerTopCount === 0 ? 'Item ini hanya top di resto kamu' : peerNames || undefined}
                      >
                        {item.peerTopCount === 0 ? '—' : peerNames}
                      </TableCell>
                      {/* PEERTOP-R1: "#3/9" — peringkat di antara resto
                          selevel yang mencatat deviasi item ini. */}
                      <TableCell className="text-xs py-1.5 text-center font-mono tabular-nums">
                        {item.target == null ? (
                          <span title="Tidak ada di resto kamu (blind spot)">—</span>
                        ) : (
                          <span title={`Peringkat resto kamu di antara ${item.target.itemOutletCount} resto selevel yang mencatat deviasi item ini (urut |nominal deviasi| terbesar)`}>
                            #{item.target.itemRank}/{item.target.itemOutletCount}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={`text-xs py-1.5 text-right font-mono tabular-nums ${inTargetTop ? 'font-semibold' : 'text-muted-foreground'}`}>
                        {item.target == null ? '—' : fmtIDR(item.target.absNominal)}
                      </TableCell>
                      {/* PEERTOP-R1: kuantiti deviasi NILAI ASLI (signed) —
                          replaces the Arah column; minus = kekurangan → red. */}
                      <TableCell
                        className={`text-xs py-1.5 text-right font-mono tabular-nums ${
                          qtyDev != null && qtyDev < 0 ? 'text-red-600 dark:text-red-400' : ''
                        }`}
                      >
                        {qtyDev == null ? '—' : fmtNum(qtyDev)}
                      </TableCell>
                      <TableCell className="text-xs py-1.5 text-right font-mono tabular-nums">
                        {item.peerTopCount === 0 ? '—' : fmtNum(item.peerAvgAbsQty)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-3 pt-3 border-t">
          💡 Baris atas = item yang jadi top deviasi di banyak resto setara (kemungkinan masalah sistemik — cek BOM/resep). &apos;—&apos; = item tidak ada di resto kamu (blind spot). Angka <span className="text-red-600 dark:text-red-400 font-medium">minus</span> pada QTY Deviasi = sisi kekurangan.
        </p>
      </CardContent>
    </Card>
  );
});
