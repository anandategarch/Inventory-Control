'use client';

// ============================================================
//  FlipRankingRow — one ranking row + its drill-down panel
//  --------------------------------------------------------
//  SPLIT-B (pure move from FlipRanking.tsx — no behavior change).
//  Renders a Fragment: the clickable TableRow (selects the item
//  for trend analysis above) +, when expanded, a second TableRow
//  (colSpan=7) hosting the FlipDrillPanel per-outlet breakdown.
// ============================================================

import { Fragment } from 'react';
import { TableRow, TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react';
import { fmtNum, fmtDecimal } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { riskBadge, categoryBadge, drillKey } from '../flip-badges';
import { FlipDrillPanel } from '../FlipDrillPanel';
import type { FlipRankItem } from './types';

interface FlipRankingRowProps {
  item: FlipRankItem;
  /** 0-based row index (drives the # column + zebra striping). */
  index: number;
  /** True when this item is the currently-selected trend item. */
  isSelected: boolean;
  /** Currently expanded drill-down key (`${itemName}|${weekLabel}|${period1Label}`)
   *  — only ONE drill-down can be open at a time. */
  expandedFlip: string | null;
  onToggleDrill: (key: string) => void;
  onSelectItem: (itemName: string) => void;
  /** Dashboard filters — scope the FlipDrillPanel fetch. */
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
}

export function FlipRankingRow({
  item,
  index: i,
  isSelected,
  expandedFlip,
  onToggleDrill,
  onSelectItem,
  area,
  kelompok,
  outletCode,
  pic,
}: FlipRankingRowProps) {
  const topFlip = item.topFlips[0];
  // VERIFY-FLIP: Δ (P2 − P1) shown in the tooltip — master context requires
  // topFlips pairs to carry P1/P2/Δ/net/disparity/category. Fallback covers
  // a cached pre-fix payload without the explicit `delta` field.
  const topFlipDelta = topFlip ? (topFlip.delta ?? topFlip.qtyP2 - topFlip.qtyP1) : 0;
  const rb = riskBadge(item.riskLevel);
  const cb = topFlip ? categoryBadge(topFlip.category) : null;
  // Drill-down key — only meaningful when there's a topFlip.
  const dKey = topFlip ? drillKey(item.itemName, topFlip.weekLabel, topFlip.period1Label) : null;
  const isExpanded = dKey !== null && expandedFlip === dKey;
  return (
    <Fragment>
      <TableRow
        className={`cursor-pointer hover:bg-muted/40 transition-colors border-b ${
          isSelected
            ? 'bg-amber-50/60 dark:bg-amber-950/20 border-l-2 border-l-amber-500'
            : i % 2 === 1
              ? 'bg-muted/20'
              : ''
        }`}
        {...clickableRowProps(() => onSelectItem(item.itemName))}
      >
        <TableCell className="text-center text-xs text-muted-foreground tabular-nums py-2">{i + 1}</TableCell>
        <TableCell className="text-xs py-2">
          <div className="font-medium truncate max-w-[200px]" title={item.itemName}>
            {item.itemName}
          </div>
          {isSelected && (
            <Badge variant="default" className="text-[10px] ml-1 h-4 bg-amber-600 hover:bg-amber-600 text-white">
              TERPILIH
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-right text-xs py-2 tabular-nums">
          {item.flipCount}
          <span className="text-muted-foreground text-[10px]"> / {item.totalPairs}</span>
        </TableCell>
        <TableCell className="text-right text-xs py-2 tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
          {item.sempurnaCount > 0 ? item.sempurnaCount : '—'}
        </TableCell>
        <TableCell className="text-right text-xs py-2 tabular-nums text-muted-foreground">
          {item.flipCount > 0 ? `${fmtDecimal(item.avgDisparity * 100, 1)}%` : '—'}
        </TableCell>
        <TableCell className="text-right py-2">
          <div className="flex items-center justify-end gap-1.5">
            {item.riskLevel === 'high' && <AlertTriangle className="h-3 w-3 text-red-500" />}
            <Badge variant="outline" className={`text-[10px] h-5 px-1.5 font-medium tabular-nums ${rb.className}`}>
              {rb.label} {item.riskScore}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="text-xs py-2">
          {/* FIX (USER-REQ): show drill-down chevron for HIGH + MODERATE risk items.
              Only LOW risk items hide the chevron — drill-down is for investigating
              items with actual flips (HIGH = sempurna flip, MODERATE = other flips). */}
          {topFlip && cb && dKey && item.riskLevel !== 'low' ? (
            <div className="flex items-center gap-1">
              {/* Chevron — toggles drill-down panel */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleDrill(dKey);
                }}
                aria-label={isExpanded ? 'Tutup drill-down' : 'Buka drill-down'}
                aria-expanded={isExpanded}
                // FIX (UI2-08): h-8 w-8 (32px) — below 44px touch target but usable; was h-5 w-5 (20px) unusable on mobile
                // P23 C1: purple (off-token family) → adaptive --chart-2 token utilities (teal light / green dark) for the FLIP drill accent.
                className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-chart-2/15 dark:hover:bg-chart-2/20 text-chart-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-chart-2"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 cursor-help">
                    <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${cb.className}`}>
                      <span aria-hidden>{cb.emoji}</span>
                      <span className="tabular-nums">{fmtDecimal(topFlip.disparityPct, 1)}%</span>
                    </span>
                    <span className="text-muted-foreground text-[10px] tabular-nums">
                      {topFlip.period1Label} → {topFlip.period2Label}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs p-3 max-w-xs">
                  <div className="space-y-1">
                    <p className="font-semibold">
                      {topFlip.period1Label} → {topFlip.period2Label} ({topFlip.weekLabel})
                    </p>
                    {/* P23 C1: tooltip signed-value colors were light-mode-only — add dark: variants. */}
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">P1 (signed):</span>
                      <span className={`font-medium tabular-nums ${topFlip.qtyP1 < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {fmtNum(topFlip.qtyP1, '', false)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">P2 (signed):</span>
                      <span className={`font-medium tabular-nums ${topFlip.qtyP2 < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {fmtNum(topFlip.qtyP2, '', false)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Δ (P2−P1):</span>
                      <span className={`font-medium tabular-nums ${topFlipDelta < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {topFlipDelta >= 0 ? '+' : ''}{fmtNum(topFlipDelta, '', false)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Net (P1+P2):</span>
                      <span className="font-medium tabular-nums">{fmtNum(topFlip.net, '', false)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Disparity:</span>
                      <span className="font-bold tabular-nums">{fmtDecimal(topFlip.disparityPct, 1)}%</span>
                    </div>
                    <p className="text-muted-foreground text-[10px] pt-1 border-t">
                      💡 Klik <ChevronRight className="h-3 w-3 inline" /> untuk per-outlet breakdown
                    </p>
                    {item.topFlips.length > 1 && (
                      <p className="text-muted-foreground text-[10px] pt-1 border-t">
                        +{item.topFlips.length - 1} flip lainnya
                      </p>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <span className="text-muted-foreground text-[10px]">—</span>
          )}
        </TableCell>
      </TableRow>
      {/* Drill-down panel — spans all 7 columns. */}
      {isExpanded && topFlip && (
        <TableRow className="border-b hover:bg-transparent">
          <TableCell colSpan={7} className="p-0">
            <FlipDrillPanel
              item={item.itemName}
              flip={topFlip}
              area={area}
              kelompok={kelompok}
              outletCode={outletCode}
              pic={pic}
            />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
