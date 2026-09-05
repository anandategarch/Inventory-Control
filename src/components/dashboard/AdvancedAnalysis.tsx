'use client';

import { memo, useState, useMemo, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR, fmtNum, fmtPct, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  Heart, Link2, MapPin,
  ChevronRight, ChevronDown, AlertTriangle, Loader2,
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
export const OutletHealthRanking = memo(function OutletHealthRanking({ data }: { data: AnalysisData }) {
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
                    <div className="text-[11px] font-medium leading-tight whitespace-normal" title={o.outletName}>{o.outletName}</div>
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
});

// ============================================================
//  1.3 ItemConsistencyAnalysis
//  Analisis pola item (MASSAL / REGIONAL / LOKAL)
//  Display mapping: SYSTEMIC→Massal, WIDESPREAD→Regional, ISOLATED→Lokal
// ============================================================
function consistencyLabel(type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED'): string {
  switch (type) {
    case 'SYSTEMIC': return 'Massal';
    case 'WIDESPREAD': return 'Regional';
    case 'ISOLATED': return 'Lokal';
    default: return 'Lokal';
  }
}

function consistencyBadge(type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED'): string {
  switch (type) {
    case 'SYSTEMIC': return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'WIDESPREAD': return 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400';
    case 'ISOLATED': return 'text-muted-foreground bg-muted/50 border-border';
    default: return 'text-muted-foreground bg-muted/50 border-border';
  }
}

// ============================================================
//  1.3a AnomaliOutletExpansion
//  Inline row-expansion component for ItemConsistencyAnalysis.
//  When the user clicks a row in "Analisis Pola Item", this component
//  renders BELOW the row (colSpan=8) showing outlets whose direction
//  is the MINORITY (anomali) direction. Each outlet row is clickable →
//  setFocusOutlet navigates to the Resto Analysis tab.
// ============================================================
interface AnomaliOutletRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  pic: string | null;
  qtyDeviasi: number;
  nominalDeviasi: number;
  direction: string;
}

