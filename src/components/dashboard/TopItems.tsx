'use client';

import { useState, memo, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtIDR, fmtNum, fmtPctAbs, numberColor, formatByPreset } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { ExternalLink, Coins, Percent, Store, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
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
      <CardContent className="p-4">
        {/* TREMOR Pattern 2 — BarList: replaces the previous Table layout
            with a compact ranked bar list. Each bar's length encodes
            |Nominal Deviasi| (absolute financial impact), color encodes
            direction (red=LOSS, emerald=SURPLUS), metadata shows direction
            label. Click triggers drill-down via onValueChange. */}
        <BarList
          data={barData}
          valueFormatter={fmtIDR}
          sortOrder="descending"
          showAnimation
          onValueChange={handleBarClick}
        />
        {/* SHADCN-PATTERNS (Pattern 4) — BarList renders nothing when its
            data array is empty, so we surface an EmptyState below it to
            give the user a clear "no data" signal instead of a blank card. */}
        {items.length === 0 && (
          <EmptyState
            icon={Coins}
            title="Tidak ada data"
            description="Belum ada item dengan deviasi pada periode ini."
          />
        )}
        <p className="text-[10px] text-muted-foreground mt-2">💡 Bar length = |Nominal|. Klik untuk drill-down.</p>
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
        <ScrollArea className="h-72">
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

export const TopOutlets = memo(function TopOutlets({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setFocusOutlet = useDashboard((s) => s.setFocusOutlet);
  const items = data.topOutlets || [];
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0">
            <Store className="h-3.5 w-3.5" />
          </span>
          Top Outlets
          <FormulaInfo
            formula="Rank by Σ|NOMINAL DEVIASI| per outlet (descending)"
            description="Outlet dengan total magnitude nominal deviation tertinggi. Dev/BOM = rata-rata |QTY Deviasi|/|QTY BOM| item di outlet tersebut. Area Avg = rata-rata Dev/BOM semua outlet di area yang sama. Merah = Dev/BOM outlet > 1.5× area avg."
            example="Outlet A: Σ|Nom Dev| = Rp 182M, Dev/BOM 18% vs Area Avg 12%"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'TOP_N_OUTLETS', label: 'Jumlah Top Outlet', dataType: 'number', min: 5, max: 50, step: 5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">By absolute nominal deviation</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 h-8 text-xs font-semibold uppercase tracking-wider">#</TableHead>
                <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Outlet</TableHead>
                <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Area</TableHead>
                <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Nominal</TableHead>
                <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Dev/BOM</TableHead>
                <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Area Avg</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs py-8">Tidak ada data</TableCell></TableRow>
              ) : items.map((o, i) => {
                const aboveArea = o.areaAvg > 0 && o.devBom > o.areaAvg * 1.5;
                return (
                  <TableRow
                    key={o.outletCode}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''} ${aboveArea ? 'bg-red-50/40 dark:bg-red-950/10' : ''}`}
                    {...clickableRowProps(() => setFocusOutlet(o.outletCode))}
                  >
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs whitespace-normal" title={o.outletName}>{o.outletName}<div className="text-[11px] text-muted-foreground">{o.outletCode}</div></TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={o.area}>{o.area}</TableCell>
                    <TableCell className={`text-right font-semibold text-xs tabular-nums ${o.nominalDeviasi != null && o.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtIDR(o.nominalDeviasi ?? o.absNominal)}</TableCell>
                    <TableCell className={`text-right text-xs font-semibold tabular-nums ${aboveArea ? 'text-red-600 dark:text-red-400' : ''}`}>{fmtPctAbs(o.devBom)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">{fmtPctAbs(o.areaAvg)}</TableCell>
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
    <Card className="overflow-visible shadow-md shadow-black/5 dark:shadow-black/20">
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
          <div className="max-h-[400px] overflow-auto">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 pb-1 border-b border-border/40 mb-1 sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm z-10">
              <span className="w-5 shrink-0">#</span>
              <span className="w-3 shrink-0"></span>
              <span className="min-w-[120px] flex-1 shrink-0">Item</span>
              <span className="w-16 text-right shrink-0">Dev/BOM</span>
              <span className="w-24 text-right shrink-0">Nominal</span>
              <span className="w-10 text-right shrink-0">%</span>
              <span className="w-10 text-right shrink-0">Cum</span>
            </div>
            <div className="space-y-0.5">
              {drivers.map((item, i) => {
                const isExpanded = expandedItems.has(item.itemName);
                return (
                  <div key={`${item.itemName}-${i}`}>
                    <button onClick={() => toggleItem(item.itemName)} aria-expanded={isExpanded} className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left">
                      <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                      {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="flex-1 truncate font-medium" title={item.itemName}>{item.itemName}</span>
                      <span className="text-muted-foreground text-[10px] tabular-nums shrink-0">{item.outletCount} out</span>
                      <span className="w-16 text-right tabular-nums font-bold shrink-0 text-red-600 dark:text-red-400">{(item.devBomAbs * 100).toFixed(0)}%</span>
                      <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</span>
                      <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{item.sharePct.toFixed(0)}%</span>
                      <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{item.cumPct.toFixed(0)}%</span>
                    </button>
                    {isExpanded && item.outlets.length > 0 && (
                      <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 py-0.5">
                          <span className="w-4 shrink-0"></span>
                          <span className="min-w-[100px] flex-1 shrink-0">Outlet</span>
                          <span className="w-16 text-right shrink-0">Dev/BOM</span>
                          <span className="w-24 text-right shrink-0">Nominal</span>
                          <span className="w-10 text-right shrink-0">%</span>
                          <span className="w-10 text-right shrink-0">Cum</span>
                        </div>
                        {item.outlets.map((o, j) => (
                          <button key={`${o.outletCode}-${j}`} onClick={() => setDrilldown({ outletCode: o.outletCode, itemName: item.itemName })} className="w-full flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20 hover:bg-muted/40 transition-colors text-left">
                            <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                            <span className="flex-1 truncate" title={`${o.outletName} (${o.outletCode})`}>{o.outletName}</span>
                            <span className={`w-16 text-right tabular-nums font-bold shrink-0 ${numberColor(o.devBom)}`}>{(o.devBom * 100).toFixed(0)}%</span>
                            <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</span>
                            <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{o.sharePct.toFixed(0)}%</span>
                            <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{o.cumPct.toFixed(0)}%</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
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
    <Card className="overflow-visible shadow-md shadow-black/5 dark:shadow-black/20">
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
          <div className="max-h-[400px] overflow-auto">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 pb-1 border-b border-border/40 mb-1 sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm z-10">
              <span className="w-5 shrink-0">#</span>
              <span className="w-3 shrink-0"></span>
              <span className="min-w-[120px] flex-1 shrink-0">Item</span>
              <span className="w-16 text-right shrink-0">Avg Gap</span>
              <span className="w-10 text-right shrink-0">Outlets</span>
            </div>
            <div className="space-y-0.5">
              {itemGaps.map((item, i) => {
                const isExpanded = expandedItems.has(item.itemName);
                const gap = Math.round(item.avgGap);
                const isQtyDriven = gap > 0;
                const isPriceDriven = gap < 0;
                return (
                  <div key={`${item.itemName}-${i}`}>
                    <button onClick={() => toggleItem(item.itemName)} aria-expanded={isExpanded} className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left">
                      <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                      {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="flex-1 truncate font-medium" title={item.itemName}>{item.itemName}</span>
                      <span className={`w-16 text-right tabular-nums font-bold shrink-0 ${isQtyDriven ? 'text-red-600 dark:text-red-400' : isPriceDriven ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{gap > 0 ? `+${gap}` : gap}</span>
                      <span className="w-10 text-right text-muted-foreground text-[10px] tabular-nums shrink-0">{item.outletCount}</span>
                    </button>
                    {isExpanded && item.sortedOutlets.length > 0 && (
                      <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 py-0.5">
                          <span className="w-4 shrink-0"></span>
                          <span className="min-w-[80px] flex-1 shrink-0">Outlet</span>
                          <span className="w-12 text-center shrink-0">Rank N</span>
                          <span className="w-12 text-center shrink-0">Rank B</span>
                          <span className="w-12 text-center shrink-0">Gap</span>
                          <span className="w-24 text-right shrink-0">Nominal</span>
                        </div>
                        {item.sortedOutlets.map((o, j) => {
                          const oGap = o.rankBom - o.rankNominal;
                          return (
                            <button key={`${o.outletCode}-${j}`} onClick={() => setDrilldown({ outletCode: o.outletCode, itemName: item.itemName })} className="w-full flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20 hover:bg-muted/40 transition-colors text-left">
                              <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                            <span className="flex-1 truncate" title={o.outletCode}>{o.outletCode}</span>
                              <span className="w-12 text-center tabular-nums shrink-0">{o.rankNominal}</span>
                              <span className="w-12 text-center tabular-nums shrink-0">{o.rankBom}</span>
                              <span className={`w-12 text-center tabular-nums font-bold shrink-0 ${oGap > 0 ? 'text-red-600 dark:text-red-400' : oGap < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{oGap > 0 ? `+${oGap}` : oGap}</span>
                              <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
