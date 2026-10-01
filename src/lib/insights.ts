// ============================================================
//  Insights — derivation engine (9-rule) — GODSPLIT-W2-B
//  --------------------------------------------------------
//  GODSPLIT-W2-B: derivation engine insights 9-rule — dipindah dari
//  InsightsPanel.tsx agar murni, testable, dan bisa di-memoize.
//
//  buildInsights(data) is a PURE function: same AnalysisData in →
//  same Insight[] out, no store reads, no side effects. The 9
//  numbered rules + their thresholds (>20% / >5% health, >2×
//  growth mismatch, >0.5 residual, >10/>5 area ppt, >5/>2 cost,
//  ±0.5 ppt net-cost trend, 0.70/0.40 loss-share) were previously
//  trapped inside the view file, running UNMEMOIZED on every
//  render and unreachable by the tests/lib culture — see
//  audit-findings/findings-GODSPLIT-B.md §9.
//
//  `icon` is emitted as an InsightIcon KEY (not JSX) so this module
//  stays React-free and unit-testable in the node vitest env;
//  InsightsPanel owns the key→ReactNode icon map (presentation
//  spec: CERTAINTY_TOOLTIPS / SEVERITY_STYLES / MAX_VISIBLE stay
//  view-side too).
// ============================================================
import { fmtIDR, fmtPct, formatByPreset } from '@/lib/format';
// Type-only import (erased at compile — no runtime lib→hooks edge,
// same house pattern as useAnalysis/types.ts importing query shapes).
import type { AnalysisData } from '@/hooks/useAnalysis';

/** Icon key rendered by the view-side icon map in InsightsPanel. */
export type InsightIcon =
  | 'shield-alert'
  | 'alert-triangle'
  | 'lightbulb'
  | 'zap'
  | 'map-pin'
  | 'coins'
  | 'package'
  | 'trending-down'
  | 'trending-up';

export interface Insight {
  id: string;
  icon: InsightIcon;
  severity: 'critical' | 'warning' | 'info' | 'positive';
  /** SPEC-1 (upload spec §6.1/§20): certainty level — presentation-layer
   *  epistemic label, NOT a new calculation. TERUKUR = the finding states
   *  directly verifiable values/concentrations from the payload; INDIKASI
   *  = a strong measured pattern that is not a root cause; HIPOTESIS = a
   *  possible cause that still needs validation (none generated today —
   *  §27-6 forbids adding new root-cause claims). */
  certainty: 'TERUKUR' | 'INDIKASI' | 'HIPOTESIS';
  title: string;
  body: string;
  action?: string;
  actionTarget?: { type: 'area' | 'item'; value: string };
}

// ============================================================
//  buildInsights — auto-generate up to 10 textual insights
// ============================================================
export function buildInsights(data: AnalysisData): Insight[] {
  const out: Insight[] = [];
  const hs = data.healthStatus;
  const total = hs.normal + hs.warning + hs.abnormal;
  const abnormalPct = total > 0 ? (hs.abnormal / total) * 100 : 0;
  const g = data.growthComparison || {};

  // ----- 1. Health verdict -----
  if (abnormalPct > 20) {
    out.push({
      id: 'health',
      icon: 'shield-alert',
      severity: 'critical',
      certainty: 'TERUKUR',
      title: 'Kondisi Inventory KRITIS',
      body: `${fmtPct(abnormalPct / 100, false, 1)} record abnormal (>20%). ${hs.abnormal.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} record memerlukan investigasi segera.`,
    });
  } else if (abnormalPct > 5) {
    out.push({
      id: 'health',
      icon: 'alert-triangle',
      severity: 'warning',
      certainty: 'TERUKUR',
      title: 'Kondisi Inventory Perlu Perhatian',
      body: `${fmtPct(abnormalPct / 100, false, 1)} record abnormal (5-20%). ${hs.abnormal.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} record perlu monitoring.`,
    });
  } else {
    out.push({
      id: 'health',
      icon: 'lightbulb',
      severity: 'positive',
      certainty: 'TERUKUR',
      title: 'Kondisi Inventory Sehat',
      body: `Hanya ${fmtPct(abnormalPct / 100, false, 1)} record abnormal (<5%). ${hs.normal.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} record dalam kondisi normal.`,
    });
  }

  // ----- 2. Growth mismatch (DEVIASI tumbuh jauh melebihi Sales) -----
  if (g.salesGrowth != null && g.salesGrowth > 0 && g.nominalDeviasiGrowth != null
      && g.nominalDeviasiGrowth > 2 * g.salesGrowth) {
    out.push({
      id: 'growth-mismatch',
      icon: 'zap',
      severity: 'critical',
      certainty: 'INDIKASI',
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
      icon: 'alert-triangle',
      severity: 'warning',
      certainty: 'TERUKUR',
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
      icon: 'map-pin',
      severity: sev,
      certainty: 'TERUKUR',
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
      icon: 'coins',
      severity: sev,
      certainty: 'TERUKUR',
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
      icon: 'package',
      severity: 'critical',
      certainty: 'INDIKASI',
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
        icon: 'trending-down',
        severity: 'warning',
        certainty: 'TERUKUR',
        title: 'Tren Biaya Neto Memburuk',
        body: `Net cost ratio naik dari ${fmtPct(first.netCostRatio, false, 2)} → ${fmtPct(last.netCostRatio, false, 2)} (+${formatByPreset(delta, 'num2')} ppt). LOSS meningkat lebih cepat dari SURPLUS.`,
      });
    } else if (delta < -0.5) {
      out.push({
        id: 'nct-improving',
        icon: 'trending-up',
        severity: 'positive',
        certainty: 'TERUKUR',
        title: 'Tren Biaya Neto Membaik',
        // SPEC-1 (§6.2): hedged — the improvement CAUSE is unverified.
        body: `Net cost ratio turun dari ${fmtPct(first.netCostRatio, false, 2)} → ${fmtPct(last.netCostRatio, false, 2)} (${formatByPreset(delta, 'num2')} ppt). Investigasi apakah mitigasi berhasil atau SURPLUS naik.`,
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
        icon: 'trending-down',
        severity: 'warning',
        certainty: 'TERUKUR',
        title: 'Dominasi LOSS',
        body: `${fmtPct(lossShare, false, 1)} nominal deviation adalah LOSS (pemakaian aktual > SOC). Hanya ${fmtPct(1 - lossShare, false, 1)} SURPLUS. Fokus pada pencegahan over-usage.`,
      });
    } else if (lossShare < 0.40) {
      out.push({
        id: 'surplus-dominance',
        icon: 'trending-up',
        severity: 'warning',
        certainty: 'TERUKUR',
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
      icon: 'alert-triangle',
      severity: 'critical',
      certainty: 'TERUKUR',
      title: `Anomali Historical: ${top.outletCode}`,
      body: `${top.itemName} di ${top.outletCode} (${top.area}) memiliki z-score ${formatByPreset(top.zScore, 'num2')} vs rata-rata historical. Current Dev/BOM ${fmtPct(top.currentDevBom, false, 1)} vs rata-rata ${fmtPct(top.historicalAvg, false, 1)}.`,
      action: 'Drill-down item',
      actionTarget: { type: 'item', value: top.itemName },
    });
  }

  return out;
}
