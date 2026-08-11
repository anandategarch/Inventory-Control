'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs, directionColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  TrendingDown, Heart, Link2, MapPin,
} from 'lucide-react';

// ============================================================
//  Helpers
// ============================================================
function healthScoreColor(score: number): string {
  if (score < 30) return 'text-red-600';
  if (score < 50) return 'text-amber-600';
  if (score < 70) return 'text-yellow-600';
  return 'text-emerald-600';
}

function healthScoreBg(score: number): string {
  if (score < 30) return 'bg-red-500';
  if (score < 50) return 'bg-amber-500';
  if (score < 70) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

function lossToSalesColor(r: number | null | undefined): string {
  if (r == null) return 'text-muted-foreground';
  if (r > 0.10) return 'text-red-600';
  if (r > 0.05) return 'text-amber-600';
  return 'text-emerald-600';
}

// ============================================================
//  1.1 VarianceAnalysis
//  Perubahan period-over-period (Memburuk vs Membaik)
// ============================================================
export function VarianceAnalysis({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);

  const variance = data.varianceAnalysis || { topWorsened: [], topImproved: [] };
  const worsened = (variance.topWorsened || []).slice(0, 10);
  const improved = (variance.topImproved || []).slice(0, 10);
  const empty = worsened.length === 0 && improved.length === 0;

  const onClick = (it: any) => {
    setDrilldown({ outletCode: it.outletCode, itemName: it.itemName });
    setDeepDiveItem({ itemName: it.itemName, outletCode: it.outletCode });
  };

  const renderSection = (title: string, items: any[], color: 'red' | 'emerald') => {
    const colorCls = color === 'red' ? 'text-red-600' : 'text-emerald-600';
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className={`text-xs font-semibold ${colorCls}`}>{title}</p>
          <Badge variant="outline" className={`text-[11px] ${colorCls}`}>{items.length} item</Badge>
        </div>
        <ScrollArea className="h-48 rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[11px] h-7 px-2">NAMA BAHAN</TableHead>
                <TableHead className="text-[11px] h-7 px-2">RESTO</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Perubahan</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4">—</TableCell></TableRow>
              ) : items.map((it, i) => {
                const pct = it.previousAbsNominal !== 0
                  ? (it.delta / Math.abs(it.previousAbsNominal)) * 100
                  : 0;
                return (
                  <TableRow
                    key={`${it.itemName}-${it.outletCode}-${i}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => onClick(it)}
                  >
                    <TableCell className="text-[11px] px-2 py-1 font-medium whitespace-normal max-w-[180px]" title={it.itemName}>{it.itemName}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-muted-foreground">{it.outletCode}</TableCell>
                    <TableCell className={`text-[11px] px-2 py-1 text-right font-semibold ${colorCls}`}>{fmtIDR(it.delta)}</TableCell>
                    <TableCell className={`text-[11px] px-2 py-1 text-right ${colorCls}`}>{fmtPct(pct / 100, true, 0)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <TrendingDown className="h-4 w-4 text-red-600" />
          Analisis Perubahan
          <FormulaInfo
            formula="Perubahan = NOMINAL DEVIASI Kini − NOMINAL DEVIASI Sebelumnya"
            description={'UNTUK APA: Mengidentifikasi item dengan perubahan NOMINAL DEVIASI terbesar antar periode.\nCARA BACA: Memburuk (merah) = deviasi naik. Membaik (hijau) = deviasi turun. Hanya perubahan > Rp 1M ditampilkan.\nCONTOH: Kini Rp 50M - Sebelumnya Rp 30M = +Rp 20M (Memburuk).\nACTION: Investigasi penyebab perubahan drastis → cek perubahan resep, harga, atau volume.'}
            example="Kini 80M − Sebelumnya 50M = +30M (Memburuk)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Top item dengan perubahan deviation terbesar</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {empty ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Tidak ada perubahan signifikan vs periode sebelumnya
          </p>
        ) : (
          <>
            {renderSection('Memburuk', worsened, 'red')}
            {renderSection('Membaik', improved, 'emerald')}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  1.2 OutletHealthRanking
//  Ranking kondisi outlet dengan skor gabungan
// ============================================================
export function OutletHealthRanking({ data }: { data: AnalysisData }) {
  const setScorecardOutlet = useDashboard((s) => s.setScorecardOutlet);
  const ranking = (data.outletHealthRanking || []).slice().sort((a, b) => a.healthScore - b.healthScore);
  const worstCount = ranking.filter((o) => o.healthScore < 50).length;
  const criticalCount = ranking.filter((o) => o.healthScore < 30).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Heart className="h-4 w-4 text-rose-600" />
          Ranking Kondisi Outlet
          <FormulaInfo
            formula="Skor = 30% % DEV TO BOM + 25% RESIDUAL + 25% LOSS/PENJUALAN + 20% Jumlah Masalah"
            description={'UNTUK APA: Memberikan skor kondisi outlet 0-100 (100 = sempurna, 0 = kritis) berdasarkan komposit 4 metric.\nCARA BACA: Skor = 30% Dev/BOM + 25% Residual + 25% Loss/Sales + 20% Abnormal Count. Diurutkan dari terburuk.\nCONTOH: Dev/BOM 49% → skor 2, Residual 96% → skor 4, Loss/Sales 7% → skor 65, Abnormal 50 → skor 0. Weighted: 18.\nACTION: Outlet skor < 30 = kritis, butuh intervensi segera.'}
            example="Outlet A: devBom 18% + residual 60% + loss/sales 8% + 12 masalah → skor 35 (kritis)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Outlet terburuk {worstCount} (berdasarkan skor kondisi) · {criticalCount} kritis
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[11px] w-8 h-7 px-2">#</TableHead>
                <TableHead className="text-[11px] h-7 px-2">Outlet</TableHead>
                <TableHead className="text-[11px] h-7 px-2">Skor</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">% DEV TO BOM</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Masalah</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">|NOMINAL DEVIASI|</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranking.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">Tidak ada data</TableCell></TableRow>
              ) : ranking.map((o, i) => (
                <TableRow
                  key={o.outletCode}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setScorecardOutlet(o.outletCode)}
                >
                  <TableCell className="text-[11px] text-muted-foreground px-2 py-1">{i + 1}</TableCell>
                  <TableCell className="px-2 py-1">
                    <div className="text-[11px] font-medium leading-tight whitespace-normal max-w-[180px]" title={o.outletName}>{o.outletName}</div>
                    <div className="text-[11px] text-muted-foreground">{o.outletCode} · {o.area}</div>
                  </TableCell>
                  <TableCell className="px-2 py-1">
                    <div className="flex items-center gap-1.5 min-w-[80px]">
                      <Progress value={o.healthScore} className={`h-1.5 ${healthScoreBg(o.healthScore)}`} />
                      <span className={`text-[11px] font-semibold ${healthScoreColor(o.healthScore)}`}>{o.healthScore}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right">{fmtPctAbs(o.devBom)}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right text-red-600">{o.abnormal}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(o.absNominal)}</TableCell>
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
//  1.3 ItemConsistencyAnalysis
//  Analisis pola item (SYSTEMIC / WIDESPREAD / ISOLATED)
// ============================================================
function consistencyBadge(type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED'): string {
  switch (type) {
    case 'SYSTEMIC': return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'WIDESPREAD': return 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400';
    case 'ISOLATED': return 'text-muted-foreground bg-muted/50 border-border';
    default: return 'text-muted-foreground bg-muted/50 border-border';
  }
}

export function ItemConsistencyAnalysis({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);

  // Use unified items list from backend (outlet-count-based classification)
  // Fallback to mapping from systemic/episodic for backward compat
  const ca = data.itemConsistencyAnalysis || { systemic: [], episodic: [], items: [] };
  const rows: Array<{
    itemName: string;
    outletCount: number;
    lossOutlets: number;
    surplusOutlets: number;
    absNominal: number;
    avgDevBom: number;
    type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
  }> = (ca.items && ca.items.length > 0)
    ? ca.items.map((i) => ({
        itemName: i.itemName,
        outletCount: i.outletCount,
        lossOutlets: i.lossOutlets,
        surplusOutlets: i.surplusOutlets,
        absNominal: i.totalAbsNominal,
        avgDevBom: i.avgDevBom,
        type: i.consistency,
      }))
    : [
        ...(ca.systemic || []).map((s) => ({
          itemName: s.itemName,
          outletCount: s.occurrences,
          lossOutlets: 0,
          surplusOutlets: 0,
          absNominal: s.absNominal,
          avgDevBom: s.avgDevBom,
          type: (s.occurrences >= 10 ? 'SYSTEMIC' : 'WIDESPREAD') as 'SYSTEMIC' | 'WIDESPREAD',
        })),
        ...(ca.episodic || []).map((s) => ({
          itemName: s.itemName,
          outletCount: 1,
          lossOutlets: 0,
          surplusOutlets: 0,
          absNominal: s.absNominal,
          avgDevBom: s.devBom,
          type: 'ISOLATED' as 'ISOLATED',
        })),
      ].sort((a, b) => b.absNominal - a.absNominal);

  const systemicCount = rows.filter((r) => r.type === 'SYSTEMIC').length;
  const widespreadCount = rows.filter((r) => r.type === 'WIDESPREAD').length;
  const isolatedCount = rows.filter((r) => r.type === 'ISOLATED').length;

  const onClick = (row: typeof rows[number]) => {
    setDrilldown({ outletCode: null, itemName: row.itemName });
    setDeepDiveItem({ itemName: row.itemName, outletCode: null });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Link2 className="h-4 w-4 text-indigo-600" />
          Analisis Pola Item
          <FormulaInfo
            formula="Outlets = COUNT(DISTINCT outlet) per item dengan deviasi"
            description={'UNTUK APA: Mengidentifikasi item yang menyimpang di multiple outlet (pola sistemik).\nCARA BACA: SYSTEMIC (≥10 outlet) = masalah produk/QTY BOM. WIDESPREAD (5-9) = pola regional. ISOLATED (2-4) = anomali lokal.\nCONTOH: UDANG KEJU FROZEN deviasi di 15 outlet = SYSTEMIC → cek QTY BOM atau harga beli.\nACTION: SYSTEMIC → revisi master data QTY BOM. WIDESPREAD → evaluasi pelatihan area. ISOLATED → investigasi outlet spesifik.'}
            example="UDANG KEJU FROZEN deviasi di 15 outlet = SYSTEMIC"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {systemicCount} systemic · {widespreadCount} widespread · {isolatedCount} isolated
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[11px] h-7 px-2">NAMA BAHAN</TableHead>
                <TableHead className="text-[11px] h-7 px-2">Type</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Outlets</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">LOSS</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">SURPLUS</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Rata-rata % DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-6">Tidak ada data</TableCell></TableRow>
              ) : rows.map((row, i) => (
                <TableRow
                  key={`${row.itemName}-${i}`}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => onClick(row)}
                >
                  <TableCell className="text-[11px] px-2 py-1 font-medium whitespace-normal max-w-[200px]" title={row.itemName}>{row.itemName}</TableCell>
                  <TableCell className="px-2 py-1">
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${consistencyBadge(row.type)}`}>{row.type}</Badge>
                  </TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{row.outletCount}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right text-red-600">{row.lossOutlets}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right text-emerald-600">{row.surplusOutlets}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(row.absNominal)}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right">{fmtPctAbs(row.avgDevBom)}</TableCell>
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
//  1.4 AreaComparison
//  Perbandingan antar area
// ============================================================
export function AreaComparison({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  const areas = (data.areaAnalysis || [])
    .slice()
    .sort((a, b) => b.totalAbsNominal - a.totalAbsNominal);
  const maxAbs = areas.length > 0 ? areas[0].totalAbsNominal : 1;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <MapPin className="h-4 w-4 text-orange-600" />
          Perbandingan Area
          <FormulaInfo
            formula="LOSS/PENJUALAN = Total LOSS / Total PENJUALAN per area"
            description={'UNTUK APA: Membandingkan performa deviasi antar area untuk intervensi tertarget.\nCARA BACA: Area dengan LOSS/PENJUALAN tinggi = paling boros. Klik baris untuk filter dashboard by area.\nCONTOH: JAWA BARAT 1: LOSS Rp 2M / PENJUALAN Rp 20M = 10% (buruk).\nACTION: Area terburuk → evaluasi proses area & bandingkan dengan area terbaik.'}
            example="JAKBAR: LOSS 8M / Sales 80M = 10% (kritis)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {areas.length} area · diurutkan dari NOMINAL DEVIASI terbesar
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[11px] h-7 px-2">Area</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Outlets</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">PENJUALAN</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">LOSS/PENJUALAN</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">% DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {areas.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">Tidak ada data</TableCell></TableRow>
              ) : areas.map((a, i) => {
                const marker = i === 0 ? '🔴' : i === areas.length - 1 ? '🟢' : '';
                return (
                  <TableRow
                    key={a.area}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setArea(a.area)}
                  >
                    <TableCell className="text-[11px] px-2 py-1 font-medium">
                      <span className="mr-1">{marker}</span>{a.area}
                    </TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right text-muted-foreground">{a.outletCount}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right">{fmtIDR(a.totalSales)}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(a.totalAbsNominal)}</TableCell>
                    <TableCell className={`text-[11px] px-2 py-1 text-right font-semibold ${lossToSalesColor(a.lossToSales)}`}>{fmtPct(a.lossToSales, false)}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right">{fmtPctAbs(a.avgDevBom)}</TableCell>
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
