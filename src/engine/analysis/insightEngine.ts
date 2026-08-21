// ============================================================
//  Insight Engine — auto-generates executive summary insights
//  from analysis data.
//  --------------------------------------------------------
//  Pure function — no DB calls, no side effects.
//  Called by /api/analysis route after assembling AnalysisData.
//
//  Pattern detection rules:
//    1. Financial concentration (top 3 outlets vs total loss)
//    2. Systemic item (item across many outlets — uses networkItemRisk)
//    3. Area outlier (area avg >> network avg)
//    4. Trend deterioration (many outlets worsening)
//    5. Tolerance compliance (items without tolerance setting)
//    6. Residual pattern (many outlets with high residual ratio)
//    7. Direction flip (outlets flipping LOSS↔SURPLUS)
//    8. Best practice (outlet deviating well below area avg)
//    9. Waste concentration (single item dominates network waste)
//   10. Over-explained (fraud indicator)
//
//  Output: 5-10 insights sorted by severity (CRITICAL first).
// ============================================================

export type InsightCategory = 'FINANCIAL' | 'OPERATIONAL' | 'PATTERN' | 'ANOMALY' | 'TREND';
export type InsightSeverity = 'CRITICAL' | 'WARNING' | 'INFO' | 'POSITIVE';

export interface ExecutiveInsight {
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;        // short headline
  description: string;  // detailed explanation
  metric?: string;      // key number (formatted string for UI display)
  action?: string;      // recommended action
}

// ============================================================
//  Local input type — structural subset of AnalysisData.
//  Defined locally to avoid importing the client-side hook
//  (useAnalysis.ts has 'use client'). All fields optional so
//  callers can pass partial data without crashing the engine.
// ============================================================
export interface NetworkItemRiskSummary {
  itemName: string;
  outletCount: number;
  deviatingOutlets: number;
  totalOutlets?: number;
  totalAbsNominal: number;
  riskScore: number;
  riskLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
}

export interface InsightInput {
  executiveSummary?: {
    totalLoss?: number;
    totalSurplus?: number;
    sales?: { current?: number };
  };
  healthStatus?: {
    normal?: number;
    warning?: number;
    abnormal?: number;
    breakdown?: {
      byCategory?: Record<string, number>;
      byRule?: Record<string, number>;
    };
  };
  topOutlets?: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    absNominal: number;
    devBom: number;
    sales?: number;
    lossAmount?: number;
    surplusAmount?: number;
    direction?: string;
  }>;
  outletHealthRanking?: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    healthScore: number;
    absNominal: number;
    residualPct: number | null;
    devBom: number;
    sales: number;
  }>;
  areaAnalysis?: Array<{
    area: string;
    outletCount: number;
    totalSales: number;
    totalAbsNominal: number;
    avgDevBom: number;
    lossToSales: number | null;
  }>;
  varianceAnalysis?: {
    topWorsened?: Array<{ outletCode?: string; outletName?: string; itemName: string; delta: number }>;
    topImproved?: Array<{ outletCode?: string; outletName?: string; itemName: string; delta: number }>;
  };
  investigationWorklist?: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    itemName: string;
    ruleCodes: string[];
  }>;
  topItemsByWaste?: Array<{ itemName: string; outletCode: string; qtyWaste?: number; nominalWaste: number }>;
  topItemsByLossSurplus?: Array<{ itemName: string; outletCode: string; nominalLossSurplus: number; direction?: string }>;
  lossVsSurplus?: { loss: number; surplus: number; lossNominal: number; surplusNominal: number };
  networkItemRisk?: NetworkItemRiskSummary[];
}

// ============================================================
//  Helpers
// ============================================================
const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;
const formatIDR = (value: number): string => {
  if (Math.abs(value) >= 1_000_000_000) return `Rp ${(value / 1_000_000_000).toFixed(2)} M`;
  if (Math.abs(value) >= 1_000_000) return `Rp ${(value / 1_000_000).toFixed(1)} jt`;
  if (Math.abs(value) >= 1_000) return `Rp ${(value / 1_000).toFixed(0)} rb`;
  return `Rp ${value.toFixed(0)}`;
};

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
  POSITIVE: 3,
};

