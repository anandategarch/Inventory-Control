'use client';

import { memo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, formatByPreset } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  Lightbulb, TrendingUp, TrendingDown, AlertTriangle, Coins,
  MapPin, Package, ShieldAlert, Zap, ArrowRight, ChevronDown, ChevronUp,
} from 'lucide-react';

// ============================================================
//  Insight type & severity styling
//  VH-3 (spec §4 L4): callout-style cards — border-left only +
//  prose (Gestalt similarity: two shapes, two meanings — data
//  cards keep the full border, insights read as annotations).
//  critical border-red-500 bg-red-500/5, warning border-amber-400
//  bg-amber-50/40, positive emerald, info zinc.
// ============================================================
interface Insight {
  id: string;
  icon: React.ReactNode;
  severity: 'critical' | 'warning' | 'info' | 'positive';
  title: string;
  body: string;
  action?: string;
  actionTarget?: { type: 'area' | 'outlet' | 'item'; value: string };
}

const SEVERITY_STYLES: Record<Insight['severity'], {
  container: string;
  icon: string;
  title: string;
}> = {
  critical: {
    container: 'border-red-500 bg-red-500/5',
    icon: 'text-red-600 dark:text-red-400',
    title: 'text-red-700 dark:text-red-400',
  },
  warning: {
    container: 'border-amber-400 bg-amber-50/40 dark:bg-amber-950/20',
    icon: 'text-amber-600 dark:text-amber-400',
    title: 'text-amber-700 dark:text-amber-400',
  },
  info: {
    container: 'border-zinc-400 bg-zinc-50/40 dark:bg-zinc-900/20',
    icon: 'text-zinc-600 dark:text-zinc-300',
    title: 'text-zinc-700 dark:text-zinc-300',
  },
  positive: {
    container: 'border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20',
    icon: 'text-emerald-600 dark:text-emerald-400',
    title: 'text-emerald-700 dark:text-emerald-400',
  },
};

// VH-3 (spec §4 L4): at most 5 insight cards visible by default —
// the rest collapse behind an "N lainnya" expander (progressive
// disclosure; the summary count badges above stay complete).
const MAX_VISIBLE = 5;

