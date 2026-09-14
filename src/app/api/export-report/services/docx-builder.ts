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
//         - Section 3: Top Items by category (6 sub-tables, 3.1–3.6)
//         - Section 4: Deviation Breakdown composition (5-row table)
//         - Section 5: Variance Analysis (top-10 worsened items)
//         - Section 6: Trend across periods
//         - Footer
//       Returns { bufferBase64, fileName } for the cache wrapper (P3-HYG-4).
//       FIX (BUG-3-a P2): the data-fetcher now fetches ONLY what the
//       selected ?sections= actually render — the section list above is the
//       source of truth for that mapping (see data-fetcher.ts header).
//
//       H-5: "5. Analisis Korelasi BOM" (aggregate alignment table + 5.1
//       per-record rule-fire table) REMOVED per user request — same removal
//       series as Loss-to-Sales/Kepatuhan. Sub-sections under Top Items
//       renumbered 4.x → 3.x to match their parent (leftover from an older
//       layout), and Variance/Trend shifted 6/7 → 5/6.
//
//  All comments preserved VERBATIM from the original route.ts (FIX #3,
//  CONFIG-06, CONFIG-07, EVAL-09, FIX-SETTINGS, Rev 2/3/4 markers, etc.).
// ============================================================
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
} from 'docx';
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
  /** H-2b (WI-2): body-cell fill override — wins over the zebra stripe (period-group coloring). */
  fill?: string;
  /** H-2b (WI-2): header-cell fill override — wins over COLOR.PRIMARY (period-group coloring). */
  headerFill?: string;
}