// ============================================================
//  generateExecutiveInsights — main entry point
//  Returns 5-10 insights sorted by severity (CRITICAL first).
// ============================================================
export function generateExecutiveInsights(data: InsightInput): ExecutiveInsight[] {
  const insights: ExecutiveInsight[] = [];

  // ----- 1. Financial concentration -----
  insights.push(...detectFinancialConcentration(data));

  // ----- 2. Systemic item -----
  insights.push(...detectSystemicItem(data));

  // ----- 3. Area outlier -----
  insights.push(...detectAreaOutlier(data));

  // ----- 4. Trend deterioration -----
  insights.push(...detectTrendDeterioration(data));

  // ----- 5. Tolerance compliance -----
  insights.push(...detectToleranceCompliance(data));

  // ----- 6. Residual pattern -----
  insights.push(...detectResidualPattern(data));

  // ----- 7. Direction flip -----
  insights.push(...detectDirectionFlip(data));

  // ----- 8. Best practice -----
  insights.push(...detectBestPractice(data));

  // ----- 9. Waste concentration -----
  insights.push(...detectWasteConcentration(data));

  // ----- 10. Over-explained (fraud indicator) -----
  insights.push(...detectOverExplained(data));

  // Sort by severity (CRITICAL first), then keep top 10.
  insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return insights.slice(0, 10);
}

// ============================================================
//  Pattern 1: Financial concentration
//  "Top 3 outlet kontribusi X% dari total loss network"
//  If top 3 outlets > 50% of total loss → CRITICAL
// ============================================================
function detectFinancialConcentration(data: InsightInput): ExecutiveInsight[] {
  const topOutlets = data.topOutlets ?? [];
  const totalLoss = data.executiveSummary?.totalLoss ?? 0;
  if (topOutlets.length < 3 || totalLoss <= 0) return [];

  // Sum lossAmount for the top 3 outlets (already sorted by absNominal DESC).
  // Fallback to absNominal if lossAmount not present.
  const top3 = topOutlets.slice(0, 3);
  const top3Loss = top3.reduce(
    (sum, o) => sum + (o.lossAmount ?? o.absNominal ?? 0), 0
  );
  const ratio = top3Loss / totalLoss;
  if (ratio > 0.5) {
    const outletNames = top3.map((o) => o.outletName).join(', ');
    return [{
      category: 'FINANCIAL',
      severity: 'CRITICAL',
      title: 'Konsentrasi Loss pada Top 3 Outlet',
      description: `Top 3 outlet (${outletNames}) berkontribusi ${formatPct(ratio)} dari total loss network (${formatIDR(top3Loss)} dari ${formatIDR(totalLoss)}). Konsentrasi tinggi mengindikasikan masalah sistemik di outlet tersebut yang perlu prioritas investigasi.`,
      metric: `${formatPct(ratio)} total loss`,
      action: `Fokus investigasi pada 3 outlet tersebut — audit operasional, pencatatan, dan management.`,
    }];
  }
  return [];
}

// ============================================================
//  Pattern 2: Systemic item
//  "Item X deviasi di Y outlet (Z% network) — potential systemic issue"
//  If deviatingOutlets / totalOutlets > 0.3 → WARNING
// ============================================================
function detectSystemicItem(data: InsightInput): ExecutiveInsight[] {
  const networkItemRisk = data.networkItemRisk ?? [];
  if (networkItemRisk.length === 0) return [];

  const results: ExecutiveInsight[] = [];
  for (const item of networkItemRisk) {
    const totalOutlets = item.totalOutlets ?? 0;
    if (totalOutlets === 0) continue;
    const coverageRatio = item.deviatingOutlets / totalOutlets;
    if (coverageRatio > 0.3) {
      results.push({
        category: 'PATTERN',
        severity: item.riskScore >= 55 ? 'CRITICAL' : 'WARNING',
        title: `Item Sistemik: ${item.itemName}`,
        description: `Item "${item.itemName}" bermasalah di ${item.deviatingOutlets} dari ${totalOutlets} outlet (${formatPct(coverageRatio)} network). Total financial impact ${formatIDR(item.totalAbsNominal)}. Pola sistemik mengindikasikan masalah di master BOM, supplier, atau SOP yang dipakai di semua outlet.`,
        metric: `${item.deviatingOutlets}/${totalOutlets} outlet (${formatPct(coverageRatio)})`,
        action: `Audit master BOM & supplier untuk item ini — kemungkinan root cause ada di pusat, bukan per outlet.`,
      });
    }
    // Only show top 3 systemic items to avoid flooding
    if (results.length >= 3) break;
  }
  return results;
}

