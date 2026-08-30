'use client';

// ============================================================
//  DiagnosisTab — NEW "Diagnosis" tab (CAUSAL-FRONTEND).
//  --------------------------------------------------------
//  Bayesian causal inference engine — diagnoses the most likely
//  root cause of stock deviation per outlet.
//
//  Layout (top → bottom):
//    1. Header (title + FormulaInfo explaining Bayesian approach
//       + cache/fetch/stale badges + summary stats)
//    2. Section 1: Cause Distribution (horizontal CSS bars)
//       — 7 cause types, bar length = outlet count,
//         bar color = avg confidence (green >80%, amber 60-80%, red <60%)
//    3. Section 2: Detail Table (sortable, expandable)
//       Columns: Outlet | Area | Top Cause | Conf% | Impact | Priority | [Expand]
//       Expand → all causes + evidence + auto-action + impact estimate
//
//  Data flow:
//    useDiagnosis (TanStack Query) → /api/diagnosis
//
//  Patterns reused from existing dashboard:
//    - React.memo + ErrorBoundary (in parent page.tsx) + useShallow (ItemTrendTab pattern)
//    - Sortable table with toggleSort (ItemTrendTab pattern)
//    - Confidence color + Priority helpers (per task spec)
//    - CSS bars instead of Recharts (keeps bundle small — no chart needed)
// ============================================================

import { memo, useState, useMemo, useCallback } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight,
  Loader2, Stethoscope, X,
} from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useDiagnosis, type CausalResult } from '@/hooks/useAnalysis';
import { fmtIDR } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';

// ----------------------------------------------------------------
//  Coloring helpers — confidence + priority (per task spec).
// ----------------------------------------------------------------

/** Confidence → text + bg color (green >80%, amber 60-80%, orange 40-60%, muted <40%). */
function confidenceColor(conf: number): string {
  if (conf > 0.80) return 'text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/50';
  if (conf > 0.60) return 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/50';
  if (conf > 0.40) return 'text-orange-700 dark:text-orange-300 bg-orange-100 dark:bg-orange-950/50';
  return 'text-muted-foreground bg-muted';
}

/** Confidence → solid bar fill color (for the inline progress bars). */
function confidenceBarColor(conf: number): string {
  if (conf > 0.80) return 'bg-emerald-500';
  if (conf > 0.60) return 'bg-amber-500';
  if (conf > 0.40) return 'bg-orange-500';
  return 'bg-muted-foreground/50';
}

/** Priority rank (lower = more urgent) — used for sort. */
function priorityRank(conf: number, impact: number): number {
  if (conf > 0.80 && impact > 50_000_000) return 0; // URGENT
  if (conf > 0.60) return 1;                         // HIGH
  if (conf > 0.40) return 2;                         // MEDIUM
  return 3;                                          // LOW
}

/** Priority badge — URGENT (red), HIGH (amber), MEDIUM (blue), LOW (muted). */
function getPriority(conf: number, impact: number): { label: string; color: string } {
  if (conf > 0.80 && impact > 50_000_000) return { label: 'URGENT', color: 'text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-950/50' };
  if (conf > 0.60) return { label: 'HIGH', color: 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/50' };
  if (conf > 0.40) return { label: 'MEDIUM', color: 'text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/50' };
  return { label: 'LOW', color: 'text-muted-foreground bg-muted' };
}

// ----------------------------------------------------------------
//  Sort helpers — same pattern as ItemTrendTab.
// ----------------------------------------------------------------

type SortKey = 'outlet' | 'area' | 'topCause' | 'confidence' | 'impact' | 'priority';
type SortDir = 'asc' | 'desc';

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
  return sortDir === 'desc' ? <ArrowDown className="h-3 w-3 inline ml-1" /> : <ArrowUp className="h-3 w-3 inline ml-1" />;
}

// ----------------------------------------------------------------
//  Outlet row helpers — derive "Impact" + "Top Cause label" from
//  the topCause field on the outlet object.
// ----------------------------------------------------------------

function getOutletTopCause(outlet: CausalResult) {
  // topCause is the causeId; resolve to the cause object for label/impact.
  return outlet.causes.find((c) => c.causeId === outlet.topCause) ?? outlet.causes[0];
}

function getOutletImpact(outlet: CausalResult): number {
  return getOutletTopCause(outlet)?.impactEstimate ?? 0;
}

function getOutletTopCauseLabel(outlet: CausalResult): string {
  return getOutletTopCause(outlet)?.causeLabel ?? outlet.topCause;
}

// ============================================================
//  DiagnosisTab — main component
// ============================================================

