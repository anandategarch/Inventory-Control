'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, AlertCircle, Activity, Info, BarChart3 } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPct } from '@/lib/format';
import { useDashboard } from '@/hooks/useDashboard';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { clickableRowProps } from '@/lib/a11y';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

// ============================================================
//  Rule category labels (Indonesian, human-readable)
// ============================================================
const CATEGORY_LABELS: Record<string, string> = {
  SALES: 'Sales vs Deviasi Mismatch',
  BOM: 'BOM vs Deviasi Mismatch',
  TOLERANCE: 'Breach Tolerance',
  RESIDUAL: 'Residual Loss Tinggi',
  DIRECTION: 'Nominal Loss Tinggi',
  BENCHMARK: 'Benchmark Outlet',
  HISTORICAL: 'Abnormal vs Historical',
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  SALES: 'Deviasi growth jauh melebihi sales growth',
  BOM: 'Deviasi growth jauh melebihi BOM growth',
  TOLERANCE: 'Deviation/BOM melebihi tolerance yang diset',
  RESIDUAL: 'Sisa deviation setelah dikurangi Waste/Susut/Trial tinggi',
  DIRECTION: 'Nominal loss absolut tinggi',
  BENCHMARK: 'Outlet menyimpang dari rata-rata area/semua resto',
  HISTORICAL: 'Pola deviation abnormal vs historical behavior',
};

interface KPI {
  label: string;
  value: number | null;
  unit?: string;
  growth?: number | null;
  previous?: number | null;
  inverse?: boolean;
  hint?: string;
  drillDown?: string; // card key for drill-down modal
}

