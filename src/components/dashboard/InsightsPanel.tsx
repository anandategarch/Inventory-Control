'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  Lightbulb, TrendingUp, TrendingDown, AlertTriangle, Target, Coins,
  MapPin, Package, ShieldAlert, Zap, ArrowRight,
} from 'lucide-react';

// ============================================================
//  Insight type & severity styling
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
  border: string;
  bg: string;
  iconBg: string;
  title: string;
  badge: string;
}> = {
  critical: {
    border: 'border-red-200/50 dark:border-red-900/50',
    bg: 'bg-red-50/40 dark:bg-red-950/20',
    iconBg: 'bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-400',
    title: 'text-red-700 dark:text-red-400',
    badge: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-400',
  },
  warning: {
    border: 'border-amber-200/50 dark:border-amber-900/50',
    bg: 'bg-amber-50/40 dark:bg-amber-950/20',
    iconBg: 'bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400',
    title: 'text-amber-700 dark:text-amber-400',
    badge: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400',
  },
  info: {
    border: 'border-sky-200/50 dark:border-sky-900/50',
    bg: 'bg-sky-50/40 dark:bg-sky-950/20',
    iconBg: 'bg-sky-100 text-sky-600 dark:bg-sky-950/60 dark:text-sky-400',
    title: 'text-sky-700 dark:text-sky-400',
    badge: 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-400',
  },
  positive: {
    border: 'border-emerald-200/50 dark:border-emerald-900/50',
    bg: 'bg-emerald-50/40 dark:bg-emerald-950/20',
    iconBg: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400',
    title: 'text-emerald-700 dark:text-emerald-400',
    badge: 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400',
  },
};

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
      body: `${abnormalPct.toFixed(1)}% record abnormal (>20%). ${hs.abnormal.toLocaleString()} dari ${total.toLocaleString()} record memerlukan investigasi segera.`,
      action: 'Buka Investigation Worklist',
    });
  } else if (abnormalPct > 5) {
    out.push({
      id: 'health',
      icon: <AlertTriangle className="h-4 w-4" />,
      severity: 'warning',
      title: 'Kondisi Inventory Perlu Perhatian',
      body: `${abnormalPct.toFixed(1)}% record abnormal (5-20%). ${hs.abnormal.toLocaleString()} dari ${total.toLocaleString()} record perlu monitoring.`,
    });
  } else {
    out.push({
      id: 'health',
      icon: <Lightbulb className="h-4 w-4" />,
      severity: 'positive',
      title: 'Kondisi Inventory Sehat',
      body: `Hanya ${abnormalPct.toFixed(1)}% record abnormal (<5%). ${hs.normal.toLocaleString()} dari ${total.toLocaleString()} record dalam kondisi normal.`,
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
      body: `${(residualPct * 100).toFixed(1)}% QTY Deviasi tidak terjelaskan oleh Waste/Susut/Trial. Perlu validasi actual usage vs SOC dan sampling fisik.`,
    });
  }

  // ----- 4. Pareto -----
  const pareto = data.pareto;
  if (pareto && pareto.classACount > 0) {
    out.push({
      id: 'pareto',
      icon: <Target className="h-4 w-4" />,
      severity: 'info',
      title: 'Aturan Pareto Berlaku',
      body: `${pareto.classACount} item (${((pareto.classACount / Math.max(pareto.totalItems, 1)) * 100).toFixed(1)}% dari total item) menyumbang ${(pareto.classAPctOfCost * 100).toFixed(1)}% biaya deviation. Fokuskan investigasi pada item-item ini.`,
    });
  }

  // ----- 5. Worst area -----
  const areas = data.areaAnalysis || [];
  if (areas.length >= 2) {
    const sorted = [...areas].sort((a, b) => (b.lossToSales ?? 0) - (a.lossToSales ?? 0));
    const worst = sorted[0];
    const best = sorted[sorted.length - 1];
    const worstPct = (worst.lossToSales ?? 0) * 100;
    const bestPct = (best.lossToSales ?? 0) * 100;
    const sev: Insight['severity'] = worstPct > 10 ? 'critical' : worstPct > 5 ? 'warning' : 'info';
    out.push({
      id: 'area-worst',
      icon: <MapPin className="h-4 w-4" />,
      severity: sev,
      title: `Area Terburuk: ${worst.area}`,
      body: `LOSS/PENJUALAN ${worstPct.toFixed(2)}% (vs ${best.area} ${bestPct.toFixed(2)}%). Selisih ${(worstPct - bestPct).toFixed(2)} ppt. ${worst.outletCount} outlet di area ini.`,
      action: `Fokus ke ${worst.area}`,
      actionTarget: { type: 'area', value: worst.area },
    });
  }

  // ----- 6. Cost impact -----
  const ci = data.costImpact;
  if (ci) {
    const pct = (ci.pctOfSales ?? 0) * 100;
    const sev: Insight['severity'] = pct > 5 ? 'critical' : pct > 2 ? 'warning' : 'info';
    out.push({
      id: 'cost-impact',
      icon: <Coins className="h-4 w-4" />,
      severity: sev,
      title: 'Biaya Bocor',
      body: `Total |NOMINAL DEVIASI| ${fmtIDR(ci.totalCost)} setara ${pct.toFixed(2)}% dari PENJUALAN. LOSS ${fmtIDR(ci.lossNominal)} · SURPLUS ${fmtIDR(ci.surplusNominal)}.`,
    });
  }

  // ----- 7. Systemic item -----
  const consistency = data.itemConsistencyAnalysis;
  if (consistency && consistency.systemic.length > 0) {
    const top = consistency.systemic[0];
    out.push({
      id: 'systemic',
      icon: <Package className="h-4 w-4" />,
      severity: 'critical',
      title: `Item Sistemik: ${top.itemName}`,
      body: `${top.itemName} (${top.outletCode}) muncul dengan deviation signifikan di ${top.occurrences} periode historis. Pola recurring — kemungkinan masalah struktural (SOC/recipe/receiving).`,
      action: 'Drill-down item',
      actionTarget: { type: 'item', value: top.itemName },
    });
  }

  // ----- 8. Net cost trend -----
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
        body: `Net cost ratio naik dari ${(first.netCostRatio * 100).toFixed(2)}% → ${(last.netCostRatio * 100).toFixed(2)}% (+${delta.toFixed(2)} ppt). LOSS meningkat lebih cepat dari SURPLUS.`,
      });
    } else if (delta < -0.5) {
      out.push({
        id: 'nct-improving',
        icon: <TrendingUp className="h-4 w-4" />,
        severity: 'positive',
        title: 'Tren Biaya Neto Membaik',
        body: `Net cost ratio turun dari ${(first.netCostRatio * 100).toFixed(2)}% → ${(last.netCostRatio * 100).toFixed(2)}% (${delta.toFixed(2)} ppt). Investigasi mitigasi berhasil atau SURPLUS naik.`,
      });
    }
  }

  // ----- 9. LOSS/SURPLUS balance -----
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
        body: `${(lossShare * 100).toFixed(1)}% nominal deviation adalah LOSS (pemakaian aktual > SOC). Hanya ${((1 - lossShare) * 100).toFixed(1)}% SURPLUS. Fokus pada pencegahan over-usage.`,
      });
    } else if (lossShare < 0.40) {
      out.push({
        id: 'surplus-dominance',
        icon: <TrendingUp className="h-4 w-4" />,
        severity: 'warning',
        title: 'Dominasi SURPLUS',
        body: `${((1 - lossShare) * 100).toFixed(1)}% nominal deviation adalah SURPLUS (pemakaian aktual < SOC). Hanya ${(lossShare * 100).toFixed(1)}% LOSS. Periksa apakah SOC terlalu tinggi atau ada under-reporting.`,
      });
    }
  }

  // ----- 10. Historical anomaly -----
  const histAnalysis = g.historicalAnalysis;
  if (histAnalysis && histAnalysis.criticalItems.length > 0) {
    const top = histAnalysis.criticalItems[0];
    out.push({
      id: 'historical-anomaly',
      icon: <AlertTriangle className="h-4 w-4" />,
      severity: 'critical',
      title: `Anomali Historical: ${top.outletCode}`,
      body: `${top.itemName} di ${top.outletCode} (${top.area}) memiliki z-score ${top.zScore.toFixed(2)} vs rata-rata historical. Current Dev/BOM ${(top.currentDevBom * 100).toFixed(1)}% vs rata-rata ${(top.historicalAvg * 100).toFixed(1)}%.`,
      action: 'Drill-down item',
      actionTarget: { type: 'item', value: top.itemName },
    });
  }

  return out;
}

