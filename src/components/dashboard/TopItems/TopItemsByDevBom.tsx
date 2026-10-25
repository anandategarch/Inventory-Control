'use client';

// ============================================================
//  TopItemsByDevBom — "Top 10 by Deviation/BOM" card
//  --------------------------------------------------------
//  GODSPLIT-W2-B: moved VERBATIM from dashboard/TopItems.tsx
//  (grab-bag 4-kartu split → TopItems/ folder; see index.tsx).
//  Consumer: tabs/ItemTab.tsx.
// ============================================================
import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtPctAbs } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { Percent } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';

export const TopItemsByDevBom = memo(function TopItemsByDevBom({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  // ITEM-HL-B (user request): resto yang sedang dipilih (picker "Filter
  // Resto" di tab Resto → focusOutlet; juga cross-tab link dari tabel
  // peer/Top Growth) di-highlight pada baris tabel ini. Sebelumnya,
  // pasca-FILTERDROP-1 tab Item tidak menerima info resto manapun —
  // tidak ada cara melihat "item prio milik resto yang kuanal" di sini.
  const focusOutlet = useDashboard((s) => s.focusOutlet);
  const items = data.topItemsByDevBom || [];
  const hasFocusedRow = focusOutlet != null && items.some((it) => it.outletCode === focusOutlet);
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
        <p className="text-xs text-muted-foreground ml-9">
          Operational abnormality ranking
          {/* ITEM-HL-B: legend saat ada baris resto terpilih — tanpa ini
              asal warna amber tidak jelas bagi user baru. */}
          {hasFocusedRow && (
            <>
              {' · '}
              <span className="text-amber-700 dark:text-amber-400 font-medium" title="Resto terpilih di tab Resto (focusOutlet)">
                {focusOutlet} ter-highlight
              </span>
            </>
          )}
        </p>
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
                // ITEM-HL-B: highlight resto terpilih — prioritas DI ATAS zebra
                // + breach TINT (sinyal breach tetap hidup di sel Dev/BOM yang
                // tetap merah + tooltip sel). Bahasa visual sama dengan baris
                // target PeerTableRow (bg-amber + border-l-4 amber) agar
                // konsisten lintas kartu.
                const focused = focusOutlet != null && it.outletCode === focusOutlet;
                return (
                  <TableRow
                    key={`${it.itemName}-${it.outletCode}`}
                    title={focused ? `Resto terpilih: ${it.outletCode} (dari tab Resto)` : undefined}
                    className={`cursor-pointer transition-colors ${
                      focused
                        ? 'bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-950/30 border-l-4 border-l-amber-500'
                        : `hover:bg-muted/40 ${i % 2 === 1 ? 'bg-muted/20' : ''} ${breach ? 'bg-red-50/40 dark:bg-red-950/10' : ''}`
                    }`}
                    {...clickableRowProps(() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName }))}
                  >
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                    {/* ITEM-HL-B: sel Outlet ikut menonjol saat barisnya ter-highlight. */}
                    <TableCell className={`text-xs ${focused ? 'text-foreground font-medium' : 'text-muted-foreground'}`} title={it.outletCode}>{it.outletCode}</TableCell>
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