interface ItemAnomaliOutletsResponse {
  success: boolean;
  item: { itemName: string };
  direction: 'LOSS' | 'SURPLUS';
  outlets: AnomaliOutletRow[];
  durationMs?: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

interface AnomaliOutletExpansionProps {
  itemName: string;
  direction: 'LOSS' | 'SURPLUS';
  monthLabel: string | null;
  currentWeek: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
  setFocusOutlet: (code: string | null) => void;
}

function AnomaliOutletExpansion({
  itemName,
  direction,
  monthLabel,
  currentWeek,
  area,
  kelompok,
  outletCode,
  pic,
  setFocusOutlet,
}: AnomaliOutletExpansionProps) {
  const { data, isLoading, error } = useQuery<ItemAnomaliOutletsResponse>({
    queryKey: [
      'item-anomali-outlets', itemName, direction,
      monthLabel, currentWeek, area, kelompok, outletCode, pic,
    ],
    queryFn: async () => {
      const p = new URLSearchParams({
        item: itemName,
        month: monthLabel ?? '',
        week: currentWeek ?? '',
        direction,
      });
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode) p.set('outlet', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/item-anomali-outlets?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ItemAnomaliOutletsResponse>;
    },
    // Parent only renders this component when expanded — fire immediately.
    enabled: true,
    staleTime: 5 * 60 * 1000, // 5 min — matches API cache
  });

  const outlets = data?.outlets ?? [];

  return (
    <TableRow className="border-b hover:bg-transparent">
      <TableCell colSpan={8} className="p-0">
        <div className="bg-amber-50/40 dark:bg-amber-950/10 border-t border-amber-200/60 dark:border-amber-900/40 p-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
              {outlets.length} Outlet {direction} (Anomali — berbeda dari mayoritas)
            </span>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Memuat outlet...
            </div>
          ) : error ? (
            <div className="text-xs text-red-600 py-2">Gagal memuat: {error.message}</div>
          ) : outlets.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">Tidak ada outlet anomali.</div>
          ) : (
            <div className="max-h-48 overflow-auto">
              <Table className="min-w-[600px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] h-7">Outlet</TableHead>
                    <TableHead className="text-[10px] h-7">Area</TableHead>
                    <TableHead className="text-[10px] h-7">PIC</TableHead>
                    <TableHead className="text-right text-[10px] h-7">QTY Dev</TableHead>
                    <TableHead className="text-right text-[10px] h-7">Nominal</TableHead>
                    <TableHead className="text-center text-[10px] h-7">Dir</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outlets.map((o, i) => {
                    const isLoss = o.qtyDeviasi < 0;
                    return (
                      <TableRow
                        key={`${o.outletCode}-${i}`}
                        className={`cursor-pointer hover:bg-muted/40 ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                        {...clickableRowProps(() => {
                          setFocusOutlet(o.outletCode);
                        })}
                      >
                        <TableCell className="py-1.5">
                          <div className="flex flex-col leading-tight">
                            <span className="text-[11px] font-medium tabular-nums">{o.outletCode}</span>
                            <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={o.outletName}>{o.outletName}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-[10px] text-muted-foreground py-1.5">{o.area || '—'}</TableCell>
                        <TableCell className="text-[10px] text-muted-foreground py-1.5">{o.pic || '—'}</TableCell>
                        <TableCell className={`text-right text-[11px] py-1.5 tabular-nums font-medium ${isLoss ? 'text-red-600' : 'text-emerald-600'}`}>
                          {fmtNum(o.qtyDeviasi)}
                        </TableCell>
                        <TableCell className={`text-right text-[11px] py-1.5 tabular-nums ${o.nominalDeviasi < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                          {fmtIDR(o.nominalDeviasi)}
                        </TableCell>
                        <TableCell className="text-center py-1.5">
                          <Badge variant="outline" className={`text-[9px] h-4 px-1 font-medium ${o.direction === 'LOSS' ? 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/30 dark:text-red-400' : 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-400'}`}>
                            {o.direction}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground mt-1">💡 Klik outlet untuk deep dive ke Resto Analysis.</p>
        </div>
      </TableCell>
    </TableRow>
  );
}

export const ItemConsistencyAnalysis = memo(function ItemConsistencyAnalysis({ data }: { data: AnalysisData }) {
  // FIX (ANOMALI-OUTLETS): inline row expansion replaces DrillDownDrawer popup.
  // Pull month/week/filters + setFocusOutlet from the dashboard store so the
  // expansion panel can fetch the per-outlet anomali list + navigate to the
  // Resto Analysis tab on click.
  const {
    monthLabel,
    currentWeek,
    area,
    kelompok,
    outletCode,
    pic,
    setFocusOutlet,
  } = useDashboard(
    useShallow((s) => ({
      monthLabel: s.monthLabel,
      currentWeek: s.currentWeek,
      area: s.area,
      kelompok: s.kelompok,
      outletCode: s.outletCode,
      pic: s.pic,
      setFocusOutlet: s.setFocusOutlet,
    })),
  );

  // Expand/collapse state. Only ONE row expanded at a time — clicking
  // another closes the previous. `expandedDirection` is the MINORITY
  // direction of the currently-expanded row (passed to the API).
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [expandedDirection, setExpandedDirection] = useState<'LOSS' | 'SURPLUS' | null>(null);

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
  }> = useMemo(() => {
    const r: Array<{
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
    return r;
  }, [ca.items, ca.systemic, ca.episodic]);

  const systemicCount = rows.filter((r) => r.type === 'SYSTEMIC').length;
  const widespreadCount = rows.filter((r) => r.type === 'WIDESPREAD').length;
  const isolatedCount = rows.filter((r) => r.type === 'ISOLATED').length;

  // Toggle expansion for a row. When anomaliCount === 0 (item is 100% one
  // direction), there are no anomali outlets to show — don't expand.
  const onRowClick = (row: typeof rows[number]) => {
    const minorityDirection: 'LOSS' | 'SURPLUS' = row.lossOutlets > row.surplusOutlets ? 'SURPLUS' : 'LOSS';
    const anomaliCount = Math.min(row.lossOutlets, row.surplusOutlets);
    if (anomaliCount === 0) return;
    if (expandedItem === row.itemName) {
      setExpandedItem(null);
      setExpandedDirection(null);
    } else {
      setExpandedItem(row.itemName);
      setExpandedDirection(minorityDirection);
    }
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
            description={'UNTUK APA: Mengidentifikasi item yang menyimpang di multiple outlet (pola penyimpangan).\nCARA BACA: Massal (≥10 outlet) = masalah produk/QTY BOM. Regional (5-9 outlet) = pola area tertentu. Lokal (2-4 outlet) = anomali outlet spesifik.\nCONTOH: UDANG KEJU FROZEN deviasi di 15 outlet = Massal → cek QTY BOM atau harga beli.\nACTION: Massal → revisi master data QTY BOM. Regional → evaluasi pelatihan area. Lokal → investigasi outlet spesifik.'}
            example="UDANG KEJU FROZEN deviasi di 15 outlet = Massal"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium text-red-600 dark:text-red-400 tabular-nums">{systemicCount} massal</span> · <span className="font-medium text-amber-600 dark:text-amber-400 tabular-nums">{widespreadCount} regional</span> · <span className="font-medium tabular-nums">{isolatedCount} lokal</span>
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
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">⚠️ Anomali</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Rata-rata % DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">Tidak ada data</TableCell></TableRow>
              ) : rows.map((row, i) => {
                // Minority direction = the LESS-FREQUENT direction of the item.
                // Anomali count = number of outlets in the minority direction.
                // When 0, the row is not expandable (no anomali to show).
                const minorityDirection: 'LOSS' | 'SURPLUS' = row.lossOutlets > row.surplusOutlets ? 'SURPLUS' : 'LOSS';
                const anomaliCount = Math.min(row.lossOutlets, row.surplusOutlets);
                const isExpanded = expandedItem === row.itemName && expandedDirection !== null;
                return (
                  <Fragment key={`${row.itemName}-${i}`}>
                    <TableRow
                      className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''} ${isExpanded ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}`}
                      {...clickableRowProps(() => onRowClick(row))}
                    >
                      <TableCell className="text-[11px] px-3 py-2 font-medium whitespace-normal" title={row.itemName}>{row.itemName}</TableCell>
                      <TableCell className="px-3 py-2">
                        <Badge variant="outline" className={`text-[11px] px-1.5 py-0 font-medium ${consistencyBadge(row.type)}`}>{consistencyLabel(row.type)}</Badge>
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right font-semibold tabular-nums">{row.outletCount}</TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right text-red-600 dark:text-red-400 font-medium tabular-nums">{row.lossOutlets}</TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">{row.surplusOutlets}</TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-center">
                        {anomaliCount > 0 ? (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 gap-0.5 cursor-pointer text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
                            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            {anomaliCount} {minorityDirection === 'LOSS' ? 'L' : 'S'}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right font-semibold tabular-nums">{fmtIDR(row.absNominal)}</TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtPctAbs(row.avgDevBom)}</TableCell>
                    </TableRow>
                    {isExpanded && expandedDirection && (
                      <AnomaliOutletExpansion
                        itemName={row.itemName}
                        direction={expandedDirection}
                        monthLabel={monthLabel}
                        currentWeek={currentWeek}
                        area={area}
                        kelompok={kelompok}
                        outletCode={outletCode}
                        pic={pic}
                        setFocusOutlet={setFocusOutlet}
                      />
                    )}
                  </Fragment>
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
//  1.4 AreaComparison
//  Perbandingan antar area
// ============================================================
export const AreaComparison = memo(function AreaComparison({ data }: { data: AnalysisData }) {
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
                        <span className="break-words leading-tight" title={a.area}>{a.area}</span>
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
});
