'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, AlertCircle } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPct, trendColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';

interface KPI {
  label: string;
  value: number | null;
  unit?: string;
  growth: number | null;
  previous?: number | null;
  inverse?: boolean;
  hint?: string;
}

function KPICard({ label, value, unit, growth, previous, inverse, hint }: KPI) {
  const growthStr = growth != null ? fmtPct(growth) : null;
  const Icon = growth == null ? Minus : growth > 0 ? TrendingUp : growth < 0 ? TrendingDown : Minus;
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide truncate">{label}</p>
          {growthStr && (
            <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${trendColor(growth, inverse)}`}>
              <Icon className="h-3 w-3" />
              {growthStr}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-xl font-bold tracking-tight">
          {unit === 'IDR' ? fmtIDR(value) : fmtNum(value, unit || '')}
        </p>
        {previous != null && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            vs {unit === 'IDR' ? fmtIDR(previous) : fmtNum(previous, unit || '')}
          </p>
        )}
        {hint && <p className="mt-1 text-[10px] text-muted-foreground/70 truncate">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function ExecutiveSummary({ data }: { data: AnalysisData }) {
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
        <KPICard label="Sales" value={s.sales.current} unit="IDR" growth={s.sales.growth} previous={s.sales.previous} />
        <KPICard label="Nominal Deviasi" value={s.nominalDeviasi.current} unit="IDR" growth={s.nominalDeviasi.growth} previous={s.nominalDeviasi.previous} inverse />
        <KPICard label="QTY BOM" value={s.qtyBom.current} unit="" growth={s.qtyBom.growth} previous={s.qtyBom.previous} />
        <KPICard label="QTY Deviasi" value={s.qtyDeviasi.current} unit="" growth={s.qtyDeviasi.growth} previous={s.qtyDeviasi.previous} inverse />
        <KPICard label="Waste + Susut + Trial" value={(s.qtyWaste.current || 0) + (s.qtySusut.current || 0) + (s.qtyTrial.current || 0)} unit="" growth={s.qtyWaste.growth} />
        <KPICard label="Loss/Surplus (QTY)" value={s.qtyLossSurplus.current} unit="" growth={s.qtyLossSurplus.growth} previous={s.qtyLossSurplus.previous} inverse hint={`Dev/BOM: ${fmtPct(s.deviationToBom, false)}`} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Total LOSS</p>
          <p className="text-base font-semibold text-red-600">{fmtIDR(s.totalLoss)}</p>
          <p className="text-xs text-muted-foreground">Loss/Sales: {fmtPct(s.lossToSales, false)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Total SURPLUS</p>
          <p className="text-base font-semibold text-emerald-600">{fmtIDR(s.totalSurplus)}</p>
          <p className="text-xs text-muted-foreground">Surplus/Sales: {fmtPct(s.surplusToSales, false)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Residual Loss (QTY)</p>
          <p className="text-base font-semibold text-amber-600">{fmtNum(s.residualLossQty)}</p>
          <p className="text-xs text-muted-foreground">{fmtPct(s.residualLossPct, false)} of deviation</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Deviation/BOM</p>
          <p className="text-base font-semibold">{fmtPct(s.deviationToBom, false)}</p>
          <p className="text-xs text-muted-foreground">normalized ratio</p>
        </CardContent></Card>
      </div>
    </div>
  );
}

export function HealthAlert({ data }: { data: AnalysisData }) {
  const { normal, warning, abnormal } = data.healthStatus;
  const total = normal + warning + abnormal;
  const dq = data.dqStatus;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span>Health &amp; Alert</span>
          <span className="text-xs font-normal text-muted-foreground">{total} records analyzed</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900 p-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{normal}</p>
            <p className="text-xs text-muted-foreground">Normal</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900 p-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
          <div>
            <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">{warning}</p>
            <p className="text-xs text-muted-foreground">Warning</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-3">
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
          <div>
            <p className="text-2xl font-bold text-red-700 dark:text-red-400">{abnormal}</p>
            <p className="text-xs text-muted-foreground">Abnormal</p>
          </div>
        </div>
      </CardContent>
      {(dq.errors > 0 || dq.warnings > 0) && (
        <div className="px-6 pb-3 -mt-1">
          <div className="flex items-center gap-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-muted-foreground">
              Data Quality: {dq.errors} errors, {dq.warnings} warnings
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
