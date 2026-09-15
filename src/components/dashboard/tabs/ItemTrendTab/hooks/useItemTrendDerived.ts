'use client';

// ============================================================
//  useItemTrendDerived — derived data for the Trend Item tab
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Memoizes, off the raw /api/item-trend response:
//    - periods          — stable ref of trend.data.periods (avoids
//                         downstream useMemo recompute when undefined)
//    - satuan           — item's unit of measure (SATUAN-BUG fix)
//    - chronological    — periods sorted by periodSortKey
//    - flips / flipScore— Phase A+B (FLIP-FE) flip analyses +
//                         aggregate score for the item
//    - sortedRows       — table rows sorted by user-selected column
//                         (incl. the 'flip' null-comparator sort)
//    - summary          — abnormal/warning/elevated counts etc.
// ============================================================

import { useMemo } from 'react';
import type { ItemTrendData, ItemTrendPeriod } from '@/hooks/useAnalysis';
import { periodSortKey } from '../periodHelpers';
import {
  computeFlipAnalyses,
  computeItemFlipScore,
  getFlipForPeriod,
  periodKey as flipPeriodKey,
  type FlipAnalysis,
  type ItemFlipScore,
} from '../flipHelpers';
import type { SortKey, SortDir } from '../types';

/** Summary stats shown next to the selected-item badge in the header. */
export interface TrendSummary {
  periodCount: number;
  abnormalCount: number;
  warningCount: number;
  elevatedCount: number;
  withZScore: number;
  lastPeriod: ItemTrendPeriod | null;
  firstPeriod: ItemTrendPeriod | null;
}

export interface UseItemTrendDerivedParams {
  data: ItemTrendData | undefined;
  sortKey: SortKey;
  sortDir: SortDir;
}

export interface ItemTrendDerivedState {
  periods: ItemTrendPeriod[];
  satuan: string | null;
  chronological: ItemTrendPeriod[];
  flips: FlipAnalysis[];
  flipScore: ItemFlipScore;
  sortedRows: ItemTrendPeriod[];
  summary: TrendSummary | null;
}

export function useItemTrendDerived({
  data,
  sortKey,
  sortDir,
}: UseItemTrendDerivedParams): ItemTrendDerivedState {
  // Memoize the periods array — `data?.periods ?? []` would create
  // a new array reference every render when periods is undefined, causing
  // downstream useMemo hooks to recompute needlessly. Wrapping it here
  // gives downstream a stable ref.
  const periods: ItemTrendPeriod[] = useMemo(
    () => data?.periods ?? [],
    [data?.periods],
  );

  // FIX (SATUAN-BUG): extract item's unit of measure from the first period.
  // All periods for 1 item share the same satuan (it's an item-level attribute).
  // Used by Flip column/matrix tooltips to display the correct unit instead of
  // hardcoded "kg" (which was wrong for non-KG items like PCS, LTR, etc.).
  const satuan = useMemo(() => periods[0]?.satuan ?? null, [periods]);

  // Chronologically sorted periods for the chart + table.
  const chronological = useMemo(
    () => [...periods].sort((a, b) => periodSortKey(a).localeCompare(periodSortKey(b))),
    [periods],
  );

  // Phase A+B (FLIP-FE) — flip analyses + aggregate score for the item.
  // Memoized off `periods` (not `chronological`) because computeFlipAnalyses
  // sorts internally per-week-group. Both `flips` + `flipScore` are passed
  // down to ItemTrendTable (column), ItemTrendLineChart (annotations),
  // and the Flip Summary Card below the rank badge row.
  const flips: FlipAnalysis[] = useMemo(() => computeFlipAnalyses(periods), [periods]);
  const flipScore: ItemFlipScore = useMemo(() => computeItemFlipScore(flips), [flips]);

  // Table rows (sorted by user-selected column).
  const sortedRows = useMemo(() => {
    const arr = [...chronological];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'period':
          cmp = periodSortKey(a).localeCompare(periodSortKey(b));
          break;
        case 'qtyBom':
          cmp = a.qtyBom - b.qtyBom;
          break;
        case 'qtyDeviasiSigned':
          cmp = a.qtyDeviasiSigned - b.qtyDeviasiSigned;
          break;
        case 'zScore':
          // Treat null zScore as -Infinity so it always sorts to the
          // bottom when desc is on (real anomalies surface to top).
          cmp = (a.zScore ?? -Infinity) - (b.zScore ?? -Infinity);
          break;
        case 'outletCount':
          cmp = a.outletCount - b.outletCount;
          break;
        case 'recordCount':
          cmp = a.recordCount - b.recordCount;
          break;
        case 'flip': {
          // Phase A+B (FLIP-FE) — sort by flip disparity.
          // FIX (BUG-FLIP-02): only sort by disparity for ACTUAL flips
          // (isFlip=true). Non-flip pairs (konsisten-naik/turun/stagnan)
          // and `first` periods (no predecessor) sort to the bottom.
          // FIX (BUG2-FLIP-04): use null + custom comparator so non-flip
          // rows ALWAYS sort to bottom regardless of ASC/DESC direction.
          // (was -1 which put non-flips at TOP on ASC — confusing UX).
          const fa = flips ? getFlipForPeriod(flips, flipPeriodKey(a)) : null;
          const fb = flips ? getFlipForPeriod(flips, flipPeriodKey(b)) : null;
          const va = fa && fa.isFlip ? fa.disparityPct : null;
          const vb = fb && fb.isFlip ? fb.disparityPct : null;
          if (va == null && vb == null) cmp = 0;
          else if (va == null) cmp = 1;  // a (non-flip) goes below b
          else if (vb == null) cmp = -1; // b (non-flip) goes below a
          else cmp = va - vb;
          break;
        }
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [chronological, sortKey, sortDir, flips]);

  // Summary stats (computed inline — small N, no useCallback needed).
  const summary = periods.length === 0 ? null : (() => {
    const withZ = periods.filter(p => p.zScore != null);
    const abnormalCount = withZ.filter(p => (p.zScore as number) > 3).length;
    const warningCount = withZ.filter(p => {
      const z = p.zScore as number;
      return z > 2 && z <= 3;
    }).length;
    const elevatedCount = withZ.filter(p => {
      const z = p.zScore as number;
      return z > 1 && z <= 2;
    }).length;
    const lastPeriod = chronological[chronological.length - 1] ?? null;
    const firstPeriod = chronological[0] ?? null;
    return {
      periodCount: periods.length,
      abnormalCount,
      warningCount,
      elevatedCount,
      withZScore: withZ.length,
      lastPeriod,
      firstPeriod,
    };
  })();

  return { periods, satuan, chronological, flips, flipScore, sortedRows, summary };
}
