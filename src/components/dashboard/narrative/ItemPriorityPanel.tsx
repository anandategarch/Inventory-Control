'use client';

// ============================================================
//  ItemPriorityPanel — L3 right column, compact (VH-3, D5-b/D6)
//  --------------------------------------------------------
//  Replaces the two FULL TopItems cards (ByNominal + ByDevBom)
//  in the narrative layer with ONE compact panel:
//    - 2-state toggle "Nominal | Dev/BOM" (D5-b — default
//      Nominal = financial impact), same Tabs pattern as
//      TopGrowthCard's "Per Resto / Per Barang" toggle
//    - top-3 default (+ expand to 10); D6 adaptive: 5 when the
//      top-3 cumulative |nominal| share of total deviation is
//      < 50% (Nominal variant only — the Dev/BOM list carries
//      no nominal magnitude to measure a share against)
//    - row anatomy: rank, item name + outlet meta, main number
//      colored by data, proportional mini-bar, click →
//      setDrilldown (the SAME interaction the full cards use —
//      opens DrillDownDrawer / ItemDeepDive)
//    - footer "lihat semua →" jumps to the Item tab
//
//  Data: the SAME payload lists the full cards render
//  (data.topItemsByNominal / data.topItemsByDevBom) — the full
//  versions live on untouched in tabs/ItemTab.tsx. No new
//  fetch, no query changes.
// ============================================================

import { memo, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BarChart3, ChevronDown, ChevronRight } from 'lucide-react';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { AnalysisData } from '@/hooks/useAnalysis';

type Variant = 'nominal' | 'devbom';

/** Compact panel shows 3 by default, at most 10 when expanded (progressive disclosure). */
const COMPACT_MAX = 10;

const TOOLTIP_TEXT =
  'Nominal: ranking berdasarkan |NOMINAL DEVIASI| (dampak finansial). Dev/BOM: |QTY Deviasi| / |QTY BOM| (abnormalitas ternormalisasi terhadap volume — merah saat melewati toleransi). Klik baris untuk drill-down; versi lengkap ada di tab Item.';

/** Normalized display row (variant-agnostic) — keeps the two payload list
 *  types out of the render path and the mini-bar scale simple. */
interface CompactRow {
  key: string;
  itemName: string;
  outletCode: string;
  magnitude: number;
  valueLabel: string;
  valueCls: string;
  barCls: string;
}

