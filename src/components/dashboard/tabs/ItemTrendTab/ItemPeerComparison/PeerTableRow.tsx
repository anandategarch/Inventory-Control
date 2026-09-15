'use client';

// ============================================================
//  PeerTableRow — one peer-table row (memo'd)
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemPeerComparison.tsx — no behavior
//  change). Memo'd to avoid re-rendering all rows when only one
//  row's hover state changes.
// ============================================================

import { memo, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Table, TableCell, TableRow } from '@/components/ui/table';
import { Store } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { AnomalyFlags, computeAnomalyFlags } from '@/components/dashboard/shared/peer-comparison-cards';
import type { ItemPeerRow, ItemPeerAverages } from './types';

interface PeerTableRowProps {
  row: ItemPeerRow;
  peerAvg: ItemPeerAverages;
  isTargetRow?: boolean;
  onOutletClick?: (outletCode: string) => void;
}

export const PeerTableRow = memo(function PeerTableRow({
  row,
  peerAvg,
  isTargetRow,
  onOutletClick,
}: PeerTableRowProps) {
  // FIX (BUG-2-11): use `direction` field (NET from SUM(nominalLossSurplus))
  // instead of `nominalDeviasi` sign (GROSS from SUM(nominalDeviasi)). These
  // two can differ when surplus items outweigh loss items in the same bucket
  // — the row color should match the direction badge, not the gross sign.
  const isLoss = row.direction === 'LOSS';
  const flags = useMemo(
    () => computeAnomalyFlags({
      devBom: row.devBom,
      peerAvgDevBom: peerAvg.devBom,
      absNominal: row.absNominalDeviasi,
      peerAvgNominal: peerAvg.absNominalDeviasi,
      direction: row.direction,
      signedNominal: row.nominalDeviasi,
    }),
    [row, peerAvg],
  );
  return (
    /* FIX (BUG-HUNT B10/B2-02): rows advertise "Klik baris untuk deep dive
       ke Resto Analysis" but had no keyboard/AT access — spread the shared
       helper only when the row is actually interactive. */
    <TableRow
      className={`transition-colors border-b ${
        onOutletClick ? 'cursor-pointer' : ''
      } ${
        isTargetRow
          ? 'bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-950/30 border-l-4 border-l-amber-500'
          : 'hover:bg-muted/40'
      }`}
      {...(onOutletClick ? clickableRowProps(() => onOutletClick(row.outletCode)) : {})}
    >
      <TableCell className="text-xs px-3 py-2">
        <div className="flex items-center gap-1.5">
          {onOutletClick && <Store className="h-3 w-3 text-muted-foreground shrink-0" />}
          <div className="min-w-0">
            {/* FIX (UI-06): added max-w-[180px] so truncate has an explicit
                max-width — without it, truncate never kicks in on flex children. */}
            <div className="font-medium leading-tight truncate max-w-[180px]" title={row.outletName}>{row.outletName}</div>
            <div className="text-[10px] text-muted-foreground">{row.outletCode}</div>
          </div>
        </div>
      </TableCell>
      <TableCell className="text-xs px-3 py-2 text-muted-foreground">{row.area}</TableCell>
      <TableCell className="text-xs px-3 py-2 text-muted-foreground">{row.pic || '—'}</TableCell>
      <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{fmtNum(row.qtyBom)}</TableCell>
      <TableCell className={`text-xs px-3 py-2 text-right tabular-nums ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {fmtNum(row.qtyDeviasi)}
      </TableCell>
      <TableCell className={`text-xs px-3 py-2 text-right tabular-nums ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {row.devBom != null ? fmtPctAbs(row.devBom) : '—'}
      </TableCell>
      <TableCell className={`text-xs px-3 py-2 text-right tabular-nums font-medium ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {fmtIDR(row.nominalDeviasi)}
      </TableCell>
      <TableCell className="text-xs px-3 py-2 text-center">
        <Badge
          variant="outline"
          className={`text-[10px] h-5 px-1.5 font-medium ${
            row.direction === 'LOSS'
              ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30'
              : row.direction === 'SURPLUS'
                ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
                : 'text-muted-foreground'
          }`}
        >
          {row.direction}
        </Badge>
      </TableCell>
      <TableCell className="text-xs px-3 py-2 text-center">
        <AnomalyFlags flags={flags} textSize="10px" />
      </TableCell>
    </TableRow>
  );
});
