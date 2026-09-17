'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData } from '@/hooks/useAnalysis';
import type { HistoricalAnalysisMeta } from '@/hooks/useAnalysis/types';
import { fmtIDR, fmtPctAbs, fmtDecimal } from '@/lib/format';
import { clickableRowProps, sortableHeaderProps } from '@/lib/a11y';
import { zScoreColor } from '@/lib/zScoreHelpers';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { ArrowUpDown, ArrowUp, ArrowDown, History, Info, ChevronDown, AlertTriangle, Database, CheckCircle2 } from 'lucide-react';
import { useState, useMemo, memo, useCallback } from 'react';

type SortKey = 'zScore' | 'absNominal' | 'currentDevBom' | 'historicalAvg' | 'itemName' | 'area';
type SortDir = 'asc' | 'desc';

// FIX (BATCH1): zScoreColor moved to @/lib/zScoreHelpers (shared with
// ItemTrendTable). Removed local duplicate — import above.

// Badge only for POSITIVE zScore (worse than historical). Negative = NORMAL (better).
function zScoreBadge(z: number): { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' } {
  if (z > 3) return { label: 'ABNORMAL', variant: 'destructive' };
  if (z > 2) return { label: 'WARNING', variant: 'default' };
  if (z > 1) return { label: 'ELEVATED', variant: 'secondary' };
  // z <= 1 (including negative) = not anomalous
  if (z < -2) return { label: 'BAIK', variant: 'outline' };
  return { label: 'NORMAL', variant: 'outline' };
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return sortDir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

// ============================================================
//  FX-HIST-EMPTY: smart empty state for Historical Z-Score card
//  --------------------------------------------------------
//  The card used to ALWAYS show "Semua item dalam batas normal" +
//  the "minimal 4 bulan data" tip whenever criticalItems was empty.
//  This was misleading when the user actually has 8 months of data
//  but no anomalies were detected (current below historical avg).
//
//  The meta block from the backend now lets us differentiate:
//    - NO_HISTORICAL_DATA : no other month has this weekLabel
//    - INSUFFICIENT_WEEKS : fewer than minWeeks historical periods
//    - NO_VALID_STATS    : stats exist but stdDev=0 / n<minWeeks (all)
//    - NO_ANOMALIES      : valid baseline + valid stats, none flagged
//                          (this is the success state — no tip needed)
//    - ALL_FILTERED_BOM  : flags exist but all filtered (BOM≈0)
//
//  Each reason gets a tailored icon, title, body, and color so the
//  user understands exactly WHY the table is empty.
// ============================================================
function HistoricalEmptyState({ meta, week }: { meta?: HistoricalAnalysisMeta; week?: string }) {
  // Fallback when backend hasn't returned meta yet (older cached response).
  if (!meta) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center px-6">
        <History className="h-8 w-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">Tidak ada anomali historical</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Semua item dalam batas normal vs rata-rata historis</p>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 max-w-md text-left">
          <Info className="h-4 w-4 text-blue-500 dark:text-blue-400 shrink-0 mt-0.5" />
          <div className="text-[11px] text-blue-700 dark:text-blue-300 space-y-1">
            <p className="font-medium">Tips: Z-Score butuh minimal 4 bulan data</p>
            <p>Baseline historical menggunakan weekLabel yang sama di bulan berbeda (W4 vs W4, bukan W4 vs W1). Upload data minimal 4 bulan untuk hasil optimal.</p>
          </div>
        </div>
      </div>
    );
  }

  const minWeeks = meta.minWeeks ?? 4;
  const histPeriods = meta.historicalPeriodsCount ?? 0;
  const validStats = meta.validStatsCount ?? 0;
  const statsCount = meta.statsCount ?? 0;
  const evaluated = meta.evaluatedCount ?? 0;
  const flagged = meta.flaggedCount ?? 0;
  const weekLabel = week ?? 'minggu ini';

  // ---- Per-reason render ----
  if (meta.reason === 'NO_HISTORICAL_DATA') {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center px-6">
        <Database className="h-8 w-8 text-amber-500/60 mb-2" />
        <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
          Belum ada data historis untuk {weekLabel}
        </p>
        <p className="text-xs text-muted-foreground/80 mt-1 max-w-md">
          Baseline Z-Score membandingkan {weekLabel} di bulan ini dengan {weekLabel} di bulan lain
          (mis. W4 Juli vs W4 Januari–Juni). Belum ada bulan lain yang memiliki {weekLabel} — upload
          data bulan sebelumnya dengan minggu yang sama untuk mengaktifkan analisis historis.
        </p>
        <div className="mt-3 text-[11px] text-muted-foreground/70 space-y-0.5">
          <p>Statistik: 0 periode historis · 0 stats · 0 record dievaluasi</p>
        </div>
      </div>
    );
  }

  if (meta.reason === 'INSUFFICIENT_WEEKS') {
    const need = Math.max(0, minWeeks - histPeriods);
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center px-6">
        <History className="h-8 w-8 text-blue-500/60 mb-2" />
        <p className="text-sm text-blue-700 dark:text-blue-300 font-medium">
          Data historis belum cukup untuk Z-Score
        </p>
        <p className="text-xs text-muted-foreground/80 mt-1 max-w-md">
          Saat ini hanya <span className="font-semibold tabular-nums">{histPeriods}</span> bulan
          yang memiliki {weekLabel}, butuh minimal <span className="font-semibold">{minWeeks}</span>{' '}
          bulan untuk hasil optimal. Tambahkan <span className="font-semibold tabular-nums">{need}</span> bulan lagi
          dengan {weekLabel} yang sama.
        </p>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 max-w-md text-left">
          <Info className="h-4 w-4 text-blue-500 dark:text-blue-400 shrink-0 mt-0.5" />
          <div className="text-[11px] text-blue-700 dark:text-blue-300 space-y-1">
            <p className="font-medium">Tips: Z-Score butuh minimal {minWeeks} bulan data</p>
            <p>Baseline historical menggunakan weekLabel yang sama di bulan berbeda (W4 vs W4, bukan W4 vs W1).</p>
          </div>
        </div>
        <div className="mt-3 text-[11px] text-muted-foreground/70 space-y-0.5">
          <p>Statistik: {histPeriods} periode historis · {statsCount} stats · {evaluated} record dievaluasi</p>
        </div>
      </div>
    );
  }

  if (meta.reason === 'NO_VALID_STATS') {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center px-6">
        <AlertTriangle className="h-8 w-8 text-amber-500/60 mb-2" />
        <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
          Data historis terlalu homogen untuk Z-Score
        </p>
        <p className="text-xs text-muted-foreground/80 mt-1 max-w-md">
          Ada <span className="font-semibold tabular-nums">{statsCount}</span> pasangan outlet-item
          dengan data historis ({histPeriods} bulan), tapi tidak ada yang memiliki variasi
          yang cukup (stdDev = 0) atau jumlah minggu &lt; {minWeeks}. Z-Score tidak dapat
          dihitung jika nilai historis konstan — pastikan upload bulan-bulan yang berbeda
          (bukan file duplikat dengan label bulan berbeda).
        </p>
        <div className="mt-3 text-[11px] text-muted-foreground/70 space-y-0.5">
          <p>Statistik: {histPeriods} periode · {statsCount} stats · 0 valid (stdDev&gt;0 & n≥{minWeeks}) · {evaluated} record dievaluasi</p>
        </div>
      </div>
    );
  }

  if (meta.reason === 'ALL_FILTERED_BOM') {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center px-6">
        <AlertTriangle className="h-8 w-8 text-amber-500/60 mb-2" />
        <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
          {flagged} item ditandai anomali tapi difilter
        </p>
        <p className="text-xs text-muted-foreground/80 mt-1 max-w-md">
          Backend menemukan {flagged} record dengan Z-Score di atas threshold, tapi semua
          difilter di sisi client karena |Dev/BOM| &gt; 500% (BOM ≈ 0 → pembagian tidak
          valid) atau historicalAvg = 0. Periksa kembali nilai BOM pada item-item tersebut.
        </p>
        <div className="mt-3 text-[11px] text-muted-foreground/70 space-y-0.5">
          <p>Statistik: {histPeriods} periode · {validStats} valid stats · {flagged} flagged · {evaluated} record dievaluasi</p>
        </div>
      </div>
    );
  }

  // ---- NO_ANOMALIES (success state) ----
  // This is the case the user reported: 8 months of data, filter July,
  // card says "Semua item dalam batas normal" + "minimal 4 bulan" tip.
  // The tip is misleading — we now confirm the baseline was valid.
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center px-6">
      <CheckCircle2 className="h-8 w-8 text-emerald-500/60 mb-2" />
      <p className="text-sm text-emerald-700 dark:text-emerald-300 font-medium">
        Semua item dalam batas normal vs rata-rata historis
      </p>
      <p className="text-xs text-muted-foreground/80 mt-1 max-w-md">
        Baseline historis <span className="font-semibold">{weekLabel}</span> dibangun dari{' '}
        <span className="font-semibold tabular-nums">{histPeriods}</span> bulan, dengan{' '}
        <span className="font-semibold tabular-nums">{validStats}</span> pasangan outlet-item valid
        (stdDev &gt; 0 &amp; n ≥ {minWeeks}) dari total {statsCount} pasangan. Tidak ada item
        yang Z-Score-nya melebihi threshold (warn &gt; {meta.zWarnThreshold ?? 1.5}σ · abnormal &gt;{' '}
        {meta.zHighThreshold ?? 2}σ). Deviasi bulan ini secara umum <span className="font-medium">di bawah
        atau sama dengan</span> rata-rata historis — kondisi yang baik.
      </p>
      <div className="mt-3 text-[11px] text-muted-foreground/70 space-y-0.5">
        <p>Statistik: {histPeriods} periode · {validStats} valid stats · {evaluated} record dievaluasi · {flagged} ditandai anomali</p>
      </div>
    </div>
  );
}

