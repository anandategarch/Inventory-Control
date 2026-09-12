'use client';

// ============================================================
//  ExecutiveStatus — L2 "EXECUTIVE STATUS" (VH-3 reskin, D1-c)
//  --------------------------------------------------------
//  Replaces the old ExecutiveSummary (6 KPI + 2 secondary
//  cards) + HealthAlert pair with the 4-KPI executive block
//  from MASTER-CONTEXT-VISUAL-HIERARCHY.md §4 L2:
//    1. DEVIASI (Rp)  — HERO text-4xl + single amber top marker
//    2. RESIDUAL (qty) — from the old "Residual Loss" card
//    3. DEV/BOM (%)    — from the old "Deviation/BOM" card
//    4. HEALTH (0-100) — score + verdict from the old HealthAlert
//       (same payload fields, same verdict thresholds)
//  + the mandatory GROSS → W/S/T → NET cascade strip (§50,
//  D1-c) as one compact row under the KPI grid.
//
//  Semantics (spec §10): the KPI grid is a real <dl> — dt is
//  the label (+ persistent InfoTooltip formula icon), dd is
//  the value + delta + caption. Cards reuse the ui Card +
//  the old KPICard anatomy (container-query @container/card
//  so values step up 2xl→3xl / 3xl→4xl by CARD width, not
//  viewport — same pattern as the old ExecutiveSummary).
//
//  All numbers come from the SAME /api/analysis payload
//  fields the old components read — no new data source.
// ============================================================

import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Minus, ArrowRight } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPct, numberColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { DeltaBar } from '@/components/dashboard/shared/DeltaBar';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { classifyDelta, deltaTypeColor } from '@/components/dashboard/shared/TargetComparison';

// Per-KPI formula tooltips (carried over verbatim from the old
// ExecutiveSummary KPI_TOOLTIPS so the wording stays identical).
const KPI_TOOLTIPS = {
  nominalDeviasi: 'Selisih aktual vs BOM. Negatif=LOSS, positif=SURPLUS.',
  residualLoss: 'Deviasi tidak terjelaskan. >70% = critical.',
  deviationBom: 'Volume-weighted: SUM(|qtyDeviasi|) / SUM(|qtyBom|).',
  health: 'Skor Kondisi Inventory = normal / total record × 100. KRITIS saat abnormal >20%, PERLU PERHATIAN saat abnormal >5% atau warning >15%.',
  cascade: 'Kaskade deviasi (Master Context §50): GROSS (Stok Fisik − Sistem) → dijelaskan oleh Waste+Susut+Trial → NET yang belum terjelaskan. Angka QTY.',
};

