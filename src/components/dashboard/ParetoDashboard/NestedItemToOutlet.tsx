'use client';

// ============================================================
//  NestedItemToOutlet — Item → Outlet drill-down card.
//  --------------------------------------------------------
//  Renders the top 10 items with |nominalDeviasi|, each
//  expandable to reveal its outlets (80% cutoff per item).
//  Returns null when nestedItems is empty.
// ============================================================

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtIDR, fmtNum, numberColorNeg } from '@/lib/format';
import type { NestedItem } from './types';

export function NestedItemToOutlet({
  nestedItems,
  expandedItems,
  toggleItem,
}: {
  nestedItems: NestedItem[];
  expandedItems: Set<string>;
  toggleItem: (name: string) => void;
}) {
  if (nestedItems.length === 0) return null;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300">
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
            Item → Outlet Breakdown
          </CardTitle>
          <Badge variant="secondary" className="text-[10px]">Klik item untuk expand outlet</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-2">
          {/* FIX (BUG-HUNT B14/B2-05): leftover EN "by deviation" (VH-7 sweep miss). */}
          Top 10 item berdasarkan deviasi. Klik untuk lihat outlet mana yang menyumbang 80% per item.
        </p>
        {/* P23 B2 (LEFTOVER #6): horizontal-scroll wrapper — the fixed-width
            shrink-0 row spans (~500px min) were clipped by the Card's
            overflow-hidden on <480px viewports (%/Cum columns cut off).
            min-w mirrors QuadrantCard's overflow-auto + Table min-w-[600px]
            pattern: header + rows scroll together on narrow screens. */}
        <div className="overflow-x-auto">
          <div className="min-w-[500px]">
        {/* Column headers */}
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
          {nestedItems.map((item, i) => {
            const isExpanded = expandedItems.has(item.itemName);
            return (
              <div key={`${item.itemName}-${i}`}>
                <button
                  onClick={() => toggleItem(item.itemName)}
                  aria-expanded={isExpanded}
                  className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                  {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="min-w-[120px] flex-1 truncate font-medium" title={item.itemName}>{item.itemName}</span>
                  <span className="text-muted-foreground text-[10px] tabular-nums shrink-0">{item.outletCount} resto</span>
                  {/* P23 B2: signed VALUE columns (qty/nominalDeviasi SUM) — minus-red only (PDF negColor). */}
                  <span className={`w-20 text-right tabular-nums shrink-0 ${numberColorNeg(item.qtyDeviasi)}`}>{fmtNum(item.qtyDeviasi)}</span>
                  <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColorNeg(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</span>
                  <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{item.sharePct.toFixed(0)}%</span>
                  <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{item.cumPct.toFixed(0)}%</span>
                </button>
                {isExpanded && item.outlets.length > 0 && (
                  <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                    {/* Outlet sub-header */}
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 py-0.5">
                      <span className="w-4 shrink-0"></span>
                      <span className="min-w-[100px] flex-1 shrink-0">Outlet</span>
                      <span className="text-[10px] shrink-0">Area</span>
                      <span className="w-20 text-right shrink-0">QTY</span>
                      <span className="w-24 text-right shrink-0">Nominal</span>
                      <span className="w-10 text-right shrink-0">%</span>
                      <span className="w-10 text-right shrink-0">Cum</span>
                    </div>
                    {item.outlets.map((o, j) => (
                      <div key={`${o.outletCode}-${j}`} className="flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20">
                        <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                        <span className="min-w-[100px] flex-1 truncate" title={o.outletName}>{o.outletName}</span>
                        <span className="text-muted-foreground text-[10px] shrink-0">{o.area}</span>
                        {/* P23 B2: signed VALUE columns — minus-red only (PDF negColor). */}
                        <span className={`w-20 text-right tabular-nums shrink-0 ${numberColorNeg(o.qtyDeviasi)}`}>{fmtNum(o.qtyDeviasi)}</span>
                        <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColorNeg(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</span>
                        <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{o.sharePct.toFixed(0)}%</span>
                        <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{o.cumPct.toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
