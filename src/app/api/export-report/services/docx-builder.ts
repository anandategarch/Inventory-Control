// ============================================================
//  docx-builder — Stage 2 of /api/export-report GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  Responsibilities (route.ts:156-270 + 669-1094 of the original):
//    1. Document styling — COLOR palette constant
//    2. Paragraph helpers — heading(), paragraph(), divider()
//    3. Table helpers — tableCell() + CellOpts + makeTable() + fmtVsHist()
//    4. buildDocxReport(data, ctx) — assembles the full Word document:
//         - Title + period header
//         - Section 1: Executive Summary table (13 rows, growth column)
//         - Section 2: Growth metrics (4-row table)
//         - Section 3: Top Items by category (6 sub-tables)
//         - Section 4: Deviation Breakdown composition (5-row table)
//         - Section 5: BOM Correlation Analysis (5-row table + findings
//           list + 5.1 per-record detail table with up to 20 BOM-rule
//           violations, batch-fetched via db.inventoryRecord.findMany
//           for current + prev period)
//         - Section 6: Variance Analysis (top-10 worsened items)
//         - Section 7: Trend across periods
//         - Footer
//       Returns { buffer: number[], fileName } for the cache wrapper.
//
//  All comments preserved VERBATIM from the original route.ts (FIX #3,
//  CONFIG-06, CONFIG-07, EVAL-09, FIX-SETTINGS, Rev 2/3/4 markers, etc.).
// ============================================================
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
} from 'docx';
import { db } from '@/lib/db';
import { calcGrowth } from '@/lib/metrics';
import { fmtIDR, fmtNum, fmtPct } from './format-helpers';
import type { ReportData, DocxContext } from './types';

// ============================================================
//  Document styling — color palette for eye-catching tables
//  --------------------------------------------------------
//  Relocated VERBATIM from route.ts:156-165.
// ============================================================
const COLOR = {
  PRIMARY: '1F4E79',      // deep blue — header background
  PRIMARY_LIGHT: 'D6E4F0', // light blue — zebra stripe
  PRIMARY_TEXT: 'FFFFFF',  // white — header text
  BORDER: 'B4C6E7',        // soft blue border
  BODY_TEXT: '1F2937',     // dark slate — body text
  MUTED: '6B7280',         // gray — secondary text
  NEGATIVE: 'DC2626',      // red — negative numbers
  POSITIVE: '059669',      // green — positive numbers
};

// ============================================================
//  Paragraph helpers
//  --------------------------------------------------------
//  Relocated VERBATIM from route.ts:167-188. All three return a single
//  Paragraph with the appropriate border / spacing / shading config.
// ============================================================
function heading(text: string): Paragraph {
  const safeText = text == null ? '' : String(text);
  return new Paragraph({
    text: safeText,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: COLOR.PRIMARY, space: 4 } },
  });
}

function paragraph(text: string, bold = false, size = 20): Paragraph {
  const safeText = text == null ? '' : String(text);
  return new Paragraph({ children: [new TextRun({ text: safeText, bold, size, color: COLOR.BODY_TEXT })], spacing: { after: 80 } });
}

function divider(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: '', size: 8 })],
    spacing: { before: 80, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.BORDER, space: 1 } },
  });
}

// ============================================================
//  Table helpers — styled with header bg, zebra rows, borders
//  --------------------------------------------------------
//  Relocated VERBATIM from route.ts:194-270.
// ============================================================

interface CellOpts {
  bold?: boolean;
  align?: 'left' | 'right';
  isHeader?: boolean;
  isZebra?: boolean;
}