function DiagnosisTabImpl() {
  // Pull dashboard filters so the diagnosis respects the user's current
  // selection. The diagnosis API takes month+week as the period scope and
  // area/kelompok/outlet/pic to filter the records.
  const { monthLabel, currentWeek, area, kelompok, outletCode, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
  })));

  const diagnosis = useDiagnosis({
    month: monthLabel,
    week: currentWeek,
    area,
    kelompok,
    outletCode,
    pic,
  });

  // Local UI state — expanded rows + table sort.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('impact');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleExpand = useCallback((outletCode: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(outletCode)) {
        next.delete(outletCode);
      } else {
        next.add(outletCode);
      }
      return next;
    });
  }, []);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return prev;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  // Memoize outlets array — stable ref for downstream useMemo.
  const outlets: CausalResult[] = useMemo(
    () => diagnosis.data?.outlets ?? [],
    [diagnosis.data?.outlets],
  );

  // Sorted rows (by user-selected column).
  const sortedOutlets = useMemo(() => {
    const arr = [...outlets];
    arr.sort((a, b) => {
      let cmp = 0;
      const aConf = a.topConfidence;
      const bConf = b.topConfidence;
      const aImpact = getOutletImpact(a);
      const bImpact = getOutletImpact(b);
      switch (sortKey) {
        case 'outlet':
          cmp = a.outletName.localeCompare(b.outletName);
          break;
        case 'area':
          cmp = a.area.localeCompare(b.area);
          break;
        case 'topCause':
          cmp = getOutletTopCauseLabel(a).localeCompare(getOutletTopCauseLabel(b));
          break;
        case 'confidence':
          cmp = aConf - bConf;
          break;
        case 'impact':
          cmp = aImpact - bImpact;
          break;
        case 'priority':
          cmp = priorityRank(aConf, aImpact) - priorityRank(bConf, bImpact);
          break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [outlets, sortKey, sortDir]);

  // Cause distribution entries sorted by count desc (for the bar chart).
  const distribution = useMemo(() => {
    const dist = diagnosis.data?.causeDistribution ?? {};
    return Object.entries(dist)
      .map(([causeId, info]) => ({ causeId, count: info.count, avgConfidence: info.avgConfidence }))
      .sort((a, b) => b.count - a.count || b.avgConfidence - a.avgConfidence);
  }, [diagnosis.data?.causeDistribution]);

  const maxCount = distribution.length > 0 ? Math.max(...distribution.map((d) => d.count)) : 0;

  // Summary stats — outlets + priority breakdown (for header subtitle).
  const summary = outlets.length === 0 ? null : (() => {
    let urgent = 0;
    let high = 0;
    let totalImpact = 0;
    for (const o of outlets) {
      const impact = getOutletImpact(o);
      const rank = priorityRank(o.topConfidence, impact);
      if (rank === 0) urgent++;
      else if (rank === 1) high++;
      totalImpact += impact;
    }
    return { outletCount: outlets.length, urgent, high, totalImpact };
  })();

  // ----------------------------------------------------------
  //  Render
  // ----------------------------------------------------------

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5 flex-wrap">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Stethoscope className="h-3.5 w-3.5" />
          </span>
          Diagnosis Engine
          <FormulaInfo
            formula="P(Cause | Evidence) = P(Evidence | Cause) · P(Cause) / P(Evidence)"
            description={
              'UNTUK APA: Identifikasi akar masalah deviasi stok per outlet.\n' +
              'CARA BACA: Confidence >80% = kuat, 60-80% = sedang, <60% = lemah.\n' +
              'ACTION: Lihat auto-generated action plan di row yang di-expand.\n' +
              'Engine memakai Bayesian causal inference dengan 7 hipotesis cause: MISSING_BOM, SHRINKAGE, FRAUD, PORTIONING, SUPPLIER, SALES_MIX, SEASONAL. Setiap cause punya evidence list (dengan weight); confidence = sum weight dari evidence yang present (normalized).'
            }
            example="Outlet A: BOM=0 untuk CABAI FROZEN + residual >80% + nominal >Rp10Jt → MISSING_BOM confidence=0.92 (URGENT). Impact estimate dihitung dari nominal loss yang bisa dijelaskan oleh cause tersebut."
            side="bottom"
          />
          {diagnosis.data?.cached && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
              cached
            </Badge>
          )}
          {diagnosis.data?.stale && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              stale (revalidating)
            </Badge>
          )}
          {diagnosis.isFetching && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
              Memuat
            </Badge>
          )}
        </CardTitle>

        {/* Summary stats */}
        {summary && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-1">
            <span><span className="font-medium tabular-nums text-foreground">{summary.outletCount}</span> outlet dianalisis</span>
            <span>·</span>
            <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">{summary.urgent} urgent</span>
            <span>·</span>
            <span className="text-amber-600 dark:text-amber-400 font-medium tabular-nums">{summary.high} high priority</span>
            <span>·</span>
            <span>Total estimated impact: <span className="font-medium tabular-nums text-foreground">{fmtIDR(summary.totalImpact)}</span></span>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {diagnosis.error ? (
          <div className="text-center text-red-600 dark:text-red-400 text-sm py-12 px-6">
            Gagal memuat diagnosis: {diagnosis.error.message}
          </div>
        ) : diagnosis.isLoading && outlets.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            <span className="ml-2 text-xs text-muted-foreground">Mendiagnosis akar masalah deviasi...</span>
          </div>
        ) : outlets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-6">
            <Stethoscope className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada hasil diagnosis</p>
            <p className="text-xs text-muted-foreground/70 mt-1 max-w-md">
              Engine tidak menemukan akar masalah untuk periode/filter ini. Coba ubah filter atau pilih periode lain.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {/* ====== Section 1: Cause Distribution ====== */}
            <div className="px-4 pt-3 pb-2 border-b">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Distribusi Akar Masalah
                </h3>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" /> {'>'}80%</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-500" /> 60-80%</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-orange-500" /> 40-60%</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-muted-foreground/50" /> {'<'}40%</span>
                </div>
              </div>
              <div className="space-y-1.5">
                {distribution.map((d) => (
                  <div key={d.causeId} className="flex items-center gap-3 text-xs">
                    <div className="w-36 shrink-0 font-medium truncate" title={d.causeId}>
                      {d.causeId}
                    </div>
                    <div className="flex-1 h-5 rounded-md bg-muted/40 overflow-hidden relative">
                      <div
                        className={`h-full ${confidenceBarColor(d.avgConfidence)} transition-all duration-300`}
                        style={{ width: `${maxCount > 0 ? (d.count / maxCount) * 100 : 0}%` }}
                      />
                      <div className="absolute inset-0 flex items-center px-2 text-[10px] font-medium text-foreground/80">
                        {d.count} outlet · avg {(d.avgConfidence * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ====== Section 2: Detail Table ====== */}
            <div className="max-h-[70vh] overflow-auto">
              <Table className="min-w-[920px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="w-8 h-10 px-2" />
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleSort('outlet')}
                    >
                      Outlet <SortIcon col="outlet" sortKey={sortKey} sortDir={sortDir} />
                    </TableHead>
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleSort('area')}
                    >
                      Area <SortIcon col="area" sortKey={sortKey} sortDir={sortDir} />
                    </TableHead>
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wider h-10 px-3 cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleSort('topCause')}
                    >
                      Top Cause <SortIcon col="topCause" sortKey={sortKey} sortDir={sortDir} />
                    </TableHead>
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleSort('confidence')}
                    >
                      Conf <SortIcon col="confidence" sortKey={sortKey} sortDir={sortDir} />
                    </TableHead>
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleSort('impact')}
                    >
                      Impact <SortIcon col="impact" sortKey={sortKey} sortDir={sortDir} />
                    </TableHead>
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center cursor-pointer hover:bg-muted/40"
                      onClick={() => toggleSort('priority')}
                    >
                      Priority <SortIcon col="priority" sortKey={sortKey} sortDir={sortDir} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedOutlets.map((o) => {
                    const isExpanded = expandedRows.has(o.outletCode);
                    const topCause = getOutletTopCause(o);
                    const topLabel = topCause?.causeLabel ?? o.topCause;
                    const impact = topCause?.impactEstimate ?? 0;
                    const conf = o.topConfidence;
                    const priority = getPriority(conf, impact);
                    return (
                      <DiagnosisRow
                        key={o.outletCode}
                        outlet={o}
                        isExpanded={isExpanded}
                        onToggle={() => toggleExpand(o.outletCode)}
                        topLabel={topLabel}
                        impact={impact}
                        conf={conf}
                        priorityLabel={priority.label}
                        priorityColor={priority.color}
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  DiagnosisRow — single outlet row (with expandable detail).
//  Memoized so re-expanding one row doesn't re-render all rows.
// ============================================================

interface DiagnosisRowProps {
  outlet: CausalResult;
  isExpanded: boolean;
  onToggle: () => void;
  topLabel: string;
  impact: number;
  conf: number;
  priorityLabel: string;
  priorityColor: string;
}

const DiagnosisRow = memo(function DiagnosisRow({
  outlet, isExpanded, onToggle, topLabel, impact, conf, priorityLabel, priorityColor,
}: DiagnosisRowProps) {
  return (
    <>
      <TableRow
        className="hover:bg-muted/40 transition-colors border-b cursor-pointer"
        onClick={onToggle}
      >
        <TableCell className="w-8 px-2 py-2 text-muted-foreground">
          {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </TableCell>
        <TableCell className="text-xs px-3 py-2">
          <div className="font-medium leading-tight">{outlet.outletName}</div>
          <div className="text-[10px] text-muted-foreground font-mono">{outlet.outletCode}</div>
        </TableCell>
        <TableCell className="text-xs px-3 py-2 text-muted-foreground">{outlet.area}</TableCell>
        <TableCell className="text-xs px-3 py-2">
          <span className="font-medium">{topLabel}</span>
        </TableCell>
        <TableCell className="text-xs px-3 py-2 text-right">
          <div className="inline-flex items-center gap-1.5">
            <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden" aria-hidden>
              <div
                className={`h-full ${confidenceBarColor(conf)}`}
                style={{ width: `${Math.min(conf * 100, 100)}%` }}
              />
            </div>
            <span className="tabular-nums font-medium">{(conf * 100).toFixed(0)}%</span>
          </div>
        </TableCell>
        <TableCell className="text-xs px-3 py-2 text-right tabular-nums font-medium text-red-600 dark:text-red-400">
          {fmtIDR(impact)}
        </TableCell>
        <TableCell className="text-xs px-3 py-2 text-center">
          <span className={`inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${priorityColor}`}>
            {priorityLabel}
          </span>
        </TableCell>
      </TableRow>

      {/* Expanded detail row — spans all columns. */}
      {isExpanded && (
        <TableRow className="bg-muted/20 dark:bg-zinc-900/30 hover:bg-transparent">
          <TableCell colSpan={7} className="p-4">
            <OutletDetail outlet={outlet} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
});

// ============================================================
//  OutletDetail — expanded panel showing all causes + evidence +
//  auto-action + impact estimate.
// ============================================================

function OutletDetail({ outlet }: { outlet: CausalResult }) {
  // Sort causes by confidence desc — most likely cause at top.
  const sortedCauses = useMemo(
    () => [...outlet.causes].sort((a, b) => b.confidence - a.confidence),
    [outlet.causes],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {outlet.outletName} — All Causes ({outlet.causes.length})
        </h4>
      </div>

      <div className="grid gap-2.5 lg:grid-cols-2">
        {sortedCauses.map((cause) => {
          const priority = getPriority(cause.confidence, cause.impactEstimate);
          return (
            <div
              key={cause.causeId}
              className={`rounded-lg border p-3 space-y-2 ${
                cause.causeId === outlet.topCause
                  ? 'border-amber-300 dark:border-amber-800/70 bg-amber-50/40 dark:bg-amber-950/20'
                  : 'border-border/60 bg-background/60'
              }`}
            >
              {/* Cause header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold">{cause.causeLabel}</span>
                    {cause.causeId === outlet.topCause && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1 font-medium text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/30">
                        TOP
                      </Badge>
                    )}
                    <span className={`inline-flex items-center justify-center rounded px-1 py-0.5 text-[9px] font-bold ${priority.color}`}>
                      {priority.label}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">{cause.causeId}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${confidenceColor(cause.confidence)}`}>
                    {(cause.confidence * 100).toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                    {fmtIDR(cause.impactEstimate)}
                  </div>
                </div>
              </div>

              {/* Confidence bar */}
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full ${confidenceBarColor(cause.confidence)} transition-all duration-300`}
                  style={{ width: `${Math.min(cause.confidence * 100, 100)}%` }}
                />
              </div>

              {/* Evidence list */}
              <div className="space-y-0.5">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Evidence</p>
                {cause.evidence.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`shrink-0 inline-flex items-center justify-center h-4 w-4 rounded-sm ${
                      ev.present
                        ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground/50'
                    }`}>
                      {ev.present ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    </span>
                    <span className={`flex-1 ${ev.present ? 'text-foreground' : 'text-muted-foreground/60 line-through'}`}>
                      {ev.label}
                    </span>
                    <span className="text-[9px] text-muted-foreground tabular-nums font-mono">
                      w={ev.weight.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Auto-action plan */}
              <div className="rounded-md bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-900/50 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300 mb-0.5">
                  Auto-Action Plan
                </p>
                <p className="text-[11px] text-blue-900 dark:text-blue-200 leading-relaxed">
                  {cause.autoAction}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const DiagnosisTab = memo(DiagnosisTabImpl);