// ------------------------------------------------------------
//  Delta pill — same classifyDelta/deltaTypeColor logic the old
//  KPICard used (PATTERN-2 / TREMOR Pattern 6): 5-level delta
//  classification, strong vs moderate pill saturation.
// ------------------------------------------------------------
function DeltaPill({ growth, inverse }: { growth: number; inverse?: boolean }) {
  const deltaType = classifyDelta(growth);
  const colorCls = deltaTypeColor(deltaType, Boolean(inverse));
  // Pill strength mirrors the old KPICard: strong (increase/decrease) = full
  // saturation, moderate = lighter tint (amber = the project's "watch" hue).
  const strong = deltaType === 'increase' || deltaType === 'decrease' || deltaType === 'unchanged';
  const cls = colorCls.includes('emerald')
    ? strong
      ? 'bg-emerald-100/80 text-emerald-700'
      : 'bg-emerald-50/60 text-emerald-600'
    : colorCls.includes('red')
      ? strong
        ? 'bg-red-100/80 text-red-700'
        : 'bg-red-50/60 text-red-600'
      : colorCls.includes('amber')
        ? 'bg-amber-50/60 text-amber-700'
        : 'bg-muted text-muted-foreground';
  const Icon = deltaType === 'increase' ? TrendingUp : deltaType === 'decrease' ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums shrink-0 ${cls}`}>
      <Icon className="h-3 w-3" />
      {fmtPct(growth)}
    </span>
  );
}

// ------------------------------------------------------------
//  One KPI card — dt (label + tooltip) + dd (value + delta +
//  caption + bar). Rendered as the direct <div> child of the
//  grid <dl> so the description-list semantics stay valid.
// ------------------------------------------------------------
function KpiCard({ label, tooltip, value, valueCls, hero, pill, caption, bar }: {
  label: string;
  tooltip: string;
  value: string;
  valueCls?: string;
  hero?: boolean;
  pill?: React.ReactNode;
  caption?: React.ReactNode;
  bar?: React.ReactNode;
}) {
  return (
    <Card
      // SHADCN Pattern 2: @container/card so the value size responds to
      // the CARD's own width (old KPICard pattern, preserved).
      className={`@container/card gap-0 p-4 pt-3.5 ${hero ? 'border-t-2 border-t-amber-500' : ''}`}
    >
      <dt className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          <span className="truncate">{label}</span>
          <InfoTooltip content={tooltip} />
        </span>
        {pill}
      </dt>
      <dd className="mt-1.5 min-w-0">
        <p className={`font-bold tabular-nums tracking-tight ${
          hero ? 'text-3xl @[250px]/card:text-4xl' : 'text-2xl @[250px]/card:text-3xl'
        } ${valueCls ?? ''}`}>
          {value}
        </p>
        {caption && <p className="mt-0.5 truncate text-xs text-muted-foreground">{caption}</p>}
        {bar && <div className="mt-2">{bar}</div>}
      </dd>
    </Card>
  );
}

export const ExecutiveStatus = memo(function ExecutiveStatus({ data }: { data: AnalysisData }) {
  const s = data.executiveSummary;
  const hs = data.healthStatus;
  const dq = data.dqStatus;

  // Health score + verdict — same fields + thresholds as the old HealthAlert.
  const total = hs.normal + hs.warning + hs.abnormal;
  const healthScore = total > 0 ? Math.round((hs.normal / total) * 100) : 100;
  const abnormalPct = total > 0 ? (hs.abnormal / total) * 100 : 0;
  const warningPct = total > 0 ? (hs.warning / total) * 100 : 0;
  let verdict = 'SEHAT';
  let verdictColor = 'text-emerald-600';
  let verdictBar = 'bg-emerald-500';
  if (abnormalPct > 20) {
    verdict = 'KRITIS';
    verdictColor = 'text-red-600';
    verdictBar = 'bg-red-500';
  } else if (abnormalPct > 5 || warningPct > 15) {
    verdict = 'PERLU PERHATIAN';
    verdictColor = 'text-amber-700';
    verdictBar = 'bg-amber-500';
  }

  // "vs {pembanding}" caption — same period segments the old
  // ExecutiveSummary badge + DashboardHeader PeriodLabel use.
  const cmpWeek = data.period.comparisonWeek;
  const cmpMonth = data.period.comparisonMonth;
  const compareLabel = cmpWeek
    ? `vs ${cmpWeek}${cmpMonth && cmpMonth !== data.period.monthLabel ? ` ${cmpMonth}` : ''}`
    : null;

  // Cascade GROSS → W/S/T → NET (§50) — the same QTY fields the old
  // ExecutiveSummary's Gross/Explained/Net KPI cards read.
  const grossQty = Math.abs(s.qtyDeviasi.current ?? 0);
  const explainedQty = Math.abs((s.qtyWaste.current || 0) + (s.qtySusut.current || 0) + (s.qtyTrial.current || 0));
  const netQty = s.qtyLossSurplus.current ?? 0;
  const explainedPct = grossQty > 0 ? explainedQty / grossQty : null;

  return (
    <div className="space-y-4 min-w-0">
      {/* KPI grid — spec §4 L2: grid-cols-2 md:grid-cols-4 gap-4, <dl> semantics */}
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          label="Deviasi"
          tooltip={KPI_TOOLTIPS.nominalDeviasi}
          value={fmtIDR(s.nominalDeviasi.current)}
          hero
          pill={s.nominalDeviasi.growth != null ? (
            <DeltaPill growth={s.nominalDeviasi.growth} inverse />
          ) : undefined}
          caption={compareLabel ?? (s.nominalDeviasi.previous != null ? `vs ${fmtIDR(s.nominalDeviasi.previous)}` : undefined)}
          bar={s.nominalDeviasi.growth != null ? (
            <DeltaBar value={s.nominalDeviasi.growth * 100} isIncreasePositive={false} label="" showAnimation />
          ) : undefined}
        />
        <KpiCard
          label="Residual"
          tooltip={KPI_TOOLTIPS.residualLoss}
          value={fmtNum(s.residualLossQty, '')}
          valueCls="text-amber-700"
          caption={s.residualLossPct != null ? `${fmtPct(s.residualLossPct, false)} dari deviasi` : undefined}
        />
        <KpiCard
          label="Dev/BOM"
          tooltip={KPI_TOOLTIPS.deviationBom}
          value={fmtPct(s.deviationToBom, false)}
          caption="rasio ternormalisasi volume"
        />
        <KpiCard
          label="Health"
          tooltip={KPI_TOOLTIPS.health}
          value={String(healthScore)}
          valueCls={verdictColor}
          caption={
            <span className="tabular-nums">
              <span className={`font-semibold ${verdictColor}`}>{verdict}</span>
              {' · '}{fmtNum(total, '')} record
            </span>
          }
          bar={
            <>
              {/* Mini progress bar colored by verdict — score/100 width */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                <div className={`h-full ${verdictBar}`} style={{ width: `${healthScore}%` }} />
              </div>
              {(dq.errors > 0 || dq.warnings > 0) && (
                <p className="mt-1 text-[11px] text-amber-700 tabular-nums">
                  Data Quality: {dq.errors} error · {dq.warnings} warning
                </p>
              )}
            </>
          }
          pill={
            <QuickSettings
              settings={[
                { key: 'STD_DEVIASI_BOM_PCT', label: 'Toleransi Deviasi BOM', dataType: 'percent', min: 0, max: 1, step: 0.05 },
                { key: 'FALLBACK_TOLERANCE_PCT', label: 'Toleransi Fallback', dataType: 'percent', min: 0, max: 1, step: 0.05 },
              ]}
            />
          }
        />
      </dl>

      {/* Cascade strip GROSS → W/S/T → NET (§50 — WAJIB visible, one compact row,
          NOT a card). Same QTY fields as the old ExecutiveSummary cascade KPIs. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
        <span className="flex items-center gap-1 font-medium text-muted-foreground">
          Kaskade QTY Deviasi
          <InfoTooltip content={KPI_TOOLTIPS.cascade} />
        </span>
        <span className="font-semibold tabular-nums text-foreground" title="GROSS — Stok Fisik − Sistem">
          |GROSS| {fmtNum(grossQty, '')}
        </span>
        <ArrowRight className="h-3 w-3 text-muted-foreground/50" aria-hidden />
        <span className="tabular-nums text-muted-foreground" title="Waste + Susut + Trial — terjelaskan">
          W+S+T {fmtNum(explainedQty, '')}
          {explainedPct != null && <span className="ml-1 text-muted-foreground/70">({fmtPct(explainedPct, false, 0)})</span>}
        </span>
        <ArrowRight className="h-3 w-3 text-muted-foreground/50" aria-hidden />
        <span className={`font-semibold tabular-nums ${numberColor(netQty)}`} title="NET — belum terjelaskan (Residual)">
          NET {fmtNum(netQty, '')}
        </span>
      </div>
    </div>
  );
});