// ============================================================
//  buildInsights — auto-generate up to 10 textual insights
// ============================================================
function buildInsights(data: AnalysisData): Insight[] {
  const out: Insight[] = [];
  const hs = data.healthStatus;
  const total = hs.normal + hs.warning + hs.abnormal;
  const abnormalPct = total > 0 ? (hs.abnormal / total) * 100 : 0;
  const g = data.growthComparison || {};

  // ----- 1. Health verdict -----
  if (abnormalPct > 20) {
    out.push({
      id: 'health',
      icon: <ShieldAlert className="h-4 w-4" />,
      severity: 'critical',
      title: 'Kondisi Inventory KRITIS',
      body: `${fmtPct(abnormalPct / 100, false, 1)} record abnormal (>20%). ${hs.abnormal.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} record memerlukan investigasi segera.`,
    });
  } else if (abnormalPct > 5) {
    out.push({
      id: 'health',
      icon: <AlertTriangle className="h-4 w-4" />,
      severity: 'warning',
      title: 'Kondisi Inventory Perlu Perhatian',
      body: `${fmtPct(abnormalPct / 100, false, 1)} record abnormal (5-20%). ${hs.abnormal.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} record perlu monitoring.`,
    });
  } else {
    out.push({
      id: 'health',
      icon: <Lightbulb className="h-4 w-4" />,
      severity: 'positive',
      title: 'Kondisi Inventory Sehat',
      body: `Hanya ${fmtPct(abnormalPct / 100, false, 1)} record abnormal (<5%). ${hs.normal.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} record dalam kondisi normal.`,
    });
  }

  // ----- 2. Growth mismatch (DEVIASI tumbuh jauh melebihi Sales) -----
  if (g.salesGrowth != null && g.salesGrowth > 0 && g.nominalDeviasiGrowth != null
      && g.nominalDeviasiGrowth > 2 * g.salesGrowth) {
    out.push({
      id: 'growth-mismatch',
      icon: <Zap className="h-4 w-4" />,
      severity: 'critical',
      title: 'Pertumbuhan DEVIASI Tidak Proporsional',
      body: `Sales tumbuh ${fmtPct(g.salesGrowth, true, 1)} tetapi |NOMINAL DEVIASI| tumbuh ${fmtPct(g.nominalDeviasiGrowth, true, 1)} (>2× sales). Indikasi cost leak yang tidak mengikuti pertumbuhan revenue.`,
    });
  }

  // ----- 3. RESIDUAL dominance -----
  const b = data.deviationBreakdown;
  const totalDev = b.total || 1;
  const residualPct = b.residual / totalDev;
  if (residualPct > 0.5) {
    out.push({
      id: 'residual',
      icon: <AlertTriangle className="h-4 w-4" />,
      severity: 'warning',
      title: 'RESIDUAL Dominan',
      body: `${fmtPct(residualPct, false, 1)} QTY Deviasi tidak terjelaskan oleh Waste/Susut/Trial. Perlu validasi actual usage vs SOC dan sampling fisik.`,
    });
  }

  // ----- 4. Worst area -----
  const areas = data.areaAnalysis || [];
  if (areas.length >= 2) {
    const sorted = [...areas].sort((a, b) => (b.lossToSales ?? 0) - (a.lossToSales ?? 0));
    const worst = sorted[0];
    const best = sorted[sorted.length - 1];
    const worstPct = (worst.lossToSales ?? 0) * 100;
    const bestPct = (best.lossToSales ?? 0) * 100;
    // ppt gap between the worst and best area (percent points, not a ratio).
    const delta = worstPct - bestPct;
    const sev: Insight['severity'] = worstPct > 10 ? 'critical' : worstPct > 5 ? 'warning' : 'info';
    out.push({
      id: 'area-worst',
      icon: <MapPin className="h-4 w-4" />,
      severity: sev,
      title: `Area Terburuk: ${worst.area}`,
      body: `LOSS/PENJUALAN ${fmtPct(worst.lossToSales ?? 0, false, 2)} (vs ${best.area} ${fmtPct(best.lossToSales ?? 0, false, 2)}). Selisih ${delta > 0 ? '+' : ''}${formatByPreset(delta, 'num2')} ppt. ${worst.outletCount} outlet di area ini.`,
      action: `Fokus ke ${worst.area}`,
      actionTarget: { type: 'area', value: worst.area },
    });
  }

  // ----- 5. Cost impact -----
  const ci = data.costImpact;
  if (ci) {
    const pct = (ci.pctOfSales ?? 0) * 100;
    const sev: Insight['severity'] = pct > 5 ? 'critical' : pct > 2 ? 'warning' : 'info';
    out.push({
      id: 'cost-impact',
      icon: <Coins className="h-4 w-4" />,
      severity: sev,
      title: 'Biaya Bocor',
      body: `Total |NOMINAL DEVIASI| ${fmtIDR(ci.totalCost)} setara ${fmtPct(ci.pctOfSales ?? 0, false, 2)} dari PENJUALAN. LOSS ${fmtIDR(ci.lossNominal)} · SURPLUS ${fmtIDR(ci.surplusNominal)}.`,
    });
  }

  // ----- 6. Massal item (was "Systemic") -----
  const consistency = data.itemConsistencyAnalysis;
  if (consistency && consistency.systemic.length > 0) {
    const top = consistency.systemic[0];
    out.push({
      id: 'systemic',
      icon: <Package className="h-4 w-4" />,
      severity: 'critical',
      title: `Item Massal: ${top.itemName}`,
      body: `${top.itemName} muncul dengan deviation signifikan di ${top.occurrences} outlet. Pola recurring — kemungkinan masalah struktural (SOC/recipe/receiving).`,
      action: 'Drill-down item',
      actionTarget: { type: 'item', value: top.itemName },
    });
  }

  // ----- 7. Net cost trend -----
  const nct = data.netCostTrend || [];
  if (nct.length >= 2) {
    const first = nct[0];
    const last = nct[nct.length - 1];
    const delta = (last.netCostRatio - first.netCostRatio) * 100;
    if (delta > 0.5) {
      out.push({
        id: 'nct-worsening',
        icon: <TrendingDown className="h-4 w-4" />,
        severity: 'warning',
        title: 'Tren Biaya Neto Memburuk',
        body: `Net cost ratio naik dari ${fmtPct(first.netCostRatio, false, 2)} → ${fmtPct(last.netCostRatio, false, 2)} (+${formatByPreset(delta, 'num2')} ppt). LOSS meningkat lebih cepat dari SURPLUS.`,
      });
    } else if (delta < -0.5) {
      out.push({
        id: 'nct-improving',
        icon: <TrendingUp className="h-4 w-4" />,
        severity: 'positive',
        title: 'Tren Biaya Neto Membaik',
        body: `Net cost ratio turun dari ${fmtPct(first.netCostRatio, false, 2)} → ${fmtPct(last.netCostRatio, false, 2)} (${formatByPreset(delta, 'num2')} ppt). Investigasi mitigasi berhasil atau SURPLUS naik.`,
      });
    }
  }

  // ----- 8. LOSS/SURPLUS balance -----
  const lvs = data.lossVsSurplus;
  const totalLS = lvs.lossNominal + lvs.surplusNominal;
  if (totalLS > 0) {
    const lossShare = lvs.lossNominal / totalLS;
    if (lossShare > 0.70) {
      out.push({
        id: 'loss-dominance',
        icon: <TrendingDown className="h-4 w-4" />,
        severity: 'warning',
        title: 'Dominasi LOSS',
        body: `${fmtPct(lossShare, false, 1)} nominal deviation adalah LOSS (pemakaian aktual > SOC). Hanya ${fmtPct(1 - lossShare, false, 1)} SURPLUS. Fokus pada pencegahan over-usage.`,
      });
    } else if (lossShare < 0.40) {
      out.push({
        id: 'surplus-dominance',
        icon: <TrendingUp className="h-4 w-4" />,
        severity: 'warning',
        title: 'Dominasi SURPLUS',
        body: `${fmtPct(1 - lossShare, false, 1)} nominal deviation adalah SURPLUS (pemakaian aktual < SOC). Hanya ${fmtPct(lossShare, false, 1)} LOSS. Periksa apakah SOC terlalu tinggi atau ada under-reporting.`,
      });
    }
  }

  // ----- 9. Historical anomaly -----
  const histAnalysis = g.historicalAnalysis;
  if (histAnalysis && histAnalysis.criticalItems.length > 0) {
    const top = histAnalysis.criticalItems[0];
    out.push({
      id: 'historical-anomaly',
      icon: <AlertTriangle className="h-4 w-4" />,
      severity: 'critical',
      title: `Anomali Historical: ${top.outletCode}`,
      body: `${top.itemName} di ${top.outletCode} (${top.area}) memiliki z-score ${formatByPreset(top.zScore, 'num2')} vs rata-rata historical. Current Dev/BOM ${fmtPct(top.currentDevBom, false, 1)} vs rata-rata ${fmtPct(top.historicalAvg, false, 1)}.`,
      action: 'Drill-down item',
      actionTarget: { type: 'item', value: top.itemName },
    });
  }

  return out;
}