function KPICard({ label, value, unit, growth, previous, inverse, hint, drillDown }: KPI) {
  const { setCardDrillDown } = useDashboard();
  const growthStr = growth != null ? fmtPct(growth) : null;
  const Icon = growth == null ? Minus : growth > 0 ? TrendingUp : growth < 0 ? TrendingDown : Minus;
  // Pill color based on direction (respects inverse flag for "bad when up" metrics)
  const pillCls =
    growth == null ? 'bg-muted text-muted-foreground'
    : growth > 0
      ? (inverse ? 'bg-red-100/80 text-red-700 dark:bg-red-950/40 dark:text-red-400' : 'bg-emerald-100/80 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400')
      : growth < 0
        ? (inverse ? 'bg-emerald-100/80 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-red-100/80 text-red-700 dark:bg-red-950/40 dark:text-red-400')
        : 'bg-muted text-muted-foreground';
  return (
    <Card
      className={`relative overflow-hidden transition-all duration-200 shadow-sm dark:shadow-black/20 ${drillDown ? 'cursor-pointer hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/30 hover:-translate-y-0.5 hover:border-amber-300/60 dark:hover:border-amber-800/60' : ''}`}
      {...(drillDown ? clickableRowProps(() => setCardDrillDown(drillDown)) : {})}
    >
      {/* Subtle top accent line */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/10 to-transparent" aria-hidden />
      <CardContent className="p-4 pt-3.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider line-clamp-2 leading-tight" title={label}>{label}</p>
          {growthStr && (
            <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold shrink-0 rounded-full px-1.5 py-0.5 ${pillCls}`}>
              <Icon className="h-2.5 w-2.5" />
              {growthStr}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-xl font-bold tracking-tight tabular-nums">
          {unit === 'IDR' ? fmtIDR(value) : fmtNum(value, unit || '')}
        </p>
        {previous != null && (
          <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            vs {unit === 'IDR' ? fmtIDR(previous) : fmtNum(previous, unit || '')}
          </p>
        )}
        {hint && <p className="mt-1 text-[10px] text-muted-foreground/70 line-clamp-1" title={hint}>{hint}</p>}
        {drillDown && (
          <p className="mt-1.5 text-[10px] text-muted-foreground/60 inline-flex items-center gap-0.5">
            <BarChart3 className="h-2.5 w-2.5" /> Detail
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function ExecutiveSummary({ data }: { data: AnalysisData }) {
  const { setCardDrillDown } = useDashboard();
  const s = data.executiveSummary;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-base font-semibold tracking-tight">Executive Summary</h2>
        </div>
        <Badge variant="outline" className="text-[11px] font-medium text-muted-foreground/80 tabular-nums h-6">
          {data.period.weekLabel} {data.period.monthLabel}
          {data.period.comparisonWeek ? ` vs ${data.period.comparisonWeek}${data.period.comparisonMonth && data.period.comparisonMonth !== data.period.monthLabel ? ` ${data.period.comparisonMonth}` : ''}` : ''}
        </Badge>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KPICard label="Sales" value={s.sales.current} unit="IDR" growth={s.sales.growth} previous={s.sales.previous} drillDown="sales" />
        <KPICard label="Nominal Deviasi" value={s.nominalDeviasi.current} unit="IDR" growth={s.nominalDeviasi.growth} previous={s.nominalDeviasi.previous} inverse drillDown="nominalDeviasi" />
        <KPICard label="QTY BOM" value={s.qtyBom.current} unit="" growth={s.qtyBom.growth} previous={s.qtyBom.previous} drillDown="qtyBom" />
        {/* Bug 5 fix: Three-layer deviation labels — Gross / Explained / Net */}
        <KPICard label="Gross Deviation (QTY)" value={s.qtyDeviasi.current} unit="" growth={s.qtyDeviasi.growth} previous={s.qtyDeviasi.previous} inverse hint="Layer 1: Stok Fisik - Sistem" drillDown="qtyDeviasi" />
        <KPICard label="Explained (W+S+T)" value={Math.abs((s.qtyWaste.current || 0) + (s.qtySusut.current || 0) + (s.qtyTrial.current || 0))} unit="" hint="Layer 2: Waste + Susut + Trial" drillDown="waste" />
        <KPICard label="Net Loss/Surplus (QTY)" value={s.qtyLossSurplus.current} unit="" growth={s.qtyLossSurplus.growth} previous={s.qtyLossSurplus.previous} inverse hint={`Layer 3: Gross - Explained | Dev/BOM: ${fmtPct(s.deviationToBom, false)}`} drillDown="lossSurplus" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
        <Card className="cursor-pointer hover:shadow-lg hover:shadow-red-500/10 dark:hover:shadow-black/30 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden relative bg-gradient-to-br from-red-50/40 to-transparent dark:from-red-950/20 border-red-200/50 dark:border-red-900/50" {...clickableRowProps(() => setCardDrillDown('loss'))}>
          <div className="absolute inset-y-0 left-0 w-0.5 bg-red-500/60" aria-hidden />
          <CardContent className="p-3.5 pl-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Total LOSS</p>
              <TrendingDown className="h-3 w-3 text-red-500/70" />
            </div>
            <p className="text-base font-bold text-red-600 dark:text-red-400 tabular-nums mt-0.5">{fmtIDR(s.totalLoss)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Loss/Sales: <span className="font-medium tabular-nums">{fmtPct(s.lossToSales, false)}</span></p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-lg hover:shadow-emerald-500/10 dark:hover:shadow-black/30 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden relative bg-gradient-to-br from-emerald-50/40 to-transparent dark:from-emerald-950/20 border-emerald-200/50 dark:border-emerald-900/50" {...clickableRowProps(() => setCardDrillDown('surplus'))}>
          <div className="absolute inset-y-0 left-0 w-0.5 bg-emerald-500/60" aria-hidden />
          <CardContent className="p-3.5 pl-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Total SURPLUS</p>
              <TrendingUp className="h-3 w-3 text-emerald-500/70" />
            </div>
            <p className="text-base font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-0.5">{fmtIDR(s.totalSurplus)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Surplus/Sales: <span className="font-medium tabular-nums">{fmtPct(s.surplusToSales, false)}</span></p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-lg hover:shadow-amber-500/10 dark:hover:shadow-black/30 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden relative bg-gradient-to-br from-amber-50/40 to-transparent dark:from-amber-950/20 border-amber-200/50 dark:border-amber-900/50" {...clickableRowProps(() => setCardDrillDown('lossSurplus'))}>
          <div className="absolute inset-y-0 left-0 w-0.5 bg-amber-500/60" aria-hidden />
          <CardContent className="p-3.5 pl-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Residual Loss</p>
              <AlertTriangle className="h-3 w-3 text-amber-500/70" />
            </div>
            <p className="text-base font-bold text-amber-600 dark:text-amber-400 tabular-nums mt-0.5">{fmtNum(s.residualLossQty)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5"><span className="font-medium tabular-nums">{fmtPct(s.residualLossPct, false)}</span> of deviation</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-lg dark:hover:shadow-black/30 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden relative bg-gradient-to-br from-zinc-50/40 to-transparent dark:from-zinc-900/20 border-zinc-200/50 dark:border-zinc-800/50" {...clickableRowProps(() => setCardDrillDown('qtyDeviasi'))}>
          <div className="absolute inset-y-0 left-0 w-0.5 bg-zinc-400/60" aria-hidden />
          <CardContent className="p-3.5 pl-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Deviation/BOM</p>
              <BarChart3 className="h-3 w-3 text-muted-foreground/70" />
            </div>
            <p className="text-base font-bold tabular-nums mt-0.5">{fmtPct(s.deviationToBom, false)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">normalized ratio</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function HealthAlert({ data }: { data: AnalysisData }) {
  const { normal, warning, abnormal, breakdown } = data.healthStatus;
  const total = normal + warning + abnormal;
  const dq = data.dqStatus;
  const s = data.executiveSummary;

  // Compute health score (0-100, higher = healthier)
  const healthScore = total > 0 ? Math.round((normal / total) * 100) : 100;
  const abnormalPct = total > 0 ? (abnormal / total) * 100 : 0;
  const warningPct = total > 0 ? (warning / total) * 100 : 0;

  // Top issue categories (sorted desc)
  const categoryList = breakdown?.byCategory
    ? Object.entries(breakdown.byCategory)
        .map(([cat, count]) => ({ cat, count }))
        .sort((a, b) => b.count - a.count)
    : [];

  // Health verdict
  let verdict = 'SEHAT';
  let verdictColor = 'text-emerald-600 dark:text-emerald-400';
  let verdictBg = 'bg-gradient-to-br from-emerald-50 to-emerald-50/40 border-emerald-200/70 dark:from-emerald-950/40 dark:to-emerald-950/10 dark:border-emerald-900/60';
  let verdictRing = 'ring-emerald-500/30';
  let scoreColor = 'text-emerald-600 dark:text-emerald-400';
  let scoreStroke = 'stroke-emerald-500';
  if (abnormalPct > 20) {
    verdict = 'KRITIS';
    verdictColor = 'text-red-600 dark:text-red-400';
    verdictBg = 'bg-gradient-to-br from-red-50 to-red-50/40 border-red-200/70 dark:from-red-950/40 dark:to-red-950/10 dark:border-red-900/60';
    verdictRing = 'ring-red-500/30';
    scoreColor = 'text-red-600 dark:text-red-400';
    scoreStroke = 'stroke-red-500';
  } else if (abnormalPct > 5 || warningPct > 15) {
    verdict = 'PERLU PERHATIAN';
    verdictColor = 'text-amber-600 dark:text-amber-400';
    verdictBg = 'bg-gradient-to-br from-amber-50 to-amber-50/40 border-amber-200/70 dark:from-amber-950/40 dark:to-amber-950/10 dark:border-amber-900/60';
    verdictRing = 'ring-amber-500/30';
    scoreColor = 'text-amber-600 dark:text-amber-400';
    scoreStroke = 'stroke-amber-500';
  }

  // Circular progress (SVG ring) for health score
  const radius = 26;
  const circ = 2 * Math.PI * radius;
  const dash = (healthScore / 100) * circ;

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
              <Activity className="h-3.5 w-3.5" />
            </span>
            Health &amp; Alert
          </span>
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs font-normal text-muted-foreground cursor-help flex items-center gap-1 tabular-nums">
                    {total.toLocaleString()} records
                    <Info className="h-3 w-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="text-xs">Total record yang dianalisis untuk periode {data.period.weekLabel} {data.period.monthLabel}.</p>
                  <p className="text-xs mt-1">Normal + Warning + Abnormal = Total records.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <QuickSettings
              settings={[
                { key: 'STD_DEVIASI_BOM_PCT', label: 'Toleransi Deviasi BOM', dataType: 'percent', min: 0, max: 1, step: 0.05 },
                { key: 'FALLBACK_TOLERANCE_PCT', label: 'Toleransi Fallback', dataType: 'percent', min: 0, max: 1, step: 0.05 },
              ]}
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Health Verdict Banner — with circular progress ring */}
        <div className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${verdictBg}`}>
          <div className="flex items-center gap-3 min-w-0">
            {/* Circular progress ring */}
            <div className={`relative h-14 w-14 shrink-0 rounded-full bg-background/60 ring-2 ${verdictRing} flex items-center justify-center`}>
              <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64" aria-hidden>
                <circle cx="32" cy="32" r={radius} className="fill-none stroke-muted/50" strokeWidth="4" />
                <circle
                  cx="32" cy="32" r={radius}
                  className={`fill-none ${scoreStroke}`}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={`${dash} ${circ}`}
                />
              </svg>
              <span className={`text-sm font-bold tabular-nums ${scoreColor}`}>{healthScore}</span>
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-bold ${verdictColor}`}>{verdict}</p>
              <p className="text-[11px] text-muted-foreground">Skor Kondisi Inventory</p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Abnormal Rate</p>
            <p className={`text-lg font-bold tabular-nums ${abnormalPct > 20 ? 'text-red-600 dark:text-red-400' : abnormalPct > 5 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {abnormalPct.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Status counts with progress bar */}
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 dark:bg-emerald-950/30 dark:border-emerald-900/60 p-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400 leading-none tabular-nums">{normal.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Normal</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-amber-200/70 bg-amber-50/60 dark:bg-amber-950/30 dark:border-amber-900/60 p-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-amber-700 dark:text-amber-400 leading-none tabular-nums">{warning.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Warning</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-red-200/70 bg-red-50/60 dark:bg-red-950/30 dark:border-red-900/60 p-2">
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-red-700 dark:text-red-400 leading-none tabular-nums">{abnormal.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Abnormal</p>
              </div>
            </div>
          </div>

          {/* Stacked progress bar */}
          <div className="flex h-2 rounded-full overflow-hidden bg-muted">
            {/* BUG 3.7 fix: guard against total=0 (division by zero → NaN%) */}
            <div className="bg-emerald-500 transition-all duration-500" style={{ width: `${total > 0 ? (normal / total) * 100 : 0}%` }} />
            <div className="bg-amber-500 transition-all duration-500" style={{ width: `${total > 0 ? (warning / total) * 100 : 0}%` }} />
            <div className="bg-red-500 transition-all duration-500" style={{ width: `${total > 0 ? (abnormal / total) * 100 : 0}%` }} />
          </div>
        </div>

        {/* Top Issue Categories */}
        {categoryList.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Kategori Masalah Utama</p>
            <div className="space-y-1.5">
              {categoryList.slice(0, 4).map(({ cat, count }) => {
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={cat} className="flex items-center gap-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[11px] text-foreground/80 w-32 sm:w-44 truncate cursor-help" title={CATEGORY_LABELS[cat] || cat}>{CATEGORY_LABELS[cat] || cat}</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs font-medium">{CATEGORY_LABELS[cat] || cat}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{CATEGORY_DESCRIPTIONS[cat] || ''}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-red-400 to-red-500 transition-all duration-500" style={{ width: `${Math.min(pct * 5, 100)}%` }} />
                    </div>
                    <span className="text-[11px] font-medium text-muted-foreground w-8 text-right tabular-nums">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick Financial Impact Summary */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t">
          <div className="rounded-md p-1.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Total LOSS</p>
            <p className="text-sm font-bold text-red-600 dark:text-red-400 tabular-nums">{fmtIDR(s.totalLoss)}</p>
            <p className="text-[10px] text-muted-foreground tabular-nums">{fmtPct(s.lossToSales, false)} of Sales</p>
          </div>
          <div className="rounded-md p-1.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Total SURPLUS</p>
            <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtIDR(s.totalSurplus)}</p>
            <p className="text-[10px] text-muted-foreground tabular-nums">{fmtPct(s.surplusToSales, false)} of Sales</p>
          </div>
        </div>

        {/* DQ status */}
        {(dq.errors > 0 || dq.warnings > 0) && (
          <div className="flex items-center gap-2 text-xs pt-2 border-t">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <span className="text-muted-foreground">
              Data Quality: <span className="font-medium text-amber-700 dark:text-amber-400 tabular-nums">{dq.errors} errors</span>, <span className="font-medium text-amber-700 dark:text-amber-400 tabular-nums">{dq.warnings} warnings</span>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