export const ItemPriorityPanel = memo(function ItemPriorityPanel({ data }: { data: AnalysisData }) {
  const { setDrilldown, setActiveTab } = useDashboard(useShallow((s) => ({
    setDrilldown: s.setDrilldown,
    setActiveTab: s.setActiveTab,
  })));

  // D5-b: 2-state toggle — default Nominal (financial impact).
  const [variant, setVariant] = useState<Variant>('nominal');
  const [expanded, setExpanded] = useState(false);

  // P3-HYG-7a: pin list identities so the memos below are stable.
  const nominalItems = useMemo(() => data.topItemsByNominal || [], [data.topItemsByNominal]);
  const devBomItems = useMemo(() => data.topItemsByDevBom || [], [data.topItemsByDevBom]);

  // D6 adaptive default — same rule as the resto panel: top-3 cumulative
  // |nominal| share of total deviation (< 50% → 5). Applies to the Nominal
  // variant only (see header comment). Falls back to 3 without costImpact.
  const totalDev = data.costImpact?.totalCost ?? null;
  const defaultCount = useMemo(() => {
    if (variant !== 'nominal' || nominalItems.length <= 3) return 3;
    if (totalDev != null && totalDev > 0) {
      const top3 = nominalItems.slice(0, 3).reduce((sum, it) => sum + Math.abs(it.nominalDeviasi), 0);
      if (top3 / totalDev < 0.5) return 5;
    }
    return 3;
  }, [variant, nominalItems, totalDev]);

  const limit = expanded ? COMPACT_MAX : defaultCount;

  // Display rows + mini-bar scale (relative to the largest |value| shown).
  const { shown, maxValue } = useMemo(() => {
    const list: CompactRow[] = variant === 'nominal'
      ? nominalItems.slice(0, limit).map((it) => ({
          key: `${it.itemName}-${it.outletCode}`,
          itemName: it.itemName,
          outletCode: it.outletCode,
          magnitude: Math.abs(it.nominalDeviasi),
          valueLabel: fmtIDR(it.nominalDeviasi),
          valueCls: it.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
          barCls: it.nominalDeviasi < 0 ? 'bg-red-500' : 'bg-emerald-500',
        }))
      : devBomItems.slice(0, limit).map((it) => {
          const breach = it.tolerance != null && Math.abs(it.devBom) > Math.abs(it.tolerance);
          return {
            key: `${it.itemName}-${it.outletCode}`,
            itemName: it.itemName,
            outletCode: it.outletCode,
            magnitude: Math.abs(it.devBom),
            valueLabel: fmtPctAbs(it.devBom),
            valueCls: breach ? 'text-red-600 dark:text-red-400' : 'text-foreground',
            barCls: breach ? 'bg-red-500' : 'bg-zinc-400',
          };
        });
    const max = Math.max(...list.map((r) => r.magnitude), 0);
    return { shown: list, maxValue: max };
  }, [variant, nominalItems, devBomItems, limit]);

  const handleVariantChange = (v: string) => setVariant(v === 'devbom' ? 'devbom' : 'nominal');
  const totalCount = variant === 'nominal' ? nominalItems.length : devBomItems.length;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <BarChart3 className="h-3.5 w-3.5" />
          </span>
          Item Prioritas
          <InfoTooltip content={TOOLTIP_TEXT} />
        </CardTitle>
        {/* D5-b toggle — same Tabs pattern as TopGrowthCard's grain toggle */}
        <div className="ml-9">
          <Tabs value={variant} onValueChange={handleVariantChange}>
            <TabsList className="grid h-8 w-full grid-cols-2">
              <TabsTrigger value="nominal" className="text-xs">Nominal</TabsTrigger>
              <TabsTrigger value="devbom" className="text-xs">Dev/BOM</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Tidak ada item dengan deviasi pada periode ini.
          </p>
        ) : shown.map((it, i) => (
          <div
            key={it.key}
            className="min-h-11 rounded-lg border bg-card p-3 cursor-pointer transition-colors hover:bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            {...clickableRowProps(() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName }))}
          >
            <div className="flex items-center gap-3">
              {/* Rank badge — round; #1 inverted (matches the resto panel) */}
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 tabular-nums ${
                i === 0 ? 'bg-foreground text-background' : 'border bg-muted/50 text-muted-foreground'
              }`}>
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight truncate" title={it.itemName}>{it.itemName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground truncate">{it.outletCode}</p>
              </div>
              {/* Main number — Nominal: signed Rp (loss red / surplus emerald);
                  Dev/BOM: ratio, red when breaching tolerance (same rule as
                  the full table). */}
              <span className={`shrink-0 text-sm font-bold tabular-nums ${it.valueCls}`}>
                {it.valueLabel}
              </span>
            </div>
            {/* Proportional mini-bar — |value| relative to the top row */}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className={`h-full ${it.barCls}`} style={{ width: `${maxValue > 0 ? Math.min(100, (it.magnitude / maxValue) * 100) : 0}%` }} />
            </div>
          </div>
        ))}

        {/* Expand / collapse — only when more rows exist beyond the current limit */}
        {totalCount > shown.length && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-expanded={false}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Tampilkan {Math.min(COMPACT_MAX, totalCount) - shown.length} lagi
          </button>
        )}
        {expanded && totalCount > defaultCount && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-expanded
          >
            <ChevronRight className="h-3.5 w-3.5" />
            Tampilkan lebih sedikit
          </button>
        )}

        {/* Footer — jump to the Item tab (full TopItems + trend + patterns) */}
        <div className="flex items-center justify-between border-t pt-2.5">
          <p className="text-xs text-muted-foreground tabular-nums">
            Top {shown.length} item — {variant === 'nominal' ? 'dampak finansial' : 'abnormalitas ternormalisasi'}
          </p>
          <button
            type="button"
            onClick={() => setActiveTab('item')}
            className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline"
          >
            lihat semua
            <span aria-hidden>→</span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
});
