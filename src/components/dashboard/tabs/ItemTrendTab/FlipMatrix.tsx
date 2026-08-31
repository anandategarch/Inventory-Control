'use client';

// ============================================================
//  FlipMatrix — Week × Month Signed-QTY Grid (Phase B / FLIP-FE)
//  --------------------------------------------------------
//  Compact matrix showing signed QTY Deviasi per (week, month) pair.
//  Rows = weekLabel (W1-W4, sorted by numeric week), Columns =
//  monthLabel (sorted chronologically by monthKey).
//
//  Cell coloring:
//    - SURPLUS (positive qtyDeviasiSigned) → emerald shades
//    - LOSS   (negative)                   → red shades
//    - ZERO / missing                      → muted empty cell
//    - Intensity scales with magnitude relative to the row's max.
//
//  Cell border:
//    - Thick amber border if this cell is part of a flip pair
//      (either as P1 or P2 in any FlipAnalysis in the `flips` array).
//
//  Cell content:
//    - Compact signed QTY, e.g. "+10K" or "-15K".
//    - "—" for missing (week × month combo with no data).
//
//  Tooltip:
//    - Full period label + signed QTY + flip pair info if applicable.
//
//  Only renders when periods.length >= 2 (need ≥2 cells to form a pair).
// ============================================================

import { memo, useMemo } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ItemTrendPeriod } from '@/hooks/useAnalysis';
import { fmtFullSigned } from '@/lib/format';
import {
  getFlipsForPeriod,
  periodKey as flipPeriodKey,
  formatDisparity,
  type FlipAnalysis,
} from './flipHelpers';

export interface FlipMatrixProps {
  periods: ItemTrendPeriod[];
  /** Flip analyses for the item — used to apply the amber border on cells
   *  that are part of any flip pair. */
  flips: FlipAnalysis[];
  /** FIX (SATUAN-BUG): item's unit of measure (e.g. "KG", "PCS", "LTR").
   *  Used in cell tooltips + footer note to display the correct unit.
   *  Was hardcoded "kg" which was wrong for non-KG items. */
  satuan?: string | null;
}

// FIX (BATCH1): fmtFullSigned moved to @/lib/format — imported above.
// Removed local duplicate definition (~5 lines).

// Numerical week from "WEEK N" label — used to sort rows W1 → W4 (ascending).
function weekNum(weekLabel: string): number {
  const m = /\d+/.exec(weekLabel);
  return m ? parseInt(m[0], 10) : 0;
}

// Sort months by monthKey ASC (chronological). Falls back to monthLabel
// when monthKey is null (rare) so the sort is still stable.
function monthSortKey(p: ItemTrendPeriod): string {
  return p.monthKey ?? p.monthLabel;
}

// Map magnitude → color intensity class.
// Returns a Tailwind className for a cell's background given the signed
// qty + the row's max magnitude (for normalization).
function cellColorClass(signed: number, maxAbs: number): string {
  if (signed === 0 || maxAbs === 0) return 'bg-muted/30 text-muted-foreground/60';
  const ratio = Math.min(Math.abs(signed) / maxAbs, 1);
  if (signed > 0) {
    // SURPLUS — emerald shades (lighter for low intensity).
    if (ratio >= 0.75) return 'bg-emerald-500/40 text-emerald-900 dark:text-emerald-100';
    if (ratio >= 0.50) return 'bg-emerald-400/30 text-emerald-900 dark:text-emerald-100';
    if (ratio >= 0.25) return 'bg-emerald-300/30 text-emerald-900 dark:text-emerald-100';
    return 'bg-emerald-200/30 text-emerald-900 dark:text-emerald-200';
  }
  // LOSS — red shades (lighter for low intensity).
  if (ratio >= 0.75) return 'bg-red-500/40 text-red-900 dark:text-red-100';
  if (ratio >= 0.50) return 'bg-red-400/30 text-red-900 dark:text-red-100';
  if (ratio >= 0.25) return 'bg-red-300/30 text-red-900 dark:text-red-100';
  return 'bg-red-200/30 text-red-900 dark:text-red-200';
}

