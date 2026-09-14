// ============================================================
//  pdf-builder — Stage 2 of /api/export-report GET pipeline (PDF)
//  --------------------------------------------------------
//  EXPORT-PDF: replaces docx-builder.ts (deleted). Output switched from
//  .docx → .pdf with a full report design: cover band, KPI hero cards,
//  13 numbered sections, zebra tables with repeated headers, and vector
//  charts (bars / lines / pareto / donut / heat matrix / flip pairs).
//
//  Section map (FIXED numbers — stable across ?sections= selections;
//  keep in sync with EXPORT_SECTION_KEYS in validation.ts + the
//  SECTIONS list in ExportDialog.tsx):
//     1 exec        — Ringkasan Eksekutif (hero cards + 16-row KPI table)
//     2 growth      — Perubahan vs Periode Pembanding (table + growth bars)
//     3 breakdown   — Rincian Komposisi Selisih (tables + donut)
//     4 area        — Analisis per Area (table + bar chart)
//     5 outlets     — Resto Prioritas (table + bar chart)
//     6 pareto      — Konsentrasi & Analisis Pareto (pareto chart + tables)
//     7 topItems    — Item Prioritas (6 sub-tables)
//     8 variance    — Perubahan Item: Memburuk / Membaik (tables + bars)
//     9 itemTrend   — Trend Item Multi-Periode (heat matrix)
//    10 flip        — Analisis Flip-Flop (risk table + pair bars)
//    11 peer        — Pembanding Peer-to-Peer (target vs peers)
//    12 trend       — Trend Antar Periode (table + bar + line charts)
//    13 coverage    — Lampiran: Cakupan Data & Filter (+ definisi metrik)
//
//  Content rule (user request, EXPAND-1): EVERY rendered line is a SQL
//  aggregate, a factual label, or a formula definition — no generated
//  narrative sentences.
//
//  Returns { bufferBase64, fileName } for the route's cache wrapper
//  (P3-HYG-4: base64 keeps the cache row compact + JSON-serializable).
// ============================================================
import PDFDocument from 'pdfkit';
import { calcGrowth } from '@/lib/metrics';
import { fmtIDR, fmtNum, fmtPct } from '../format-helpers';
import type { ReportData, ReportContext } from '../types';
import { Rpt, C, PAGE, CONTENT_W } from './pdf-primitives';
import {
  barChartV, hBarChart, lineChart, paretoChart, stackedHBar, donutChart, flipPairBars,
} from './pdf-charts';

// ------------------------------------------------------------
//  Local formatters (moved from the deleted docx-builder.ts — identical
//  formatting logic, byte-for-byte parity for the shared ones)
// ------------------------------------------------------------
function fmtPp(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '\u2014';
  const pp = v * 100;
  const sign = pp > 0 ? '+' : '';
  return `${sign}${pp.toFixed(2)} pp`;
}

function fmtDateTimeWIB(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  return `${d.toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'medium', timeZone: 'Asia/Jakarta' })} WIB`;
}

function fmtVsHist(current: number | null, histAvg: number | null): string {
  if (current == null || histAvg == null || histAvg === 0) return '\u2014';
  const pctChange = (current - histAvg) / Math.abs(histAvg);
  const pctStr = `${(Math.abs(pctChange) * 100).toFixed(1)}%`;
  if (pctChange > 0) return `+ ${pctStr}`;
  if (pctChange < 0) return `- ${pctStr}`;
  return '= 0%';
}

/** "Juli 2026" → "JUL 26" (same short format the docx export used). */
function shortMonth(label: string): string {
  if (!label) return '\u2014';
  const parts = label.trim().split(/\s+/);
  if (parts.length >= 2) {
    const month = parts[0].substring(0, 3).toUpperCase();
    const year = parts[1].length === 4 ? parts[1].substring(2) : parts[1];
    return `${month} ${year}`;
  }
  return label.substring(0, 10);
}

/** Heat color for the item-trend matrix cells (amber intensity scale). */
function heatColor(v: number, max: number): string | undefined {
  if (max <= 0 || v <= 0) return undefined;
  const r = v / max;
  if (r < 0.2) return '#FFFBEB';
  if (r < 0.4) return '#FEF3C7';
  if (r < 0.6) return '#FDE68A';
  if (r < 0.8) return '#FCD34D';
  return '#F59E0B';
}

/** Signed compact IDR for chart tick labels (no 'Rp' prefix — axis stays narrow). */
const tickIDR = (v: number): string => {
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
  return v.toFixed(0);
};
const tickPct = (v: number): string => `${v.toFixed(1)}%`;

// ============================================================
//  Main entry — buildPdfReport
// ============================================================
export async function buildPdfReport(
  data: ReportData,
  ctx: ReportContext,
): Promise<{ bufferBase64: string; fileName: string }> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `Laporan Audit Inventory ${shortMonth(data.period.monthLabel)} ${data.period.weekLabel}`,
      Author: 'Inventory Control',
      Creator: 'Inventory Control',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  return new Promise<{ bufferBase64: string }>((resolve, reject) => {
    doc.on('end', () => resolve({ bufferBase64: Buffer.concat(chunks).toString('base64') }));
    doc.on('error', reject);
    try {
      drawReport(doc, data, ctx);
      // Post-hoc pass: running header (pages 2+) + footer (every page).
      const range = doc.bufferedPageRange();
      const headerLabel = `LAPORAN AUDIT INVENTORY  \u00B7  ${shortMonth(data.period.monthLabel)} ${data.period.weekLabel}`;
      const footerLabel = `${shortMonth(data.period.monthLabel)} ${data.period.weekLabel}${data.period.comparisonMonth ? ` vs ${shortMonth(data.period.comparisonMonth)} ${data.period.comparisonWeek ?? ''}` : ''}`;
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        if (i > range.start) Rpt.runningHeader(doc, headerLabel);
        Rpt.footer(doc, i, range.count, footerLabel);
      }
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }).then((r) => {
    // fileName — sanitized to the RFC 2183/5987-safe charset (BUG-3-a C5
    // convention): outlet + month + week + compare suffix.
    const outletLabel = data.filters.outletCode && data.filters.outletCode !== 'all'
      ? data.filters.outletCode
      : 'Semua_Resto';
    const vs = data.period.comparisonWeek ? `_vs_${data.period.comparisonWeek}` : '';
    const raw = `Laporan_Audit_${outletLabel}_${shortMonth(data.period.monthLabel).replace(/\s+/g, '_')}_${data.period.weekLabel}${vs}.pdf`;
    return { bufferBase64: r.bufferBase64, fileName: raw.replace(/[^A-Za-z0-9._-]/g, '_') };
  });
}

