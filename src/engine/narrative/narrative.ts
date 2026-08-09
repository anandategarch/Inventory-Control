// ============================================================
//  Narrative Engine — Structured summary builder + LLM client
//  IMPORTANT: Only aggregated metrics + flags are sent to LLM.
//  NEVER raw transactional data. LLM does NOT recalculate.
// ============================================================
import ZAI from 'z-ai-web-dev-sdk';
import type { ExecutiveSummary, GrowthMetrics, InvestigationItem } from '@/types/inventory';

export interface NarrativeInput {
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  executiveSummary: ExecutiveSummary;
  growthMetrics: GrowthMetrics;
  healthStatus: { normal: number; warning: number; abnormal: number };
  topAnomalies: Array<{
    itemName: string;
    outletCode: string;
    area: string;
    issue: string;
    absNominal: number;
    devBom: number | null;
    direction: string;
  }>;
  deviationBreakdown: { waste: number; susut: number; trial: number; residual: number; total: number };
  investigationCount: number;
}

const SYSTEM_PROMPT = `Anda adalah Inventory Control Analyst senior untuk jaringan 19 outlet F&B.
Tugas Anda: menulis narasi analisis inventory berdasarkan ANGKA yang sudah dihitung oleh calculation engine.

ATURAN MUTLAK:
1. Anda TIDAK boleh menghitung ulang angka. Gunakan angka yang diberikan apa adanya.
2. Anda TIDAK boleh menyatakan root cause secara pasti. Gunakan istilah: "indikasi", "kemungkinan", "perlu investigasi".
3. Sebutkan periode, outlet, item, dan magnitude secara eksplisit.
4. Bahasa: Indonesia formal-professional.
5. Jika evidence tidak cukup, katakan: "Insufficient evidence — further investigation required."
6. Narasi harus menjawab: SEBERAPA BESAR, DIBANDINGKAN DENGAN APA, APAKAH WAJAR, DIMANA, ITEM APA, KEMUNGKINAN PENYEBAB.
7. Pisahkan analisis menjadi: OVERVIEW, VOLUME VS DEVIATION, DEVIATION COMPOSITION, TOP ANOMALY.
8. Maksimal 400 kata. Padat dan actionable.`;

