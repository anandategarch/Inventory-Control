'use client';

// ============================================================
//  ItemTrendTableHeader — sortable table header row
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTable.tsx — no behavior
//  change). Columns: Periode | QTY BOM | QTY Deviasi | Z-Score |
//  Status | Outlets | Pola | Flip | Records. Seven sortable heads
//  use the shared sortableHeaderProps helper + SortIcon.
// ============================================================

import { TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { sortableHeaderProps } from '@/lib/a11y';
import type { SortKey, SortDir } from '../types';

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return sortDir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

// FIX (UI2-01 P1 + BUG-HUNT B12/B2-14): sortable headers are keyboard-accessible
// via the shared helper — kept as a thin local wrapper for the 7 call sites.
// role="button" removed: it overrode the th's columnheader semantics and made
// aria-sort meaningless; labels localized to Indonesian.
const SORT_LABELS: Record<SortKey, string> = {
  period: 'Periode',
  qtyBom: 'QTY BOM',
  qtyDeviasiSigned: 'QTY Deviasi',
  zScore: 'Z-Score',
  outletCount: 'Resto',
  flip: 'Flip',
  recordCount: 'Jumlah Record',
};

interface ItemTrendTableHeaderProps {
  sortKey: SortKey;
  sortDir: SortDir;
  toggleSort: (key: SortKey) => void;
}

export function ItemTrendTableHeader({ sortKey, sortDir, toggleSort }: ItemTrendTableHeaderProps) {
  const sortHeaderProps = (key: SortKey) =>
    sortableHeaderProps(key, SORT_LABELS[key], sortKey, sortDir, toggleSort);

  return (
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
  );
}