function tableCell(text: string, opts: CellOpts = {}): TableCell {
  const { bold = false, align = 'left', isHeader = false, isZebra = false } = opts;
  const safeText = text == null ? '' : String(text);
  // Negative numbers in red (but not em-dash null indicator)
  const isNegative = safeText.startsWith('-') && safeText !== '—' && !safeText.startsWith('—');
  // FIX #3: Detect "↑" (increase vs historical = warning/red) and "↓" (decrease = good/green)
  const isIncrease = safeText.startsWith('↑');
  const isDecrease = safeText.startsWith('↓');

  // Header: white text on primary bg
  // Zebra row: light blue bg
  // Normal: white bg
  const shadingFill = isHeader
    ? { fill: COLOR.PRIMARY, type: ShadingType.CLEAR, color: 'auto' }
    : isZebra
      ? { fill: COLOR.PRIMARY_LIGHT, type: ShadingType.CLEAR, color: 'auto' }
      : undefined;

  const textColor = isHeader
    ? COLOR.PRIMARY_TEXT
    : isNegative
      ? COLOR.NEGATIVE
      : isIncrease
        ? COLOR.NEGATIVE   // red for increase (warning)
        : isDecrease
          ? COLOR.POSITIVE  // green for decrease (good)
          : COLOR.BODY_TEXT;

  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: safeText, bold: bold || isHeader || isIncrease || isDecrease, size: 18, color: textColor })],
      alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 20, after: 20 },
    })],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: shadingFill,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
    },
  });
}

// FIX #3: Format "vs Hist" column — compares current vs historical average.
// Returns "↑ X%" (red, increase = warning) or "↓ X%" (green, decrease = good) or "—".
function fmtVsHist(current: number | null, histAvg: number | null): string {
  if (current == null || histAvg == null || histAvg === 0) return '—';
  const pctChange = (current - histAvg) / Math.abs(histAvg);
  const pctStr = `${(Math.abs(pctChange) * 100).toFixed(1)}%`;
  if (pctChange > 0) return `↑ ${pctStr}`;
  if (pctChange < 0) return `↓ ${pctStr}`;
  return '= 0%';
}

function makeTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((l, i) => tableCell(l, { bold: true, align: i > 0 ? 'right' : 'left', isHeader: true })),
      }),
      ...rows.map((r, idx) => new TableRow({
        children: r.map((v, i) => tableCell(v, { align: i > 0 ? 'right' : 'left', isZebra: idx % 2 === 1 })),
      })),
    ],
  });
}