// ============================================================
//  InsightsPanel — main component
// ============================================================
export const InsightsPanel = memo(function InsightsPanel({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  const setOutlet = useDashboard((s) => s.setOutlet);
  const setScorecardOutlet = useDashboard((s) => s.setScorecardOutlet);
  const setItem = useDashboard((s) => s.setItem);
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);
  // VH-3 (spec §4 L4): ≤5 cards visible by default, "N lainnya" expander
  // for the rest.
  const [showAll, setShowAll] = useState(false);

  const insights = buildInsights(data);
  const counts = {
    critical: insights.filter((i) => i.severity === 'critical').length,
    warning: insights.filter((i) => i.severity === 'warning').length,
    info: insights.filter((i) => i.severity === 'info').length,
    positive: insights.filter((i) => i.severity === 'positive').length,
  };
  const visible = showAll ? insights : insights.slice(0, MAX_VISIBLE);
  const hiddenCount = insights.length - visible.length;

  const onAction = (insight: Insight) => {
    if (!insight.actionTarget) return;
    const { type, value } = insight.actionTarget;
    if (type === 'area') {
      setArea(value);
    } else if (type === 'outlet') {
      setOutlet(value);
      setScorecardOutlet(value);
      setDrilldown({ outletCode: value, itemName: null });
    } else if (type === 'item') {
      setItem(value);
      setDeepDiveItem({ itemName: value, outletCode: null });
      setDrilldown({ outletCode: null, itemName: value });
    }
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3 border-b">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-start gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
              <Lightbulb className="h-3.5 w-3.5" />
            </span>
            <div>
              <CardTitle className="text-sm">Insight Otomatis</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                <span className="font-medium tabular-nums">{insights.length}</span> insight dari analisis periode <span className="font-medium">{data.period.weekLabel} {data.period.monthLabel}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {counts.critical > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-red-300 text-red-700 dark:border-red-800 dark:text-red-400 bg-red-50/50 dark:bg-red-950/30 font-medium">
                Kritis: <span className="tabular-nums">{counts.critical}</span>
              </Badge>
            )}
            {counts.warning > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/30 font-medium">
                Warning: <span className="tabular-nums">{counts.warning}</span>
              </Badge>
            )}
            {counts.positive > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/30 font-medium">
                Positif: <span className="tabular-nums">{counts.positive}</span>
              </Badge>
            )}
            {counts.info > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300 bg-zinc-50/50 dark:bg-zinc-900/30 font-medium">
                Info: <span className="tabular-nums">{counts.info}</span>
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {insights.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground/50 mb-3">
              <Lightbulb className="h-6 w-6" />
            </div>
            <p className="text-sm text-muted-foreground">Tidak ada insight yang dapat dihasilkan dari data ini.</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {visible.map((insight) => {
              const style = SEVERITY_STYLES[insight.severity];
              return (
                // VH-3 (spec §4 L4): callout anatomy — border-left accent +
                // tint, no icon chip / lift / full border (that chrome now
                // belongs to DATA cards; insights read as annotations).
                <div
                  key={insight.id}
                  className={`rounded-r-lg border-l-4 p-3 pl-4 flex items-start gap-2.5 ${style.container}`}
                >
                  <span className={`shrink-0 mt-0.5 ${style.icon}`}>{insight.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${style.title}`}>{insight.title}</p>
                    <p className="text-sm leading-relaxed text-foreground/90 mt-1">{insight.body}</p>
                    {insight.action && insight.actionTarget && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 mt-2 px-2 text-xs hover:bg-foreground/5"
                        onClick={() => onAction(insight)}
                      >
                        {insight.action}
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* "N lainnya" expander — progressive disclosure for the tail */}
        {insights.length > MAX_VISIBLE && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 h-7 px-2 text-xs text-muted-foreground"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
          >
            {showAll ? (
              <>
                <ChevronUp className="h-3.5 w-3.5 mr-1" />
                Tampilkan lebih sedikit
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5 mr-1" />
                Tampilkan {hiddenCount} insight lainnya
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
});
