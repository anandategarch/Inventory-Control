'use client';

// ============================================================
//  RankingNasionalCard — Top 30 Deviasi Items for selected outlet
//  Shows after resto is selected. No filters — fixed Top 30.
//  Data source: /api/outlet-items → topDeviasiRank (per-outlet query
//  with national rank + peer benchmark).
//  (split from RestoAnalysis.tsx — Phase 3)
//
//  Phase 1 — Navigation Bridge:
//    Each table row is clickable. Clicking sets `trendSelectedItem`
//    in the Zustand store + switches to the Item tab (VH-2: the trend
//    view merged into it), so the user can immediately see the
//    per-period trend for that item.
//    Hover hint shown at the top of the card body.
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target, TrendingUp } from 'lucide-react';
import { fmtIDR, fmtNum } from './helpers';
import { fmtDecimal, numberColorNeg } from '@/lib/format';
import type { AnalysisData, DeviasiRankItem } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { SparkLine } from '@/components/dashboard/shared/SparkLine';
import { clickableRowProps } from '@/lib/a11y';

export const RankingNasionalCard = memo(function RankingNasionalCard({
  focusOutlet,
  analysisData,
  outletDeviasiRank,
}: {
  focusOutlet: string;
  analysisData?: AnalysisData;
  outletDeviasiRank?: DeviasiRankItem[];
}) {
  // Phase 1 — Navigation Bridge: row click sets the item tab's
  // `selectedItem` (via the shared Zustand store) + switches to
  // the Item tab (VH-2: the trend view merged into it). The trend
  // section reads `trendSelectedItem` as its selected item
  // (replacing local useState), so this transparently pre-selects
  // the item without any prop drilling.
  const { setTrendSelectedItem, setActiveTab } = useDashboard(useShallow((s) => ({
    setTrendSelectedItem: s.setTrendSelectedItem,
    setActiveTab: s.setActiveTab,
  })));

  const handleRowClick = (itemName: string) => {
    setTrendSelectedItem(itemName);
    setActiveTab('item');
  };

  // Primary source: per-outlet top 30 (from /api/outlet-items — fired when
  // resto is selected). Falls back to analysisData.topDeviasiRank (national
  // top-50) if outlet-items hasn't loaded yet.
  // P3-HYG-7c: memoized — the filter+slice ran inline on every render
  // (each hover/parent re-render repaid the cost over the national top-50).
  const items: DeviasiRankItem[] = useMemo(() => (
    outletDeviasiRank && outletDeviasiRank.length > 0
      ? outletDeviasiRank
      : (analysisData?.topDeviasiRank || []).filter((it) => it.outletCode === focusOutlet).slice(0, 30)
  ), [outletDeviasiRank, analysisData, focusOutlet]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Ranking Item Nasional (Deviasi)
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Top 30 item deviasi untuk <span className="font-medium text-foreground">{focusOutlet}</span>.
          {/* P23 B7: VALUE columns are now minus-red only (PDF negColor parity) —
              only the Trend mini-chart keeps loss/surplus hue; caption updated. */}
          Negatif (merah) = rugi. Warna mini-chart Trend mengikuti arah deviasi (merah rugi, hijau surplus).
          AVG Dev By BOM = rata-rata |QTY Deviasi| item yang sama di resto lain dengan BOM ±50%.
        </p>
        <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
          <Badge variant="secondary" className="text-xs tabular-nums font-medium">{items.length} item</Badge>
          {/* Phase 1 — Navigation Bridge hint */}
          <Badge
            variant="outline"
            className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5 gap-1"
          >
            <TrendingUp className="h-3 w-3" />
            {/* FIX (BUG-HUNT C5/B2-09): the standalone "Trend Item" tab no longer
                exists (merged into the Item tab in VH-2) — stale copy. */}
            Klik baris untuk lihat trend item di tab Item
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-auto">
          <Table className="min-w-[1200px]">
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 text-center text-xs font-semibold uppercase tracking-wider h-8">Rank Nas</TableHead>
                <TableHead className="w-8 text-center text-xs font-semibold uppercase tracking-wider h-8">Rank BOM</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Item</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Resto</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Deviasi</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Waste</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY LS</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">%LS to BOM</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">AVG Dev By BOM</TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
                {/* TREMOR Pattern 5 — SparkLine: 3-point mini chart visualizing
                    the item's deviation from BOM benchmark. Line goes from 0 →
                    avgDeviasiByBom (peer baseline) → |qtyDeviasi| (this item).
                    Red when qtyDeviasi<0 (loss), emerald when qtyDeviasi>=0. */}
                <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8 w-20">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={13} className="text-center text-muted-foreground text-xs py-8">Tidak ada data deviasi untuk outlet ini pada periode terpilih</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow
                  key={`${it.itemName}-${it.outletCode}-${i}`}
                  className={`hover:bg-amber-50/60 dark:hover:bg-amber-950/20 hover:cursor-pointer transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                  title={`Klik untuk lihat trend ${it.itemName} di tab Item`}
                  {...clickableRowProps(() => handleRowClick(it.itemName))}
                >
                  <TableCell className="text-center text-xs font-bold tabular-nums">{it.rankNominal}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground tabular-nums">{it.rankBom != null && it.rankBom > 0 ? it.rankBom : '—'}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[150px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.pic || '—'}</TableCell>
                  {/* P23 B7: signed VALUE column — numberColorNeg (minus-red only, PDF negColor). */}
                  <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(it.qtyDeviasi)}`}>{fmtNum(it.qtyDeviasi)}</TableCell>
                  {/* FIX (BUG-HUNT B11/B2-06): QTY Waste / QTY BOM are non-negative volume
                      columns — the LOSS/SURPLUS sign coloring was a copy-paste from the
                      Deviasi column and painted waste counts emerald ("membaik") even when
                      large. Neutral muted now; sign coloring stays on Deviasi/LS/%LS/Nominal. */}
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(it.qtyWaste)}</TableCell>
                  {/* P23 B7: signed VALUE column — numberColorNeg (minus-red only). */}
                  <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(it.qtyLossSurplus)}`}>{fmtNum(it.qtyLossSurplus)}</TableCell>
                  {/* pctLossSurplusToBom is always ≥0 (SQL uses ABS). Color by
                      nominalDeviasi sign (signed) — P23 B7: numberColorNeg (minus-red only). */}
                  <TableCell className={`text-right text-xs tabular-nums ${numberColorNeg(it.nominalDeviasi)}`}>
                    {it.pctLossSurplusToBom != null ? `${fmtDecimal(Math.abs(it.pctLossSurplusToBom * 100), 2)}%` : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(it.qtyBom)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {it.avgDeviasiByBom != null ? fmtNum(it.avgDeviasiByBom) : '—'}
                  </TableCell>
                  {/* P23 B7: signed VALUE column — numberColorNeg (minus-red only). */}
                  <TableCell className={`text-right font-semibold text-xs tabular-nums ${numberColorNeg(it.nominalDeviasi)}`}>
                    {fmtIDR(it.nominalDeviasi)}
                  </TableCell>
                  {/* TREMOR Pattern 5 — SparkLine cell. Renders a 3-point
                      mini chart [0, avgDeviasiByBom, |qtyDeviasi|] so users
                      can see at a glance how the item compares to the peer
                      benchmark. Red for losses (qtyDeviasi<0), emerald for
                      surpluses. Falls back to "—" when there's no peer
                      baseline (avgDeviasiByBom is null). */}
                  <TableCell className="text-center py-1.5">
                    {it.avgDeviasiByBom != null ? (
                      /* P23 B7: hardcoded hex #dc2626/#10b981 bypassed the var(--chart-*)
                         token family (no dark-mode adaptation) — now the adaptive
                         --chart-loss/--chart-surplus tokens with raw-hex fallback,
                         mirroring ItemDeepDive's var(--chart-*, #hex) pattern. */
                      <SparkLine
                        data={[0, it.avgDeviasiByBom, Math.abs(it.qtyDeviasi)]}
                        width={60}
                        height={20}
                        color={it.qtyDeviasi < 0 ? 'var(--chart-loss, #dc2626)' : 'var(--chart-surplus, #10b981)'}
                        showDot
                      />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
});
