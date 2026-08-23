'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { ExternalLink, Coins, Percent, Store } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';

export function TopItemsByNominal({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.topItemsByNominal || [];
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
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
        <ScrollArea className="h-72">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="w-8 h-8 text-xs font-semibold uppercase tracking-wider">#</TableHead>
                <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Item</TableHead>
                <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Outlet</TableHead>
                <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Nominal</TableHead>
                <TableHead className="text-center h-8 text-xs font-semibold uppercase tracking-wider w-12">Dir</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-8">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow
                  key={`${it.itemName}-${it.outletCode}`}
                  className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                  {...clickableRowProps(() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName }))}
                >
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[180px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className={`text-right font-semibold text-xs tabular-nums ${it.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtIDR(it.nominalDeviasi)}</TableCell>
                  <TableCell className={`text-center text-xs font-bold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export function TopItemsByDevBom({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.topItemsByDevBom || [];
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
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
                    <TableCell className="font-medium text-xs max-w-[180px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
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
}

export function TopOutlets({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setFocusOutlet = useDashboard((s) => s.setFocusOutlet);
  const items = data.topOutlets || [];
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
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
                    <TableCell className="font-medium text-xs max-w-[180px] whitespace-normal" title={`${o.outletName} (${o.outletCode})`}>{o.outletName}<div className="text-[11px] text-muted-foreground">{o.outletCode}</div></TableCell>
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
}