export const FlipMatrix = memo(function FlipMatrix({ periods, flips, satuan }: FlipMatrixProps) {
  // FIX (SATUAN-BUG): use item's actual satuan, fallback to empty (no suffix).
  const unitLabel = satuan || '';
  // Build the grid:
  //   - rows: sorted weeks (W1 → W4)
  //   - cols: sorted months (chronological)
  //   - cells: signed qtyDeviasiSigned
  //
  // Memoize so the matrix doesn't recompute on every keystroke of the
  // parent's search box (which only changes `query`, not `periods`).
  const grid = useMemo(() => {
    // Collect distinct weeks + months.
    const weekSet = new Map<number, string>(); // weekNum → weekLabel
    const monthSet = new Map<string, string>(); // monthKey → monthLabel
    for (const p of periods) {
      const wn = weekNum(p.weekLabel);
      if (!weekSet.has(wn)) weekSet.set(wn, p.weekLabel);
      const mk = monthSortKey(p);
      if (!monthSet.has(mk)) monthSet.set(mk, p.monthLabel);
    }
    const weeks = Array.from(weekSet.entries()).sort((a, b) => a[0] - b[0]);
    const months = Array.from(monthSet.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    // Cell lookup map: `${monthKey}|${weekNum}` → ItemTrendPeriod.
    const cellMap = new Map<string, ItemTrendPeriod>();
    for (const p of periods) {
      cellMap.set(`${monthSortKey(p)}|${weekNum(p.weekLabel)}`, p);
    }

    // Per-row max magnitude (for color normalization within each week row).
    const rowMax = new Map<number, number>();
    for (const [wn] of weeks) {
      let mx = 0;
      for (const [mk] of months) {
        const p = cellMap.get(`${mk}|${wn}`);
        if (p) mx = Math.max(mx, Math.abs(p.qtyDeviasiSigned));
      }
      rowMax.set(wn, mx);
    }

    return { weeks, months, cellMap, rowMax };
  }, [periods]);

  const { weeks, months, cellMap, rowMax } = grid;

  // Build a Set of period keys involved in any ACTUAL flip pair (isFlip=true).
  // FIX (BUG-FLIP-01): was adding all pairs including konsisten-naik/turun
  // (same-direction), causing amber ring on non-flip cells. Now only actual
  // sign-change flips get the ring.
  const flipPeriodKeys = useMemo(() => {
    const s = new Set<string>();
    for (const f of flips) {
      if (!f.isFlip) continue;
      s.add(f.period1Key);
      s.add(f.period2Key);
    }
    return s;
  }, [flips]);

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-xs flex items-center gap-1.5 font-medium">
          <span aria-hidden>🔀</span>
          Flip Matrix
          <span className="text-muted-foreground font-normal">· week × month signed QTY</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-0">
        <div className="overflow-x-auto">
          {/* FIX (UI-03): text-[11px] — was text-[10px], below readability threshold */}
          <table className="border-separate border-spacing-1 text-[11px] tabular-nums">
            <thead>
              <tr>
                <th className="text-left text-muted-foreground font-medium uppercase tracking-wider px-1 py-0.5 sticky left-0 bg-background min-w-[64px]">
                  Week
                </th>
                {months.map(([mk, ml]) => (
                  <th
                    key={mk}
                    className="text-center text-muted-foreground font-medium uppercase tracking-wider px-2 py-0.5 min-w-[58px]"
                    title={ml}
                  >
                    {ml.slice(0, 3)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map(([wn, wl]) => {
                const maxAbs = rowMax.get(wn) ?? 0;
                return (
                  <tr key={wn}>
                    <td className="text-left text-muted-foreground font-medium uppercase tracking-wider px-1 py-0.5 sticky left-0 bg-background">
                      {wl.replace('WEEK ', 'W')}
                    </td>
                    {months.map(([mk]) => {
                      const p = cellMap.get(`${mk}|${wn}`);
                      if (!p) {
                        return (
                          <td
                            key={mk}
                            className="text-center px-2 py-1 rounded bg-muted/20 text-muted-foreground/30 min-w-[58px]"
                            title="No data"
                          >
                            —
                          </td>
                        );
                      }
                      const pk = flipPeriodKey(p);
                      const isFlipCell = flipPeriodKeys.has(pk);
                      const cls = cellColorClass(p.qtyDeviasiSigned, maxAbs);
                      // FIX (BUG-FLIP-01): filter to actual flips only for tooltip.
                      const pairs = getFlipsForPeriod(flips, pk).filter((f) => f.isFlip);
                      const flipTooltip = pairs.length > 0
                        ? pairs.map((f) => {
                            const otherLabel = f.period1Key === pk ? f.period2Label : f.period1Label;
                            const otherQty = f.period1Key === pk ? f.qtyP2 : f.qtyP1;
                            return `🔀 Flip vs ${otherLabel}: ${fmtFullSigned(otherQty)}${unitLabel ? ` ${unitLabel}` : ''} (${formatDisparity(f)} disparity, ${f.category})`;
                          }).join('\n')
                        : null;
                      return (
                        <Tooltip key={mk}>
                          <TooltipTrigger asChild>
                            <td
                              className={`text-center px-2 py-1 rounded font-semibold min-w-[58px] cursor-help ${cls} ${
                                isFlipCell
                                  ? 'ring-2 ring-amber-500 dark:ring-amber-400 ring-offset-1 ring-offset-background'
                                  : ''
                              }`}
                            >
                              {fmtFullSigned(p.qtyDeviasiSigned)}
                            </td>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[11px] p-2.5 max-w-xs">
                            <div className="space-y-1">
                              <p className="font-semibold">{p.monthLabel} · {p.weekLabel}</p>
                              <div className="flex justify-between gap-4">
                                <span className="text-muted-foreground">Signed QTY:</span>
                                <span className={`font-medium tabular-nums ${p.qtyDeviasiSigned < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                  {p.qtyDeviasiSigned.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                                </span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-muted-foreground">QTY BOM:</span>
                                <span className="font-medium tabular-nums">{p.qtyBom.toLocaleString('id-ID')}</span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-muted-foreground">Outlets / Records:</span>
                                <span className="font-medium tabular-nums">{p.outletCount} / {p.recordCount}</span>
                              </div>
                              {flipTooltip && (
                                <p className="mt-1 pt-1 border-t border-amber-300/40 dark:border-amber-700/40 text-amber-700 dark:text-amber-400 font-medium whitespace-pre-line">
                                  {flipTooltip}
                                </p>
                              )}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          Cells = signed QTY Deviasi{unitLabel ? ` (${unitLabel})` : ''}.{' '}
          <span className="text-emerald-700 dark:text-emerald-400">Emerald = SURPLUS</span>{' '}
          · <span className="text-red-700 dark:text-red-400">red = LOSS</span>{' '}
          · <span className="text-muted-foreground">— = no data</span>.{' '}
          Amber ring = part of a flip pair (vs same-week predecessor).
        </p>
      </CardContent>
    </Card>
  );
});
