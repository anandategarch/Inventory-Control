'use client';

// ============================================================
//  GeneralizedNested — parentDim → childDim drill-down card.
//  --------------------------------------------------------
//  FIX #42: rendered when the user-selected combo differs from
//  the default Item→Outlet (which is already shown by the
//  NestedItemToOutlet card). Returns null when:
//    - nestedGen is missing/empty, OR
//    - the selected combo is the default (item→outlet)
// ============================================================

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtIDR, fmtNum, numberColor } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { DIM_LABELS } from './constants';
import type { ParetoData, ParetoDimension } from './types';

export function GeneralizedNested({
  nestedGen,
  parentDim,
  childDim,
  expandedGen,
  toggleGen,
}: {
  nestedGen: ParetoData['nestedGeneralized'];
  parentDim: ParetoDimension;
  childDim: ParetoDimension;
  expandedGen: Set<string>;
  toggleGen: (name: string) => void;
}) {
  if (!nestedGen || nestedGen.items.length === 0 || (parentDim === 'item' && childDim === 'outlet')) {
    return null;
  }

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
            {DIM_LABELS[parentDim]} → {DIM_LABELS[childDim]} Breakdown
            <InfoTooltip content={`Top 10 ${DIM_LABELS[parentDim].toLowerCase()} berdasarkan |nominalDeviasi|, dengan breakdown per ${DIM_LABELS[childDim].toLowerCase()} (cutoff 80%).`} />
          </CardTitle>
          <Badge variant="secondary" className="text-[10px]">Klik untuk expand</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-2">
          Top 10 {DIM_LABELS[parentDim].toLowerCase()} by deviation. Klik untuk lihat {DIM_LABELS[childDim].toLowerCase()} mana yang menyumbang 80% per parent.
        </p>
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 pb-1 border-b border-border/40 mb-1">
          <span className="w-5 shrink-0">#</span>
          <span className="w-3 shrink-0"></span>
          <span className="min-w-[120px] flex-1 shrink-0">Nama</span>
          <span className="w-20 text-right shrink-0">QTY</span>
          <span className="w-24 text-right shrink-0">Nominal</span>
          <span className="w-10 text-right shrink-0">%</span>
          <span className="w-10 text-right shrink-0">Cum</span>
        </div>
        <div className="space-y-0.5 max-h-[500px] overflow-y-auto">
          {nestedGen.items.map((item, i) => {
            const isExpanded = expandedGen.has(item.name);
            return (
              <div key={`${item.name}-${i}`}>
                <button
                  onClick={() => toggleGen(item.name)}
                  aria-expanded={isExpanded}
                  className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                  {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="min-w-[120px] flex-1 truncate font-medium" title={item.name}>{item.name}</span>
                  <span className={`w-20 text-right tabular-nums shrink-0 ${numberColor(item.qtyDeviasi)}`}>{fmtNum(item.qtyDeviasi)}</span>
                  <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</span>
                  <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{item.sharePct.toFixed(0)}%</span>
                  <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{item.cumPct.toFixed(0)}%</span>
                </button>
                {isExpanded && item.children.length > 0 && (
                  <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 py-0.5">
                      <span className="w-4 shrink-0"></span>
                      <span className="min-w-[100px] flex-1 shrink-0">{DIM_LABELS[childDim]}</span>
                      <span className="w-20 text-right shrink-0">QTY</span>
                      <span className="w-24 text-right shrink-0">Nominal</span>
                      <span className="w-10 text-right shrink-0">%</span>
                      <span className="w-10 text-right shrink-0">Cum</span>
                    </div>
                    {item.children.map((c, j) => (
                      <div key={`${c.name}-${j}`} className="flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20">
                        <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                        <span className="min-w-[100px] flex-1 truncate" title={c.name}>{c.name}</span>
                        <span className={`w-20 text-right tabular-nums shrink-0 ${numberColor(c.qtyDeviasi)}`}>{fmtNum(c.qtyDeviasi)}</span>
                        <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(c.nominalDeviasi)}`}>{fmtIDR(c.nominalDeviasi)}</span>
                        <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{c.sharePct.toFixed(0)}%</span>
                        <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{c.cumPct.toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
