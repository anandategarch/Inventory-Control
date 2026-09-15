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
//  PEERTOP-R2 (user feedback) — target terminology replaced by the
//  outlet's own NAME everywhere:
//    - "Ganti istilah target jadi nama resto target itu sendiri ...
//      Misal aku lagi filter kwggal berarti pakai nama kwggal aja
//      daripada Resto" → "Rangking KWGGAL" / "Nominal (KWGGAL)" /
//      "QTY Deviasi (KWGGAL)" (user example: "QTY DEVIASI (SBMOTI)
//      jadi ada nama resto nya langsung").
//    - "RANKING RESTO DI ANTARA RESTO YANG SELEVEL PER ITEM ganti jadi
//      Rangking (Nama Resto Langsung)" → "Rangking KWGGAL".
//    - "TOP DI ini isi top 3 aja resto aja dan jika resto target
//      termasuk masukan juga" → the cell shows the TOP-3 resto names
//      by |nominal deviasi| of the item, target included exactly when
//      it ranks among the top 3 (topDiNames — server pre-computed).
//  PEERTOP-R3 (user: "ada bug di rangking. misal resto target 11/11
//  tapi juga muncul di top di"): topDiNames is now computed on the
//  SAME RANK() basis as the "Rangking" cell (itemRank <= 3 among ALL
//  band outlets recording the item) — the target's name shows exactly
//  when its itemRank <= 3, so "Top di" and "Rangking" can never
//  contradict each other. Server-side fix only (peer-top-items.ts);
//  this card's rendering is unchanged.
//
//  Data source: GET /api/peer-comparison/top-items (PEERTOP-1
//  backend — queryPeerTopItems). `items` arrives SERVER-SORTED
//  (peerTopCount desc → target absNominal desc →
//  peerMaxAbsNominal desc → name asc) — no client-side sorting.
// ============================================================

import { memo } from 'react';
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
  /** PEERTOP-R2: the target outlet's NAME (e.g. "KWGGAL" — from the
   *  main query's target row) — headers reference it directly instead
   *  of the generic "Target" (user: "pakai nama kwggal aja daripada
   *  Resto"). Falls back to "Resto Kamu" while the main query loads. */
  targetName?: string | null;
}

export const TopItemsAcrossPeers = memo(function TopItemsAcrossPeers({
  data,
  isLoading,
  error,
  totalPeers,
  topN,
  targetName,
}: TopItemsAcrossPeersProps) {
  // PEERTOP-R2: the outlet's own name in every header that used to
  // reference the generic "target" — "Rangking KWGGAL", "Nominal
  // (KWGGAL)", "QTY Deviasi (KWGGAL)". "Resto Kamu" only flashes while
  // the main peer query is still loading (both queries fire in
  // parallel).
  const tn = targetName || 'Resto Kamu';

  return (
    <Card className="overflow-visible shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Layers className="h-3.5 w-3.5" />
          </span>
          Top Items Across Peers
          <InfoTooltip content={`Top item = SUM |nominal deviasi| per item (agregat) di tiap resto setara (sales ±10%). 'Top di' = 3 resto dengan |nominal deviasi| terbesar untuk item ini — termasuk ${tn} bila termasuk. 'Rangking ${tn}' = peringkat ${tn} di antara resto selevel yang mencatat deviasi item ini (urut |nominal deviasi| terbesar). Rata-rata resto setara dihitung ABSOLUTE dari |kuantiti deviasi|. Angka minus = kekurangan (merah).`} />
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Top {topN} item di tiap resto setara{totalPeers > 0 ? ` (${totalPeers} resto)` : ''} — masalah bersama vs khusus {tn}.
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
                {/* PEERTOP-R2 (user: "Ganti istilah target jadi nama resto
                    target itu sendiri") — every header that referenced
                    the generic "target" carries the outlet's own NAME
                    ("Rangking KWGGAL", "Nominal (KWGGAL)", "QTY Deviasi
                    (KWGGAL)" — user example: "QTY DEVIASI (SBMOTI) jadi
                    ada nama resto nya langsung"). No fixed header height
                    needed — the headers are short now. */}
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">Item</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider min-w-[120px]">Top di</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">{`Rangking ${tn}`}</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">{`Nominal (${tn})`}</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">{`QTY Deviasi (${tn})`}</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">Rata-Rata Absolute (QTY)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Server pre-sorted (peerTopCount desc → target absNominal
                    desc → peerMaxAbsNominal desc → name) — no client sort. */}
                {data.items.map((item) => {
                  const inTargetTop = item.target != null && item.target.rank <= topN;
                  // PEERTOP-R2: "Top di" = the TOP-3 resto names by
                  // |nominal deviasi| of this item, target included when
                  // it ranks among them (topDiNames — server pre-computed,
                  // so no perPeer code→name map is needed here anymore).
                  const topDi = item.topDiNames.join(', ');
                  const qtyDev = item.target?.qtyDeviasi ?? null;
                  return (
                    <TableRow key={item.itemId} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="text-xs py-1.5 font-medium max-w-[220px] truncate" title={item.itemName}>
                        {item.itemName}
                      </TableCell>
                      {/* PEERTOP-R2 (user: "TOP DI ini isi top 3 aja resto
                          aja dan jika resto target termasuk masukan
                          juga") — top-3 names; the tooltip carries the
                          full list when the cell truncates. */}
                      <TableCell
                        className="text-xs py-1.5 max-w-[200px] truncate"
                        title={topDi || undefined}
                      >
                        {item.topDiNames.length > 0 ? topDi : '—'}
                      </TableCell>
                      {/* PEERTOP-R1: "#3/9" — peringkat di antara resto
                          selevel yang mencatat deviasi item ini. */}
                      <TableCell className="text-xs py-1.5 text-center font-mono tabular-nums">
                        {item.target == null ? (
                          <span title={`Tidak ada di ${tn} (blind spot)`}>—</span>
                        ) : (
                          <span title={`Peringkat ${tn} di antara ${item.target.itemOutletCount} resto selevel yang mencatat deviasi item ini (urut |nominal deviasi| terbesar)`}>
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
          💡 Baris atas = item yang jadi top deviasi di banyak resto setara (kemungkinan masalah sistemik — cek BOM/resep). &apos;Top di&apos; = 3 resto dengan deviasi |nominal| terbesar untuk item itu ({tn} ikut bila termasuk). &apos;—&apos; = item tidak ada di {tn} (blind spot). Angka <span className="text-red-600 dark:text-red-400 font-medium">minus</span> pada QTY Deviasi = sisi kekurangan.
        </p>
      </CardContent>
    </Card>
  );
});
