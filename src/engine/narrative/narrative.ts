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
  // BUG 2.6 fix: align with format.ts conventions (M=miliar/billion, Jt=juta/million, Rb=ribu/thousand)
  // Previously used M=million, causing 1000x discrepancy between LLM narrative and dashboard.
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}M${unit}`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}Jt${unit}`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}Rb${unit}`;
  return `${sign}${v.toFixed(0)}${unit}`;
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
  lines.push(`- Waste: ${fmtNum(db.waste)} (${db.total > 0 ? ((db.waste / db.total) * 100).toFixed(1) : '0.0'}%)`);
  lines.push(`- Susut: ${fmtNum(db.susut)} (${db.total > 0 ? ((db.susut / db.total) * 100).toFixed(1) : '0.0'}%)`);
  lines.push(`- Trial: ${fmtNum(db.trial)} (${db.total > 0 ? ((db.trial / db.total) * 100).toFixed(1) : '0.0'}%)`);
  lines.push(`- Residual: ${fmtNum(db.residual)} (${db.total > 0 ? ((db.residual / db.total) * 100).toFixed(1) : '0.0'}%)`);
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
    `Waste ${fmtNum(db.waste)} (${db.total > 0 ? ((db.waste / db.total) * 100).toFixed(1) : '0.0'}%), ` +
    `Susut ${fmtNum(db.susut)} (${db.total > 0 ? ((db.susut / db.total) * 100).toFixed(1) : '0.0'}%), ` +
    `Trial ${fmtNum(db.trial)} (${db.total > 0 ? ((db.trial / db.total) * 100).toFixed(1) : '0.0'}%), ` +
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
        // Bug 4 fix: role must be 'system' (not 'assistant') for system prompt
        { role: 'system', content: SYSTEM_PROMPT },
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

// ============================================================
//  AI Executive Summary — Opsi A
//  2-3 paragraf opini AI di awal laporan, sebelum section detail.
//  Persona: Business Consultant (strategis, fokus impact + risk).
//  Memberi context + key highlights sebelum SM/AM/RM baca tabel.
// ============================================================
const EXEC_SUMMARY_PROMPT = `Anda adalah Business Consultant senior untuk jaringan F&B.
Tugas: tulis EXECUTIVE SUMMARY singkat (2-3 paragraf) untuk laporan analisis deviasi inventory.

STRUKTUR WAJIB:
Paragraf 1 — KONDISI: Ringkas kondisi periode ini (baik/waspada/kritis) + 1-2 angka kunci.
Paragraf 2 — KEY HIGHLIGHTS: 3-5 bullet point temuan penting (item/outlet/area yang menonjol).
Paragraf 3 — RISK LEVEL + NEXT STEP: Risk (LOW/MEDIUM/HIGH) + alasan + 1-2 action immediate.

