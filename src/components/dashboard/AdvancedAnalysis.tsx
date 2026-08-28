'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  Heart, Link2, MapPin,
} from 'lucide-react';

// ============================================================
//  Helpers
// ============================================================
function healthScoreColor(score: number): string {
  if (score < 30) return 'text-red-600 dark:text-red-400';
  if (score < 50) return 'text-amber-600 dark:text-amber-400';
  if (score < 70) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function healthScoreBg(score: number): string {
  if (score < 30) return 'bg-red-500';
  if (score < 50) return 'bg-amber-500';
  if (score < 70) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

function lossToSalesColor(r: number | null | undefined): string {
  if (r == null) return 'text-muted-foreground';
  if (r > 0.10) return 'text-red-600 dark:text-red-400';
  if (r > 0.05) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

// ============================================================
//  1.2 OutletHealthRanking
//  Ranking kondisi outlet dengan skor gabungan
// ============================================================
export function OutletHealthRanking({ data }: { data: AnalysisData }) {
  const setFocusOutlet = useDashboard((s) => s.setFocusOutlet);
  const ranking = (data.outletHealthRanking || []).slice().sort((a, b) => a.healthScore - b.healthScore);
  const worstCount = ranking.filter((o) => o.healthScore < 50).length;
  const criticalCount = ranking.filter((o) => o.healthScore < 30).length;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Heart className="h-3.5 w-3.5" />
          </span>
          Ranking Kondisi Outlet
          <FormulaInfo
            formula="Skor = 30% % DEV TO BOM + 25% RESIDUAL + 25% LOSS/PENJUALAN + 20% Jumlah Masalah"
            description={'UNTUK APA: Memberikan skor kondisi outlet 0-100 (100 = sempurna, 0 = kritis) berdasarkan komposit 4 metric.\nCARA BACA: Skor = 30% Dev/BOM + 25% Residual + 25% Loss/Sales + 20% Abnormal Count. Diurutkan dari terburuk.\nCONTOH: Dev/BOM 49% → skor 2, Residual 96% → skor 4, Loss/Sales 7% → skor 65, Abnormal 50 → skor 0. Weighted: 18.\nACTION: Outlet skor < 30 = kritis, butuh intervensi segera.'}
            example="Outlet A: devBom 18% + residual 60% + loss/sales 8% + 12 masalah → skor 35 (kritis)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'HEALTH_WEIGHT_DEV_BOM', label: 'Bobot Dev/BOM (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
              { key: 'HEALTH_WEIGHT_RESIDUAL', label: 'Bobot Residual (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
              { key: 'HEALTH_WEIGHT_LOSS_TO_SALES', label: 'Bobot Loss/Sales (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
              { key: 'HEALTH_WEIGHT_ABNORMAL', label: 'Bobot Abnormal (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium tabular-nums">{worstCount}</span> outlet terburuk · <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">{criticalCount} kritis</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider w-8 h-10 px-3">#</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Outlet</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Skor</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">% DEV TO BOM</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Masalah</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">NOMINAL DEVIASI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranking.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-8">Tidak ada data</TableCell></TableRow>
              ) : ranking.map((o, i) => (
                <TableRow
                  key={o.outletCode}
                  className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''} ${o.healthScore < 30 ? 'bg-red-50/30 dark:bg-red-950/10' : ''}`}
                  {...clickableRowProps(() => setFocusOutlet(o.outletCode))}
                >
                  <TableCell className="text-[11px] text-muted-foreground px-3 py-2 tabular-nums">{i + 1}</TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="text-[11px] font-medium leading-tight whitespace-normal max-w-[180px]" title={o.outletName}>{o.outletName}</div>
                    <div className="text-[11px] text-muted-foreground">{o.outletCode} · {o.area}</div>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex items-center gap-1.5 min-w-[80px]">
                      <Progress value={o.healthScore} className="h-1.5" indicatorClassName={healthScoreBg(o.healthScore)} />
                      <span className={`text-[11px] font-semibold tabular-nums ${healthScoreColor(o.healthScore)}`}>{o.healthScore}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtPctAbs(o.devBom)}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right text-red-600 dark:text-red-400 font-medium tabular-nums">{o.abnormal}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right font-semibold tabular-nums">
                    {/* FIX: display SIGNED nominalDeviasi (negative=LOSS=red, positive=SURPLUS=green) */}
                    {/* FIX (AUDIT-CALC-FRONTEND P1-3): was fallback to o.absNominal (always ≥0) when
                        nominalDeviasi is null → worst-ranking outlets colored green. Now show '—' if null. */}
                    <span className={o.nominalDeviasi != null
                      ? (o.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')
                      : 'text-muted-foreground'}>
                      {o.nominalDeviasi != null ? fmtIDR(o.nominalDeviasi) : '—'}
                    </span>
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
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Link2 className="h-3.5 w-3.5" />
          </span>
          Analisis Pola Item
          <FormulaInfo
            formula="Outlets = COUNT(DISTINCT outlet) per item dengan deviasi"
            description={'UNTUK APA: Mengidentifikasi item yang menyimpang di multiple outlet (pola sistemik).\nCARA BACA: SYSTEMIC (≥10 outlet) = masalah produk/QTY BOM. WIDESPREAD (5-9) = pola regional. ISOLATED (2-4) = anomali lokal.\nCONTOH: UDANG KEJU FROZEN deviasi di 15 outlet = SYSTEMIC → cek QTY BOM atau harga beli.\nACTION: SYSTEMIC → revisi master data QTY BOM. WIDESPREAD → evaluasi pelatihan area. ISOLATED → investigasi outlet spesifik.'}
            example="UDANG KEJU FROZEN deviasi di 15 outlet = SYSTEMIC"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium text-red-600 dark:text-red-400 tabular-nums">{systemicCount} systemic</span> · <span className="font-medium text-amber-600 dark:text-amber-400 tabular-nums">{widespreadCount} widespread</span> · <span className="font-medium tabular-nums">{isolatedCount} isolated</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">NAMA BAHAN</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Type</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Outlets</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">LOSS</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">SURPLUS</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Rata-rata % DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-8">Tidak ada data</TableCell></TableRow>
              ) : rows.map((row, i) => (
                <TableRow
                  key={`${row.itemName}-${i}`}
                  className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                  {...clickableRowProps(() => onClick(row))}
                >
                  <TableCell className="text-[11px] px-3 py-2 font-medium whitespace-normal max-w-[200px]" title={row.itemName}>{row.itemName}</TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge variant="outline" className={`text-[11px] px-1.5 py-0 font-medium ${consistencyBadge(row.type)}`}>{row.type}</Badge>
                  </TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right font-semibold tabular-nums">{row.outletCount}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right text-red-600 dark:text-red-400 font-medium tabular-nums">{row.lossOutlets}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">{row.surplusOutlets}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right font-semibold tabular-nums">{fmtIDR(row.absNominal)}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtPctAbs(row.avgDevBom)}</TableCell>
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

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <MapPin className="h-3.5 w-3.5" />
          </span>
          Perbandingan Area
          <FormulaInfo
            formula="LOSS/PENJUALAN = Total LOSS / Total PENJUALAN per area"
            description={'UNTUK APA: Membandingkan performa deviasi antar area untuk intervensi tertarget.\nCARA BACA: Area dengan LOSS/PENJUALAN tinggi = paling boros. Klik baris untuk filter dashboard by area.\nCONTOH: JAWA BARAT 1: LOSS Rp 2M / PENJUALAN Rp 20M = 10% (buruk).\nACTION: Area terburuk → evaluasi proses area & bandingkan dengan area terbaik.'}
            example="JAKBAR: LOSS 8M / Sales 80M = 10% (kritis)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'BENCHMARK_AREA_FACTOR', label: 'Faktor Benchmark Area', dataType: 'number', min: 1, max: 5, step: 0.5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium tabular-nums">{areas.length}</span> area · diurutkan dari NOMINAL DEVIASI terbesar
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Area</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Outlets</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">PENJUALAN</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">LOSS/PENJUALAN</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">% DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {areas.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-8">Tidak ada data</TableCell></TableRow>
              ) : areas.map((a, i) => {
                const isWorst = i === 0;
                const isBest = i === areas.length - 1;
                return (
                  <TableRow
                    key={a.area}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                    {...clickableRowProps(() => setArea(a.area))}
                  >
                    <TableCell className="text-[11px] px-3 py-2 font-medium">
                      <div className="flex items-center gap-1.5">
                        {isWorst && <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" title="Terburuk" />}
                        {isBest && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" title="Terbaik" />}
                        <span className="truncate" title={a.area}>{a.area}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-[11px] px-3 py-2 text-right text-muted-foreground tabular-nums">{a.outletCount}</TableCell>
                    <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtIDR(a.totalSales)}</TableCell>
                    <TableCell className="text-[11px] px-3 py-2 text-right font-semibold tabular-nums">{fmtIDR(a.totalAbsNominal)}</TableCell>
                    <TableCell className={`text-[11px] px-3 py-2 text-right font-semibold tabular-nums ${lossToSalesColor(a.lossToSales)}`}>{fmtPct(a.lossToSales, false)}</TableCell>
                    <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtPctAbs(a.avgDevBom)}</TableCell>
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
