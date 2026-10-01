'use client';

// ============================================================
//  TopItemsByNominal — "Top 10 by Nominal Deviasi" card
//  --------------------------------------------------------
//  GODSPLIT-W2-B: moved VERBATIM from dashboard/TopItems.tsx
//  (grab-bag 4-kartu split → TopItems/ folder; see index.tsx).
//  Consumer: tabs/ItemTab.tsx.
// ============================================================
import { memo, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtIDR } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { Coins } from 'lucide-react';
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