ATURAN:
1. Bahasa: Indonesia formal-professional, padat, tidak bertele-tele.
2. Sebutkan angka dengan eksplisit (Sales, Deviasi, Growth %).
3. Jangan hitung ulang — pakai angka yang diberikan.
4. Jangan sebut root cause pasti — pakai "indikasi", "kemungkinan".
5. Maksimal 250 kata. Eye-catching untuk SM/AM/RM baca 30 detik.`;

export async function generateAIExecutiveSummary(input: NarrativeInput): Promise<string> {
  const structuredSummary = buildStructuredSummary(input);
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: EXEC_SUMMARY_PROMPT },
        { role: 'user', content: `Data terstruktur:\n\n${structuredSummary}` },
      ],
      thinking: { type: 'disabled' },
    });
    const summary = completion.choices[0]?.message?.content?.trim();
    if (!summary) return buildFallbackExecSummary(input);
    return summary;
  } catch (e: any) {
    return buildFallbackExecSummary(input);
  }
}

function buildFallbackExecSummary(input: NarrativeInput): string {
  const { period, executiveSummary: s, growthMetrics: g, healthStatus: hs, topAnomalies } = input;
  const total = hs.normal + hs.warning + hs.abnormal;
  const abnPct = total > 0 ? ((hs.abnormal / total) * 100).toFixed(1) : '0.0';
  const riskLevel = hs.abnormal > 10 || (g.nominalDeviasiGrowth != null && g.nominalDeviasiGrowth > 0.2) ? 'HIGH' : hs.abnormal > 5 ? 'MEDIUM' : 'LOW';
  const lines: string[] = [];
  lines.push(`KONDISI: Periode ${period.weekLabel} ${period.monthLabel} menunjukkan ${riskLevel === 'HIGH' ? 'kondisi yang perlu perhatian segera' : riskLevel === 'MEDIUM' ? 'kondisi yang perlu monitoring' : 'kondisi stabil'}. Sales ${fmtNum(s.sales.current, ' IDR')}${s.sales.growth != null ? ` (${fmtPct(s.sales.growth)})` : ''}, Nominal Deviasi ${fmtNum(s.nominalDeviasi.current, ' IDR')}${s.nominalDeviasi.growth != null ? ` (${fmtPct(s.nominalDeviasi.growth)})` : ''}. ${hs.abnormal} item abnormal dari ${total} total (${abnPct}%).`);
  lines.push('');
  lines.push('KEY HIGHLIGHTS:');
  topAnomalies.slice(0, 3).forEach((a, i) => {
    lines.push(`- ${a.itemName} @ ${a.outletCode} (${a.direction}): ${fmtNum(a.absNominal, ' IDR')} — ${a.issue}`);
  });
  if (g.nominalDeviasiGrowth != null && g.salesGrowth != null && g.nominalDeviasiGrowth > g.salesGrowth * 1.5) {
    lines.push(`- Deviasi growth (${fmtPct(g.nominalDeviasiGrowth)}) jauh melebihi Sales growth (${fmtPct(g.salesGrowth)}) — indikasi masalah operational, bukan volume.`);
  }
  lines.push('');
  lines.push(`RISK LEVEL: ${riskLevel} — ${riskLevel === 'HIGH' ? 'investigasi P1 dalam 7 hari' : riskLevel === 'MEDIUM' ? 'monitoring ketat minggu depan' : 'lanjutkan practice, monitoring rutin'}.`);
  return lines.join('\n');
}

// ============================================================
//  AI Pattern Insight — Opsi D
//  1-2 paragraf insight pola/korelasi/anomaly yang AI temukan.
//  Persona: Inventory Analyst (teknis, fokus pattern + correlation).
//  Ditempatkan sebelum section narrative (15).
// ============================================================
const PATTERN_PROMPT = `Anda adalah Inventory Data Analyst senior.
Tugas: temukan POLA dan INSIGHT tersembunyi dari data deviasi inventory.

FOKUS:
1. Cross-correlation: hubungan antar metric (mis. sales↑ vs waste↑, BOM↑ vs deviasi↓)
2. Anomaly pattern: item/outlet yang muncul berulang atau punya pola tidak wajar
3. Composition insight: apakah Waste/Susut/Trial/Residual proporsional atau ada yang dominan
4. Historical context: bandingkan dengan growth trend
5. Benchmark indication: area/outlet yang menonjol dari network

FORMAT:
- 1-2 paragraf naratif (maks 200 kata)
- Sebutkan pola spesifik dengan angka
- Berikan interpretasi (bukan deskripsi ulang data)
- Akhiri dengan 1 pertanyaan investigasi yang critical