function fmtPct(v: number | null, withSign = true): string {
  if (v == null) return 'N/A';
  const pct = v * 100;
  const sign = withSign && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtNum(v: number | null, unit = ''): string {
  if (v == null) return 'N/A';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M${unit}`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K${unit}`;
  return `${v.toFixed(0)}${unit}`;
}

export function buildStructuredSummary(input: NarrativeInput): string {
  const { period, executiveSummary: s, growthMetrics: g, healthStatus, topAnomalies, deviationBreakdown: db, investigationCount } = input;
  const lines: string[] = [];

  const compareLabel = period.comparisonWeek
    ? `${period.comparisonWeek}${period.comparisonMonth && period.comparisonMonth !== period.monthLabel ? ` ${period.comparisonMonth}` : ''}`
    : 'N/A';
  lines.push(`PERIODE: ${period.monthLabel} - ${period.weekLabel} (vs ${compareLabel})`);
  lines.push(`SCOPE: ${healthStatus.normal + healthStatus.warning + healthStatus.abnormal} records | NORMAL=${healthStatus.normal} WARNING=${healthStatus.warning} ABNORMAL=${healthStatus.abnormal}`);
  lines.push('');

  lines.push('EXECUTIVE METRICS (current vs previous):');
  lines.push(`- Sales: ${fmtNum(s.sales.current, ' IDR')} (prev ${fmtNum(s.sales.previous, ' IDR')}, growth ${fmtPct(s.sales.growth)})`);
  lines.push(`- Nominal Deviasi: ${fmtNum(s.nominalDeviasi.current, ' IDR')} (prev ${fmtNum(s.nominalDeviasi.previous, ' IDR')}, growth ${fmtPct(s.nominalDeviasi.growth)})`);
  lines.push(`- QTY BOM: ${fmtNum(s.qtyBom.current)} (prev ${fmtNum(s.qtyBom.previous)}, growth ${fmtPct(s.qtyBom.growth)})`);
  lines.push(`- QTY Deviasi: ${fmtNum(s.qtyDeviasi.current)} (prev ${fmtNum(s.qtyDeviasi.previous)}, growth ${fmtPct(s.qtyDeviasi.growth)})`);
  lines.push(`- QTY Waste: ${fmtNum(s.qtyWaste.current)} | Susut: ${fmtNum(s.qtySusut.current)} | Trial: ${fmtNum(s.qtyTrial.current)}`);
  lines.push(`- QTY Loss/Surplus: ${fmtNum(s.qtyLossSurplus.current)} (growth ${fmtPct(s.qtyLossSurplus.growth)})`);
  lines.push(`- Total LOSS: ${fmtNum(s.totalLoss, ' IDR')} | Total SURPLUS: ${fmtNum(s.totalSurplus, ' IDR')}`);
  lines.push(`- Loss/Sales: ${fmtPct(s.lossToSales)} | Surplus/Sales: ${fmtPct(s.surplusToSales)}`);
  lines.push(`- Deviation/BOM: ${fmtPct(s.deviationToBom, false)}`);
  lines.push(`- Residual Loss: ${fmtNum(s.residualLossQty)} (${fmtPct(s.residualLossPct, false)} of deviation)`);
  lines.push('');

  lines.push('GROWTH COMPARISON:');
  lines.push(`- Sales Growth: ${fmtPct(g.salesGrowth)}`);
  lines.push(`- BOM Growth: ${fmtPct(g.bomGrowth)}`);
  lines.push(`- QTY Deviasi Growth: ${fmtPct(g.qtyDeviasiGrowth)}`);
  lines.push(`- Nominal Deviasi Growth: ${fmtPct(g.nominalDeviasiGrowth)}`);
  lines.push(`- Price Growth: ${fmtPct(g.priceGrowth)}`);
  lines.push(`- Deviation/Sales ratio: ${fmtPct(g.deviationToSalesRatio, false)}`);
  lines.push(`- Deviation/BOM ratio: ${fmtPct(g.deviationToBomRatio, false)}`);
  lines.push('');

  lines.push('DEVIATION COMPOSITION (QTY):');
  lines.push(`- Total Deviation: ${fmtNum(db.total)}`);
  lines.push(`- Waste: ${fmtNum(db.waste)} (${db.total > 0 ? ((db.waste / db.total) * 100).toFixed(1) : 0}%)`);
  lines.push(`- Susut: ${fmtNum(db.susut)} (${db.total > 0 ? ((db.susut / db.total) * 100).toFixed(1) : 0}%)`);
  lines.push(`- Trial: ${fmtNum(db.trial)} (${db.total > 0 ? ((db.trial / db.total) * 100).toFixed(1) : 0}%)`);
  lines.push(`- Residual: ${fmtNum(db.residual)} (${db.total > 0 ? ((db.residual / db.total) * 100).toFixed(1) : 0}%)`);
  lines.push('');

  lines.push(`TOP ANOMALIES (${topAnomalies.length} items, ${investigationCount} in worklist):`);
  topAnomalies.slice(0, 5).forEach((a, i) => {
    lines.push(`${i + 1}. ${a.itemName} @ ${a.outletCode} (${a.area}) — ${a.direction}`);
    lines.push(`   Issue: ${a.issue}`);
    lines.push(`   Nominal: ${fmtNum(a.absNominal, ' IDR')} | Dev/BOM: ${fmtPct(a.devBom, false)}`);
  });

  return lines.join('\n');
}

export function buildFallbackNarrative(input: NarrativeInput): string {
  const { period, executiveSummary: s, growthMetrics: g, topAnomalies, deviationBreakdown: db } = input;
  const parts: string[] = [];

  parts.push(`OVERVIEW`);
  parts.push(`Pada ${period.weekLabel} ${period.monthLabel}${period.comparisonWeek ? ` (vs ${period.comparisonWeek})` : ''}, ` +
    `Sales mencapai ${fmtNum(s.sales.current, ' IDR')}${s.sales.growth != null ? ` (${fmtPct(s.sales.growth)} vs previous)` : ''}. ` +
    `Nominal Deviasi ${fmtNum(s.nominalDeviasi.current, ' IDR')}${s.nominalDeviasi.growth != null ? ` (${fmtPct(s.nominalDeviasi.growth)})` : ''}. ` +
    `QTY BOM ${fmtNum(s.qtyBom.current)}${s.qtyBom.growth != null ? ` (${fmtPct(s.qtyBom.growth)})` : ''}, ` +
    `QTY Deviasi ${fmtNum(s.qtyDeviasi.current)}${s.qtyDeviasi.growth != null ? ` (${fmtPct(s.qtyDeviasi.growth)})` : ''}.`);

  parts.push(`\nVOLUME VS DEVIATION`);
  const mismatchSales = g.salesGrowth != null && g.nominalDeviasiGrowth != null &&
    g.nominalDeviasiGrowth > CFG_FACTOR * (g.salesGrowth || 0) && g.salesGrowth > 0;
  const mismatchBom = g.bomGrowth != null && g.qtyDeviasiGrowth != null &&
    g.qtyDeviasiGrowth > CFG_FACTOR * (g.bomGrowth || 0) && g.bomGrowth > 0;
  if (mismatchSales) {
    parts.push(`Deviasi Growth ${fmtPct(g.nominalDeviasiGrowth)} jauh melebihi Sales Growth ${fmtPct(g.salesGrowth)}. ` +
      `Kenaikan deviation tidak cukup dijelaskan oleh pertumbuhan Sales. Perlu investigasi.`);
  }
  if (mismatchBom) {
    parts.push(`QTY Deviasi Growth ${fmtPct(g.qtyDeviasiGrowth)} jauh melebihi QTY BOM Growth ${fmtPct(g.bomGrowth)}. ` +
      `Selisih pertumbuhan mengindikasikan deviation tidak cukup dijelaskan oleh peningkatan volume aktivitas.`);
  }

  parts.push(`\nDEVIATION COMPOSITION`);
  const residualPct = db.total > 0 ? (db.residual / db.total) * 100 : 0;
  parts.push(`Dari total QTY Deviasi ${fmtNum(db.total)}, ` +
    `Waste ${fmtNum(db.waste)} (${db.total > 0 ? ((db.waste / db.total) * 100).toFixed(1) : 0}%), ` +
    `Susut ${fmtNum(db.susut)} (${db.total > 0 ? ((db.susut / db.total) * 100).toFixed(1) : 0}%), ` +
    `Trial ${fmtNum(db.trial)} (${db.total > 0 ? ((db.trial / db.total) * 100).toFixed(1) : 0}%), ` +
    `Residual ${fmtNum(db.residual)} (${residualPct.toFixed(1)}%).`);
  if (residualPct > 50) {
    parts.push(`Residual Loss tinggi (${residualPct.toFixed(1)}% dari deviation) — sebagian deviation tidak terjelaskan oleh Waste/Susut/Trial. Perlu ditelusuri.`);
  }

  parts.push(`\nTOP ANOMALY`);
  if (topAnomalies.length > 0) {
    const a = topAnomalies[0];
    parts.push(`${a.itemName} @ ${a.outletCode} (${a.area}) — ${a.direction}, Nominal ${fmtNum(a.absNominal, ' IDR')}, Dev/BOM ${fmtPct(a.devBom, false)}. ${a.issue}.`);
  }

  parts.push(`\nINDICATION (bukan final root cause):`);
  parts.push(`- Perlu investigasi: Actual Usage vs SOC, pencatatan Waste/Susut/Trial, receiving discrepancy, UOM conversion.`);
  parts.push(`- Jika pola sama di multiple outlet: indikasi masalah systemic (SOC/standard).`);
  parts.push(`- Jika hanya 1 outlet: indikasi masalah operational lokal.`);

  return parts.join('\n');
}

const CFG_FACTOR = 2.0;

export async function generateNarrative(input: NarrativeInput): Promise<{ narrative: string; source: 'llm' | 'fallback'; error?: string }> {
  const structuredSummary = buildStructuredSummary(input);

  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: SYSTEM_PROMPT },
        { role: 'user', content: `Berdasarkan data terstruktur berikut, tulis narasi analisis inventory:\n\n${structuredSummary}` },
      ],
      thinking: { type: 'disabled' },
    });

    const narrative = completion.choices[0]?.message?.content?.trim();
    if (!narrative) {
      return { narrative: buildFallbackNarrative(input), source: 'fallback', error: 'Empty LLM response' };
    }
    return { narrative, source: 'llm' };
  } catch (e: any) {
    return { narrative: buildFallbackNarrative(input), source: 'fallback', error: e?.message || String(e) };
  }
}