export const HistoricalZScoreCard = memo(function HistoricalZScoreCard({ data }: { data: AnalysisData }) {
  // NAVLINK-1 (B1): row click opens the raw-records drawer for the exact
  // (outlet × item) pair behind the z-score — same setDrilldown pattern as
  // TopItems / InsightsPanel rows.
  const setDrilldown = useDashboard(useShallow((s) => s.setDrilldown));
  // FIX BUG 1: Filter out items with |Dev/BOM| > 500% — these are data anomalies
  // where BOM ≈ 0 (division by near-zero produces extreme pctQtyDeviasiToBom).
  // Z-Scores of 680.99 are meaningless and pollute the table.
  // Also filter out items with zScore = 0 (no historical baseline).
  const allItems = data.growthComparison?.historicalAnalysis?.criticalItems || [];
  // FX-HIST-EMPTY: diagnostics meta for the smart empty state.
  const histMeta = data.growthComparison?.historicalAnalysis?.meta;
  // The current week filter the user applied — surfaced to the empty state
  // so it can reference "W4 Juli" instead of a generic "minggu ini".
  const currentWeek = data.period?.weekLabel || undefined;
  const [metricView, setMetricView] = useState<'devBom' | 'qtyDeviasi'>('devBom');
  // FIX FE-05: filter uses active metric's zScore (was always i.zScore = Dev/BOM)
  const items = useMemo(() => allItems.filter(i => {
    const activeZ = metricView === 'qtyDeviasi' ? i.qtyDeviasiZScore : i.zScore;
    return Math.abs(i.currentDevBom) <= 5 &&
      activeZ > 0 &&
      i.historicalAvg > 0;
  }), [allItems, metricView]);
  const [sortKey, setSortKey] = useState<SortKey>('zScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Phase B-4: Pagination
  const [displayCount, setDisplayCount] = useState(20);
  const PAGE_SIZE = 20;
  // Phase B-3: Severity filter
  const [severityFilter, setSeverityFilter] = useState<'all' | 'abnormal' | 'warning' | 'elevated'>('all');
  // Phase B-1: Multi-metric selector — Dev/BOM (ratio) + QTY Deviasi (absolute)
  // metricView state declared above (before items filter — FE-05 fix)

  const sorted = useMemo(() => {
    // Phase B-3: Filter by severity — only POSITIVE zScore is anomalous
    // Negative zScore = current below historical = better (not anomalous)
    const filtered = severityFilter === 'all' ? items : items.filter(i => {
      const z = metricView === 'qtyDeviasi' ? i.qtyDeviasiZScore : i.zScore;
      if (severityFilter === 'abnormal') return z > 3;
      if (severityFilter === 'warning') return z > 2 && z <= 3;
      if (severityFilter === 'elevated') return z > 1 && z <= 2;
      return true;
    });
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      const zA = metricView === 'qtyDeviasi' ? a.qtyDeviasiZScore : a.zScore;
      const zB = metricView === 'qtyDeviasi' ? b.qtyDeviasiZScore : b.zScore;
      switch (sortKey) {
        case 'zScore': cmp = zA - zB; break; // signed: high positive first when desc
        case 'absNominal': cmp = a.absNominal - b.absNominal; break;
        case 'currentDevBom': cmp = Math.abs(a.currentDevBom) - Math.abs(b.currentDevBom); break;
        case 'historicalAvg': cmp = a.historicalAvg - b.historicalAvg; break;
        case 'itemName': cmp = a.itemName.localeCompare(b.itemName); break;
        case 'area': cmp = a.area.localeCompare(b.area); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [items, sortKey, sortDir, severityFilter, metricView]);

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }, [sortKey, sortDir]);

  // Phase B-4: Reset display count when sort changes
  const handleSort = useCallback((key: SortKey) => {
    toggleSort(key);
    setDisplayCount(PAGE_SIZE);
  }, [toggleSort]);

  const loadMore = useCallback(() => {
    setDisplayCount(prev => Math.min(prev + PAGE_SIZE, sorted.length));
  }, [sorted.length]);

  const activeZScore = (i: typeof items[number]) => metricView === 'qtyDeviasi' ? i.qtyDeviasiZScore : i.zScore;
  // Only POSITIVE zScore counts as abnormal/warning (negative = better than historical)
  const abnormalCount = items.filter(i => activeZScore(i) > 3).length;
  const warningCount = items.filter(i => activeZScore(i) > 2 && activeZScore(i) <= 3).length;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          {/* P23 C2: purple (off-token family) → adaptive --chart-2 token utilities (teal light / green dark). */}
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-chart-2/10 dark:bg-chart-2/20 text-chart-2 shrink-0">
            <History className="h-3.5 w-3.5" />
          </span>
          Historical Z-Score Analysis
          <FormulaInfo
            formula="Z-Score = (|Current Dev/BOM| - Mean(|Historical Dev/BOM|)) / StdDev"
            description="Mendeteksi item yang deviasinya jauh di atas rata-rata historisnya sendiri. Z-Score > 2 = WARNING, > 3 = ABNORMAL. Baseline = periode dengan weekLabel yang sama di bulan lain (W4 vs W4, bukan W4 vs W1). Klik header kolom untuk sort."
            example="Item X: current Dev/BOM 45%, historical avg 15%, stdDev 8% → Z = (45-15)/8 = 3.75 (ABNORMAL)"
            side="bottom"
          />
        </CardTitle>
        <div className="flex items-center justify-between gap-2 ml-9 flex-wrap">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">{sorted.length}</span> item
            {severityFilter !== 'all' && <span className="text-muted-foreground/60"> (filtered dari {items.length})</span>}
            {allItems.length !== items.length && <span className="text-muted-foreground/60"> · {allItems.length - items.length} difilter: BOM≈0</span>}
            {' · '}
            <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">{abnormalCount} abnormal</span> ·{' '}
            <span className="text-amber-600 dark:text-amber-400 font-medium tabular-nums">{warningCount} warning</span>
            {/* FX-HIST-EMPTY: surface baseline context so the user can verify
                the Z-Score was computed from a sufficient historical sample.
                Hidden when meta is missing (older cached response). */}
            {histMeta && (
              <span className="text-muted-foreground/70"> · baseline {histMeta.historicalPeriodsCount} bln · {histMeta.validStatsCount} valid stats</span>
            )}
          </p>
          {/* Phase B-3: Severity filter */}
          <div className="flex items-center gap-1.5">
            {/* Phase B-1: Multi-metric selector — Dev/BOM (ratio) + QTY Deviasi (absolute) */}
            <div className="flex items-center gap-0.5 mr-2 p-0.5 rounded-lg bg-muted/40">
              {(['devBom', 'qtyDeviasi'] as const).map(m => (
                <button
                  key={m}
                  aria-pressed={metricView === m}
                  onClick={() => { setMetricView(m); setDisplayCount(PAGE_SIZE); }}
                  className={`text-[10px] px-2 py-0.5 rounded-md transition-colors ${
                    // P23 C2: purple active pill → adaptive --chart-2 token (matches the card accent).
                    metricView === m
                      ? 'bg-chart-2 text-white'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  {m === 'devBom' ? 'Dev/BOM' : 'QTY Deviasi'}
                </button>
              ))}
            </div>
            {(['all', 'abnormal', 'warning', 'elevated'] as const).map(f => (
              <button
                key={f}
                aria-pressed={severityFilter === f}
                onClick={() => { setSeverityFilter(f); setDisplayCount(PAGE_SIZE); }}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  severityFilter === f
                    ? 'bg-amber-600 text-white border-amber-600'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted/40'
                }`}
              >
                {f === 'all' ? 'Semua' : f === 'abnormal' ? '>3σ' : f === 'warning' ? '2-3σ' : '1-2σ'}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <HistoricalEmptyState meta={histMeta} week={currentWeek} />
        ) : (
          <div className="max-h-[500px] overflow-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 w-8">#</TableHead>
                  {/* FIX (BUG-HUNT B12/B2-03): sortable headers were onClick-only —
                      shared helper adds keyboard + AT access while keeping the th's
                      columnheader semantics; "Historical Avg" label localized (B2-12). */}
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('itemName', 'Item', sortKey, sortDir, handleSort)}
                  >
                    Item <SortIcon col="itemName" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('area', 'Area', sortKey, sortDir, handleSort)}
                  >
                    Area <SortIcon col="area" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('currentDevBom', metricView === 'qtyDeviasi' ? 'QTY Deviasi' : 'Dev/BOM', sortKey, sortDir, handleSort)}
                  >
                    {metricView === 'qtyDeviasi' ? 'QTY Deviasi' : 'Dev/BOM'} <SortIcon col="currentDevBom" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('historicalAvg', 'Rata-rata Historis', sortKey, sortDir, handleSort)}
                  >
                    Rata-rata Historis <SortIcon col="historicalAvg" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('zScore', 'Z-Score', sortKey, sortDir, handleSort)}
                  >
                    Z-Score <SortIcon col="zScore" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">Status</TableHead>
                  <TableHead
                    className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    {...sortableHeaderProps('absNominal', 'Nominal', sortKey, sortDir, handleSort)}
                  >
                    |Nominal| <SortIcon col="absNominal" sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.slice(0, displayCount).map((item, i) => {
                  const activeZ = activeZScore(item);
                  const badge = zScoreBadge(activeZ);
                  const isLoss = item.currentQtyDeviasi < 0;
                  return (
                    <TableRow
                      key={`${item.itemName}-${item.outletCode}-${i}`}
                      {...clickableRowProps(() => setDrilldown({ outletCode: item.outletCode, itemName: item.itemName }))}
                      className="cursor-pointer hover:bg-muted/40 transition-colors border-b"
                      title="Klik untuk lihat record mentah resto × item ini"
                    >
                      <TableCell className="text-[11px] text-muted-foreground px-3 py-2 tabular-nums">{i + 1}</TableCell>
                      <TableCell className="text-[11px] px-3 py-2">
                        <div className="font-medium leading-tight whitespace-normal" title={item.itemName}>{item.itemName}</div>
                        <div className="text-[11px] text-muted-foreground">{item.outletCode}</div>
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-muted-foreground">{item.area}</TableCell>
                      {/* Current value: Dev/BOM (rasio) atau QTY Deviasi (nilai asli signed) */}
                      {metricView === 'qtyDeviasi' ? (
                        <TableCell className={`text-[11px] px-3 py-2 text-right tabular-nums font-medium ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {item.currentQtyDeviasi.toLocaleString('id-ID')}
                        </TableCell>
                      ) : (
                        <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtPctAbs(item.currentDevBom)}</TableCell>
                      )}
                      {/* Historical Avg */}
                      <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {metricView === 'qtyDeviasi' ? item.qtyDeviasiHistoricalAvg.toLocaleString('id-ID') : fmtPctAbs(item.historicalAvg)}
                      </TableCell>
                      {/* Z-Score with tooltip — SIGNED: positive=red, negative=green */}
                      <TableCell className={`text-[11px] px-3 py-2 text-right tabular-nums ${zScoreColor(activeZ)}`}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center justify-end gap-1.5 cursor-help">
                              <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden" aria-hidden>
                                <div
                                  className={`h-full ${activeZ > 3 ? 'bg-red-500' : activeZ > 2 ? 'bg-amber-500' : activeZ > 1 ? 'bg-yellow-500' : 'bg-emerald-500'}`}
                                  style={{ width: `${Math.min(Math.abs(activeZ) / 5 * 100, 100)}%` }}
                                />
                              </div>
                              {activeZ > 0 ? `+${fmtDecimal(activeZ, 2)}` : fmtDecimal(activeZ, 2)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="text-xs p-3 max-w-xs">
                            <div className="space-y-1">
                              <p className="font-semibold">Z-Score Breakdown {metricView === 'qtyDeviasi' ? '(QTY Deviasi)' : '(Dev/BOM)'}</p>
                              {/* P23 C2: tooltip signed-value colors were light-mode-only — add dark: variants. */}
                              {metricView === 'qtyDeviasi' ? (
                                <>
                                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Current QTY Deviasi:</span><span className={`font-medium tabular-nums ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{item.currentQtyDeviasi.toLocaleString('id-ID')}</span></div>
                                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Historical Avg (|weekly|):</span><span className="font-medium tabular-nums">{item.qtyDeviasiHistoricalAvg.toLocaleString('id-ID')}</span></div>
                                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">|Current| vs Avg:</span><span className="font-medium tabular-nums">{fmtDecimal(Math.abs(item.currentQtyDeviasi) / (item.qtyDeviasiHistoricalAvg || 1), 2)}×</span></div>
                                </>
                              ) : (
                                <>
                                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Current Dev/BOM:</span><span className="font-medium tabular-nums">{fmtPctAbs(item.currentDevBom)}</span></div>
                                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Historical Avg:</span><span className="font-medium tabular-nums">{fmtPctAbs(item.historicalAvg)}</span></div>
                                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Delta:</span><span className={`font-medium tabular-nums ${Math.abs(item.currentDevBom) > Math.abs(item.historicalAvg) ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtDecimal((item.currentDevBom - item.historicalAvg) * 100, 1)}pp</span></div>
                                </>
                              )}
                              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Z-Score:</span><span className={`font-bold tabular-nums ${zScoreColor(activeZ)}`}>{fmtDecimal(activeZ, 2)} ({badge.label})</span></div>
                              <div className="flex justify-between gap-4"><span className="text-muted-foreground">|Nominal|:</span><span className="font-medium tabular-nums">{fmtIDR(item.absNominal)}</span></div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-center">
                        <Badge variant={badge.variant} className="text-[11px] h-4 px-1 font-medium">{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums font-semibold">{fmtIDR(item.absNominal)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {/* Phase B-4: Load more button */}
            {displayCount < sorted.length && (
              <div className="flex items-center justify-center py-3 border-t">
                <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={loadMore}>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Tampilkan lebih banyak ({sorted.length - displayCount} tersisa)
                </Button>
              </div>
            )}
            {displayCount > PAGE_SIZE && (
              <div className="flex items-center justify-center py-1">
                <span className="text-[10px] text-muted-foreground">Menampilkan {displayCount} dari {sorted.length} item</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
