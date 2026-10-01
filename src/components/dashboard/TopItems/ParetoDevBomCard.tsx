'use client';

// ============================================================
//  ParetoDevBomCard — "Pareto Item Abnormal (|Dev/BOM| > 50%)"
//  --------------------------------------------------------
//  GODSPLIT-W2-B: moved VERBATIM from dashboard/TopItems.tsx
//  (grab-bag 4-kartu split → TopItems/ folder; see index.tsx).
//  Consumer: ParetoDashboard/ParetoDashboard.tsx.
// ============================================================
import { memo, useState, Fragment } from 'react';
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
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

// ============================================================
//  TopOutlets — REMOVED (H-11 / #4a — UI dedup).
//  --------------------------------------------------------
//  The Dashboard's "Top Outlets" card ranked outlets by
//  ABS(SUM(nominalDeviasi)) — the SAME metric the Pareto tab's
//  "Top Outlets (80% Deviation)" QuadrantCard renders (via
//  /api/pareto byOutlet, with cumulative 80/20 distribution on
//  top). Two tabs, two backend scans, one analysis.
//
//  Kept: the Pareto tab's quadrant card (it is one of the five
//  Pareto dimensions — Items/Outlets/Kelompok/Areas/PIC — and the
//  80/20 view is the Pareto tab's core purpose).
//  Removed with the card (dead upstream): the analysis payload's
//  `topOutlets` + `topOutletsBySales` sections and the
//  queryTopOutlets / queryTopOutletsBySales scans — see
//  src/app/api/analysis/services/ (H-11).
//  Outlet prioritization on the Dashboard remains covered by Resto
//  Prioritas Analisa + Ranking Kondisi Resto (both click-to-focus).
// ============================================================

// ============================================================
//  Pareto Dev/BOM — 80/20 untuk item dengan |Dev/BOM| > 50%
//  Group by item, drill-down ke outlet.
// ============================================================
export const ParetoDevBomCard = memo(function ParetoDevBomCard({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const pareto = data.paretoDevBom;
  const drivers = pareto?.drivers || [];

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
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            Pareto Item Abnormal (|Dev/BOM| &gt; {(pareto?.thresholdPct ?? 0.50) * 100}%)
            <InfoTooltip content={`Item dengan |Dev/BOM| > ${(pareto?.thresholdPct ?? 0.50) * 100}% — diabsolute-kan dulu, lalu dibuat Pareto 80/20 berdasarkan |nominal deviasi|. Klik item untuk expand outlet.`} />
          </CardTitle>
          {pareto && pareto.totalCount > 0 && (
            <Badge variant="secondary" className="text-[10px]">{drivers.length} item · {pareto.totalCount} total</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {drivers.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Tidak ada item dengan |Dev/BOM| &gt; {(pareto?.thresholdPct ?? 0.50) * 100}% pada periode ini.</p>
        ) : (
          // STRUCTURAL (S-2): rewritten from a hand-rolled flex-list (fixed-width
          // spans + manual sticky pseudo-header) to the standard Table component
          // with the unified density spec (text-xs cells, h-8 headers) — same
          // data, same expand/collapse + drill-down interactions. Outlet rows
          // align 1:1 with the main columns, so they render as flat nested
          // table rows at the intentional denser detail density (py-1.5,
          // text-[11px] — nested-detail pattern, same as AnomaliOutletExpansion).
          <div className="overflow-x-auto max-h-[400px] overflow-y-auto border rounded-lg">
            <Table>
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 w-8 text-center">#</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">Item</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Dev/BOM</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Nominal</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">%</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Cum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drivers.map((item, i) => {
                  const isExpanded = expandedItems.has(item.itemName);
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
                            <span className="text-[10px] text-muted-foreground shrink-0">{item.outletCount} out</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-xs px-3 py-2 text-right font-bold tabular-nums text-red-600 dark:text-red-400">{(item.devBomAbs * 100).toFixed(0)}%</TableCell>
                        {/* P23 B1: signed SUM(nominalDeviasi) VALUE column — minus-red only (PDF negColor). */}
                        <TableCell className={`text-xs px-3 py-2 text-right font-medium tabular-nums ${numberColorNeg(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</TableCell>
                        <TableCell className="text-xs px-3 py-2 text-right text-muted-foreground tabular-nums">{item.sharePct.toFixed(0)}%</TableCell>
                        <TableCell className="text-xs px-3 py-2 text-right text-muted-foreground/60 tabular-nums">{item.cumPct.toFixed(0)}%</TableCell>
                      </TableRow>
                      {isExpanded && item.outlets.length > 0 && item.outlets.map((o, j) => (
                        <TableRow
                          key={`${o.outletCode}-${j}`}
                          className="cursor-pointer bg-muted/20 hover:bg-muted/40 transition-colors"
                          {...clickableRowProps(() => setDrilldown({ outletCode: o.outletCode, itemName: item.itemName }))}
                        >
                          <TableCell className="text-[11px] px-3 py-1.5 text-center tabular-nums text-muted-foreground/60">{j + 1}</TableCell>
                          <TableCell className="text-[11px] px-3 py-1.5 pl-9">
                            <span className="block truncate max-w-[200px]" title={`${o.outletName} (${o.outletCode})`}>{o.outletName}</span>
                          </TableCell>
                          {/* P23 B1: o.devBom is SIGNED (ΣqtyDeviasi/Σ|qtyBom|, by-other-metric-pareto.ts:72) —
                              minus-red only; positive no longer paints emerald (a positive Dev/BOM is not "good"). */}
                          <TableCell className={`text-[11px] px-3 py-1.5 text-right font-bold tabular-nums ${numberColorNeg(o.devBom)}`}>{(o.devBom * 100).toFixed(0)}%</TableCell>
                          {/* P23 B1: signed VALUE column — minus-red only (PDF negColor). */}
                          <TableCell className={`text-[11px] px-3 py-1.5 text-right font-medium tabular-nums ${numberColorNeg(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</TableCell>
                          <TableCell className="text-[11px] px-3 py-1.5 text-right text-muted-foreground tabular-nums">{o.sharePct.toFixed(0)}%</TableCell>
                          <TableCell className="text-[11px] px-3 py-1.5 text-right text-muted-foreground/60 tabular-nums">{o.cumPct.toFixed(0)}%</TableCell>
                        </TableRow>
                      ))}
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