function tableCell(text: string, opts: CellOpts = {}): TableCell {
  const { bold = false, align = 'left', isHeader = false, isZebra = false, fill, headerFill } = opts;
  const safeText = text == null ? '' : String(text);
  // Negative numbers in red (but not em-dash null indicator)
  const isNegative = safeText.startsWith('-') && safeText !== '—' && !safeText.startsWith('—');
  // FIX #3: Detect "↑" (increase vs historical = warning/red) and "↓" (decrease = good/green)
  const isIncrease = safeText.startsWith('↑');
  const isDecrease = safeText.startsWith('↓');

  // Header: white text on primary bg (headerFill — H-2b period-group override)
  // Zebra row: light blue bg
  // Normal: white bg
  // H-2b (WI-2): a per-column `fill` (period-group color) wins over the zebra
  // stripe so the whole period column reads as one colored group.
  const shadingFill = isHeader
    ? { fill: headerFill ?? COLOR.PRIMARY, type: ShadingType.CLEAR, color: 'auto' }
    : fill
      ? { fill, type: ShadingType.CLEAR, color: 'auto' }
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

// ============================================================
//  H-2b (WI-2) — per-column table options + period-group colors
//  --------------------------------------------------------
//  makeTable() accepts an optional `colOpts` array (one entry per column
//  index; undefined entries keep the current default styling EXACTLY):
//    - fill:       body-cell fill — WINS OVER the zebra stripe on that column
//    - headerFill: header-cell fill — WINS OVER COLOR.PRIMARY on that column
//    - align:      WINS OVER the default (i > 0 → right)
//  Period-group rule (applied to every table with period columns):
//    - current-period columns (header embeds currLabel): neutral (default)
//    - prev-period columns (header embeds prevLabel): amber group
//    - Hist columns (header is histLabel): emerald group
//    - derived columns ('Perubahan', 'vs Hist', 'Selisih', 'Growth') and
//      non-period columns ('#', 'Item', 'Resto', 'Satuan', 'Metrik'): neutral
// ============================================================
interface ColumnOpts {
  fill?: string;
  headerFill?: string;
  align?: 'left' | 'right';
}

// USER-POLISH (export colors): muted professional neutrals — was amber
// (D97706/FEF3C7) + emerald (047857/D1FAE5), too loud for a finance doc.
// Prev = warm stone gray, Hist = cool slate gray: quiet, distinct (warm vs
// cool), and they recede behind the blue-dominant palette (PRIMARY headers
// + light-blue zebra stay the only strong color).
const PERIOD_COL_PREV: ColumnOpts = { headerFill: '8A8578', fill: 'F4F3EF' }; // stone — periode pembanding (prev)
const PERIOD_COL_HIST: ColumnOpts = { headerFill: '75838C', fill: 'EEF1F2' }; // slate — rata-rata historis (Hist)

function makeTable(headers: string[], rows: string[][], colOpts?: Array<ColumnOpts | undefined>): Table {
  const colAlign = (i: number): 'left' | 'right' => colOpts?.[i]?.align ?? (i > 0 ? 'right' : 'left');
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((l, i) => tableCell(l, { bold: true, align: colAlign(i), isHeader: true, headerFill: colOpts?.[i]?.headerFill })),
      }),
      ...rows.map((r, idx) => new TableRow({
        children: r.map((v, i) => tableCell(v, { align: colAlign(i), isZebra: idx % 2 === 1, fill: colOpts?.[i]?.fill })),
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
//  Returns { bufferBase64: string; fileName: string } for
//  withCacheAndDedup to JSON-serialize + cache (P3-HYG-4: base64 keeps the
//  cache row 1.33× the binary size instead of ~4× for the old number[]
//  encoding; the route handler Buffer.from(b64, 'base64')s it back).
// ============================================================
export async function buildDocxReport(
  data: ReportData,
  ctx: DocxContext,
): Promise<{ bufferBase64: string; fileName: string }> {
  // Local section-filter helper — matches route.ts:316 verbatim.
  // FIX (BUG-3-a C4): an EMPTY sections list (from `?sections=`) now means
  // "NO section active" — every hasSection() check below returns false and
  // the document degrades to title + footer only (verified crash-free: all
  // section bodies sit behind these guards, and the data-fetcher feeds
  // zero-value placeholders for the sections it skipped). `null` (param
  // absent) still means ALL sections.
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
      // H-2b (WI-3b): 'Loss To Sales' / 'Total LOSS' / 'Total SURPLUS' rows removed per user request.
      ['Loss/Surplus Qty', fmtNum(s.residualLossQty), s._prevMetrics?.residualLossQty != null ? fmtPct(calcGrowth(s.residualLossQty, s._prevMetrics.residualLossQty), true) : '—', s._prevMetrics?.residualLossQty != null ? fmtNum(s._prevMetrics.residualLossQty) : '—'],
      ['Loss/Surplus %', fmtPct(s.residualLossPct, false), s._prevMetrics?.residualLossPct != null ? fmtPct(calcGrowth(s.residualLossPct, s._prevMetrics.residualLossPct), true) : '—', s._prevMetrics?.residualLossPct != null ? fmtPct(s._prevMetrics.residualLossPct, false) : '—'],
    ], [undefined, undefined, undefined, PERIOD_COL_PREV]));

  }
  if (hasSection('growth')) {
    const g = data.growthComparison || {};
    children.push(heading('2. Perubahan (Growth)'));
    // USER-POLISH: + QTY Waste / Susut / Trial growth — same calcGrowth-based
    // values the Section 1 rows already show for these metrics (single MoM
    // step, signed), now surfaced in the growth section itself.
    children.push(makeTable(['Metric', 'Value'], [
      ['Penjualan Growth', fmtPct(g.salesGrowth, true)],
      ['QTY BOM Growth', fmtPct(g.bomGrowth, true)],
      ['QTY Deviasi Growth', fmtPct(g.qtyDeviasiGrowth, true)],
      ['Nominal Deviasi Growth', fmtPct(g.nominalDeviasiGrowth, true)],
      ['QTY Waste Growth', fmtPct(g.qtyWasteGrowth, true)],
      ['QTY Susut Growth', fmtPct(g.qtySusutGrowth, true)],
      ['QTY Trial Growth', fmtPct(g.qtyTrialGrowth, true)],
    ]));
    children.push(divider());

  }
  if (hasSection('topItems')) {
    children.push(heading('3. Item Prioritas (Top Items)'));
    children.push(paragraph('Item-item dengan kontribusi terbesar berdasarkan berbagai kategori. Angka negatif = LOSS/rugi (ditandai merah).'));
    // H-2b (WI-1c): kolom "Satuan" disisipkan setelah "Item" di tabel 3.3-3.6 (unit of
    // measure per item — MAX(ir."satuan") dari query, nullable → '—').
    // H-2b (WI-2b): colOpts untuk tabel 3.3-3.6 (9 kolom): Satuan left-align,
    // kolom prev (amber) + kolom Hist (emerald); kolom current & derived netral.
    const TOP_CAT_COL_OPTS: Array<ColumnOpts | undefined> = [
      undefined,          // '#'
      undefined,          // 'Item'
      { align: 'left' },  // 'Satuan' — teks, left-align (default i>0 = right)
      undefined,          // 'Resto'
      undefined,          // `QTY <metrik> ${currLabel}` — periode berjalan → netral
      PERIOD_COL_PREV,    // `QTY ${prevLabel}` — periode pembanding → amber
      PERIOD_COL_HIST,    // histLabel — rata-rata historis → emerald
      undefined,          // 'vs Hist' — derived → netral
      undefined,          // `Nominal <metrik> ${currLabel}` — periode berjalan → netral
    ];
    const topSections = [
      // Rev 3: Sort by absNominalDeviasi (done in query), display signed nominalDeviasi
      { title: `3.1 Nominal Deviasi Terbesar (${currLabel})`, items: data.topItemsByNominal, cols: ['#', 'Item', 'Resto', `Nominal Deviasi ${currLabel}`], colOpts: undefined, map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.nominalDeviasi)] },
      // Rev 4: Sort by abs(devBom) (done in query), display signed devBom
      // USER-POLISH: '% Toleransi' column removed per user request — the
      // deviation magnitude is the story; tolerance is set per item elsewhere.
      { title: `3.2 % Deviasi To BOM Terbesar (${currLabel})`, items: data.topItemsByDevBom, cols: ['#', 'Item', 'Resto', `% Deviasi To BOM ${currLabel}`], colOpts: undefined, map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtPct(it.devBom, false)] },
      // Rev 2: Add QTY Prev + QTY Hist Avg columns for Waste/Susut/Trial/LossSurplus
      { title: `3.3 QTY Waste Terbesar (${currLabel})`, items: data.topItemsByWaste, cols: ['#', 'Item', 'Satuan', 'Resto', `QTY Waste ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Waste ${currLabel}`], colOpts: TOP_CAT_COL_OPTS, map: (it, i) => [String(i + 1), it.itemName, it.satuan ?? '—', it.outletCode, fmtNum(it.qtyWaste), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyWaste, it.histAvgQty), fmtIDR(it.nominalWaste)] },
      { title: `3.4 QTY Susut Terbesar (${currLabel})`, items: data.topItemsBySusut, cols: ['#', 'Item', 'Satuan', 'Resto', `QTY Susut ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Susut ${currLabel}`], colOpts: TOP_CAT_COL_OPTS, map: (it, i) => [String(i + 1), it.itemName, it.satuan ?? '—', it.outletCode, fmtNum(it.qtySusut), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtySusut, it.histAvgQty), fmtIDR(it.nominalSusut)] },
      { title: `3.5 QTY Trial Terbesar (${currLabel})`, items: data.topItemsByTrial, cols: ['#', 'Item', 'Satuan', 'Resto', `QTY Trial ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Trial ${currLabel}`], colOpts: TOP_CAT_COL_OPTS, map: (it, i) => [String(i + 1), it.itemName, it.satuan ?? '—', it.outletCode, fmtNum(it.qtyTrial), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyTrial, it.histAvgQty), fmtIDR(it.nominalTrial)] },
      { title: `3.6 QTY Loss/Surplus Terbesar (${currLabel})`, items: data.topItemsByLossSurplus, cols: ['#', 'Item', 'Satuan', 'Resto', `QTY Loss/Surplus ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Loss/Surplus ${currLabel}`], colOpts: TOP_CAT_COL_OPTS, map: (it, i) => [String(i + 1), it.itemName, it.satuan ?? '—', it.outletCode, fmtNum(it.qtyLossSurplus), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyLossSurplus, it.histAvgQty), fmtIDR(it.nominalLossSurplus)] },
    ];
    // H-2b (WI-2c): the one-line color legend ("Warna kolom: kuning = …")
    // was removed per user request — the muted professional tints are
    // self-evident and the headers already label each period group.
    for (const sec of topSections) {
      if (sec.items && sec.items.length > 0) {
        children.push(paragraph(sec.title, true));
        children.push(makeTable(sec.cols, sec.items.map(sec.map), sec.colOpts));
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
  if (hasSection('variance')) {
    const va = data.varianceAnalysis || {};
    if ((va.topWorsened || []).length > 0) {
      children.push(heading('5. Perubahan Item (Selisih Terbesar)'));
      children.push(makeTable(['Item', 'Resto', `Nominal ${currLabel}`, `Nominal ${prevLabel}`, 'Selisih'],
        va.topWorsened.slice(0, 10).map((it) => [it.itemName, it.outletCode, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)]),
        [undefined, undefined, undefined, PERIOD_COL_PREV, undefined]));
      children.push(divider());
    }

  }
  // Section 13 (RANKING ITEM NASIONAL) removed per user request
  if (hasSection('trend')) {
    if (data.trend && data.trend.length > 0) {
      children.push(heading('6. Trend Antar Periode'));
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
  // FIX (BUG-3-a C5): sanitize the filename down to the RFC 2183/5987-safe
  // charset [A-Za-z0-9._-]. currLabel is a DB month label ("AGUSTUS 26") so
  // this is belt-and-braces, but a weird month label can never again smuggle
  // quotes/CR/LF into the Content-Disposition header downstream.
  const fileName = `Laporan_Deviasi_${currLabel.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_')}.docx`;

  // PERF-CACHE-06: withCacheAndDedup handles setCached(awaitWrite=true) +
  // in-flight Promise resolution. Return { bufferBase64, fileName } —
  // P3-HYG-4: base64 instead of the old Array.from(buffer) number[].
  // A JSON number[] serializes each byte as "123," (~4× bloat: a 500KB docx
  // became a ~2MB cache row + a slow JSON.parse); base64 is 1.33× and parses
  // to a string instantly. The route handler Buffer.from(b64, 'base64')s it
  // back to bytes on both the fresh + cache-hit paths.
  return { bufferBase64: buffer.toString('base64'), fileName };
}
