// ============================================================
//  FlipCell — Flip table cell with tooltip
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTable.tsx — no behavior
//  change). Shows whether the period's signed qtyDeviasi flipped
//  direction vs its same-week predecessor (W4 Jul → W4 Agu).
//  Categories: sempurna / dominan / parsial / konsisten-naik /
//  konsisten-turun / stagnan / first. Tooltip carries the full
//  P1/P2/net/disparity breakdown (with the item's satuan).
// ============================================================

import { TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import {
  flipBadge,
  formatDisparity,
  type FlipAnalysis,
} from '../flipHelpers';

interface FlipCellProps {
  /** Flip pair vs same-week predecessor (null = no predecessor / `first`). */
  flip: FlipAnalysis | null;
  /** Resolved category (`flip?.category ?? 'first'`). */
  flipCat: FlipAnalysis['category'];
  /** Pre-computed badge config (flipBadge(flipCat)). */
  flipCfg: ReturnType<typeof flipBadge>;
  /** Item's unit of measure ("" when null/unknown — SATUAN-BUG fix). */
  unitLabel: string;
}

export function FlipCell({ flip, flipCat, flipCfg, unitLabel }: FlipCellProps) {
  return (
    <TableCell className="text-xs px-3 py-2 text-center">
      {flip == null ? (
        <span className="text-muted-foreground/60">—</span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={`text-[10px] h-5 px-1.5 font-medium gap-0.5 cursor-help ${flipCfg.className}`}
            >
              <span aria-hidden>{flipCfg.emoji}</span>
              <span>
                {flip.isFlip
                  ? `Flip ${formatDisparity(flip)}`
                  : flipCat === 'konsisten-naik'
                    ? '↑ Konsisten'
                    : flipCat === 'konsisten-turun'
                      ? '↓ Konsisten'
                      : 'Stagnan'}
              </span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs p-3 max-w-xs">
            <div className="space-y-1">
              <p className="font-semibold">🔀 Flip Analysis</p>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">vs Predecessor:</span>
                <span className="font-medium">{flip.period1Label}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">P1 (signed):</span>
                <span className={`font-medium tabular-nums ${flip.qtyP1 < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {flip.qtyP1.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">P2 (signed):</span>
                <span className={`font-medium tabular-nums ${flip.qtyP2 < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {flip.qtyP2.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Net (P1+P2):</span>
                <span className="font-medium tabular-nums">
                  {flip.net.toLocaleString('id-ID', { maximumFractionDigits: 1 })}{unitLabel ? ` ${unitLabel}` : ''}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Disparity:</span>
                <span className="font-bold tabular-nums">{formatDisparity(flip)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Category:</span>
                <span className="font-medium">{flipCfg.label || '—'} {flip.isFlip ? `(risk: ${flip.riskLevel})` : ''}</span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </TableCell>
  );
}
