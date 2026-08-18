'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor, priorityColor } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { clickableRowProps } from '@/lib/a11y';

export function TopItemsByNominal({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.topItemsByNominal || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
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
        <p className="text-xs text-muted-foreground">Financial impact ranking (absolute)</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Nominal</TableHead>
                <TableHead className="text-center">Dir</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow
                  key={`${it.itemName}-${it.outletCode}`}
                  className="cursor-pointer hover:bg-muted/50"
                  {...clickableRowProps(() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName }))}
                >
                  <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[180px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className="text-right font-semibold text-xs">{fmtIDR(it.absNominal)}</TableCell>
                  <TableCell className={`text-center text-xs font-semibold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
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
        <p className="text-xs text-muted-foreground">Operational abnormality ranking</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Dev/BOM</TableHead>
                <TableHead className="text-right">Tol.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => {
                const breach = it.tolerance != null && Math.abs(it.devBom) > Math.abs(it.tolerance);
                return (
                  <TableRow
                    key={`${it.itemName}-${it.outletCode}`}
                    className="cursor-pointer hover:bg-muted/50"
                    {...clickableRowProps(() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName }))}
                  >
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs max-w-[180px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                    <TableCell className={`text-right font-semibold text-xs ${breach ? 'text-red-600' : ''}`}>{fmtPctAbs(it.devBom)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{it.tolerance != null ? fmtPctAbs(it.tolerance) : '—'}</TableCell>
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
  const setOutlet = useDashboard((s) => s.setOutlet);
  const items = data.topOutlets || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
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
        <p className="text-xs text-muted-foreground">By absolute nominal deviation</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Area</TableHead>
                <TableHead className="text-right">Nominal</TableHead>
                <TableHead className="text-right">Dev/BOM</TableHead>
                <TableHead className="text-right">Area Avg</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs py-6">Tidak ada data</TableCell></TableRow>
              ) : items.map((o, i) => {
                const aboveArea = o.areaAvg > 0 && o.devBom > o.areaAvg * 1.5;
                return (
                  <TableRow
                    key={o.outletCode}
                    className="cursor-pointer hover:bg-muted/50"
                    {...clickableRowProps(() => { setOutlet(o.outletCode); setDrilldown({ outletCode: o.outletCode, itemName: null }); })}
                  >
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs max-w-[180px] whitespace-normal" title={`${o.outletName} (${o.outletCode})`}>{o.outletName}<div className="text-[11px] text-muted-foreground">{o.outletCode}</div></TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={o.area}>{o.area}</TableCell>
                    <TableCell className="text-right font-semibold text-xs">{fmtIDR(o.absNominal)}</TableCell>
                    <TableCell className={`text-right text-xs font-semibold ${aboveArea ? 'text-red-600' : ''}`}>{fmtPctAbs(o.devBom)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{fmtPctAbs(o.areaAvg)}</TableCell>
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

// ============================================================
//  Top Deviasi Rank — National item ranking (Section 13)
//  Per (item, resto) with dual ranking + all deviasi metrics
// ============================================================
export function TopDeviasiRank({ data }: { data: AnalysisData }) {
  const items = data.topDeviasiRank || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          Ranking Item Nasional (Deviasi)
          <FormulaInfo
            formula="Rank Nasional = sort by |Nominal Deviasi| DESC. Rank BOM = sort by |Qty BOM| DESC."
            description="Ranking item per resto. Semua nilai signed (negatif = SURPLUS, hijau). %LS to BOM = Qty Loss/Surplus / Qty BOM. AVG Deviasi By BOM = rata-rata |% Deviasi To BOM| item di semua resto."
            example="Rank 1 = |Nominal Deviasi| terbesar di seluruh jaringan"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Top 20 item per resto — ranking nasional</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-96">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 text-center">Rank Nas</TableHead>
                <TableHead className="w-8 text-center">Rank BOM</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Resto</TableHead>
                <TableHead>PIC</TableHead>
                <TableHead className="text-right">QTY Deviasi</TableHead>
                <TableHead className="text-right">QTY Waste</TableHead>
                <TableHead className="text-right">QTY LS</TableHead>
                <TableHead className="text-right">%LS to BOM</TableHead>
                <TableHead className="text-right">QTY BOM</TableHead>
                <TableHead className="text-right">AVG Dev By BOM</TableHead>
                <TableHead className="text-right">Nominal Deviasi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground text-xs py-6">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow key={`${it.itemName}-${it.outletCode}-${i}`}>
                  <TableCell className="text-center text-xs font-bold">{it.rankNominal}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground">{it.rankBom}</TableCell>
                  <TableCell className="font-medium text-xs max-w-[150px] whitespace-normal" title={it.itemName}>{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={it.outletCode}>{it.outletCode}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.pic || '—'}</TableCell>
                  <TableCell className={`text-right text-xs ${it.qtyDeviasi < 0 ? 'text-emerald-600' : ''}`}>{fmtNum(it.qtyDeviasi)}</TableCell>
                  <TableCell className={`text-right text-xs ${it.qtyWaste < 0 ? 'text-emerald-600' : ''}`}>{fmtNum(it.qtyWaste)}</TableCell>
                  <TableCell className={`text-right text-xs ${it.qtyLossSurplus < 0 ? 'text-emerald-600' : ''}`}>{fmtNum(it.qtyLossSurplus)}</TableCell>
                  <TableCell className={`text-right text-xs ${it.pctLossSurplusToBom != null && it.pctLossSurplusToBom < 0 ? 'text-emerald-600' : ''}`}>
                    {it.pctLossSurplusToBom != null ? fmtPctAbs(it.pctLossSurplusToBom) : '—'}
                  </TableCell>
                  <TableCell className={`text-right text-xs ${it.qtyBom < 0 ? 'text-emerald-600' : ''}`}>{fmtNum(it.qtyBom)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {it.avgDeviasiByBom != null ? fmtPctAbs(it.avgDeviasiByBom) : '—'}
                  </TableCell>
                  <TableCell className={`text-right font-semibold text-xs ${it.nominalDeviasi < 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {fmtIDR(it.nominalDeviasi)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