// ============================================================
//  drawReport — all pages/sections
// ============================================================
function drawReport(doc: PDFKit.PDFDocument, data: ReportData, ctx: ReportContext): void {
  const rpt = new Rpt(doc);
  const hasSection = (key: string): boolean => !ctx.sections || ctx.sections.includes(key);

  // ---- dynamic labels ------------------------------------------------
  const currLabel = shortMonth(data.period.monthLabel);
  const prevLabel = data.period.comparisonMonth ? shortMonth(data.period.comparisonMonth) : '\u2014';
  const histMonths = ctx.historicalPeriods.map((p) => shortMonth(p.monthLabel)).filter((m) => m !== '\u2014');
  const histLabel = histMonths.length === 0
    ? 'Hist (\u2014)'
    : histMonths.length === 1
      ? `Hist (${histMonths[0]})`
      : `Hist (${histMonths[0]}-${histMonths[histMonths.length - 1]})`;
  const histRange = histMonths.length >= 2
    ? `${histMonths[0]}-${histMonths[histMonths.length - 1]}`
    : histMonths.length === 1
      ? histMonths[0]
      : currLabel;
  const restoName = data.filters.outletCode && data.filters.outletCode !== 'all' ? data.filters.outletCode : 'Semua Resto';
  const s = data.executiveSummary;
  const pm = s._prevMetrics;
  const kpisAvailable = hasSection('exec') || hasSection('growth') || hasSection('breakdown') || hasSection('area');

  // ============================================================
  //  COVER — band + filter chips + KPI hero cards + TOC
  // ============================================================
  rpt.coverBand(
    'LAPORAN AUDIT INVENTORY',
    `${restoName}  \u00B7  ${data.period.monthLabel} \u2014 ${data.period.weekLabel}`,
    [
      fmtDateTimeWIB(data.coverage?.generatedAt ?? new Date().toISOString()),
      data.period.comparisonMonth ? `Pembanding: ${data.period.comparisonMonth} \u2014 ${data.period.comparisonWeek ?? '\u2014'}` : 'Tanpa periode pembanding',
      `Baseline historis: ${histRange}`,
    ],
  );

  // filter chips
  const f = data.filters;
  const fv = (v: string | null | undefined): string | null => (v && v !== 'all' ? v : null);
  const chips: Array<[string, string | null]> = [
    ['AREA', fv(f.area)], ['KELOMPOK', fv(f.kelompok)], ['RESTO', fv(f.outletCode)],
    ['ITEM', fv(f.itemName)], ['PIC', fv(f.pic)],
  ];
  {
    let cx = PAGE.M;
    const cy = rpt.y + 2;
    for (const [lb, val] of chips) {
      const w = rpt.chip(val ? `${lb}: ${val}` : `${lb}: Semua`, cx, cy, val ? C.accentLight : C.borderSoft, val ? C.accentDark : C.muted, { size: 6.2 });
      cx += w + 5;
      if (cx > PAGE.W - PAGE.M - 120) break;
    }
    rpt.y = cy + 16;
  }

  // KPI hero cards (2 rows x 3) — only when the kpis row was fetched
  if (kpisAvailable) {
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    // Hoisted (TS narrowing through repeated pm?.x ternaries inside one
    // object literal is fragile) — also avoids re-running calcGrowth.
    const lossG = pm != null && pm.totalLoss != null ? calcGrowth(s.totalLoss, pm.totalLoss) : null;
    const surplusG = pm != null && pm.totalSurplus != null ? calcGrowth(s.totalSurplus, pm.totalSurplus) : null;
    rpt.kpiCards([
      { label: 'Penjualan', value: fmtIDR(s.sales.current), sub: s.sales.growth != null ? `vs ${prevLabel}: ${fmtPct(s.sales.growth, true)}` : undefined, subColor: s.sales.growth != null ? (s.sales.growth >= 0 ? C.success : C.danger) : C.muted },
      { label: 'Nominal Deviasi', value: fmtIDR(s.nominalDeviasi.current), sub: s.nominalDeviasi.growth != null ? `vs ${prevLabel}: ${fmtPct(s.nominalDeviasi.growth, true)}` : undefined, subColor: s.nominalDeviasi.growth != null ? (s.nominalDeviasi.growth > 0 ? C.danger : C.success) : C.muted, accent: C.danger },
      { label: '% Deviasi To BOM', value: fmtPct(s.deviationToBom, false), sub: pm?.deviationToBom != null ? `vs ${prevLabel}: ${fmtPct(calcGrowth(s.deviationToBom, pm.deviationToBom), true)}` : undefined, subColor: C.muted },
      { label: 'Total LOSS', value: fmtIDR(s.totalLoss), sub: lossG != null ? `vs ${prevLabel}: ${fmtPct(lossG, true)}` : undefined, subColor: lossG != null ? (lossG > 0 ? C.danger : C.success) : C.muted, accent: C.danger },
      { label: 'Total SURPLUS', value: fmtIDR(s.totalSurplus), sub: surplusG != null ? `vs ${prevLabel}: ${fmtPct(surplusG, true)}` : undefined, subColor: surplusG != null ? (surplusG > 0 ? C.danger : C.success) : C.muted, accent: C.success },
      { label: '% Nominal Deviasi to Sales', value: fmtPct(devToSalesCur, false), sub: pm != null ? `Loss/Sales ${fmtPct(s.lossToSales, false)} \u00B7 Surplus/Sales ${fmtPct(s.surplusToSales, false)}` : undefined, subColor: C.muted },
    ]);
  }

  // Table of contents — fixed section numbers
  const SECTION_TITLES: Record<string, string> = {
    exec: 'Ringkasan Eksekutif',
    growth: 'Perubahan vs Periode Pembanding',
    breakdown: 'Rincian Komposisi Selisih',
    area: 'Analisis per Area',
    outlets: 'Resto Prioritas',
    pareto: 'Konsentrasi & Analisis Pareto',
    topItems: 'Item Prioritas (Top Items)',
    variance: 'Perubahan Item (vs Pembanding)',
    itemTrend: 'Trend Item Multi-Periode',
    flip: 'Analisis Flip-Flop',
    peer: 'Pembanding Peer-to-Peer',
    trend: 'Trend Antar Periode',
    coverage: 'Lampiran: Cakupan Data & Filter',
  };
  const SECTION_ORDER = ['exec', 'growth', 'breakdown', 'area', 'outlets', 'pareto', 'topItems', 'variance', 'itemTrend', 'flip', 'peer', 'trend', 'coverage'];
  const active = SECTION_ORDER.filter(hasSection);
  if (active.length > 0) {
    rpt.subhead('Isi Laporan', { size: 10 });
    const col2 = PAGE.M + CONTENT_W / 2 + 8;
    active.forEach((key, i) => {
      const x = i % 2 === 0 ? PAGE.M : col2;
      if (i % 2 === 0) rpt.ensure(13);
      const y = rpt.y;
      const no = SECTION_ORDER.indexOf(key) + 1;
      doc.fillColor(C.accent).roundedRect(x, y + 1, 13, 9, 2).fill();
      rpt.text(String(no).padStart(2, '0'), x, y + 2.6, { font: 'Helvetica-Bold', size: 6, color: C.white, align: 'center', width: 13 });
      rpt.text(SECTION_TITLES[key], x + 18, y + 1.2, { size: 7.2, color: C.inkSoft });
      if (i % 2 === 1) rpt.y = y + 13;
      if (i === active.length - 1 && i % 2 === 0) rpt.y = y + 13;
    });
    rpt.y += 8;
  }

  // ============================================================
  //  1 — RINGKASAN EKSEKUTIF
  // ============================================================
  if (hasSection('exec')) {
    rpt.sectionHeader(1, 'Ringkasan Eksekutif', `Agregat periode ${currLabel} (kolom pembanding: ${prevLabel})`);
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    const g = (v: number | null): string => (v != null ? fmtPct(v, true) : '\u2014');
    rpt.table({
      cols: [
        { header: 'Metrik', w: 172 },
        { header: currLabel, w: 118, align: 'right' },
        { header: 'Perubahan', w: 90, align: 'right' },
        { header: prevLabel, w: 131.28, align: 'right' },
      ],
      boldFirst: true,
      rowText: (row) => (row[2].startsWith('-') ? C.danger : undefined),
      rows: [
        ['Penjualan', fmtIDR(s.sales.current), g(s.sales.growth), fmtIDR(s.sales.previous)],
        ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), g(s.nominalDeviasi.growth), fmtIDR(s.nominalDeviasi.previous)],
        ['% Nominal Deviasi to Sales', fmtPct(devToSalesCur, false), devToSalesCur != null && devToSalesPrev != null ? fmtPct(calcGrowth(devToSalesCur, devToSalesPrev), true) : '\u2014', fmtPct(devToSalesPrev, false)],
        ['QTY BOM', fmtNum(s.qtyBom.current), g(s.qtyBom.growth), fmtNum(s.qtyBom.previous)],
        ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), g(s.qtyDeviasi.growth), fmtNum(s.qtyDeviasi.previous)],
        ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), pm?.deviationToBom != null ? fmtPct(calcGrowth(s.deviationToBom, pm.deviationToBom), true) : '\u2014', pm?.deviationToBom != null ? fmtPct(pm.deviationToBom, false) : '\u2014'],
        ['QTY Waste', fmtNum(s.qtyWaste.current), g(s.qtyWaste.growth), fmtNum(s.qtyWaste.previous)],
        ['QTY Susut', fmtNum(s.qtySusut.current), g(s.qtySusut.growth), fmtNum(s.qtySusut.previous)],
        ['QTY Trial', fmtNum(s.qtyTrial.current), g(s.qtyTrial.growth), fmtNum(s.qtyTrial.previous)],
        ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), g(s.qtyLossSurplus.growth), fmtNum(s.qtyLossSurplus.previous)],
        ['Loss/Surplus Qty', fmtNum(s.residualLossQty), pm?.residualLossQty != null ? fmtPct(calcGrowth(s.residualLossQty, pm.residualLossQty), true) : '\u2014', pm?.residualLossQty != null ? fmtNum(pm.residualLossQty) : '\u2014'],
        ['Loss/Surplus %', fmtPct(s.residualLossPct, false), pm?.residualLossPct != null ? fmtPct(calcGrowth(s.residualLossPct, pm.residualLossPct), true) : '\u2014', pm?.residualLossPct != null ? fmtPct(pm.residualLossPct, false) : '\u2014'],
        ['Total LOSS', fmtIDR(s.totalLoss), pm?.totalLoss != null ? fmtPct(calcGrowth(s.totalLoss, pm.totalLoss), true) : '\u2014', pm?.totalLoss != null ? fmtIDR(pm.totalLoss) : '\u2014'],
        ['Total SURPLUS', fmtIDR(s.totalSurplus), pm?.totalSurplus != null ? fmtPct(calcGrowth(s.totalSurplus, pm.totalSurplus), true) : '\u2014', pm?.totalSurplus != null ? fmtIDR(pm.totalSurplus) : '\u2014'],
        ['% Loss to Sales', fmtPct(s.lossToSales, false), pm?.lossToSales != null ? fmtPct(calcGrowth(s.lossToSales, pm.lossToSales), true) : '\u2014', pm?.lossToSales != null ? fmtPct(pm.lossToSales, false) : '\u2014'],
        ['% Surplus to Sales', fmtPct(s.surplusToSales, false), pm?.surplusToSales != null ? fmtPct(calcGrowth(s.surplusToSales, pm.surplusToSales), true) : '\u2014', pm?.surplusToSales != null ? fmtPct(pm.surplusToSales, false) : '\u2014'],
      ],
    });
  }

  // ============================================================
  //  2 — PERUBAHAN VS PERIODE PEMBANDING
  // ============================================================
  if (hasSection('growth')) {
    rpt.sectionHeader(2, 'Perubahan vs Periode Pembanding', `${currLabel} vs ${prevLabel} \u2014 selisih absolut, selisih pp (rasio), growth %`);
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    const vr = (label: string, cur: number | null, prev: number | null, fmt: typeof fmtIDR, growth: number | null): string[] => [
      label, fmt(cur), fmt(prev),
      cur != null && prev != null ? fmt(cur - prev) : '\u2014',
      growth != null ? fmtPct(growth, true) : '\u2014',
    ];
    const rr = (label: string, cur: number | null, prev: number | null, growth: number | null): string[] => [
      label, fmtPct(cur, false), fmtPct(prev, false),
      cur != null && prev != null ? fmtPp(cur - prev) : '\u2014',
      growth != null ? fmtPct(growth, true) : '\u2014',
    ];
    const growthRows: string[][] = [
      vr('Penjualan (Rp)', s.sales.current, s.sales.previous, fmtIDR, s.sales.growth),
      vr('Nominal Deviasi (Rp)', s.nominalDeviasi.current, s.nominalDeviasi.previous, fmtIDR, s.nominalDeviasi.growth),
      vr('QTY BOM', s.qtyBom.current, s.qtyBom.previous, fmtNum, s.qtyBom.growth),
      vr('QTY Deviasi', s.qtyDeviasi.current, s.qtyDeviasi.previous, fmtNum, s.qtyDeviasi.growth),
      vr('QTY Waste', s.qtyWaste.current, s.qtyWaste.previous, fmtNum, s.qtyWaste.growth),
      vr('QTY Susut', s.qtySusut.current, s.qtySusut.previous, fmtNum, s.qtySusut.growth),
      vr('QTY Trial', s.qtyTrial.current, s.qtyTrial.previous, fmtNum, s.qtyTrial.growth),
      vr('Total LOSS (Rp)', s.totalLoss, pm?.totalLoss ?? null, fmtIDR, pm?.totalLoss != null ? calcGrowth(s.totalLoss, pm.totalLoss) : null),
      vr('Total SURPLUS (Rp)', s.totalSurplus, pm?.totalSurplus ?? null, fmtIDR, pm?.totalSurplus != null ? calcGrowth(s.totalSurplus, pm.totalSurplus) : null),
      rr('% Deviasi To BOM', s.deviationToBom, pm?.deviationToBom ?? null, pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null),
      rr('% Nominal Deviasi to Sales', devToSalesCur, devToSalesPrev, devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null),
      rr('% Loss to Sales', s.lossToSales, pm?.lossToSales ?? null, pm?.lossToSales != null ? calcGrowth(s.lossToSales, pm.lossToSales) : null),
      rr('% Surplus to Sales', s.surplusToSales, pm?.surplusToSales ?? null, pm?.surplusToSales != null ? calcGrowth(s.surplusToSales, pm.surplusToSales) : null),
    ];
    rpt.table({
      cols: [
        { header: 'Metrik', w: 160 },
        { header: currLabel, w: 95, align: 'right' },
        { header: prevLabel, w: 95, align: 'right' },
        { header: 'Selisih', w: 93, align: 'right' },
        { header: 'Growth %', w: 68.28, align: 'right' },
      ],
      boldFirst: true,
      rows: growthRows,
    });
    rpt.para('Selisih baris rasio dinyatakan dalam poin persentase (pp). Growth % = (nilai sekarang \u2212 nilai pembanding) / |nilai pembanding|.', { size: 7.2, color: C.muted });

    // growth % horizontal bars — sales/BOM up = green (good); deviation
    // metrics up = red (bad). Factual coloring by metric direction.
    const withGrowth = [
      { label: 'Penjualan', g: s.sales.growth, goodUp: true },
      { label: 'Nominal Deviasi', g: s.nominalDeviasi.growth, goodUp: false },
      { label: 'QTY BOM', g: s.qtyBom.growth, goodUp: true },
      { label: 'QTY Deviasi', g: s.qtyDeviasi.growth, goodUp: false },
      { label: 'QTY Waste', g: s.qtyWaste.growth, goodUp: false },
      { label: 'QTY Susut', g: s.qtySusut.growth, goodUp: false },
      { label: 'QTY Trial', g: s.qtyTrial.growth, goodUp: false },
      { label: 'Total LOSS', g: pm?.totalLoss != null ? calcGrowth(s.totalLoss, pm.totalLoss) : null, goodUp: false },
      { label: 'Total SURPLUS', g: pm?.totalSurplus != null ? calcGrowth(s.totalSurplus, pm.totalSurplus) : null, goodUp: false },
      { label: '% Dev/BOM', g: pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, goodUp: false },
      { label: '% Loss to Sales', g: pm?.lossToSales != null ? calcGrowth(s.lossToSales, pm.lossToSales) : null, goodUp: false },
      { label: '% Surplus to Sales', g: pm?.surplusToSales != null ? calcGrowth(s.surplusToSales, pm.surplusToSales) : null, goodUp: false },
    ].filter((r) => r.g != null) as Array<{ label: string; g: number; goodUp: boolean }>;
    if (withGrowth.length > 0) {
      rpt.ensure(18 * withGrowth.length + 24);
      rpt.subhead('Growth % per Metrik (vs Pembanding)', { size: 8.5, gapAfter: 2 });
      hBarChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * withGrowth.length,
        labels: withGrowth.map((r) => r.label),
        values: withGrowth.map((r) => r.g * 100),
        fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
        colors: withGrowth.map((r) => (r.g > 0 ? (r.goodUp ? C.success : C.danger) : r.goodUp ? C.danger : C.success)),
        labelW: 118, valW: 52,
      });
      rpt.y += 18 * withGrowth.length + 6;
    }
  }

  // ============================================================
  //  3 — RINCIAN KOMPOSISI SELISIH
  // ============================================================
  if (hasSection('breakdown')) {
    rpt.sectionHeader(3, 'Rincian Komposisi Selisih', 'Komposisi QTY, komposisi Nominal (Rp), dan jumlah record');
    const b = data.deviationBreakdown;
    const cst = data.deviationCost;
    const bdTotal = b.total || 0;
    const ct = cst.totalCost || 0;

    rpt.subhead('3.1 Komposisi QTY', { size: 8.5 });
    rpt.table({
      cols: [{ header: 'Komponen', w: 180 }, { header: 'QTY', w: 150, align: 'right' }, { header: '% dari Total', w: 181.28, align: 'right' }],
      boldFirst: true,
      rows: [
        ['QTY Waste', fmtNum(b.waste), bdTotal > 0 ? `${((b.waste / bdTotal) * 100).toFixed(1)}%` : '\u2014'],
        ['QTY Susut', fmtNum(b.susut), bdTotal > 0 ? `${((b.susut / bdTotal) * 100).toFixed(1)}%` : '\u2014'],
        ['QTY Trial', fmtNum(b.trial), bdTotal > 0 ? `${((b.trial / bdTotal) * 100).toFixed(1)}%` : '\u2014'],
        ['Loss/Surplus Qty', fmtNum(b.residual), bdTotal > 0 ? `${((b.residual / bdTotal) * 100).toFixed(1)}%` : '\u2014'],
        ['TOTAL', fmtNum(bdTotal), '100%'],
      ],
      rowBold: (row) => row[0] === 'TOTAL',
    });

    rpt.subhead('3.2 Komposisi Nominal (Rp)', { size: 8.5 });
    rpt.table({
      cols: [{ header: 'Komponen', w: 180 }, { header: 'Nominal (Rp)', w: 150, align: 'right' }, { header: '% dari Total', w: 181.28, align: 'right' }],
      boldFirst: true,
      rows: [
        ['Waste', fmtIDR(cst.wasteCost), ct > 0 ? `${((cst.wasteCost / ct) * 100).toFixed(1)}%` : '\u2014'],
        ['Susut', fmtIDR(cst.susutCost), ct > 0 ? `${((cst.susutCost / ct) * 100).toFixed(1)}%` : '\u2014'],
        ['Trial', fmtIDR(cst.trialCost), ct > 0 ? `${((cst.trialCost / ct) * 100).toFixed(1)}%` : '\u2014'],
        ['Loss/Surplus', fmtIDR(cst.residualCost), ct > 0 ? `${((cst.residualCost / ct) * 100).toFixed(1)}%` : '\u2014'],
        ['TOTAL', fmtIDR(ct), '100%'],
      ],
      rowBold: (row) => row[0] === 'TOTAL',
    });

    // Donut — nominal composition
    if (ct > 0) {
      const segs = [
        { value: cst.wasteCost, color: '#F59E0B', label: 'Waste' },
        { value: cst.susutCost, color: '#D97706', label: 'Susut' },
        { value: cst.trialCost, color: '#B45309', label: 'Trial' },
        { value: cst.residualCost, color: '#92400E', label: 'Loss/Surplus' },
      ];
      rpt.ensure(120);
      rpt.subhead('Komposisi Nominal (donut)', { size: 8.5, gapAfter: 2 });
      donutChart(doc, { cx: PAGE.M + 62, cy: rpt.y + 52, r: 52, thickness: 20, segments: segs });
      // legend
      let ly = rpt.y + 14;
      doc.font('Helvetica').fontSize(7.2);
      for (const seg of segs) {
        doc.fillColor(seg.color).rect(PAGE.M + 150, ly, 9, 9).fill();
        rpt.text(`${seg.label} \u2014 ${fmtIDR(seg.value)} (${((seg.value / ct) * 100).toFixed(1)}%)`, PAGE.M + 164, ly + 1, { size: 7.2, color: C.inkSoft, ellipsize: true, width: CONTENT_W - 130 });
        ly += 15;
      }
      rpt.y = rpt.y + 104 + 8;
    }

    rpt.subhead('3.3 Jumlah Record', { size: 8.5 });
    rpt.table({
      cols: [{ header: 'Kategori', w: 180 }, { header: 'Jumlah Record', w: 331.28, align: 'right' }],
      boldFirst: true,
      rows: [
        ['LOSS', fmtNum(cst.lossCount)],
        ['SURPLUS', fmtNum(cst.surplusCount)],
        ['TOTAL', fmtNum((cst.lossCount || 0) + (cst.surplusCount || 0))],
      ],
      rowBold: (row) => row[0] === 'TOTAL',
    });
    rpt.para('Residual (Loss/Surplus) = selisih yang tidak terjelaskan oleh Waste + Susut + Trial.', { size: 7.2, color: C.muted });
  }

  // ============================================================
  //  4 — ANALISIS PER AREA
  // ============================================================
  if (hasSection('area') && data.areaAnalysis.length > 0) {
    const ar = data.areaAnalysis;
    rpt.sectionHeader(4, 'Analisis per Area', 'Agregat per area \u2014 resto, penjualan, nominal deviasi, rasio');
    const sumOutletCount = ar.reduce((acc, r) => acc + (r.outletCount || 0), 0);
    const sumSales = ar.reduce((acc, r) => acc + (r.totalSales || 0), 0);
    const sumAbsNominal = ar.reduce((acc, r) => acc + (r.totalAbsNominal || 0), 0);
    rpt.table({
      cols: [
        { header: 'Area', w: 96 },
        { header: 'Resto', w: 44, align: 'right' },
        { header: 'Penjualan', w: 92, align: 'right' },
        { header: 'Nominal Deviasi', w: 92, align: 'right' },
        { header: '% Dev/BOM', w: 61, align: 'right' },
        { header: '% Loss to Sales', w: 62, align: 'right' },
        { header: '% Nominal to Sales', w: 64.28, align: 'right' },
      ],
      rows: [
        ...ar.map((r) => [
          r.area,
          fmtNum(r.outletCount),
          fmtIDR(r.totalSales),
          fmtIDR(r.totalAbsNominal),
          fmtPct(r.avgDevBom, false),
          r.lossToSales != null ? fmtPct(r.lossToSales, false) : '\u2014',
          r.totalSales > 0 ? fmtPct(Math.abs(r.totalAbsNominal) / r.totalSales, false) : '\u2014',
        ]),
        ['TOTAL', fmtNum(sumOutletCount), fmtIDR(sumSales), fmtIDR(sumAbsNominal), fmtPct(s.deviationToBom, false), fmtPct(s.lossToSales, false), s.sales.current > 0 ? fmtPct(Math.abs(s.nominalDeviasi.current) / s.sales.current, false) : '\u2014'],
      ],
      rowBold: (row) => row[0] === 'TOTAL',
    });

    // bar chart — nominal deviasi (abs) per area
    const chartRows = [...ar].sort((a, b2) => b2.totalAbsNominal - a.totalAbsNominal).slice(0, 12);
    rpt.ensure(18 * chartRows.length + 24);
    rpt.subhead('Nominal Deviasi per Area (Rp, nilai absolut)', { size: 8.5, gapAfter: 2 });
    hBarChart(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * chartRows.length,
      labels: chartRows.map((r) => `${r.area} (${r.outletCount})`),
      values: chartRows.map((r) => r.totalAbsNominal),
      fmt: tickIDR,
      labelW: 118, valW: 52,
      colors: chartRows.map((r) => (r.lossToSales != null && s.lossToSales != null && r.lossToSales > s.lossToSales ? C.danger : C.accent)),
    });
    rpt.y += 18 * chartRows.length + 8;
  }

  // ============================================================
  //  5 — RESTO PRIORITAS
  // ============================================================
  if (hasSection('outlets') && data.outletRanking.length > 0) {
    const orr = data.outletRanking;
    rpt.sectionHeader(5, 'Resto Prioritas', '10 resto dengan nominal deviasi terbesar (nilai absolut) \u2014 angka negatif = LOSS');
    rpt.table({
      cols: [
        { header: '#', w: 20, align: 'center' },
        { header: 'Kode', w: 62 },
        { header: 'Nama Resto', w: 108 },
        { header: 'Area', w: 62 },
        { header: 'Nominal Deviasi', w: 78, align: 'right' },
        { header: 'QTY Deviasi', w: 62, align: 'right' },
        { header: '% Dev/BOM', w: 55, align: 'right' },
        { header: 'Loss (Rp)', w: 66, align: 'right' },
        { header: 'Penjualan', w: 62.28, align: 'right' },
      ],
      rows: orr.slice(0, 10).map((o, i) => [
        String(i + 1),
        o.outletCode,
        o.outletName,
        o.area,
        fmtIDR(o.nominalDeviasi),
        fmtNum(o.totalQtyDeviasi),
        o.totalQtyBom > 0 ? fmtPct(o.totalQtyDeviasi / o.totalQtyBom, false) : '\u2014',
        fmtIDR(o.lossNominal),
        fmtIDR(o.sales),
      ]),
      rowText: (row) => (row[4].startsWith('-') ? C.danger : undefined),
    });

    const chartRows = orr.slice(0, 10);
    rpt.ensure(18 * chartRows.length + 24);
    rpt.subhead('Nominal Deviasi Top-10 Resto (Rp, bertanda)', { size: 8.5, gapAfter: 2 });
    hBarChart(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * chartRows.length,
      labels: chartRows.map((o) => `${o.outletCode} ${o.outletName}`),
      values: chartRows.map((o) => o.nominalDeviasi),
      fmt: tickIDR,
      labelW: 118, valW: 52,
      colors: chartRows.map((o) => (o.nominalDeviasi < 0 ? C.danger : C.accent)),
    });
    rpt.y += 18 * chartRows.length + 8;
  }

  // ============================================================
  //  6 — KONSENTRASI & ANALISIS PARETO  (EXPORT-PDF — NEW)
  // ============================================================
  if (hasSection('pareto') && data.paretoItem.drivers.length > 0) {
    const pi = data.paretoItem;
    const po = data.paretoOutlet;
    rpt.sectionHeader(6, 'Konsentrasi & Analisis Pareto', 'Item / resto teratas yang menyumbang porsi terbesar nominal deviasi (aturan 80/20)');

    // factual concentration lines
    const n80 = pi.drivers.filter((d) => d.cumPct < 0.8).length + 1;
    rpt.noteBox(
      `Konsentrasi item: ${n80} item teratas dari ${pi.totalCount} item (${((n80 / Math.max(1, pi.totalCount)) * 100).toFixed(1)}%) menyumbang \u226580% dari total nominal deviasi ${fmtIDR(pi.totalAbsNominal)}. Sisa ${pi.remainderCount} item menyumbang ${fmtPct(pi.remainderPct, false)}.`,
    );
    if (po.drivers.length > 0) {
      const n80o = po.drivers.filter((d) => d.cumPct < 0.8).length + 1;
      rpt.noteBox(
        `Konsentrasi resto: ${n80o} resto teratas dari ${po.totalCount} resto (${((n80o / Math.max(1, po.totalCount)) * 100).toFixed(1)}%) menyumbang \u226580% dari total nominal deviasi ${fmtIDR(po.totalAbsNominal)}.`,
      );
    }

    // pareto chart — top 15 items (bars = abs nominal, line = cumulative %)
    const top15 = pi.drivers.slice(0, 15);
    rpt.ensure(180);
    rpt.subhead('Pareto Item \u2014 15 Teratas (batang = nominal, garis = kumulatif %)', { size: 8.5, gapAfter: 2 });
    paretoChart(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 168,
      labels: top15.map((_, i) => String(i + 1)),
      values: top15.map((d) => d.totalAbsNominal),
      cumPcts: top15.map((d) => d.cumPct * 100),
      fmt: tickIDR,
    });
    rpt.y += 168 + 8;

    rpt.subhead('6.1 Pareto per Item (15 teratas)', { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', w: 20, align: 'center' },
        { header: 'Item', w: 168 },
        { header: 'Resto', w: 42, align: 'right' },
        { header: 'Nominal Deviasi (Rp)', w: 88, align: 'right' },
        { header: 'Nominal Bertanda', w: 82, align: 'right' },
        { header: '% Share', w: 52, align: 'right' },
        { header: '% Kumulatif', w: 59.28, align: 'right' },
      ],
      rows: top15.map((d, i) => [
        String(i + 1),
        d.name,
        d.outletCount != null ? String(d.outletCount) : '\u2014',
        fmtIDR(d.totalAbsNominal),
        fmtIDR(d.nominalDeviasi),
        fmtPct(d.sharePct, false),
        fmtPct(d.cumPct, false),
      ]),
      rowText: (row) => (row[4].startsWith('-') ? C.danger : undefined),
    });

    if (po.drivers.length > 0) {
      rpt.subhead('6.2 Pareto per Resto (10 teratas)', { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', w: 20, align: 'center' },
          { header: 'Resto', w: 178 },
          { header: 'Kode', w: 78 },
          { header: 'Nominal Deviasi (Rp)', w: 92, align: 'right' },
          { header: 'Nominal Bertanda', w: 85, align: 'right' },
          { header: '% Share', w: 58.28, align: 'right' },
        ],
        rows: po.drivers.slice(0, 10).map((d, i) => [
          String(i + 1),
          d.name,
          d.code ?? '\u2014',
          fmtIDR(d.totalAbsNominal),
          fmtIDR(d.nominalDeviasi),
          fmtPct(d.sharePct, false),
        ]),
        rowText: (row) => (row[4].startsWith('-') ? C.danger : undefined),
      });
    }
  }

  // ============================================================
  //  7 — ITEM PRIORITAS (TOP ITEMS)
  // ============================================================
  if (hasSection('topItems')) {
    rpt.sectionHeader(7, 'Item Prioritas (Top Items)', `Enam ranking \u2014 ${currLabel}; kolom ${prevLabel} + ${histLabel} sebagai pembanding`);
    rpt.para('Angka negatif = LOSS/rugi (merah). "vs Hist" membandingkan nilai sekarang dengan rata-rata historis periode sejenis.', { size: 7.2, color: C.muted });

    // 7.1 nominal
    if (data.topItemsByNominal.length > 0) {
      rpt.subhead(`7.1 Nominal Deviasi Terbesar (${currLabel})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', w: 22, align: 'center' },
          { header: 'Item', w: 190 },
          { header: 'Resto', w: 92 },
          { header: 'Satuan', w: 62 },
          { header: `Nominal Deviasi ${currLabel}`, w: 145.28, align: 'right' },
        ],
        rows: data.topItemsByNominal.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtIDR(it.nominalDeviasi)]),
        rowText: (row) => (row[4].startsWith('-') ? C.danger : undefined),
      });
    }
    // 7.2 devBom
    if (data.topItemsByDevBom.length > 0) {
      rpt.subhead(`7.2 % Deviasi To BOM Terbesar (${currLabel})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', w: 22, align: 'center' },
          { header: 'Item', w: 190 },
          { header: 'Resto', w: 92 },
          { header: 'Satuan', w: 62 },
          { header: `% Deviasi To BOM ${currLabel}`, w: 145.28, align: 'right' },
        ],
        rows: data.topItemsByDevBom.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtPct(it.devBom, false)]),
      });
    }
    // 7.3-7.6 category tables
    const catTables: Array<{ title: string; items: Array<{ itemName: string; outletCode: string; satuan?: string | null; qty: number; nominal: number; prevQty: number | null; histAvgQty: number | null }> }> = [
      { title: `7.3 QTY Waste Terbesar (${currLabel})`, items: data.topItemsByWaste.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qty: r.qtyWaste, nominal: r.nominalWaste, prevQty: r.prevQty, histAvgQty: r.histAvgQty })) },
      { title: `7.4 QTY Susut Terbesar (${currLabel})`, items: data.topItemsBySusut.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qty: r.qtySusut, nominal: r.nominalSusut, prevQty: r.prevQty, histAvgQty: r.histAvgQty })) },
      { title: `7.5 QTY Trial Terbesar (${currLabel})`, items: data.topItemsByTrial.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qty: r.qtyTrial, nominal: r.nominalTrial, prevQty: r.prevQty, histAvgQty: r.histAvgQty })) },
      { title: `7.6 QTY Loss/Surplus Terbesar (${currLabel})`, items: data.topItemsByLossSurplus.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, qty: r.qtyLossSurplus, nominal: r.nominalLossSurplus, prevQty: r.prevQty, histAvgQty: r.histAvgQty })) },
    ];
    for (const ct2 of catTables) {
      if (ct2.items.length === 0) continue;
      rpt.subhead(ct2.title, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', w: 20, align: 'center' },
          { header: 'Item', w: 128 },
          { header: 'Satuan', w: 42 },
          { header: 'Resto', w: 62 },
          { header: `QTY ${currLabel}`, w: 56, align: 'right' },
          { header: `QTY ${prevLabel}`, w: 56, align: 'right' },
          { header: histLabel, w: 52, align: 'right' },
          { header: 'vs Hist', w: 44, align: 'right' },
          { header: 'Nominal (Rp)', w: 51.28, align: 'right' },
        ],
        rows: ct2.items.map((it, i) => [
          String(i + 1),
          it.itemName,
          it.satuan ?? '\u2014',
          it.outletCode,
          fmtNum(it.qty),
          it.prevQty != null ? fmtNum(it.prevQty) : '\u2014',
          it.histAvgQty != null ? fmtNum(it.histAvgQty) : '\u2014',
          fmtVsHist(it.qty, it.histAvgQty),
          fmtIDR(it.nominal),
        ]),
      });
    }
  }

  // ============================================================
  //  8 — PERUBAHAN ITEM (MEMBURUK / MEMBAIK)
  // ============================================================
  if (hasSection('variance')) {
    const va = data.varianceAnalysis;
    if (va.topWorsened.length > 0 || va.topImproved.length > 0) {
      rpt.sectionHeader(8, 'Perubahan Item (vs Periode Pembanding)', `${currLabel} vs ${prevLabel} \u2014 selisih nominal per item terbesar`);
    }
    if (va.topWorsened.length > 0) {
      rpt.subhead(`8.1 Memburuk \u2014 selisih nominal terbesar (${currLabel} vs ${prevLabel})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', w: 20, align: 'center' },
          { header: 'Item', w: 160 },
          { header: 'Resto', w: 66 },
          { header: 'Area', w: 66 },
          { header: `Nominal ${currLabel}`, w: 68, align: 'right' },
          { header: `Nominal ${prevLabel}`, w: 68, align: 'right' },
          { header: 'Selisih', w: 63.28, align: 'right' },
        ],
        rows: va.topWorsened.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.area, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)]),
        rowText: () => C.danger,
      });
      const worsened = va.topWorsened.slice(0, 10);
      rpt.ensure(18 * worsened.length + 24);
      rpt.subhead('Selisih Nominal \u2014 Memburuk (Rp)', { size: 8.5, gapAfter: 2 });
      hBarChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * worsened.length,
        labels: worsened.map((it) => `${it.itemName} \u00B7 ${it.outletCode}`),
        values: worsened.map((it) => it.selisih),
        fmt: tickIDR,
        labelW: 150, valW: 52,
        colors: worsened.map(() => C.danger),
      });
      rpt.y += 18 * worsened.length + 8;
    }
    if (va.topImproved.length > 0) {
      rpt.subhead(`8.2 Membaik \u2014 penurunan selisih nominal terbesar (${currLabel} vs ${prevLabel})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', w: 20, align: 'center' },
          { header: 'Item', w: 160 },
          { header: 'Resto', w: 66 },
          { header: 'Area', w: 66 },
          { header: `Nominal ${currLabel}`, w: 68, align: 'right' },
          { header: `Nominal ${prevLabel}`, w: 68, align: 'right' },
          { header: 'Selisih', w: 63.28, align: 'right' },
        ],
        rows: va.topImproved.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.area, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)]),
        rowText: () => C.success,
      });
    }
  }

  // ============================================================
  //  9 — TREND ITEM MULTI-PERIODE  (EXPORT-PDF — NEW)
  // ============================================================
  if (hasSection('itemTrend') && data.itemTrendMatrix.length > 0) {
    rpt.sectionHeader(9, 'Trend Item Multi-Periode', `15 item dengan nominal deviasi terbesar di ${currLabel} \u2014 nilai ABS(nominal) per ${data.period.weekLabel} tiap bulan`);

    // group rows: item → month → absNominal
    const byMonth = new Map<string, string>(); // monthLabel → monthKey (for sort)
    const byItem = new Map<string, Map<string, number>>();
    for (const r of data.itemTrendMatrix) {
      byMonth.set(r.monthLabel, r.monthKey ?? '9999-99');
      let m = byItem.get(r.itemName);
      if (!m) { m = new Map(); byItem.set(r.itemName, m); }
      m.set(r.monthLabel, r.absNominal);
    }
    const months = [...byMonth.keys()].sort((a, b2) => {
      const ka = byMonth.get(a) ?? '9999-99';
      const kb = byMonth.get(b2) ?? '9999-99';
      return ka.localeCompare(kb);
    });
    // Months AFTER the exported month (e.g. Agustus rows when the report is
    // for Juli — already imported for the upcoming period) are EXCLUDED: the
    // report's timeline ends at its own period. Fallback: when the exported
    // month itself has no rows for this weekLabel, keep the raw month list.
    const curKey = byMonth.get(data.period.monthLabel) ?? null;
    const monthsUpToCurrent = curKey != null
      ? months.filter((m) => (byMonth.get(m) ?? '9999-99').localeCompare(curKey) <= 0)
      : months;
    // keep the LAST 7 periods (incl. current), in chronological order
    const shownMonths = (monthsUpToCurrent.length > 0 ? monthsUpToCurrent : months).slice(-7);
    // (the exported month is always the LAST shown column — the header row
    // is self-evident, no extra marker needed)

    // top 15 items by current-month absNominal (fallback: latest period they appear in)
    const itemScore = (m: Map<string, number>): number =>
      [...m.entries()].filter(([ml]) => shownMonths.includes(ml)).reduce((acc, [, v]) => Math.max(acc, v), 0);
    const topItems = [...byItem.entries()]
      .filter(([_, m]) => shownMonths.some((ml) => m.has(ml)))
      .sort((a, b2) => itemScore(b2[1]) - itemScore(a[1]))
      .slice(0, 15);

    const maxCell = topItems.reduce((acc, [, m]) => Math.max(acc, ...shownMonths.map((ml) => m.get(ml) ?? 0)), 0);
    const trendPct = (m: Map<string, number>): string => {
      const curIdx = shownMonths.reduce((acc, ml, i) => (m.has(ml) ? i : acc), -1);
      if (curIdx < 1) return '\u2014';
      const cur = m.get(shownMonths[curIdx]) ?? 0;
      const prev = m.get(shownMonths[curIdx - 1]) ?? 0;
      if (prev === 0) return cur === 0 ? '= 0%' : 'BARU';
      const pct = ((cur - prev) / Math.abs(prev)) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    };

    const monthLabel = (ml: string): string => shortMonth(ml);
    rpt.table({
      cols: [
        { header: 'Item', w: 118 },
        ...shownMonths.map((ml) => ({ header: monthLabel(ml), w: 44, align: 'right' as const })),
        { header: 'Trend', w: 85.28, align: 'right' },
      ],
      rows: topItems.map(([name, m]) => [
        name,
        ...shownMonths.map((ml) => (m.has(ml) ? fmtIDR(m.get(ml)) : '\u2014')),
        trendPct(m),
      ]),
      cellFill: (row, ci) => {
        if (ci === 0 || ci > shownMonths.length) return undefined;
        const ml = shownMonths[ci - 1];
        const val = byItem.get(row[0])?.get(ml) ?? 0;
        return heatColor(val, maxCell);
      },
      rowText: (row) => {
        const t = row[row.length - 1];
        return t.startsWith('+') || t === 'BARU' ? C.danger : t.startsWith('-') ? C.success : undefined;
      },
    });
    rpt.para(
      `Sel warna: intensitas amber = besarnya nominal deviasi relatif terhadap sel maksimum (${fmtIDR(maxCell)}). Kolom trend = perubahan ABS(nominal) periode terakhir vs periode sebelumnya (merah = naik, hijau = turun). Periode ditampilkan maksimal 7 terakhir (${shownMonths.map(monthLabel).join(', ')}).`,
      { size: 7.2, color: C.muted },
    );
  }

  // ============================================================
  //  10 — ANALISIS FLIP-FLOP  (EXPORT-PDF — NEW)
  // ============================================================
  if (hasSection('flip') && data.flipRanking.items.length > 0) {
    const fr = data.flipRanking;
    rpt.sectionHeader(10, 'Analisis Flip-Flop', `Pembalikan arah QTY deviasi antar periode sejenis \u2014 ${data.period.weekLabel} lintas bulan (${fr.totalItemsScanned} item terpindai)`);

    rpt.table({
      cols: [
        { header: '#', w: 18, align: 'center' },
        { header: 'Item', w: 118 },
        { header: 'Pasangan', w: 40, align: 'right' },
        { header: 'Flip', w: 36, align: 'right' },
        { header: 'Sempurna', w: 52, align: 'right' },
        { header: 'Dominan', w: 48, align: 'right' },
        { header: 'Parsial', w: 42, align: 'right' },
        { header: 'Konsisten', w: 52, align: 'right' },
        { header: 'Disparitas Rata2', w: 55, align: 'right' },
        { header: 'Risk', w: 50.28, align: 'right' },
      ],
      rows: fr.items.slice(0, 10).map((it, i) => [
        String(i + 1),
        it.itemName,
        fmtNum(it.totalPairs),
        fmtNum(it.flipCount),
        fmtNum(it.sempurnaCount),
        fmtNum(it.dominanCount),
        fmtNum(it.parsialCount),
        fmtNum(it.konsistenCount),
        it.flipCount > 0 ? `${(it.avgDisparity * 100).toFixed(1)}%` : '\u2014',
        `${it.riskScore} (${it.riskLevel.toUpperCase()})`,
      ]),
      rowText: (row) => (row[9].startsWith('100') || row[9].includes('HIGH') ? C.danger : undefined),
    });
    rpt.para(
      'Flip = tanda QTY deviasi berbalik antar dua periode sejenis (mis. +100 menjadi -98 pada minggu yang sama di bulan berbeda). Sempurna: disparitas < 10% (pembalikan hampir seimbang). Dominan: 10-40%. Parsial: \u2265 40%. Risk = min(100, 30\u00D7sempurna + 10\u00D7flip).',
      { size: 7.2, color: C.muted },
    );

    // pair detail for the top 3 items
    const topFlipItems = fr.items.filter((it) => it.topFlips.length > 0).slice(0, 3);
    for (const it of topFlipItems) {
      rpt.ensure(34);
      rpt.subhead(`Flip paling seimbang \u2014 ${it.itemName}`, { size: 8.5, gapAfter: 2 });
      it.topFlips.slice(0, 2).forEach((fp) => {
        rpt.ensure(36);
        const y = rpt.y;
        // left labels
        rpt.text(`${fp.period1Label}: ${fmtNum(fp.qtyP1)}`, PAGE.M, y + 2, { size: 6.8, color: fp.qtyP1 < 0 ? C.danger : C.success, font: 'Helvetica-Bold' });
        rpt.text(`${fp.period2Label}: ${fmtNum(fp.qtyP2)}`, PAGE.M, y + 13, { size: 6.8, color: fp.qtyP2 < 0 ? C.danger : C.success, font: 'Helvetica-Bold' });
        // center bars
        flipPairBars(doc, { x: PAGE.M + 108, y, w: 190, h: 26, qtyP1: fp.qtyP1, qtyP2: fp.qtyP2 });
        // right facts
        rpt.text(`Net: ${fmtNum(fp.net)}`, PAGE.M + 310, y + 2, { size: 6.8, color: C.inkSoft });
        rpt.text(`Disparitas: ${fp.disparityPct.toFixed(1)}%`, PAGE.M + 310, y + 13, { size: 6.8, color: C.inkSoft });
        rpt.chip(fp.category.toUpperCase(), PAGE.M + CONTENT_W - 64, y + 8, fp.category === 'sempurna' ? C.dangerLight : fp.category === 'dominan' ? C.accentLight : C.borderSoft, fp.category === 'sempurna' ? C.danger : fp.category === 'dominan' ? C.accentDark : C.muted);
        rpt.y = y + 34;
      });
      rpt.y += 4;
    }
  }

  // ============================================================
  //  11 — PEMBANDING PEER-TO-PEER  (EXPORT-PDF — NEW)
  // ============================================================
  if (hasSection('peer')) {
    rpt.sectionHeader(11, 'Pembanding Peer-to-Peer', 'Resto dengan penjualan \u00B110% dari resto target (nasional, kelompok aktif)');
    const pc = data.peerComparison;
    if (!pc || pc.peers.length === 0) {
      rpt.noteBox('Data pembanding peer tidak tersedia untuk filter ini \u2014 pilih satu resto pada Filter Resto (tab Resto Analysis) lalu export ulang.');
    } else {
      const target = pc.peers.find((p) => p.isTarget) ?? null;
      // target card facts
      const lines = [
        `Target: ${pc.targetOutlet.name} (${pc.targetOutlet.code}) \u00B7 Area ${pc.targetOutlet.area}`,
        `Penjualan target: ${fmtIDR(pc.targetSales)}`,
        `Jumlah peer sejenis: ${pc.peers.length - 1} resto`,
      ];
      if (pc.autoTarget) {
        lines.push('Target otomatis: resto prioritas #1 (tidak ada resto dipilih pada filter).');
      }
      rpt.noteBox(lines.join('  \u00B7  '));

      rpt.table({
        cols: [
          { header: '#', w: 18, align: 'center' },
          { header: 'Resto', w: 132 },
          { header: 'Area', w: 58 },
          { header: 'Penjualan', w: 74, align: 'right' },
          { header: 'Nominal Deviasi', w: 78, align: 'right' },
          { header: '% Dev/BOM', w: 55, align: 'right' },
          { header: 'Loss (Rp)', w: 56, align: 'right' },
          { header: 'Surplus (Rp)', w: 40.28, align: 'right' },
        ],
        rows: pc.peers.map((p, i) => [
          String(i + 1),
          `${p.outletName} (${p.outletCode})${p.isTarget ? ' \u2605' : ''}`,
          p.area,
          fmtIDR(p.sales),
          fmtIDR(p.nominalDeviasi),
          fmtPct(p.devBom, false),
          fmtIDR(p.totalLoss),
          fmtIDR(p.totalSurplus),
        ]),
        rowBold: (row) => row[1].includes('\u2605'),
        rowText: (row) => (row[4].startsWith('-') ? C.danger : undefined),
      });
      rpt.para('\u2605 = resto target. Peer = resto dengan mode penjualan dalam rentang \u00B110% penjualan target pada periode yang sama.', { size: 7.2, color: C.muted });

      // % Dev/BOM comparison bars — target highlighted amber
      const sortedPeers = [...pc.peers].sort((a, b2) => b2.devBom - a.devBom);
      rpt.ensure(18 * sortedPeers.length + 24);
      rpt.subhead('% Deviasi To BOM \u2014 Target vs Peer', { size: 8.5, gapAfter: 2 });
      hBarChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * sortedPeers.length,
        labels: sortedPeers.map((p) => `${p.outletName} (${p.outletCode})`),
        values: sortedPeers.map((p) => p.devBom * 100),
        fmt: (v) => `${v.toFixed(1)}%`,
        labelW: 132, valW: 52,
        colors: sortedPeers.map((p) => (p.isTarget ? C.accent : '#CBD5E1')),
        boldLabels: sortedPeers.map((p) => p.isTarget),
      });
      rpt.y += 18 * sortedPeers.length + 8;

      // loss vs surplus stacked bars per peer
      const stackRows = pc.peers.slice(0, 8).map((p) => ({ label: `${p.outletName} (${p.outletCode})`, neg: p.totalLoss, pos: p.totalSurplus }));
      if (stackRows.length > 0) {
        rpt.ensure(18 * stackRows.length + 24);
        rpt.subhead('Komposisi Loss vs Surplus per Peer (Rp)', { size: 8.5, gapAfter: 2 });
        stackedHBar(doc, {
          x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * stackRows.length,
          rows: stackRows,
          fmt: tickIDR,
          labelW: 132, valW: 104,
        });
        rpt.y += 18 * stackRows.length + 8;
      }

      // factual gap lines (target rank among peers by devBom + best peer)
      if (target) {
        const byDevBomDesc = [...pc.peers].sort((a, b2) => b2.devBom - a.devBom);
        const rank = byDevBomDesc.findIndex((p) => p.isTarget) + 1;
        const best = byDevBomDesc[0];
        const gap = target.devBom - best.devBom;
        rpt.noteBox(
          `Peringkat % Dev/BOM target di antara ${pc.peers.length} resto sejenis: #${rank}. Peer terbaik: ${best.outletName} (${best.outletCode}) dengan ${fmtPct(best.devBom, false)} \u2014 selisih target ${fmtPp(gap)}${best.topItem ? `. Item deviasi terbesar target: ${target.topItem} (${fmtIDR(target.topItemNominal)})` : ''}.`,
        );
      }
    }
  }

  // ============================================================
  //  12 — TREND ANTAR PERIODE
  // ============================================================
  if (hasSection('trend') && data.trend.length > 0) {
    rpt.sectionHeader(12, 'Trend Antar Periode', `Rangkaian ${data.period.weekLabel} lintas bulan \u2014 nominal, rasio, loss/surplus`);
    rpt.table({
      cols: [
        { header: 'Periode', w: 92 },
        { header: 'Nominal Deviasi', w: 92, align: 'right' },
        { header: '% Dev/BOM', w: 70, align: 'right' },
        { header: 'Loss (Rp)', w: 85, align: 'right' },
        { header: 'Surplus (Rp)', w: 85, align: 'right' },
        { header: '% Nominal to Sales', w: 87.28, align: 'right' },
      ],
      rows: data.trend.map((t) => [
        t.weekLabel,
        fmtIDR(t.nominal),
        fmtPct(t.devBom, false),
        fmtIDR(t.lossNominal),
        fmtIDR(t.surplusNominal),
        t.sales && t.sales > 0 ? fmtPct(Math.abs(t.nominal) / t.sales, false) : '\u2014',
      ]),
    });

    const labels = data.trend.map((t) => t.weekLabel.replace(` ${currLabel.split(' ')[0]}`, '').replace(/\s*$/, '')).map((l, i) => (data.trend.length > 8 && i % 2 === 1 ? '' : l));
    // bar — nominal per period
    rpt.ensure(150);
    rpt.subhead('Nominal Deviasi per Periode (Rp)', { size: 8.5, gapAfter: 2 });
    barChartV(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
      labels,
      values: data.trend.map((t) => Math.abs(t.nominal)),
      fmt: tickIDR,
    });
    rpt.y += 140 + 16;

    // line — loss vs surplus
    if (data.trend.length >= 2) {
      rpt.ensure(150);
      rpt.subhead('Loss vs Surplus per Periode (Rp)', { size: 8.5, gapAfter: 2 });
      lineChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
        xLabels: labels,
        series: [
          { name: 'Total LOSS', values: data.trend.map((t) => t.lossNominal), color: C.danger },
          { name: 'Total SURPLUS', values: data.trend.map((t) => t.surplusNominal), color: C.success },
        ],
        yFmt: tickIDR,
      });
      rpt.y += 140 + 16;
    }
  }

  // ============================================================
  //  13 — LAMPIRAN: CAKUPAN DATA & FILTER
  // ============================================================
  if (hasSection('coverage') && data.coverage) {
    const cv = data.coverage;
    rpt.sectionHeader(13, 'Lampiran: Cakupan Data & Filter', 'Metadata laporan + definisi metrik');
    const filterVal = (v: string | null | undefined): string => (v && v !== 'all' ? v : 'Semua');
    rpt.table({
      cols: [{ header: 'Keterangan', w: 200 }, { header: 'Nilai', w: 311.28 }],
      boldFirst: true,
      rows: [
        ['Periode', `${data.period.monthLabel} \u2014 ${data.period.weekLabel}`],
        ['Periode Pembanding', data.period.comparisonMonth ? `${data.period.comparisonMonth} \u2014 ${data.period.comparisonWeek ?? '\u2014'}` : '\u2014'],
        ['Jumlah Record', fmtNum(cv.recordCount)],
        ['Jumlah Resto', cv.outletCount != null ? fmtNum(cv.outletCount) : '\u2014'],
        ['Jumlah Item', cv.itemCount != null ? fmtNum(cv.itemCount) : '\u2014'],
        ['Jumlah Periode Terdata', fmtNum(cv.periodCount)],
        ['Jumlah Periode Historis (baseline)', fmtNum(cv.historicalPeriodCount)],
        ['Rentang Historis', histRange],
        ['Filter Area', filterVal(f.area)],
        ['Filter Kelompok', filterVal(f.kelompok)],
        ['Filter Resto', filterVal(f.outletCode)],
        ['Filter Item', filterVal(f.itemName)],
        ['Filter PIC', filterVal(f.pic)],
        ['Waktu Laporan Dibuat', fmtDateTimeWIB(cv.generatedAt)],
      ],
    });
    rpt.subhead('Definisi Metrik', { size: 8.5 });
    rpt.table({
      cols: [{ header: 'Metrik', w: 200 }, { header: 'Definisi', w: 311.28 }],
      boldFirst: true,
      rows: [
        ['Nominal Deviasi', 'SUM(nominalDeviasi) record pada periode'],
        ['% Deviasi To BOM', '|QTY Deviasi| / |QTY BOM|'],
        ['% Loss to Sales', 'Total LOSS / Penjualan'],
        ['% Surplus to Sales', 'Total SURPLUS / Penjualan'],
        ['% Nominal to Sales', '|Nominal Deviasi| / Penjualan'],
        ['Total LOSS', 'SUM(|nominalLossSurplus|) untuk nominalLossSurplus < 0'],
        ['Total SURPLUS', 'SUM(nominalLossSurplus) untuk nominalLossSurplus > 0'],
        ['Growth %', '(nilai sekarang \u2212 nilai pembanding) / |nilai pembanding|'],
        ['Peer', 'Resto dengan mode penjualan dalam rentang \u00B110% penjualan resto target'],
        ['Flip-Flop', 'Tanda QTY deviasi berbalik antar dua periode sejenis (minggu sama, bulan berbeda)'],
        ['Disparitas Flip', '|QTY P1 + QTY P2| / MAX(|QTY P1|, |QTY P2|)'],
      ],
    });
  }
}
