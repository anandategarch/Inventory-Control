'use client';

// ============================================================
//  ZScoreCell — Z-Score table cell with tooltip + mini bar
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTable.tsx — no behavior
//  change). SIGNED coloring; tooltip carries the full breakdown
//  (current value, mean, stdDev, sampleSize, nominal).
// ============================================================

import { TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import type { ItemTrendMetric, ItemTrendPeriod } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtDecimal } from '@/lib/format';
import { zScoreColor, zScoreStatus } from '../zScoreHelpers';
import { METRICS } from '../types';

interface ZScoreCellProps {
  period: ItemTrendPeriod;
  metric: ItemTrendMetric;
  /** Pre-computed status badge (zScoreStatus(z)) — shared with the Status cell. */
  status: ReturnType<typeof zScoreStatus>;
}

export function ZScoreCell({ period: p, metric, status }: ZScoreCellProps) {
  const z = p.zScore;
  return (
    <TableCell className={`text-xs px-3 py-2 text-right tabular-nums ${z != null ? zScoreColor(z) : 'text-muted-foreground'}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-end gap-1.5 cursor-help">
            {z != null && (
              <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden" aria-hidden>
                <div
                  className={`h-full ${
                    z > 3 ? 'bg-red-500' :
                    z > 2 ? 'bg-amber-500' :
                    z > 1 ? 'bg-yellow-500' :
                    z < -2 ? 'bg-emerald-500' :
                    z < -1 ? 'bg-emerald-400' :
                    'bg-muted-foreground/40'
                  }`}
                  style={{ width: `${Math.min(Math.abs(z) / 5 * 100, 100)}%` }}
                />
              </div>
            )}
            {z == null ? '—' : z > 0 ? `+${fmtDecimal(z, 2)}` : fmtDecimal(z, 2)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs p-3 max-w-xs">
          <div className="space-y-1">
            <p className="font-semibold">Z-Score Breakdown</p>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Current |{METRICS.find(m => m.value === metric)?.shortLabel ?? 'Deviasi'}|:</span>
              <span className="font-medium tabular-nums">{fmtNum(Math.abs(metric === 'qtyDeviasi' ? p.qtyDeviasiSigned : metric === 'qtyWaste' ? p.qtyWaste : metric === 'qtySusut' ? p.qtySusut : p.qtyTrial))}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Historical Mean:</span>
              <span className="font-medium tabular-nums">{fmtNum(p.historicalMean)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Std Dev:</span>
              <span className="font-medium tabular-nums">{fmtNum(p.historicalStdDev)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Sample Size:</span>
              <span className="font-medium tabular-nums">{p.sampleSize} weeks</span>
            </div>
            {z != null && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Z-Score:</span>
                <span className={`font-bold tabular-nums ${zScoreColor(z)}`}>
                  {z > 0 ? '+' : ''}{fmtDecimal(z, 2)} ({status.label})
                </span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">|Nominal|:</span>
              <span className="font-medium tabular-nums">{fmtIDR(p.nominalDeviasi)}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TableCell>
  );
}