// ============================================================
//  Recommendation Engine — rule-based WHY/WHAT/PRIORITY
// ============================================================
export function buildRecommendations(worklist: InvestigationItem[]): Array<{
  why: string;
  what: string[];
  priority: 'P1' | 'P2' | 'P3';
}> {
  if (worklist.length === 0) {
    return [{
      why: 'Tidak ada anomaly terdeteksi pada periode ini.',
      what: ['Lanjutkan monitoring rutin.'],
      priority: 'P3',
    }];
  }

  const p1 = worklist.filter((w) => w.priority === 'P1');
  const p2 = worklist.filter((w) => w.priority === 'P2');

  const recommendations: Array<{ why: string; what: string[]; priority: 'P1' | 'P2' | 'P3' }> = [];

  if (p1.length > 0) {
    const top = p1[0];
    const hasResidual = p1.some((w) => w.ruleCodes.some((c) => c.includes('RESIDUAL')));
    const hasBomMismatch = p1.some((w) => w.ruleCodes.some((c) => c.includes('BOM')));
    const hasSalesMismatch = p1.some((w) => w.ruleCodes.some((c) => c.includes('SALES')));
    const hasTolerance = p1.some((w) => w.ruleCodes.some((c) => c.includes('TOLERANCE')));
    const hasBenchmark = p1.some((w) => w.ruleCodes.some((c) => c.includes('BENCHMARK')));
    const hasHistorical = p1.some((w) => w.ruleCodes.some((c) => c.includes('HISTORICAL')));

    const whyParts: string[] = [];
    if (hasResidual) whyParts.push('Residual Loss tinggi setelah dikurangi Waste/Susut/Trial');
    if (hasBomMismatch) whyParts.push('Deviation growth tidak sebanding dengan BOM growth');
    if (hasSalesMismatch) whyParts.push('Deviation growth jauh melebihi Sales growth');
    if (hasTolerance) whyParts.push('Deviation/BOM melebihi tolerance');
    if (hasBenchmark) whyParts.push('Outlet menyimpang dari benchmark area/network');
    if (hasHistorical) whyParts.push('Deviation abnormal vs historical behavior');
    whyParts.push(`Financial impact tertinggi: ${top.itemName} @ ${top.outletCode} (Rp ${top.absNominalDeviasi.toLocaleString('id-ID')})`);

    const what: string[] = [];
    if (hasResidual) what.push('Validasi Actual Usage vs SOC + sampling fisik + cek pencatatan Waste/Susut/Trial');
    if (hasBomMismatch) what.push('Rekonsiliasi BOM aktual vs sistem + periksa receiving/transfer/UOM conversion');
    if (hasSalesMismatch) what.push('Audit transaksi inventory + cek price effect vs quantity effect');
    if (hasTolerance) what.push('Review SOC/standard + sampling pemakaian aktual per menu');
    if (hasBenchmark) what.push('Benchmarking vs outlet serupa + audit prosedur operasional');
    if (hasHistorical) what.push('Investigasi pola outlier vs historical behavior');
    what.push('Cross-check receiving vs invoice supplier');
    what.push('Verifikasi transfer antar outlet');

    recommendations.push({
      why: whyParts.join('; '),
      what,
      priority: 'P1',
    });
  }

  if (p2.length > 0) {
    recommendations.push({
      why: `${p2.length} item dengan severity WARNING perlu monitoring. Pattern: deviation moderate atau tolerance breach ringan.`,
      what: [
        'Monitoring tren mingguan item-item P2',
        'Sampling spot-check pada item dengan deviation rising',
        'Verifikasi pencatatan Waste/Susut rutin',
      ],
      priority: 'P2',
    });
  }

  return recommendations;
}