// ============================================================
//  buildDocxReport — assemble the full Word document
//  --------------------------------------------------------
//  Body relocated VERBATIM from route.ts:669-1094 (the docx-assembly
//  portion of the original computeFn). All comments preserved.
//
//  Signature change vs original: was an inline closure that read
//  `data` + many free variables from the enclosing computeFn scope;
//  now an explicit (data, ctx) pair so the function is self-contained.
//
//  Returns { buffer: number[]; fileName } for withCacheAndDedup to
//  JSON-serialize + cache (Array.from(buffer) keeps binary data JSON-
//  serializable; the route handler Buffer.from()s it back to bytes).
// ============================================================
export async function buildDocxReport(
  data: ReportData,
  ctx: DocxContext,
): Promise<{ buffer: number[]; fileName: string }> {
  // Local section-filter helper — matches route.ts:316 verbatim.
  const hasSection = (key: string) => !ctx.sections || ctx.sections.includes(key);

  // ============================================================
  //  Build Word document
  // ============================================================
  const children: Array<Paragraph | Table> = [];

  // Build dynamic period labels — short format (no week, month abbreviated to 3 chars + 2-digit year)
  // e.g., "MEI 2026" → "MEI 26", "WEEK 4 MEI 2026" → "MEI 26" (week removed per user request)
  const shortMonth = (label: string): string => {
    if (!label) return '—';
    const parts = label.trim().split(/\s+/);
    if (parts.length >= 2) {
      const month = parts[0].substring(0, 3).toUpperCase();
      const year = parts[1].length === 4 ? parts[1].substring(2) : parts[1];
      return `${month} ${year}`;
    }
    return label.substring(0, 10);
  };
  const currLabel = shortMonth(data.period.monthLabel);
  const prevLabel = data.period.comparisonMonth
    ? shortMonth(data.period.comparisonMonth)
    : '—';
  // Historical periods: show range "Jan-Jul 26" (earliest to latest)
  const histMonths = ctx.historicalPeriods.map(p => shortMonth(p.monthLabel)).filter(m => m !== '—');
  const histLabel = histMonths.length === 0
    ? 'Hist (—)'
    : histMonths.length === 1
      ? `Hist (${histMonths[0]})`
      : `Hist (${histMonths[histMonths.length - 1]}-${histMonths[0]})`;

  // Title — simplified header per user request
  const restoName = data.filters.outletCode && data.filters.outletCode !== 'all' ? data.filters.outletCode : 'Semua Resto';
  const compareText = data.period.comparisonMonth
    ? ` vs ${prevLabel}`
    : '';
  // History range label (e.g., "Jan-Jul 26") for header
  const histRange = histMonths.length >= 2
    ? `${histMonths[histMonths.length - 1]}-${histMonths[0]}`
    : histMonths.length === 1
      ? histMonths[0]
      : currLabel;
  children.push(
    new Paragraph({
      children: [new TextRun({ text: 'Ringkasan Laporan Deviasi', bold: true, size: 36, color: COLOR.PRIMARY })],
      alignment: AlignmentType.CENTER, spacing: { before: 400, after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `${restoName}  |  ${histRange}${compareText}`, size: 22, color: COLOR.MUTED })],
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: COLOR.PRIMARY, space: 6 } },
    }),
    divider(),
  );

  if (hasSection('exec')) {
    const s = data.executiveSummary;
    children.push(heading('1. Rangkuman'));
    children.push(makeTable(['Metrik', currLabel, 'Perubahan', prevLabel], [
      ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth != null ? fmtPct(s.nominalDeviasi.growth, true) : '—', fmtIDR(s.nominalDeviasi.previous)],
      ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth != null ? fmtPct(s.qtyBom.growth, true) : '—', fmtNum(s.qtyBom.previous)],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth != null ? fmtPct(s.qtyDeviasi.growth, true) : '—', fmtNum(s.qtyDeviasi.previous)],
      ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth != null ? fmtPct(s.qtyWaste.growth, true) : '—', fmtNum(s.qtyWaste.previous)],
      ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth != null ? fmtPct(s.qtySusut.growth, true) : '—', fmtNum(s.qtySusut.previous)],
      ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth != null ? fmtPct(s.qtyTrial.growth, true) : '—', fmtNum(s.qtyTrial.previous)],
      ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth != null ? fmtPct(s.qtyLossSurplus.growth, true) : '—', fmtNum(s.qtyLossSurplus.previous)],
      ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), s._prevMetrics?.deviationToBom != null ? fmtPct(calcGrowth(s.deviationToBom, s._prevMetrics.deviationToBom), true) : '—', s._prevMetrics?.deviationToBom != null ? fmtPct(s._prevMetrics.deviationToBom, false) : '—'],
      ['Loss To Sales', fmtPct(s.lossToSales, false), s._prevMetrics?.lossToSales != null ? fmtPct(calcGrowth(s.lossToSales, s._prevMetrics.lossToSales), true) : '—', s._prevMetrics?.lossToSales != null ? fmtPct(s._prevMetrics.lossToSales, false) : '—'],
      ['Total LOSS', fmtIDR(s.totalLoss), s._prevMetrics?.totalLoss != null ? fmtPct(calcGrowth(s.totalLoss, s._prevMetrics.totalLoss), true) : '—', s._prevMetrics?.totalLoss != null ? fmtIDR(s._prevMetrics.totalLoss) : '—'],
      ['Total SURPLUS', fmtIDR(s.totalSurplus), s._prevMetrics?.totalSurplus != null ? fmtPct(calcGrowth(s.totalSurplus, s._prevMetrics.totalSurplus), true) : '—', s._prevMetrics?.totalSurplus != null ? fmtIDR(s._prevMetrics.totalSurplus) : '—'],
      ['Loss/Surplus Qty', fmtNum(s.residualLossQty), s._prevMetrics?.residualLossQty != null ? fmtPct(calcGrowth(s.residualLossQty, s._prevMetrics.residualLossQty), true) : '—', s._prevMetrics?.residualLossQty != null ? fmtNum(s._prevMetrics.residualLossQty) : '—'],
      ['Loss/Surplus %', fmtPct(s.residualLossPct, false), s._prevMetrics?.residualLossPct != null ? fmtPct(calcGrowth(s.residualLossPct, s._prevMetrics.residualLossPct), true) : '—', s._prevMetrics?.residualLossPct != null ? fmtPct(s._prevMetrics.residualLossPct, false) : '—'],
    ]));

  }
  if (hasSection('growth')) {
    const g = data.growthComparison || {};
    children.push(heading('2. Perubahan (Growth)'));
    children.push(makeTable(['Metric', 'Value'], [
      ['Penjualan Growth', fmtPct(g.salesGrowth, true)],
      ['QTY BOM Growth', fmtPct(g.bomGrowth, true)],
      ['QTY Deviasi Growth', fmtPct(g.qtyDeviasiGrowth, true)],
      ['Nominal Deviasi Growth', fmtPct(g.nominalDeviasiGrowth, true)],
    ]));
    children.push(divider());

  }
  if (hasSection('topItems')) {
    children.push(heading('3. Item Prioritas (Top Items)'));
    children.push(paragraph('Item-item dengan kontribusi terbesar berdasarkan berbagai kategori. Angka negatif = LOSS/rugi (ditandai merah).'));
    const topSections = [
      // Rev 3: Sort by absNominalDeviasi (done in query), display signed nominalDeviasi
      { title: `4.1 Nominal Deviasi Terbesar (${currLabel})`, items: data.topItemsByNominal, cols: ['#', 'Item', 'Resto', `Nominal Deviasi ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.nominalDeviasi)] },
      // Rev 4: Sort by abs(devBom) (done in query), display signed devBom
      { title: `4.2 % Deviasi To BOM Terbesar (${currLabel})`, items: data.topItemsByDevBom, cols: ['#', 'Item', 'Resto', `% Deviasi To BOM ${currLabel}`, '% Toleransi'], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtPct(it.devBom, false), it.tolerance != null ? fmtPct(it.tolerance, false) : '—'] },
      // Rev 2: Add QTY Prev + QTY Hist Avg columns for Waste/Susut/Trial/LossSurplus
      { title: `4.3 QTY Waste Terbesar (${currLabel})`, items: data.topItemsByWaste, cols: ['#', 'Item', 'Resto', `QTY Waste ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Waste ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyWaste), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyWaste, it.histAvgQty), fmtIDR(it.nominalWaste)] },
      { title: `4.4 QTY Susut Terbesar (${currLabel})`, items: data.topItemsBySusut, cols: ['#', 'Item', 'Resto', `QTY Susut ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Susut ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtySusut), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtySusut, it.histAvgQty), fmtIDR(it.nominalSusut)] },
      { title: `4.5 QTY Trial Terbesar (${currLabel})`, items: data.topItemsByTrial, cols: ['#', 'Item', 'Resto', `QTY Trial ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Trial ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyTrial), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyTrial, it.histAvgQty), fmtIDR(it.nominalTrial)] },
      { title: `4.6 QTY Loss/Surplus Terbesar (${currLabel})`, items: data.topItemsByLossSurplus, cols: ['#', 'Item', 'Resto', `QTY Loss/Surplus ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Loss/Surplus ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyLossSurplus), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyLossSurplus, it.histAvgQty), fmtIDR(it.nominalLossSurplus)] },
    ];
    for (const sec of topSections) {
      if (sec.items && sec.items.length > 0) {
        children.push(paragraph(sec.title, true));
        children.push(makeTable(sec.cols, sec.items.map(sec.map)));
        children.push(paragraph(''));
      }
    }
    children.push(divider());

  }
  if (hasSection('breakdown')) {
    const b = data.deviationBreakdown || {};
    const bdTotal = b.total || 0;
    children.push(heading('4. Rincian Komposisi Selisih'));
    children.push(makeTable(['Component', 'QTY', '% of Total'], [
      ['QTY Waste', fmtNum(b.waste), bdTotal > 0 ? `${((b.waste / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['QTY Susut', fmtNum(b.susut), bdTotal > 0 ? `${((b.susut / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['QTY Trial', fmtNum(b.trial), bdTotal > 0 ? `${((b.trial / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['Loss/Surplus Qty', fmtNum(b.residual), bdTotal > 0 ? `${((b.residual / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['TOTAL', fmtNum(bdTotal), '100%'],
    ]));
    children.push(divider());

  }
  // Section 5: BOM Correlation Analysis
  if (hasSection('bomCorrelation')) {
    const s = data.executiveSummary;
    children.push(heading('5. Analisis Korelasi BOM'));
    const bomUp = (s.qtyBom.growth ?? 0) > 0;
    const bomDown = (s.qtyBom.growth ?? 0) < 0;
    const devUp = (s.qtyDeviasi.growth ?? 0) > 0;
    const devDown = (s.qtyDeviasi.growth ?? 0) < 0;
    const wasteUp = (s.qtyWaste.growth ?? 0) > 0;
    const wasteDown = (s.qtyWaste.growth ?? 0) < 0;
    const susutUp = (s.qtySusut.growth ?? 0) > 0;
    const susutDown = (s.qtySusut.growth ?? 0) < 0;
    const trialUp = (s.qtyTrial.growth ?? 0) > 0;
    const trialDown = (s.qtyTrial.growth ?? 0) < 0;

    // Build correlation findings
    // FIX (CONFIG-07 / EVAL-09): use configurable thresholds instead of hardcoded
    // `> 2` and `> 1.5`. The `thresholds` object is fetched at line ~335 via
    // getRuntimeThresholds(). BOM_DEVIATION_FACTOR (default 2.0) corresponds to
    // the BOM_DEVIATION_MISMATCH SQL rule's multiplier; BOM_DISPROPORTIONATE_FACTOR
    // (default 1.5) corresponds to the BOM_DEVIATION_DISPROPORTIONATE rule's lower
    // bound (decoupled from BOM_DEVIATION_FACTOR by FIX-SETTINGS — was previously
    // hardcoded to 1.5 in rule-evaluation.ts:156, which made the rule silently
    // never fire if a user lowered BOM_DEVIATION_FACTOR ≤ 1.5).
    const disproportionateFactor = ctx.thresholds.BOM_DISPROPORTIONATE_FACTOR ?? 1.5;
    const deviationFactor = ctx.thresholds.BOM_DEVIATION_FACTOR ?? 2.0;
    const findings: string[] = [];
    if (bomUp && devUp) {
      const ratio = (s.qtyBom.growth ?? 0) > 0 ? (s.qtyDeviasi.growth ?? 0) / (s.qtyBom.growth ?? 1) : 0;
      if (ratio > deviationFactor) findings.push(`⚠ Deviasi naik ${(s.qtyDeviasi.growth ?? 0).toFixed(1)}% jauh melebihi BOM naik ${(s.qtyBom.growth ?? 0).toFixed(1)}% (rasio ${ratio.toFixed(1)}×, ambang ${deviationFactor}×)`);
      else if (ratio > disproportionateFactor) findings.push(`⚠ Deviasi naik ${(s.qtyDeviasi.growth ?? 0).toFixed(1)}% tidak proporsional dengan BOM naik ${(s.qtyBom.growth ?? 0).toFixed(1)}% (rasio ${ratio.toFixed(1)}×, ambang ${disproportionateFactor}×)`);
      else findings.push(`✓ Deviasi naik proporsional dengan BOM (rasio ${ratio.toFixed(1)}×)`);
    }
    if (bomDown && devUp) findings.push(`⚠ BOM turun ${(s.qtyBom.growth ?? 0).toFixed(1)}% tapi deviasi naik ${(s.qtyDeviasi.growth ?? 0).toFixed(1)}% — tidak sejalan`);
    if (bomUp && wasteDown) findings.push(`⚠ Waste turun ${(s.qtyWaste.growth ?? 0).toFixed(1)}% saat BOM naik ${(s.qtyBom.growth ?? 0).toFixed(1)}% — harusnya ikut naik`);
    if (bomDown && wasteUp) findings.push(`⚠ Waste naik ${(s.qtyWaste.growth ?? 0).toFixed(1)}% saat BOM turun ${(s.qtyBom.growth ?? 0).toFixed(1)}% — harusnya ikut turun`);
    if (bomUp && susutDown) findings.push(`⚠ Susut turun ${(s.qtySusut.growth ?? 0).toFixed(1)}% saat BOM naik ${(s.qtyBom.growth ?? 0).toFixed(1)}% — harusnya ikut naik`);
    if (bomDown && susutUp) findings.push(`⚠ Susut naik ${(s.qtySusut.growth ?? 0).toFixed(1)}% saat BOM turun ${(s.qtyBom.growth ?? 0).toFixed(1)}% — harusnya ikut turun`);
    if (bomUp && trialDown) findings.push(`⚠ Trial turun ${(s.qtyTrial.growth ?? 0).toFixed(1)}% saat BOM naik ${(s.qtyBom.growth ?? 0).toFixed(1)}% — harusnya ikut naik`);
    if (bomDown && trialUp) findings.push(`⚠ Trial naik ${(s.qtyTrial.growth ?? 0).toFixed(1)}% saat BOM turun ${(s.qtyBom.growth ?? 0).toFixed(1)}% — harusnya ikut turun`);
    if (findings.length === 0) findings.push('✓ Semua metrik sejalan dengan BOM');

    children.push(makeTable(['Metrik', `${currLabel}`, 'Growth', `${prevLabel}`, 'Sejalan?'], [
      ['QTY BOM', fmtNum(s.qtyBom.current), fmtPct(s.qtyBom.growth, true), fmtNum(s.qtyBom.previous), '— (baseline)'],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), fmtPct(s.qtyDeviasi.growth, true), fmtNum(s.qtyDeviasi.previous),
        (bomUp && devUp) || (bomDown && devDown) ? '✓ Ya' : '⚠ Tidak'],
      ['QTY Waste', fmtNum(s.qtyWaste.current), fmtPct(s.qtyWaste.growth, true), fmtNum(s.qtyWaste.previous),
        (bomUp && wasteUp) || (bomDown && wasteDown) ? '✓ Ya' : '⚠ Tidak'],
      ['QTY Susut', fmtNum(s.qtySusut.current), fmtPct(s.qtySusut.growth, true), fmtNum(s.qtySusut.previous),
        (bomUp && susutUp) || (bomDown && susutDown) ? '✓ Ya' : '⚠ Tidak'],
      ['QTY Trial', fmtNum(s.qtyTrial.current), fmtPct(s.qtyTrial.growth, true), fmtNum(s.qtyTrial.previous),
        (bomUp && trialUp) || (bomDown && trialDown) ? '✓ Ya' : '⚠ Tidak'],
    ]));
    for (const f of findings) children.push(paragraph(f));

    // ==========================================================
    // FIX (CONFIG-06): 5.1 Detail Per-Record Findings
    // The aggregate analysis above only shows execSummary-level growth.
    // Add a per-record table listing top outlets where BOM correlation
    // rules actually fired (from sqlFlags, the SQL rule evaluator output).
    // Previously the Word report's Section 5 duplicated BomCorrelationCard
    // with the same divergences — now it adds actionable per-record detail.
    // ==========================================================
    const bomCategoryFlags = ctx.sqlFlags.filter(f => f.category === 'BOM');
    const bomRuleCounts = new Map<string, number>();
    for (const f of bomCategoryFlags) {
      bomRuleCounts.set(f.ruleCode, (bomRuleCounts.get(f.ruleCode) ?? 0) + 1);
    }
    // Top 20 most severe (highest priority first). Task spec lists ascending
    // sort `a.priority - b.priority` but the comment says "top 20" — using
    // descending so ABNORMAL (priority 88, 82) appears before WARNING (53-56).
    const bomFindings = [...bomCategoryFlags]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 20);

    if (bomFindings.length > 0) {
      children.push(paragraph('5.1 Detail Per-Record Findings (BOM Correlation)', true));
      // Count summary — total + per-rule breakdown (all BOM-category rules)
      children.push(paragraph(`Total anomali korelasi BOM: ${bomCategoryFlags.length} record`));
      const ruleOrder = [
        'BOM_DEVIATION_MISMATCH',
        'BOM_DOWN_DEV_UP',
        'BOM_DEVIATION_DISPROPORTIONATE',
        'WASTE_BOM_MISMATCH',
        'SUSUT_BOM_MISMATCH',
        'TRIAL_BOM_MISMATCH',
      ];
      for (const ruleCode of ruleOrder) {
        const cnt = bomRuleCounts.get(ruleCode) ?? 0;
        if (cnt > 0) children.push(paragraph(`- ${ruleCode}: ${cnt}`));
      }

      // Batch-fetch current + prev InventoryRecord rows for the top-20 keys.
      // Includes outlet.outletCode + item.name for human-readable display.
      // Prisma `OR` with nullable akunPenyesuaian generates `IS NULL` for null
      // entries and `= 'value'` for non-null — same semantics as the SQL
      // `IS NOT DISTINCT FROM` used in rule-evaluation.ts:166.
      const bomKeys = bomFindings.map(f => ({
        outletId: f.outletId,
        itemId: f.itemId,
        akunPenyesuaian: f.akunPenyesuaian,
      }));
      const bomKeyOf = (o: { outletId: number; itemId: number; akunPenyesuaian: string | null }) =>
        `${o.outletId}|${o.itemId}|${o.akunPenyesuaian ?? ''}`;

      const [currBomRecs, prevBomRecs] = await Promise.all([
        db.inventoryRecord.findMany({
          where: {
            monthLabel: ctx.month,
            weekLabel: ctx.week,
            OR: bomKeys.map(k => ({
              outletId: k.outletId,
              itemId: k.itemId,
              akunPenyesuaian: k.akunPenyesuaian,
            })),
          },
          select: {
            outletId: true,
            itemId: true,
            akunPenyesuaian: true,
            qtyBom: true,
            qtyDeviasi: true,
            qtyWaste: true,
            qtySusut: true,
            qtyTrial: true,
            outlet: { select: { outletCode: true } },
            item: { select: { name: true } },
          },
        }),
        ctx.prevMonth && ctx.prevWeek
          ? db.inventoryRecord.findMany({
              where: {
                monthLabel: ctx.prevMonth,
                weekLabel: ctx.prevWeek,
                OR: bomKeys.map(k => ({
                  outletId: k.outletId,
                  itemId: k.itemId,
                  akunPenyesuaian: k.akunPenyesuaian,
                })),
              },
              select: {
                outletId: true,
                itemId: true,
                akunPenyesuaian: true,
                qtyBom: true,
                qtyDeviasi: true,
                qtyWaste: true,
                qtySusut: true,
                qtyTrial: true,
              },
            })
          : Promise.resolve([]),
      ]);

      // Build lookup maps keyed by "outletId|itemId|akun"
      type BomRec = {
        qtyBom: number | null;
        qtyDeviasi: number | null;
        qtyWaste: number | null;
        qtySusut: number | null;
        qtyTrial: number | null;
      };
      const prevBomMap = new Map<string, BomRec>();
      for (const r of prevBomRecs) {
        prevBomMap.set(bomKeyOf(r), {
          qtyBom: r.qtyBom, qtyDeviasi: r.qtyDeviasi, qtyWaste: r.qtyWaste,
          qtySusut: r.qtySusut, qtyTrial: r.qtyTrial,
        });
      }
      const currBomMap = new Map<string, BomRec & { outletCode: string; itemName: string }>();
      for (const r of currBomRecs) {
        currBomMap.set(bomKeyOf(r), {
          qtyBom: r.qtyBom, qtyDeviasi: r.qtyDeviasi, qtyWaste: r.qtyWaste,
          qtySusut: r.qtySusut, qtyTrial: r.qtyTrial,
          outletCode: r.outlet.outletCode, itemName: r.item.name,
        });
      }

      // Growth helper — matches rule-evaluation.ts:174-192 ABS magnitude formula
      const growthAbs = (curr: number | null | undefined, prev: number | null | undefined): number | null => {
        if (curr == null || prev == null || prev === 0) return null;
        return (Math.abs(curr) - Math.abs(prev)) / Math.abs(prev);
      };

      // Render the per-record table. For each finding, pick the relevant
      // metric growth based on rule code:
      //   BOM_DEVIATION_MISMATCH / BOM_DOWN_DEV_UP / BOM_DEVIATION_DISPROPORTIONATE → qtyDeviasi
      //   WASTE_BOM_MISMATCH → qtyWaste
      //   SUSUT_BOM_MISMATCH → qtySusut
      //   TRIAL_BOM_MISMATCH → qtyTrial
      // Ratio = metricGrowth / bomGrowth (only when bomGrowth > 0 — otherwise
      // opposite-sign or negative-BOM cases produce meaningless ratios).
      const bomRows: string[][] = bomFindings.map(f => {
        const key = bomKeyOf(f);
        const c = currBomMap.get(key);
        const p = prevBomMap.get(key);
        if (!c) {
          return [String(f.outletId), String(f.itemId), f.ruleCode, '—', '—', '—'];
        }
        const bomGrowth = growthAbs(c.qtyBom, p?.qtyBom ?? null);
        let metricGrowth: number | null = null;
        switch (f.ruleCode) {
          case 'BOM_DEVIATION_MISMATCH':
          case 'BOM_DOWN_DEV_UP':
          case 'BOM_DEVIATION_DISPROPORTIONATE':
            metricGrowth = growthAbs(c.qtyDeviasi, p?.qtyDeviasi ?? null);
            break;
          case 'WASTE_BOM_MISMATCH':
            metricGrowth = growthAbs(c.qtyWaste, p?.qtyWaste ?? null);
            break;
          case 'SUSUT_BOM_MISMATCH':
            metricGrowth = growthAbs(c.qtySusut, p?.qtySusut ?? null);
            break;
          case 'TRIAL_BOM_MISMATCH':
            metricGrowth = growthAbs(c.qtyTrial, p?.qtyTrial ?? null);
            break;
        }
        // Ratio only meaningful when both growths are positive (same-direction
        // disproportionate case). For sign-mismatch rules the ratio is negative
        // or undefined — show '—'.
        let ratio: number | null = null;
        if (bomGrowth != null && metricGrowth != null && bomGrowth > 0 && metricGrowth > 0) {
          ratio = metricGrowth / bomGrowth;
        }
        return [
          c.outletCode,
          c.itemName,
          f.ruleCode,
          bomGrowth != null ? fmtPct(bomGrowth, true) : '—',
          metricGrowth != null ? fmtPct(metricGrowth, true) : '—',
          ratio != null ? `${ratio.toFixed(2)}×` : '—',
        ];
      });

      children.push(makeTable(
        ['Outlet', 'Item', 'Rule', 'BOM Growth', 'Metric Growth', 'Ratio'],
        bomRows,
      ));
      children.push(paragraph(
        `Catatan: tabel menampilkan ${bomFindings.length} record teratas (diurutkan berdasarkan prioritas rule). ` +
        `Ratio hanya ditampilkan ketika BOM growth dan metric growth keduanya positif (kasus disproportionate).`,
      ));
    }

    children.push(divider());

  }
  if (hasSection('variance')) {
    const va = data.varianceAnalysis || {};
    if ((va.topWorsened || []).length > 0) {
      children.push(heading('6. Perubahan Item (Selisih Terbesar)'));
      children.push(makeTable(['Item', 'Resto', `Nominal ${currLabel}`, `Nominal ${prevLabel}`, 'Selisih'],
        va.topWorsened.slice(0, 10).map((it) => [it.itemName, it.outletCode, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)])));
      children.push(divider());
    }

  }
  // Section 13 (RANKING ITEM NASIONAL) removed per user request
  if (hasSection('trend')) {
    if (data.trend && data.trend.length > 0) {
      children.push(heading('7. Trend Antar Periode'));
      // Hapus Penjualan, tambah % Nominal Deviasi to Sales = |nominal| / sales * 100
      children.push(makeTable(['Period', 'Nominal Deviasi', '% Deviasi To BOM', '% Nominal to Sales'],
        data.trend.map((t) => [
          t.weekLabel,
          fmtIDR(t.nominal),
          fmtPct(t.devBom, false),
          t.sales && t.sales > 0 ? fmtPct(Math.abs(t.nominal) / t.sales, false) : '—',
        ])));
      children.push(divider());
    }

  }

  // ============================================================
  // NEW SECTIONS — additional analyses
  // ============================================================

  // Sections 19 (HISTORICAL ANOMALY), 2 (RESTO PRIORITAS), 14 (ITEM CROSS-OUTLET) removed per user request

  // Footer — simple closing (no date per user request)
  children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  children.push(new Paragraph({
    children: [new TextRun({ text: '', size: 8 })],
    spacing: { before: 60, after: 60 },
    border: { top: { style: BorderStyle.SINGLE, size: 12, color: COLOR.PRIMARY, space: 2 } },
  }));

  // Generate document — creator metadata neutral (no AI/platform mention)
  const doc = new Document({
    creator: 'Inventory Analyst',
    title: `Ringkasan Laporan Deviasi ${currLabel}`,
    sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  const fileName = `Laporan_Deviasi_${currLabel.replace(/\s+/g, '_')}.docx`;

  // PERF-CACHE-06: withCacheAndDedup handles setCached(awaitWrite=true) +
  // in-flight Promise resolution. Return the { buffer, fileName } payload —
  // the helper stores it as JSON (Array.from(buffer) keeps the binary data
  // JSON-serializable; consumers Buffer.from() it back to bytes).
  return { buffer: Array.from(buffer), fileName };
}
