'use client';

import { useState, memo, useMemo, useCallback, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtIDR, fmtPctAbs, numberColor } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { Coins, Percent, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { BarList, type BarListItem } from '@/components/dashboard/shared/BarList';
// SHADCN-PATTERNS (Pattern 4) — reusable structured EmptyState for the
// BarList-empty case (BarList itself renders nothing when its data array
// is empty — we surface a small EmptyState below it instead).
import { EmptyState } from '@/components/ui/empty-state';

export const TopItemsByNominal = memo(function TopItemsByNominal({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  // P3-HYG-7a: pin `items` identity FIRST — `data.topItemsByNominal || []`
  // created a NEW empty array whenever the field is undefined, which would
  // defeat both memos below (deps change every render). useMemo keeps the
  // fallback [] stable across renders while the dep is undefined.
  const items = useMemo(() => data.topItemsByNominal || [], [data.topItemsByNominal]);
  // P3-HYG-7a: the BarList data array was rebuilt (new array + new object
  // per item + new closure) on EVERY render — BarList's memo could never hit.
  // useMemo pins the array identity to `items`; useCallback pins the handler
  // (the items.find() lookup inside is cheap and only runs on click).
  const barData = useMemo(() => items.map((it) => ({
    key: `${it.itemName}-${it.outletCode}`,
    name: it.itemName,
    value: Math.abs(it.nominalDeviasi),
    color: (it.nominalDeviasi < 0 ? 'red' : 'emerald') as 'red' | 'emerald',
    metadata: it.direction,
  })), [items]);
  const handleBarClick = useCallback((item: BarListItem) => {
    setDrilldown({
      outletCode: items.find((it) => `${it.itemName}-${it.outletCode}` === item.key)?.outletCode ?? '',
      itemName: item.name,
    });
  }, [items, setDrilldown]);
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Coins className="h-3.5 w-3.5" />
          </span>
          Top 10 by Nominal Deviasi
          <FormulaInfo
            formula="Rank by |NOMINAL DEVIASI| (descending)"
            description="Ranking berdasarkan magnitude absolut Nominal Deviasi (financial impact). Loss (merah) & Surplus (hijau) ditampilkan direction. Klik baris untuk drill-down."
            example="Rp 182M = |NOMINAL DEVIASI| tertinggi"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'TOP_N_ITEMS', label: 'Jumlah Top Item', dataType: 'number', min: 5, max: 50, step: 5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Financial impact ranking (absolute)</p>
      </CardHeader>
      <CardContent className="p-0">
        {/* HI-1 (UI-audit): fixed h-80 viewport — identical to the two sibling
            cards in this grid row (TopItemsByDevBom / TopOutlets). Without a
            scroll viewport, setting TOP_N_ITEMS=50 via QuickSettings grew this
            card to ~1400px while its neighbors stayed fixed, breaking the
            3-card row balance. Inner px-4 py-3 keeps the BarList inset so the
            scrollbar sits flush with the card edge like the sibling tables. */}
        {items.length > 0 ? (
          <ScrollArea className="h-80">
            <div className="px-4 py-3">
              <BarList
                data={barData}
                valueFormatter={fmtIDR}
                sortOrder="descending"
                showAnimation
                onValueChange={handleBarClick}
              />
            </div>
          </ScrollArea>
        ) : (
          <EmptyState
            icon={Coins}
            title="Tidak ada data"
            description="Belum ada item dengan deviasi pada periode ini."
          />
        )}
        <p className="text-[10px] text-muted-foreground px-4 pb-3 pt-1">💡 Bar length = |Nominal|. Klik untuk drill-down.</p>
      </CardContent>
    </Card>
  );
});

export const TopItemsByDevBom = memo(function TopItemsByDevBom({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.topItemsByDevBom || [];
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Percent className="h-3.5 w-3.5" />
          </span>
          Top 10 by Deviation/BOM
          <FormulaInfo
            formula="Dev/BOM % = |QTY Deviasi| / |QTY BOM| × 100%"
            description="Ranking operational abnormality berdasarkan rasio deviation terhadap BOM (normalized). Merah = melebihi tolerance. Berbeda dari Top Nominal karena ini normalized terhadap volume aktivitas."
            example="Deviasi 50 / BOM 1000 = 5%"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'TOP_N_ITEMS', label: 'Jumlah Top Item', dataType: 'number', min: 5, max: 50, step: 5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">Operational abnormality ranking</p>
      </CardHeader>
      <CardContent className="p-0">
        {/* HI-2 (UI-audit): h-72 → h-80 — matches every other table viewport
            in the Dashboard tab (AdvancedAnalysis trio) so section heights
            stop jumping 288px↔320px while scrolling. */}
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 h-8 text-xs font-semibold uppercase tracking-wider">#</TableHead>
                <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Item</TableHead>
                <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Outlet</TableHead>
                <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Dev/BOM</TableHead>
                <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider w-16">Tol.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-8">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => {
                const breach = it.tolerance != null && Math.abs(it.devBom) > Math.abs(it.tolerance);
                return (
                  <TableRow
                    key={`${it.itemName}-${it.outletCode}`}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''} ${breach ? 'bg-red-50/40 dark:bg-red-950/10' : ''}`}
                    {...clickableRowProps(() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName }))}
                  >
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                    <TableCell className={`text-right font-semibold text-xs tabular-nums ${breach ? 'text-red-600 dark:text-red-400' : ''}`}>{fmtPctAbs(it.devBom)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">{it.tolerance != null ? fmtPctAbs(it.tolerance) : '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
});

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
                        <TableCell className={`text-xs px-3 py-2 text-right font-medium tabular-nums ${numberColor(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</TableCell>
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
                          <TableCell className={`text-[11px] px-3 py-1.5 text-right font-bold tabular-nums ${numberColor(o.devBom)}`}>{(o.devBom * 100).toFixed(0)}%</TableCell>
                          <TableCell className={`text-[11px] px-3 py-1.5 text-right font-medium tabular-nums ${numberColor(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</TableCell>
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
                                          <TableCell className={`text-[11px] px-2 py-1.5 text-right font-medium tabular-nums ${numberColor(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</TableCell>
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