// ============================================================
//  Pattern 3: Area outlier
//  "Area X punya avg deviasi Y× dari network average"
//  If area avg > 1.5 × network avg → WARNING
// ============================================================
function detectAreaOutlier(data: InsightInput): ExecutiveInsight[] {
  const areaAnalysis = data.areaAnalysis ?? [];
  if (areaAnalysis.length === 0) return [];

  // Compute network weighted avg Dev/Bom across all areas:
  // weighted by outletCount so large areas don't get drowned out.
  const totalOutlets = areaAnalysis.reduce((s, a) => s + a.outletCount, 0);
  if (totalOutlets === 0) return [];
  const weightedAvg = areaAnalysis.reduce(
    (s, a) => s + (a.avgDevBom ?? 0) * a.outletCount, 0
  ) / totalOutlets;
  if (weightedAvg <= 0) return [];

  const results: ExecutiveInsight[] = [];
  for (const area of areaAnalysis) {
    const avgDevBom = area.avgDevBom ?? 0;
    if (avgDevBom > weightedAvg * 1.5) {
      const multiple = avgDevBom / weightedAvg;
      results.push({
        category: 'ANOMALY',
        severity: multiple > 2 ? 'CRITICAL' : 'WARNING',
        title: `Area Outlier: ${area.area}`,
        description: `Area ${area.area} punya avg Dev/BOM ${avgDevBom.toFixed(3)} (${multiple.toFixed(2)}× dari network average ${weightedAvg.toFixed(3)}). ${area.outletCount} outlet di area ini perlu investigasi penyebab kolektif (training gap, supplier issue, atau management).`,
        metric: `${multiple.toFixed(2)}× network avg`,
        action: `Audit semua outlet di area ${area.area} — cari pola kolektif yang menyebabkan deviasi tinggi.`,
      });
    }
    // Only show top 2 area outliers
    if (results.length >= 2) break;
  }
  return results;
}

// ============================================================
//  Pattern 4: Trend deterioration
//  "N outlet mengalami trend deteriorating — perlu investigasi segera"
//  If > 3 outlets deteriorating → CRITICAL
// ============================================================
function detectTrendDeterioration(data: InsightInput): ExecutiveInsight[] {
  const topWorsened = data.varianceAnalysis?.topWorsened ?? [];
  if (topWorsened.length === 0) return [];

  // Count distinct outlets that have at least one worsening item.
  const deterioratingOutlets = new Set<string>();
  for (const item of topWorsened) {
    if (item.outletCode) deterioratingOutlets.add(item.outletCode);
  }
  const count = deterioratingOutlets.size;

  if (count > 3) {
    return [{
      category: 'TREND',
      severity: 'CRITICAL',
      title: `${count} Outlet Mengalami Trend Deteriorating`,
      description: `${count} outlet menunjukkan paling tidak satu item dengan deviasi memburuk signifikan vs periode sebelumnya. Trend kolektif ini mengindikasikan masalah operasional yang sedang menyebar dan perlu intervensi segera sebelum menjadi sistemik.`,
      metric: `${count} outlet deteriorating`,
      action: `Prioritaskan investigasi pada ${count} outlet tersebut — fokus pada item dengan delta terbesar.`,
    }];
  }
  if (count > 0) {
    return [{
      category: 'TREND',
      severity: 'WARNING',
      title: `${count} Outlet dengan Deviasi Memburuk`,
      description: `${count} outlet menunjukkan item dengan deviasi memburuk vs periode sebelumnya. Jumlah masih terkontrol tapi perlu monitoring agar tidak menyebar.`,
      metric: `${count} outlet`,
      action: `Monitor trend minggu depan — jika jumlah naik, lakukan investigasi mendalam.`,
    }];
  }
  return [];
}