// ============================================================
//  InsightsPanel — main component
// ============================================================
export function InsightsPanel({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  const setOutlet = useDashboard((s) => s.setOutlet);
  const setScorecardOutlet = useDashboard((s) => s.setScorecardOutlet);
  const setItem = useDashboard((s) => s.setItem);
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);

  const insights = buildInsights(data);
  const counts = {
    critical: insights.filter((i) => i.severity === 'critical').length,
    warning: insights.filter((i) => i.severity === 'warning').length,
    info: insights.filter((i) => i.severity === 'info').length,
    positive: insights.filter((i) => i.severity === 'positive').length,
  };

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
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              Insight Otomatis
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {insights.length} insight dihasilkan dari analisis periode {data.period.weekLabel} {data.period.monthLabel}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {counts.critical > 0 && (
              <Badge variant="outline" className="text-xs border-red-300 text-red-700 dark:border-red-800 dark:text-red-400">
                Kritis: {counts.critical}
              </Badge>
            )}
            {counts.warning > 0 && (
              <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400">
                Warning: {counts.warning}
              </Badge>
            )}
            {counts.positive > 0 && (
              <Badge variant="outline" className="text-xs border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400">
                Positif: {counts.positive}
              </Badge>
            )}
            {counts.info > 0 && (
              <Badge variant="outline" className="text-xs border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-400">
                Info: {counts.info}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {insights.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Tidak ada insight yang dapat dihasilkan dari data ini.
          </p>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {insights.map((insight) => {
              const style = SEVERITY_STYLES[insight.severity];
              return (
                <div
                  key={insight.id}
                  className={`rounded-lg border ${style.border} ${style.bg} p-3 flex items-start gap-3`}
                >
                  <div className={`shrink-0 h-8 w-8 rounded-md flex items-center justify-center ${style.iconBg}`}>
                    {insight.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${style.title}`}>{insight.title}</p>
                    <p className="text-xs text-foreground/80 mt-0.5 leading-relaxed">{insight.body}</p>
                    {insight.action && insight.actionTarget && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 mt-2 px-2 text-xs"
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
      </CardContent>
    </Card>
  );
}
