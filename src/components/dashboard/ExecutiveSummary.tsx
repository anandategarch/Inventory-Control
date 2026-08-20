'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, AlertCircle, Activity, ShieldCheck, ShieldAlert, Info } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPct, trendColor } from '@/lib/format';
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
  BENCHMARK: 'Outlet menyimpang dari rata-rata area/network',
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
  return (
    <Card
      className={`relative overflow-hidden transition-all ${drillDown ? 'cursor-pointer hover:ring-2 hover:ring-primary/30 hover:shadow-md' : ''}`}
      {...(drillDown ? clickableRowProps(() => setCardDrillDown(drillDown)) : {})}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide line-clamp-2 leading-tight" title={label}>{label}</p>
          {growthStr && (
            <span className={`inline-flex items-center gap-0.5 text-xs font-semibold shrink-0 ${trendColor(growth, inverse)}`}>
              <Icon className="h-3 w-3" />
              {growthStr}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-lg font-bold tracking-tight">
          {unit === 'IDR' ? fmtIDR(value) : fmtNum(value, unit || '')}
        </p>
        {previous != null && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            vs {unit === 'IDR' ? fmtIDR(previous) : fmtNum(previous, unit || '')}
          </p>
        )}
        {hint && <p className="mt-1 text-[11px] text-muted-foreground/70 line-clamp-1" title={hint}>{hint}</p>}
        {drillDown && <p className="mt-1 text-[11px] text-primary/60">📊 Detail</p>}
      </CardContent>
    </Card>
  );
}

export function ExecutiveSummary({ data }: { data: AnalysisData }) {
  const { setCardDrillDown } = useDashboard();
  const s = data.executiveSummary;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Executive Summary</h2>
        <Badge variant="outline" className="text-xs">
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="cursor-pointer hover:ring-2 hover:ring-primary/30 hover:shadow-md transition-all" {...clickableRowProps(() => setCardDrillDown('loss'))}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Total LOSS</p>
            <p className="text-base font-semibold text-red-600">{fmtIDR(s.totalLoss)}</p>
            <p className="text-xs text-muted-foreground">Loss/Sales: {fmtPct(s.lossToSales, false)}</p>
            <p className="mt-1 text-[11px] text-primary/60">📊 Detail</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:ring-2 hover:ring-primary/30 hover:shadow-md transition-all" {...clickableRowProps(() => setCardDrillDown('surplus'))}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Total SURPLUS</p>
            <p className="text-base font-semibold text-emerald-600">{fmtIDR(s.totalSurplus)}</p>
            <p className="text-xs text-muted-foreground">Surplus/Sales: {fmtPct(s.surplusToSales, false)}</p>
            <p className="mt-1 text-[11px] text-primary/60">📊 Detail</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:ring-2 hover:ring-primary/30 hover:shadow-md transition-all" {...clickableRowProps(() => setCardDrillDown('lossSurplus'))}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Residual Loss (QTY)</p>
            <p className="text-base font-semibold text-amber-600">{fmtNum(s.residualLossQty)}</p>
            <p className="text-xs text-muted-foreground">{fmtPct(s.residualLossPct, false)} of deviation</p>
            <p className="mt-1 text-[11px] text-primary/60">📊 Detail</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:ring-2 hover:ring-primary/30 hover:shadow-md transition-all" {...clickableRowProps(() => setCardDrillDown('qtyDeviasi'))}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Deviation/BOM</p>
            <p className="text-base font-semibold">{fmtPct(s.deviationToBom, false)}</p>
            <p className="text-xs text-muted-foreground">normalized ratio</p>
            <p className="mt-1 text-[11px] text-primary/60">📊 Detail</p>
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
  let verdictColor = 'text-emerald-600';
  let verdictBg = 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900';
  let verdictIcon = <ShieldCheck className="h-5 w-5" />;
  if (abnormalPct > 20) {
    verdict = 'KRITIS';
    verdictColor = 'text-red-600';
    verdictBg = 'bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-900';
    verdictIcon = <ShieldAlert className="h-5 w-5" />;
  } else if (abnormalPct > 5 || warningPct > 15) {
    verdict = 'PERLU PERHATIAN';
    verdictColor = 'text-amber-600';
    verdictBg = 'bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900';
    verdictIcon = <AlertTriangle className="h-5 w-5" />;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Health &amp; Alert
          </span>
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs font-normal text-muted-foreground cursor-help flex items-center gap-1">
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
        {/* Health Verdict Banner */}
        <div className={`flex items-center justify-between rounded-lg border p-3 ${verdictBg}`}>
          <div className="flex items-center gap-2">
            <span className={verdictColor}>{verdictIcon}</span>
            <div>
              <p className={`text-sm font-bold ${verdictColor}`}>{verdict}</p>
              <p className="text-[11px] text-muted-foreground">Skor Kondisi Inventory: {healthScore}/100</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Abnormal Rate</p>
            <p className={`text-sm font-bold ${abnormalPct > 20 ? 'text-red-600' : abnormalPct > 5 ? 'text-amber-600' : 'text-emerald-600'}`}>
              {abnormalPct.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Status counts with progress bar */}
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900 p-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400 leading-none">{normal.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Normal</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900 p-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-amber-700 dark:text-amber-400 leading-none">{warning.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Warning</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-2">
              <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-red-700 dark:text-red-400 leading-none">{abnormal.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Abnormal</p>
              </div>
            </div>
          </div>

          {/* Stacked progress bar */}
          <div className="flex h-2 rounded-full overflow-hidden bg-muted">
            {/* BUG 3.7 fix: guard against total=0 (division by zero → NaN%) */}
            <div className="bg-emerald-500" style={{ width: `${total > 0 ? (normal / total) * 100 : 0}%` }} />
            <div className="bg-amber-500" style={{ width: `${total > 0 ? (warning / total) * 100 : 0}%` }} />
            <div className="bg-red-500" style={{ width: `${total > 0 ? (abnormal / total) * 100 : 0}%` }} />
          </div>
        </div>

        {/* Top Issue Categories */}
        {categoryList.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Kategori Masalah Utama</p>
            <div className="space-y-1">
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
                      <div className="h-full bg-red-400" style={{ width: `${Math.min(pct * 5, 100)}%` }} />
                    </div>
                    <span className="text-[11px] font-medium text-muted-foreground w-8 text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick Financial Impact Summary */}
        <div className="grid grid-cols-2 gap-2 pt-1 border-t">
          <div>
            <p className="text-[11px] text-muted-foreground">Total LOSS</p>
            <p className="text-sm font-semibold text-red-600">{fmtIDR(s.totalLoss)}</p>
            <p className="text-[11px] text-muted-foreground">{fmtPct(s.lossToSales, false)} of Sales</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Total SURPLUS</p>
            <p className="text-sm font-semibold text-emerald-600">{fmtIDR(s.totalSurplus)}</p>
            <p className="text-[11px] text-muted-foreground">{fmtPct(s.surplusToSales, false)} of Sales</p>
          </div>
        </div>

        {/* DQ status */}
        {(dq.errors > 0 || dq.warnings > 0) && (
          <div className="flex items-center gap-2 text-xs pt-1 border-t">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <span className="text-muted-foreground">
              Data Quality: {dq.errors} errors, {dq.warnings} warnings
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