// ============================================================
//  Pattern 5: Tolerance compliance
//  "X% item belum diset toleransi — tidak bisa deteksi breach"
//  If noTolerance count > 5 → WARNING
//
//  Note: We don't have direct "% items without tolerance" in the
//  response. We use TOLERANCE_NOT_SET_HIGH_DEV count from rule
//  breakdown as a proxy (items with high deviation + no tolerance
//  = the ones that ACTIVELY need tolerance set).
// ============================================================
function detectToleranceCompliance(data: InsightInput): ExecutiveInsight[] {
  const byRule = data.healthStatus?.breakdown?.byRule ?? {};
  const noToleranceCount = byRule['TOLERANCE_NOT_SET_HIGH_DEV'] ?? 0;
  if (noToleranceCount > 5) {
    return [{
      category: 'DATA_QUALITY' as InsightCategory,
      severity: 'WARNING',
      title: `${noToleranceCount} Item Tanpa Tolerance Setting`,
      description: `${noToleranceCount} item dengan deviasi tinggi belum diset toleransi — engine tidak bisa mendeteksi TOLERANCE_BREACH untuk item-item ini. Setup tolerance baseline segera agar monitoring anomaly bisa berfungsi optimal.`,
      metric: `${noToleranceCount} item`,
      action: `Set tolerance baseline — gunakan avg historis + 1 std dev sebagai starting point.`,
    }];
  }
  if (noToleranceCount > 0) {
    return [{
      category: 'DATA_QUALITY' as InsightCategory,
      severity: 'INFO',
      title: `${noToleranceCount} Item Perlu Tolerance Setting`,
      description: `${noToleranceCount} item dengan deviasi tinggi belum diset toleransi. Set baseline segera untuk monitoring anomaly.`,
      metric: `${noToleranceCount} item`,
      action: `Update master item — tambah tolerance per item.`,
    }];
  }
  return [];
}

// ============================================================
//  Pattern 6: Residual pattern
//  "N outlet punya residual ratio > 50% — indikasi unexplained deviation"
//  If > 5 outlets with high residual → WARNING
// ============================================================
function detectResidualPattern(data: InsightInput): ExecutiveInsight[] {
  const ranking = data.outletHealthRanking ?? [];
  if (ranking.length === 0) return [];

  const highResidualOutlets = ranking.filter(
    (o) => o.residualPct != null && o.residualPct > 0.5
  );
  if (highResidualOutlets.length > 5) {
    return [{
      category: 'ANOMALY',
      severity: 'WARNING',
      title: `${highResidualOutlets.length} Outlet dengan Residual Tinggi`,
      description: `${highResidualOutlets.length} outlet punya residual ratio > 50% — indikasi banyak selisih tidak dijelaskan oleh Waste/Susut/Trial. Kemungkinan pencatatan tidak lengkap atau ada inventory issue yang belum terdeteksi.`,
      metric: `${highResidualOutlets.length} outlet`,
      action: `Audit pencatatan Waste/Susut/Trial di outlet tersebut — pastikan semua kategori diinput lengkap.`,
    }];
  }
  return [];
}

// ============================================================
//  Pattern 7: Direction flip
//  "N outlet berubah arah deviasi (LOSS↔SURPLUS) — possible data quality issue"
//  If any direction flip → WARNING
// ============================================================
function detectDirectionFlip(data: InsightInput): ExecutiveInsight[] {
  const worklist = data.investigationWorklist ?? [];
  const flipOutlets = new Set<string>();
  for (const item of worklist) {
    if (item.ruleCodes?.includes('DIRECTION_FLIP')) {
      flipOutlets.add(item.outletCode);
    }
  }
  if (flipOutlets.size === 0) return [];

  return [{
    category: 'ANOMALY',
    severity: 'WARNING',
    title: `${flipOutlets.size} Outlet Berubah Arah Deviasi`,
    description: `${flipOutlets.size} outlet menunjukkan direction flip (LOSS↔SURPLUS) antar periode. Perubahan arah sering kali mengindikasikan data quality issue (salah tanda, perubahan prosedur stock opname) atau perubahan operasional fundamental yang perlu di-validasi.`,
    metric: `${flipOutlets.size} outlet`,
    action: `Verifikasi prosedur stock opname — pastikan konsistensi timing & metodologi antar periode.`,
  }];
}