ATURAN:
1. Bahasa Indonesia formal-professional
2. Jangan ulang data mentah — beri INSIGHT/INTERPRETASI
3. Jangan sebut root cause pasti
4. Fokus pada "APA ARTINYA" bukan "APA ANGKANYA"`;

export async function generateAIPatternInsight(input: NarrativeInput): Promise<string> {
  const structuredSummary = buildStructuredSummary(input);
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: PATTERN_PROMPT },
        { role: 'user', content: `Data terstruktur:\n\n${structuredSummary}` },
      ],
      thinking: { type: 'disabled' },
    });
    const insight = completion.choices[0]?.message?.content?.trim();
    if (!insight) return buildFallbackPatternInsight(input);
    return insight;
  } catch (e: any) {
    return buildFallbackPatternInsight(input);
  }
}

function buildFallbackPatternInsight(input: NarrativeInput): string {
  const { executiveSummary: s, growthMetrics: g, deviationBreakdown: db, topAnomalies, healthStatus: hs } = input;
  const lines: string[] = [];
  // Pattern 1: composition
  const residualPct = db.total > 0 ? (db.residual / db.total) * 100 : 0;
  const wastePct = db.total > 0 ? (db.waste / db.total) * 100 : 0;
  if (residualPct > 40) {
    lines.push(`Pola komposisi menunjukkan Residual Loss mendominasi (${residualPct.toFixed(1)}% dari total deviation) — ini mengindikasikan sebagian besar selisih TIDAK terjelaskan oleh Waste/Susut/Trial. Kemungkinan: gap antara Actual Usage vs SOC, atau pencatatan Waste/Susut/Trial tidak lengkap. Investigasi: apakah SOC perlu review, atau apakah ada item yang belum dikategorisasi dengan benar?`);
  } else if (wastePct > 50) {
    lines.push(`Waste mendominasi komposisi deviation (${wastePct.toFixed(1)}%) — fokus investigasi pada handling process, storage, dan portion control. Residual hanya ${residualPct.toFixed(1)}% menunjukkan pencatatan relatif lengkap.`);
  } else {
    lines.push(`Komposisi deviation relatif terdistribusi: Waste ${wastePct.toFixed(1)}%, Residual ${residualPct.toFixed(1)}%. Tidak ada single driver dominan — investigasi per-item lebih efektif daripada per-category.`);
  }
  // Pattern 2: growth mismatch
  if (g.nominalDeviasiGrowth != null && g.salesGrowth != null) {
    const ratio = g.salesGrowth !== 0 ? g.nominalDeviasiGrowth / g.salesGrowth : 0;
    if (ratio > 2) {
      lines.push(`Deviasi growth (${fmtPct(g.nominalDeviasiGrowth)}) ${ratio.toFixed(1)}× lebih besar dari Sales growth (${fmtPct(g.salesGrowth)}) — pola ini sering muncul saat ada operational issue (bukan volume). Pertanyaan kritis: apakah item P1 terkonsentrasi di area tertentu atau menyebar?`);
    } else if (ratio < 0.5 && g.nominalDeviasiGrowth < 0) {
      lines.push(`Deviasi turun (${fmtPct(g.nominalDeviasiGrowth)}) meski Sales ${fmtPct(g.salesGrowth)} — indikasi perbaikan operational. Pertanyaan: practice apa yang berubah? Dapat direplikasi ke outlet lain?`);
    }
  }
  // Pattern 3: anomaly concentration
  if (topAnomalies.length > 0) {
    const outlets = new Set(topAnomalies.map(a => a.outletCode));
    const items = new Set(topAnomalies.map(a => a.itemName));
    if (outlets.size === 1 && topAnomalies.length > 2) {
      lines.push(`Anomaly terkonsentrasi di 1 outlet (${[...outlets][0]}) dengan ${topAnomalies.length} item — indikasi masalah operational lokal, bukan systemic. Pertanyaan: apakah ada perubahan staff atau proses di outlet ini?`);
    } else if (items.size === 1 && topAnomalies.length > 2) {
      lines.push(`Anomaly terkonsentrasi di 1 item (${[...items][0]}) di multiple outlet — indikasi masalah recipe/BOM/supplier systemic. Pertanyaan: apakah BOM item ini perlu review?`);
    }
  }
  return lines.length > 0 ? lines.join('\n\n') : 'Tidak ada pola signifikan terdeteksi pada periode ini. Data relatif normal — monitoring rutin dilanjutkan.';
}
