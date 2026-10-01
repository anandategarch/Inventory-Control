'use client';

// ============================================================
//  GapAnalysisCard — "Gap Analysis: Rank BOM vs Rank Nasional"
//  --------------------------------------------------------
//  GODSPLIT-W2-B: moved VERBATIM from dashboard/TopItems.tsx
//  (grab-bag 4-kartu split → TopItems/ folder; see index.tsx).
//  Consumer: ParetoDashboard/ParetoDashboard.tsx.
// ============================================================
import { memo, useState, useMemo, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
// P23 B1: numberColorNeg (neg-only) on signed VALUE columns — strict PDF
// negColor parity (positive stays neutral); the BarList barColor in
// TopItemsByNominal.tsx keeps the chart convention (emerald surplus)
// since it is a magnitude surface.
import { fmtIDR, numberColorNeg } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { Coins, ChevronDown, ChevronRight } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

// ============================================================
//  Gap Analysis Card — Rank BOM vs Rank Nasional
//  Group by item, drill-down ke outlet.
//  Gap = rankBom - rankNominal. +N = qty dominan, -N = nominal dominan.
// ============================================================
export const GapAnalysisCard = memo(function GapAnalysisCard({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // P3-HYG-7b: the whole gap pipeline (filter → group-by-item reduce →
  // avgGap map → sort, plus the per-item outlet sort that used to run inline
  // at render time on every expanded repaint) is now ONE memo keyed on the
  // source array. This card renders in 3 tabs (Pareto / Peer / ItemPeer) —
  // previously every mount + every expand-toggle re-ran the full computation
  // over up to 500 topDeviasiRank rows.
  const itemGaps = useMemo(() => {
    const items = (data.topDeviasiRank || []).filter((it: any) => it.rankBom != null && it.rankBom > 0);
    const grouped = items.reduce((acc, it) => {
      if (!acc.has(it.itemName)) acc.set(it.itemName, []);
      acc.get(it.itemName)!.push(it);
      return acc;
    }, new Map<string, any[]>());
    return Array.from(grouped.entries()).map(([itemName, outlets]) => {
      const gaps = outlets.map((o) => o.rankBom - o.rankNominal);
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      return {
        itemName,
        avgGap,
        outletCount: outlets.length,
        // Pre-sorted outlets (desc by outlet gap) — replaces the inline
        // [...outlets].sort(...) that ran per render inside the map.
        sortedOutlets: [...outlets].sort(
          (a, b) => (b.rankBom - b.rankNominal) - (a.rankBom - a.rankNominal),
        ),
      };
    }).sort((a, b) => b.avgGap - a.avgGap);
  }, [data.topDeviasiRank]);

  const toggleItem = (name: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
              <Coins className="h-3.5 w-3.5" />
            </span>
            Gap Analysis: Rank BOM vs Rank Nasional
            <InfoTooltip content="Gap = Rank BOM - Rank Nasional. +N (merah) = qty BOM lebih dominan → cek portioning/operasional. -N (kuning) = nominal lebih dominan → cek harga/procurement." />
          </CardTitle>
          {itemGaps.length > 0 && <Badge variant="secondary" className="text-[10px]">{itemGaps.length} item</Badge>}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {itemGaps.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Tidak ada data rank untuk periode ini.</p>
        ) : (
          // STRUCTURAL (S-2): rewritten from a hand-rolled flex-list to the
          // standard Table component (same spec as ParetoDevBomCard above).
          // The outlet detail has a different column set than the main rows,
          // so the expansion follows the AnomaliOutletExpansion pattern: a
          // colSpan row containing a nested table at the intentional denser
          // detail density (text-[10px] h-7 headers, py-1.5 cells).
          <div className="overflow-x-auto max-h-[400px] overflow-y-auto border rounded-lg">
            <Table>
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 w-8 text-center">#</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">Item</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Avg Gap</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Outlets</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {itemGaps.map((item, i) => {
                  const isExpanded = expandedItems.has(item.itemName);
                  const gap = Math.round(item.avgGap);
                  const isQtyDriven = gap > 0;
                  const isPriceDriven = gap < 0;
                  return (
                    <Fragment key={`${item.itemName}-${i}`}>
                      <TableRow
                        className={`cursor-pointer hover:bg-muted/40 transition-colors ${isExpanded ? 'bg-muted/30' : ''}`}
                        aria-expanded={isExpanded}
                        {...clickableRowProps(() => toggleItem(item.itemName))}
                      >
                        <TableCell className="text-xs px-3 py-2 text-center font-medium tabular-nums text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="text-xs px-3 py-2">
                          <span className="flex items-center gap-1.5 min-w-0">
                            {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                            <span className="truncate font-medium" title={item.itemName}>{item.itemName}</span>
                          </span>
                        </TableCell>
                        <TableCell className={`text-xs px-3 py-2 text-right font-bold tabular-nums ${isQtyDriven ? 'text-red-600 dark:text-red-400' : isPriceDriven ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{gap > 0 ? `+${gap}` : gap}</TableCell>
                        <TableCell className="text-xs px-3 py-2 text-right text-muted-foreground tabular-nums">{item.outletCount}</TableCell>
                      </TableRow>
                      {isExpanded && item.sortedOutlets.length > 0 && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={4} className="p-0">
                            <div className="bg-muted/20 border-t border-border/40 px-3 py-2">
                              <div className="max-h-48 overflow-auto rounded-md border border-border/40 bg-background/60">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="text-[10px] h-7 px-2 w-8 text-center">#</TableHead>
                                      <TableHead className="text-[10px] h-7 px-2">Outlet</TableHead>
                                      <TableHead className="text-center text-[10px] h-7 px-2">Rank N</TableHead>
                                      <TableHead className="text-center text-[10px] h-7 px-2">Rank B</TableHead>
                                      <TableHead className="text-center text-[10px] h-7 px-2">Gap</TableHead>
                                      <TableHead className="text-right text-[10px] h-7 px-2">Nominal</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {item.sortedOutlets.map((o, j) => {
                                      const oGap = o.rankBom - o.rankNominal;
                                      return (
                                        <TableRow
                                          key={`${o.outletCode}-${j}`}
                                          className="cursor-pointer hover:bg-muted/40 transition-colors"
                                          {...clickableRowProps(() => setDrilldown({ outletCode: o.outletCode, itemName: item.itemName }))}
                                        >
                                          <TableCell className="text-[11px] px-2 py-1.5 text-center tabular-nums text-muted-foreground/60">{j + 1}</TableCell>
                                          <TableCell className="text-[11px] px-2 py-1.5 font-medium" title={o.outletCode}>{o.outletCode}</TableCell>
                                          <TableCell className="text-[11px] px-2 py-1.5 text-center tabular-nums">{o.rankNominal}</TableCell>
                                          <TableCell className="text-[11px] px-2 py-1.5 text-center tabular-nums">{o.rankBom}</TableCell>
                                          <TableCell className={`text-[11px] px-2 py-1.5 text-center font-bold tabular-nums ${oGap > 0 ? 'text-red-600 dark:text-red-400' : oGap < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{oGap > 0 ? `+${oGap}` : oGap}</TableCell>
                                          {/* P23 B1: signed VALUE column — minus-red only (PDF negColor). */}
                                          <TableCell className={`text-[11px] px-2 py-1.5 text-right font-medium tabular-nums ${numberColorNeg(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