// ============================================================
//  Pattern 8: Best practice
//  "Outlet X adalah best practice — deviasi terendah di area Y"
//  If outlet devBom < 50% of area avg → POSITIVE
// ============================================================
function detectBestPractice(data: InsightInput): ExecutiveInsight[] {
  const ranking = data.outletHealthRanking ?? [];
  const areaAnalysis = data.areaAnalysis ?? [];
  if (ranking.length === 0 || areaAnalysis.length === 0) return [];

  // Build area → avg DevBom map
  const areaAvgMap = new Map<string, number>();
  for (const a of areaAnalysis) {
    areaAvgMap.set(a.area, a.avgDevBom ?? 0);
  }

  const results: ExecutiveInsight[] = [];
  // Look at the bottom of the ranking (lowest healthScore = worst, so we want
  // the BEST outlets = the END of the ranking array, which is sorted worst-first).
  // Iterate from the end (best performers).
  const sortedByBest = [...ranking].reverse();
  for (const outlet of sortedByBest) {
    const areaAvg = areaAvgMap.get(outlet.area) ?? 0;
    if (areaAvg <= 0) continue;
    const ratio = outlet.devBom / areaAvg;
    if (ratio < 0.5) {
      results.push({
        category: 'OPERATIONAL',
        severity: 'POSITIVE',
        title: `Best Practice: ${outlet.outletName}`,
        description: `Outlet ${outlet.outletName} (${outlet.area}) adalah best practice — Dev/BOM ${outlet.devBom.toFixed(3)} hanya ${(ratio * 100).toFixed(0)}% dari rata-rata area (${areaAvg.toFixed(3)}). Health score: ${outlet.healthScore.toFixed(1)}. Pelajari prosedur operasional outlet ini untuk replikasi ke outlet lain.`,
        metric: `${(ratio * 100).toFixed(0)}% area avg`,
        action: `Dokumentasikan SOP outlet ini — gunakan sebagai template untuk training outlet lain di area yang sama.`,
      });
    }
    // Only show top 2 best practices
    if (results.length >= 2) break;
  }
  return results;
}

// ============================================================
//  Pattern 9: Waste concentration
//  "Item X kontribusi Y% dari total waste network — fokus reduction"
//  If top item > 30% of total waste → WARNING
//
//  Note: We don't have network-wide total waste nominal in the
//  response. We approximate using SUM of topItemsByWaste (which
//  captures the top N items by waste). If a single item dominates
//  even this top-N list, it's definitely a network-wide concentration.
// ============================================================
function detectWasteConcentration(data: InsightInput): ExecutiveInsight[] {
  const topWaste = data.topItemsByWaste ?? [];
  if (topWaste.length < 3) return [];

  const totalWasteInTop = topWaste.reduce((s, i) => s + (i.nominalWaste ?? 0), 0);
  if (totalWasteInTop <= 0) return [];

  const topItem = topWaste[0];
  const ratio = (topItem.nominalWaste ?? 0) / totalWasteInTop;
  if (ratio > 0.3) {
    return [{
      category: 'PATTERN',
      severity: 'WARNING',
      title: `Konsentrasi Waste: ${topItem.itemName}`,
      description: `Item "${topItem.itemName}" (outlet ${topItem.outletCode}) kontribusi ${formatPct(ratio)} dari total waste pada top ${topWaste.length} item. Konsentrasi tinggi mengindikasikan item ini adalah target reduction yang paling impactful — fokus improvement effort di sini.`,
      metric: `${formatPct(ratio)} waste (top ${topWaste.length})`,
      action: `Audit proses produksi item ini — pertimbangkan supplier review, porsioning training, atau storage improvement.`,
    }];
  }
  return [];
}

// ============================================================
//  Pattern 10: Over-explained (fraud indicator)
//  "N item memiliki Waste+Susut+Trial > Deviasi — possible fraud/error"
//  If any over-explained → CRITICAL
// ============================================================
function detectOverExplained(data: InsightInput): ExecutiveInsight[] {
  const worklist = data.investigationWorklist ?? [];
  const overExplainedItems = worklist.filter(
    (w) => w.ruleCodes?.includes('OVER_EXPLAINED')
  );
  if (overExplainedItems.length === 0) return [];

  // Count distinct outlets affected
  const outlets = new Set(overExplainedItems.map((i) => i.outletCode));
  const topItems = overExplainedItems.slice(0, 3).map((i) => `${i.itemName} (${i.outletCode})`).join(', ');

  return [{
    category: 'ANOMALY',
    severity: 'CRITICAL',
    title: `${overExplainedItems.length} Item dengan Indikasi Fraud (OVER_EXPLAINED)`,
    description: `${overExplainedItems.length} item di ${outlets.size} outlet memiliki Waste+Susut+Trial melebihi total Deviasi. Pola ini adalah red flag fraud — pencatatan waste dibesar-besarkan untuk menutupi selisih, atau salah input SPV (double-counting). Item teratas: ${topItems}.`,
    metric: `${overExplainedItems.length} item di ${outlets.size} outlet`,
    action: `Audit fisik waste segera — bandingkan pencatatan vs actual. Cek CCTV jika tersedia. Interview staff pencatatan.`,
  }];
}
