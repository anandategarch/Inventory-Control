'use client';

// ============================================================
//  FlipRankingTableHeader — sortable table header row
//  --------------------------------------------------------
//  SPLIT-B (pure move from FlipRanking.tsx — no behavior change).
//  Columns: # | Item | Flip | 🟢 Sempurna | Disparitas Rata-rata |
//  Skor Risiko | Top Flip Pair. Six sortable heads use the shared
//  sortableHeaderProps helper (keyboard/AT accessible) + SortIcon.
// ============================================================

import { Table, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { sortableHeaderProps } from '@/lib/a11y';
import type { FlipSortKey, FlipSortDir } from './types';

function SortIcon({ active, dir }: { active: boolean; dir: FlipSortDir }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return dir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

interface FlipRankingTableHeaderProps {
  sortKey: FlipSortKey;
  sortDir: FlipSortDir;
  toggleSort: (key: FlipSortKey) => void;
}

export function FlipRankingTableHeader({ sortKey, sortDir, toggleSort }: FlipRankingTableHeaderProps) {
  return (
    <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
      <TableRow className="border-b hover:bg-transparent">
        <TableHead className="w-12 text-center text-xs font-semibold uppercase tracking-wider h-9">#</TableHead>
        {/* FIX (BUG-HUNT B12/B2-03): sortable headers were onClick-only —
            keyboard/screen-reader users could not sort. Shared helper keeps
            th columnheader semantics + aria-sort; labels localized (B2-12). */}
        <TableHead
          className="text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          {...sortableHeaderProps('itemName', 'Item', sortKey, sortDir, toggleSort)}
        >
          Item <SortIcon active={sortKey === 'itemName'} dir={sortDir} />
        </TableHead>
        <TableHead
          className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          {...sortableHeaderProps('flipCount', 'Flip', sortKey, sortDir, toggleSort)}
        >
          Flip <SortIcon active={sortKey === 'flipCount'} dir={sortDir} />
        </TableHead>
        <TableHead
          className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          {...sortableHeaderProps('sempurnaCount', 'Sempurna', sortKey, sortDir, toggleSort)}
        >
          🟢 Sempurna <SortIcon active={sortKey === 'sempurnaCount'} dir={sortDir} />
        </TableHead>
        <TableHead
          className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          {...sortableHeaderProps('avgDisparity', 'Disparitas Rata-rata', sortKey, sortDir, toggleSort)}
        >
          Disparitas Rata-rata <SortIcon active={sortKey === 'avgDisparity'} dir={sortDir} />
        </TableHead>
        <TableHead
          className="text-right text-xs font-semibold uppercase tracking-wider h-9 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          {...sortableHeaderProps('riskScore', 'Skor Risiko', sortKey, sortDir, toggleSort)}
        >
          Skor Risiko <SortIcon active={sortKey === 'riskScore'} dir={sortDir} />
        </TableHead>
        <TableHead className="text-xs font-semibold uppercase tracking-wider h-9">Top Flip Pair</TableHead>
      </TableRow>
    </TableHeader>
  );
}
