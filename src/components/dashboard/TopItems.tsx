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

export function InvestigationWorklist({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.investigationWorklist || [];

  // Filter state
  const [filterText, setFilterText] = useState('');
  const [filterPriority, setFilterPriority] = useState<string>('all');

  // Apply filters
  const filteredItems = items.filter((w) => {
    if (filterPriority !== 'all' && w.priority !== filterPriority) return false;
    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      return (
        w.outletCode?.toLowerCase().includes(q) ||
        w.outletName?.toLowerCase().includes(q) ||
        w.itemName?.toLowerCase().includes(q) ||
        w.area?.toLowerCase().includes(q) ||
        w.issue?.toLowerCase().includes(q) ||
        w.recommendedAction?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base">Investigation Worklist</CardTitle>
            <p className="text-xs text-muted-foreground">
              {filteredItems.length} dari {items.length} item{filterText || filterPriority !== 'all' ? ' (terfilter)' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              P1: {items.filter((i) => i.priority === 'P1').length} · P2: {items.filter((i) => i.priority === 'P2').length}
            </Badge>
            <QuickSettings
              settings={[
                { key: 'HIGH_LOSS_NOMINAL_THRESHOLD', label: 'Ambang Loss Nominal', dataType: 'number', min: 1000000, max: 100000000, step: 1000000 },
                { key: 'FALLBACK_TOLERANCE_PCT', label: 'Toleransi Fallback', dataType: 'percent', min: 0, max: 1, step: 0.05 },
              ]}
            />
          </div>
        </div>
        {/* Filter bar */}
        <div className="flex items-center gap-2 mt-2">
          <Input
            placeholder="Cari outlet, item, area, issue..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="h-8 text-xs flex-1"
          />
          <Select value={filterPriority} onValueChange={setFilterPriority}>
            <SelectTrigger className="h-8 text-xs w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">Semua Prioritas</SelectItem>
              <SelectItem value="P1" className="text-xs">P1 saja</SelectItem>
              <SelectItem value="P2" className="text-xs">P2 saja</SelectItem>
              <SelectItem value="P3" className="text-xs">P3 saja</SelectItem>
            </SelectContent>
          </Select>
          {(filterText || filterPriority !== 'all') && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => { setFilterText(''); setFilterPriority('all'); }}
            >
              Bersihkan
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-96">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-12">Pri</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="min-w-[200px]">Issue</TableHead>
                <TableHead className="text-right">Nominal</TableHead>
                <TableHead className="text-right">Dev/BOM</TableHead>
                <TableHead className="min-w-[200px]">Rekomendasi Tindakan</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                  {items.length === 0 ? 'Tidak ada anomali terdeteksi' : 'Tidak ada item sesuai filter'}
                </TableCell></TableRow>
              ) : filteredItems.map((w, i) => (
                <TableRow
                  key={`${w.outletCode}-${w.itemName}-${i}`}
                  className="cursor-pointer hover:bg-muted/50"
                  {...clickableRowProps(() => setDrilldown({ outletCode: w.outletCode, itemName: w.itemName }))}
                >
                  <TableCell>
                    <Badge variant="outline" className={`text-[11px] px-1.5 py-0 ${priorityColor(w.priority)}`}>{w.priority}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="font-medium max-w-[180px] whitespace-normal" title={w.outletName}>{w.outletName}</div>
                    <div className="text-[11px] text-muted-foreground">{w.outletCode} · {w.area}</div>
                  </TableCell>
                  <TableCell className="text-xs font-medium max-w-[180px] whitespace-normal" title={w.itemName}>{w.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] whitespace-normal" title={w.issue}>{w.issue}</TableCell>
                  <TableCell className="text-right text-xs font-semibold">{fmtIDR(w.absNominalDeviasi)}</TableCell>
                  <TableCell className={`text-right text-xs ${directionColor(w.direction)}`}>{w.deviationToBom != null ? fmtPctAbs(w.deviationToBom) : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] whitespace-normal" title={w.recommendedAction}>{w.recommendedAction}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      title="Open drill-down"
                      onClick={(e) => { e.stopPropagation(); setDrilldown({ outletCode: w.outletCode, itemName: w.itemName }); }}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Button>
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
