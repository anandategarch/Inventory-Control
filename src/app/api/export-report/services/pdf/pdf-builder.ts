// ============================================================
//  pdf-builder — Stage 2 of /api/export-report GET pipeline (PDF)
//  --------------------------------------------------------
//  EXPORT-PDF: replaces docx-builder.ts (deleted). Output switched from
//  .docx → .pdf with a full report design: cover band, KPI hero cards,
//  numbered sections, zebra tables with repeated headers, and vector
//  charts (bars / lines / heat matrix).
//
//  EXPORT-TRIM (user request): report trimmed 13 → 6 sections. Removed:
//  breakdown (Rincian Komposisi), area (Analisis per Area), outlets (Resto
//  Prioritas), pareto (Konsentrasi & Pareto), flip (Analisis Flip-Flop),
//  peer (Pembanding Peer-to-Peer), coverage (Lampiran). Explanatory
//  caption/legend lines under tables were removed per the same request.
//
//  FIX-TERPOTONG (user request: "laporan banyak yang terpotong … untuk
//  persen peningkatan beri tanda, penurunan juga"):
//    - NO truncation anywhere: tables use the auto-fit engine in
//      pdf-primitives (content-derived column widths + word-wrap +
//      variable row height); fixed-width slots (KPI cards, cover band,
//      chart labels) SHRINK the font instead of ellipsizing; filter
//      chips wrap onto extra lines instead of being dropped.
//    - ▲ / ▼ markers (MK_UP/MK_DN vector triangles) + semantic colors
//      on EVERY change column: Perubahan (section 1), Selisih & Growth %
//      (section 2), vs Hist (3.3-3.6), Selisih (4.1/4.2), Trend
//      (section 5) and the KPI hero card deltas. Green = favorable
//      direction, red = unfavorable (goodUp per metric — e.g. sales up
//      is green, deviation up is red).
//
//  DESAIN-SIMPEL (user request: "tidak kelihatan seperti buatan AI,
//  natural buatan manusia — simpel, sedikit warna, tetap merah/hijau
//  untuk perubahan"):
//    - Plain cover (no dark band), plain numbered section headers
//      ("1. Ringkasan" + thin rule — NO caption lines per request), no
//      page footer, light-gray table headers, neutral chart bars.
//    - Removed: Total LOSS / Total SURPLUS metrics (KPI cards, Ringkasan
//      rows, growth rows + bars, line-chart legend renamed Loss/Surplus).
//    - Title: "Ringkasan Laporan Deviasi" (was "LAPORAN AUDIT INVENTORY").
//    - Colors kept: ▲/▼ + red/green change markers, light-red heat scale.
//
//  REFINE-1 (user request round 4):
//    - SALES SECRECY: "Penjualan merupakan angka yang rahasia jadi
//      tampilkan aja persentasi kenaikan gak perlu nominal nya" — the
//      Penjualan KPI card shows ONLY the ▲/▼ % change (no Rp figure),
//      and the Penjualan rows are gone from the section 1/2 tables
//      (their % change lives on the card + the growth bars).
//    - "% Loss to Sales" / "% Surplus to Sales" rows + bars REMOVED
//      ("gak perlu jadi hapus aja").
//    - "% Nominal Deviasi to Sales" → renamed "Nominal Deviasi to Sales"
//      ("rename sesuai headernya").
//    - The word "pembanding" is replaced by the actual selected period
//      ("Misal Agustus 2026 week 1"): section titles, KPI subs and the
//      table column headers now carry the comparator's month + week
//      (e.g. "AGU 26 W1" in headers, "Agustus 2026 Week 1" in titles).
//    - 3.1 gains a "% Deviasi To BOM" column; 3.2 gains a "Nominal
//      Deviasi" column on its right.
//    - 3.3-3.6: "HIST (…)" + "vs Hist" renamed to "Rata-rata per Bulan" /
//      "vs Rata-rata" ("istilah rata-rata tiap bulannya"), a NEW
//      "Rata-rata Area" column (average of the area where the row's
//      resto is located), and the "Nominal (Rp)" column is REMOVED
//      ("hapus nominal nya biar fit").
//    - Heat map colors: percentile-scaled (p90 of the non-zero cells)
//      + a finer 6-step ramp — one outlier no longer flattens the whole
//      matrix to near-white ("warna heat map buat lebih akurat lagi").
//    - Section 6 table: Loss/Surplus columns REMOVED
//      ("trend antar periode hapuss kolom loss dan surplus").
//    - NEW section 7 "Resto dengan Penjualan Kurang Lebih Sama"
//      (peer-to-peer, renamed per request): peers' nominal deviations +
//      a per-item breakdown (kuantitas, % to BOM) vs the peer average.
//      Sales nominals are never printed.
//    - NEW section 8 "Item yang Kemungkinan Plus Minus antar Periode"
//      (flip-flop items, renamed per request).
//
//  REFINE-2 (user request, 3 items):
//    - Minimal cover header ("Hapus Bagian Header laporan itu. Cukup buat:
//      Ringkasan Laporan Deviasi / 1042.KWGGAL · September") — the
//      timestamp, "Periode pembanding", "Rata-rata per bulan" meta lines
//      and the Area/Kelompok/Resto/Item/PIC filter line are GONE; the
//      running header on pages 2+ mirrors the same minimal form.
//    - "Section yang belum punya satuan tambahain" — tables 4.1, 4.2, 5,
//      7.2 and 8 gain the per-item "Satuan" column (SQL: MAX(satuan) on
//      variance / item-trend-matrix / flip-ranking / peer-comparison-items;
//      cache sv forked so pre-deploy rows can't render '—').
//    - "Data yang terpotong di laporan sama" — root cause of the awkward
//      subhead wrap ("3.3 QTY Waste Terbesar (SEP 26 / W1)") fixed in
//      pdf-primitives Rpt.text: pdfkit's LineWrapper measures per-word
//      WITHOUT cross-word kerning, so some strings exceeded the passed
//      `width: tw + 2` by a fraction and wrapped their last word. No width
//      is passed anymore (see the note there) — single-line draws stay
//      single-line, deterministically.
//
//  Section map (FIXED numbers — stable across ?sections= selections;
//  keep in sync with EXPORT_SECTION_KEYS in validation.ts + the
//  SECTIONS list in ExportDialog.tsx):
//     1 exec        — Ringkasan (hero cards + KPI table)
//     2 growth      — Perubahan vs <periode pembanding> (table + growth bars)
//     3 topItems    — Item Prioritas (6 sub-tables)
//     4 variance    — Perubahan Item: Memburuk / Membaik (tables + bars)
//     5 itemTrend   — Trend Item Multi-Periode (heat matrix)
//     6 trend       — Trend Antar Periode (table + bar + line charts)
//     7 peer        — Resto dengan Penjualan Kurang Lebih Sama (REFINE-1)
//     8 flip        — Item yang Kemungkinan Plus Minus antar Periode (REFINE-1)
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
import { Rpt, C, PAGE, CONTENT_W, MK_UP, markOf, stripMark } from './pdf-primitives';
import {
  barChartV, hBarChart, lineChart,
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

/** FIX-TERPOTONG: vs-historical delta now carries the ▲/▼ marker. */
function fmtVsHist(current: number | null, histAvg: number | null): string {
  if (current == null || histAvg == null || histAvg === 0) return '\u2014';
  const pctChange = (current - histAvg) / Math.abs(histAvg);
  if (pctChange === 0) return '= 0%';
  const sign = pctChange > 0 ? '+ ' : '- ';
  return markOf(pctChange) + sign + `${(Math.abs(pctChange) * 100).toFixed(1)}%`;
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

// ------------------------------------------------------------
//  REFINE-1 period label helpers — the user asked for the comparator to
//  be named as the actual selected period ("Misal Agustus 2026 week 1")
//  instead of the generic word "pembanding", and every period reference
//  now carries its week (the comparison is week-scoped).
// ------------------------------------------------------------

/** "AGUSTUS 2026" / "Agustus 2026" → "Agustus 2026". */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** "WEEK 1" → "Week 1" (digit-less labels pass through). */
function prettyWeek(wl: string | null | undefined): string {
  if (!wl) return '\u2014';
  const n = wl.replace(/\D/g, '');
  return n ? `Week ${n}` : wl;
}

/** Column-header period: "SEP 26" + "WEEK 1" → "SEP 26 W1". */
function periodCol(monthLabel: string | null | undefined, weekLabel: string | null | undefined): string {
  const m = monthLabel ? shortMonth(monthLabel) : '\u2014';
  const n = weekLabel ? weekLabel.replace(/\D/g, '') : '';
  return n ? `${m} W${n}` : m;
}

/** Full period: "September 2026" + "WEEK 1" → "September 2026 Week 1". */
function periodFull(monthLabel: string | null | undefined, weekLabel: string | null | undefined): string {
  if (!monthLabel) return '\u2014';
  return `${titleCase(monthLabel)} ${prettyWeek(weekLabel)}`;
}

/** Heat color for the item-trend matrix cells — DESAIN-SIMPEL: light-red
 *  intensity scale (deviation magnitude = further into the red; the only
 *  chromatic family besides the change green).
 *  REFINE-1 ("warna heat map buat lebih akurat lagi"): the scale max is
 *  now the 90th PERCENTILE of the non-zero cells (computed by the caller),
 *  not the global max — one outlier row no longer compresses every other
 *  cell into the palest bucket — and the ramp has 6 steps instead of 5, so
 *  adjacent magnitudes are easier to tell apart. Values above the p90
 *  saturate at the deepest red. */
function heatColor(v: number, scale: number): string | undefined {
  if (scale <= 0 || v <= 0) return undefined;
  const r = Math.min(1, v / scale);
  if (r < 1 / 6) return '#FEF2F2';
  if (r < 2 / 6) return '#FEE2E2';
  if (r < 3 / 6) return '#FECACA';
  if (r < 4 / 6) return '#FCA5A5';
  if (r < 5 / 6) return '#F87171';
  return '#EF4444';
}

/** Signed compact IDR for chart tick labels (no 'Rp' prefix — axis stays narrow). */
const tickIDR = (v: number): string => {
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
  return v.toFixed(0);
};

/**
 * FIX-TERPOTONG: semantic color for a change value given whether "up" is
 * the favorable direction (goodUp). Neutral (0 / missing) → undefined.
 */
function chgColor(v: number | null | undefined, goodUp: boolean): string | undefined {
  if (v == null || isNaN(v) || !isFinite(v) || v === 0) return undefined;
  return v > 0 ? (goodUp ? C.success : C.danger) : (goodUp ? C.danger : C.success);
}

/** Marker + signed growth string ("▲+1.23%") — null → '—'. */
const mkGrowth = (v: number | null | undefined): string =>
  v != null ? markOf(v) + fmtPct(v, true) : '\u2014';

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
    // bufferPages: keep every page addressable until end() — without it
    // pdfkit flushes the page buffer on every addPage(), so the post-hoc
    // running-header pass below saw bufferedPageRange() = { start: N-1,
    // count: 1 } and rendered the header ONLY... on the last page (and the
    // old footer read "Halaman N dari 1" — the exact bug in the user's
    // screenshot "Halaman 8 dari 1").
    bufferPages: true,
    info: {
      Title: `Ringkasan Laporan Deviasi ${shortMonth(data.period.monthLabel)} ${prettyWeek(data.period.weekLabel)}`,
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
      // Post-hoc pass: small running header on pages 2+ only — no footer
      // (DESAIN-SIMPEL: user asked to remove the page footer entirely).
      // REFINE-2: mirrors the new minimal cover header —
      // "Ringkasan Laporan Deviasi · <resto> · <bulan>".
      const range = doc.bufferedPageRange();
      const outletLabel = data.filters.outletCode && data.filters.outletCode !== 'all'
        ? data.filters.outletCode
        : 'Semua Resto';
      const headerLabel = `Ringkasan Laporan Deviasi  \u00B7  ${outletLabel}  \u00B7  ${titleCase(data.period.monthLabel.split(/\s+/)[0] ?? '')}`;
      for (let i = range.start; i < range.start + range.count; i++) {
        if (i === range.start) continue;
        doc.switchToPage(i);
        Rpt.runningHeader(doc, headerLabel);
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
    const raw = `Ringkasan_Laporan_Deviasi_${outletLabel}_${shortMonth(data.period.monthLabel).replace(/\s+/g, '_')}_${data.period.weekLabel}${vs}.pdf`;
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
  // REFINE-1: the comparator is NAMED, not called "pembanding" — full form
  // for titles/subs ("Agustus 2026 Week 1"), column form for table headers
  // ("AGU 26 W1"). Every period reference also carries its week now (the
  // comparison is week-scoped).
  const currCol = periodCol(data.period.monthLabel, data.period.weekLabel);
  const prevCol = data.period.comparisonMonth ? periodCol(data.period.comparisonMonth, data.period.comparisonWeek) : '\u2014';
  const cmpFull = data.period.comparisonMonth ? periodFull(data.period.comparisonMonth, data.period.comparisonWeek) : null;
  const restoName = data.filters.outletCode && data.filters.outletCode !== 'all' ? data.filters.outletCode : 'Semua Resto';
  const s = data.executiveSummary;
  const pm = s._prevMetrics;
  const kpisAvailable = hasSection('exec') || hasSection('growth');

  // ============================================================
  //  COVER — plain title header + KPI cards
  //  (DESAIN-SIMPEL: no TOC — the report is short and every section is
  //  numbered; nothing navigational was lost)
  //  REFINE-2 (user: "Hapus Bagian Header laporan itu. Cukup buat:
  //  Ringkasan Laporan Deviasi / 1042.KWGGAL · September"): the cover
  //  header is now ONLY the title + the outlet · month subtitle — the
  //  timestamp / "Periode pembanding" / "Rata-rata per bulan" meta lines
  //  AND the Area/Kelompok/Resto/Item/PIC filter line are GONE. The named
  //  comparator period still lives in every section title + KPI sub where
  //  it matters; the week scope stays visible in the table column headers
  //  (e.g. "SEP 26 W1").
  // ============================================================
  rpt.coverBand(
    'Ringkasan Laporan Deviasi',
    `${restoName}  \u00B7  ${titleCase(data.period.monthLabel.split(/\s+/)[0] ?? '')}`,
    [],
  );

  // KPI hero cards (2 × 2) — only when the kpis row was fetched.
  // DESAIN-SIMPEL: Total LOSS / Total SURPLUS cards REMOVED (user
  // request); % Nominal Deviasi to Sales now shows its own growth sub.
  // FIX-TERPOTONG: every "vs …" sub carries the ▲/▼ marker + a semantic
  // color (green favorable / red unfavorable).
  // REFINE-1: SALES SECRECY (user: "Penjualan merupakan angka yang rahasia
  // jadi tampilkan aja persentasi kenaikan gak perlu nominal nya") — the
  // Penjualan card's VALUE is the ▲/▼ % change itself (no Rp figure),
  // colored green/red. The card's % Nominal Deviasi to Sales dropped its
  // "%-sign" prefix (renamed "Nominal Deviasi to Sales").
  if (kpisAvailable) {
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    const devToSalesG = devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null;
    // Hoisted (TS narrowing through repeated pm?.x ternaries inside one
    // object literal is fragile) — also avoids re-running calcGrowth.
    const bomG = pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null;
    rpt.kpiCards([
      {
        label: 'Penjualan',
        value: s.sales.growth != null ? markOf(s.sales.growth) + fmtPct(s.sales.growth, true) : '\u2014',
        valueColor: chgColor(s.sales.growth, true),
        sub: cmpFull ?? undefined,
        subColor: C.muted,
      },
      {
        label: 'Nominal Deviasi', value: fmtIDR(s.nominalDeviasi.current),
        sub: s.nominalDeviasi.growth != null && cmpFull ? `${markOf(s.nominalDeviasi.growth)}vs ${cmpFull}: ${fmtPct(s.nominalDeviasi.growth, true)}` : undefined,
        subColor: chgColor(s.nominalDeviasi.growth, false) ?? C.muted,
      },
      {
        label: '% Deviasi To BOM', value: fmtPct(s.deviationToBom, false),
        sub: bomG != null && cmpFull ? `${markOf(bomG)}vs ${cmpFull}: ${fmtPct(bomG, true)}` : undefined,
        subColor: chgColor(bomG, false) ?? C.muted,
      },
      {
        label: 'Nominal Deviasi to Sales', value: fmtPct(devToSalesCur, false),
        sub: devToSalesG != null && cmpFull ? `${markOf(devToSalesG)}vs ${cmpFull}: ${fmtPct(devToSalesG, true)}` : undefined,
        subColor: chgColor(devToSalesG, false) ?? C.muted,
      },
    ], { perRow: 2 });
  }

  // ============================================================
  //  1 — RINGKASAN  (EXPORT-TRIM: renamed from "Ringkasan Eksekutif")
  // ============================================================
  if (hasSection('exec')) {
    rpt.sectionHeader(1, 'Ringkasan');
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    // [label, current, change value (marker + color source), previous, goodUp]
    // REFINE-1: the Penjualan row is GONE (sales nominal is confidential —
    // its ▲/▼ % change lives on the cover KPI card + the growth bars);
    // % Loss to Sales / % Surplus to Sales rows REMOVED ("gak perlu jadi
    // hapus aja"); "% Nominal Deviasi to Sales" renamed "Nominal Deviasi
    // to Sales" ("rename sesuai headernya").
    const defs: Array<[string, string, number | null, string, boolean]> = [
      ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth, fmtIDR(s.nominalDeviasi.previous), false],
      ['Nominal Deviasi to Sales', fmtPct(devToSalesCur, false), devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null, fmtPct(devToSalesPrev, false), false],
      ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth, fmtNum(s.qtyBom.previous), true],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth, fmtNum(s.qtyDeviasi.previous), false],
      ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, pm?.deviationToBom != null ? fmtPct(pm.deviationToBom, false) : '\u2014', false],
      ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth, fmtNum(s.qtyWaste.previous), false],
      ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth, fmtNum(s.qtySusut.previous), false],
      ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth, fmtNum(s.qtyTrial.previous), false],
      ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth, fmtNum(s.qtyLossSurplus.previous), false],
      ['Loss/Surplus Qty', fmtNum(s.residualLossQty), pm?.residualLossQty != null ? calcGrowth(s.residualLossQty, pm.residualLossQty) : null, pm?.residualLossQty != null ? fmtNum(pm.residualLossQty) : '\u2014', false],
      ['Loss/Surplus %', fmtPct(s.residualLossPct, false), pm?.residualLossPct != null ? calcGrowth(s.residualLossPct, pm.residualLossPct) : null, pm?.residualLossPct != null ? fmtPct(pm.residualLossPct, false) : '\u2014', false],
    ];
    rpt.table({
      cols: [
        { header: 'Metrik' },
        { header: currCol, align: 'right' },
        { header: 'Perubahan', align: 'right' },
        { header: prevCol, align: 'right' },
      ],
      boldFirst: true,
      rows: defs.map((d) => [d[0], d[1], mkGrowth(d[2]), d[3]]),
      // FIX-TERPOTONG: ▲/▼ + semantic color on the Perubahan column only
      // (the rest of the row stays neutral ink).
      cellColor: (row, ri, ci) => (ci === 2 ? chgColor(defs[ri]?.[2], defs[ri]?.[4] ?? false) : undefined),
    });
  }

  // ============================================================
  //  2 — PERUBAHAN VS <PERIODE PEMBANDING DINAMAI>
  // REFINE-1: the title names the actual selected comparator period
  // ("Perubahan vs Agustus 2026 Week 1") — user: "Kata pembanding jadi Kata
  // periode yang terpilih menjadi pembanding. Misal Agustus 2026 week 1".
  // ============================================================
  if (hasSection('growth')) {
    rpt.sectionHeader(2, cmpFull ? `Perubahan vs ${cmpFull}` : 'Perubahan');
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    type GRow = { cells: string[]; g: number | null; goodUp: boolean };
    const vr = (label: string, cur: number | null, prev: number | null, fmt: typeof fmtIDR, growth: number | null, goodUp: boolean): GRow => ({
      cells: [
        label, fmt(cur), fmt(prev),
        cur != null && prev != null ? markOf(cur - prev) + fmt(cur - prev) : '\u2014',
        mkGrowth(growth),
      ],
      g: growth, goodUp,
    });
    const rr = (label: string, cur: number | null, prev: number | null, growth: number | null, goodUp: boolean): GRow => ({
      cells: [
        label, fmtPct(cur, false), fmtPct(prev, false),
        cur != null && prev != null ? markOf(cur - prev) + fmtPp(cur - prev) : '\u2014',
        mkGrowth(growth),
      ],
      g: growth, goodUp,
    });
    // REFINE-1: Penjualan (Rp) row REMOVED (sales nominal confidential — the
    // % change lives on the cover card + the growth bars below); % Loss to
    // Sales / % Surplus to Sales rows REMOVED; "% Nominal Deviasi to Sales"
    // renamed "Nominal Deviasi to Sales".
    const defs: GRow[] = [
      vr('Nominal Deviasi (Rp)', s.nominalDeviasi.current, s.nominalDeviasi.previous, fmtIDR, s.nominalDeviasi.growth, false),
      vr('QTY BOM', s.qtyBom.current, s.qtyBom.previous, fmtNum, s.qtyBom.growth, true),
      vr('QTY Deviasi', s.qtyDeviasi.current, s.qtyDeviasi.previous, fmtNum, s.qtyDeviasi.growth, false),
      vr('QTY Waste', s.qtyWaste.current, s.qtyWaste.previous, fmtNum, s.qtyWaste.growth, false),
      vr('QTY Susut', s.qtySusut.current, s.qtySusut.previous, fmtNum, s.qtySusut.growth, false),
      vr('QTY Trial', s.qtyTrial.current, s.qtyTrial.previous, fmtNum, s.qtyTrial.growth, false),
      rr('% Deviasi To BOM', s.deviationToBom, pm?.deviationToBom ?? null, pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, false),
      rr('Nominal Deviasi to Sales', devToSalesCur, devToSalesPrev, devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null, false),
    ];
    rpt.table({
      cols: [
        { header: 'Metrik' },
        { header: currCol, align: 'right' },
        { header: prevCol, align: 'right' },
        { header: 'Selisih', align: 'right' },
        { header: 'Growth %', align: 'right' },
      ],
      boldFirst: true,
      rows: defs.map((d) => d.cells),
      // ▲/▼ + semantic color on the Selisih and Growth % columns.
      cellColor: (row, ri, ci) => (ci === 3 || ci === 4 ? chgColor(defs[ri]?.g, defs[ri]?.goodUp ?? false) : undefined),
    });

    // growth % horizontal bars — sales/BOM up = green (good); deviation
    // metrics up = red (bad). Factual coloring by metric direction.
    // REFINE-1: the Penjualan BAR stays — it IS "tampilkan aja persentasi
    // kenaikan" (a % change, not a nominal). % Loss/% Surplus bars REMOVED.
    const withGrowth = [
      { label: 'Penjualan', g: s.sales.growth, goodUp: true },
      { label: 'Nominal Deviasi', g: s.nominalDeviasi.growth, goodUp: false },
      { label: 'QTY BOM', g: s.qtyBom.growth, goodUp: true },
      { label: 'QTY Deviasi', g: s.qtyDeviasi.growth, goodUp: false },
      { label: 'QTY Waste', g: s.qtyWaste.growth, goodUp: false },
      { label: 'QTY Susut', g: s.qtySusut.growth, goodUp: false },
      { label: 'QTY Trial', g: s.qtyTrial.growth, goodUp: false },
      { label: '% Dev/BOM', g: pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, goodUp: false },
    ].filter((r) => r.g != null) as Array<{ label: string; g: number; goodUp: boolean }>;
    if (withGrowth.length > 0) {
      rpt.ensure(18 * withGrowth.length + 24);
      rpt.subhead('Growth % per Metrik', { size: 8.5, gapAfter: 2 });
      hBarChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * withGrowth.length,
        labels: withGrowth.map((r) => r.label),
        values: withGrowth.map((r) => r.g * 100),
        fmt: (v) => markOf(v) + `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
        colors: withGrowth.map((r) => (r.g > 0 ? (r.goodUp ? C.success : C.danger) : r.goodUp ? C.danger : C.success)),
        labelW: 118, valW: 52,
      });
      rpt.y += 18 * withGrowth.length + 6;
    }
  }

  // ============================================================
  //  3 — ITEM PRIORITAS (TOP ITEMS)  (EXPORT-TRIM: was 7)
  // ============================================================
  if (hasSection('topItems')) {
    rpt.sectionHeader(3, 'Item Prioritas (Top Items)');

    // 3.1 nominal — REFINE-1: + "% Deviasi To BOM" column (user: "3.1
    // Nominal Deviasi Terbesar tambahkan % Deviasi to bom nya juga").
    if (data.topItemsByNominal.length > 0) {
      rpt.subhead(`3.1 Nominal Deviasi Terbesar (${currCol})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Resto' },
          { header: 'Satuan' },
          { header: `Nominal Deviasi`, align: 'right' },
          { header: '% Deviasi To BOM', align: 'right' },
        ],
        rows: data.topItemsByNominal.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtIDR(it.nominalDeviasi), fmtPct(it.devBom, false)]),
        rowText: (row) => (stripMark(row[4]).startsWith('-') ? C.danger : undefined),
      });
    }
    // 3.2 devBom — REFINE-1: + "Nominal Deviasi" column on the right (user:
    // "3.2 % Deviasi To BOM Terbesar tambahkan Nominal Deviasi juga di
    // sebelah kanan nya").
    if (data.topItemsByDevBom.length > 0) {
      rpt.subhead(`3.2 % Deviasi To BOM Terbesar (${currCol})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Resto' },
          { header: 'Satuan' },
          { header: '% Deviasi To BOM', align: 'right' },
          { header: 'Nominal Deviasi', align: 'right' },
        ],
        rows: data.topItemsByDevBom.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtPct(it.devBom, false), fmtIDR(it.nominalDeviasi)]),
        rowText: (row) => (stripMark(row[5]).startsWith('-') ? C.danger : undefined),
      });
    }
    // 3.3-3.6 category tables
    // REFINE-1: "HIST (…)"/"vs Hist" → "Rata-rata per Bulan"/"vs Rata-rata";
    // + NEW "Rata-rata Area" column (avg across the area where the row's
    // resto is located); "Nominal (Rp)" column REMOVED ("hapus nominal nya
    // biar fit").
    const catTables: Array<{ title: string; items: Array<{ itemName: string; outletCode: string; satuan?: string | null; area: string; qty: number; nominal: number; prevQty: number | null; histAvgQty: number | null; areaAvgQty: number | null }> }> = [
      { title: `3.3 QTY Waste Terbesar (${currCol})`, items: data.topItemsByWaste.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyWaste, nominal: r.nominalWaste, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
      { title: `3.4 QTY Susut Terbesar (${currCol})`, items: data.topItemsBySusut.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtySusut, nominal: r.nominalSusut, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
      { title: `3.5 QTY Trial Terbesar (${currCol})`, items: data.topItemsByTrial.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyTrial, nominal: r.nominalTrial, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
      { title: `3.6 QTY Loss/Surplus Terbesar (${currCol})`, items: data.topItemsByLossSurplus.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyLossSurplus, nominal: r.nominalLossSurplus, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
    ];
    for (const ct2 of catTables) {
      if (ct2.items.length === 0) continue;
      rpt.subhead(ct2.title, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Satuan' },
          { header: 'Resto' },
          { header: `QTY ${currCol}`, align: 'right' },
          { header: `QTY ${prevCol}`, align: 'right' },
          { header: 'Rata-rata per Bulan', align: 'right' },
          { header: 'vs Rata-rata', align: 'right' },
          { header: 'Rata-rata Area', align: 'right' },
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
          it.areaAvgQty != null ? fmtNum(it.areaAvgQty) : '\u2014',
        ]),
        // ▲/▼ semantic color on the "vs Rata-rata" delta column (up = bad —
        // these are all deviation-magnitude rankings).
        cellColor: (row, ri, ci) => {
          if (ci !== 7) return undefined;
          const it = ct2.items[ri];
          if (it == null || it.histAvgQty == null || it.histAvgQty === 0) return undefined;
          return it.qty > it.histAvgQty ? C.danger : it.qty < it.histAvgQty ? C.success : undefined;
        },
      });
    }
  }

  // ============================================================
  //  4 — PERUBAHAN ITEM (MEMBURUK / MEMBAIK)  (EXPORT-TRIM: was 8)
  // ============================================================
  if (hasSection('variance')) {
    const va = data.varianceAnalysis;
    if (va.topWorsened.length > 0 || va.topImproved.length > 0) {
      // REFINE-1: the comparator period is NAMED ("vs Agustus 2026 Week 1")
      // instead of the generic "vs Periode Pembanding".
      rpt.sectionHeader(4, cmpFull ? `Perubahan Item (vs ${cmpFull})` : 'Perubahan Item');
    }
    if (va.topWorsened.length > 0) {
      rpt.subhead(`4.1 Memburuk \u2014 selisih nominal terbesar (${currCol} vs ${prevCol})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          // REFINE-2 (user: "section yang belum punya satuan tambahain"):
          // per-item unit of measure, same convention as the 3.x tables.
          { header: 'Satuan' },
          { header: 'Resto' },
          { header: 'Area' },
          { header: `Nominal ${currCol}`, align: 'right' },
          { header: `Nominal ${prevCol}`, align: 'right' },
          { header: 'Selisih', align: 'right' },
        ],
        rows: va.topWorsened.map((it, i) => [String(i + 1), it.itemName, it.satuan ?? '\u2014', it.outletCode, it.area, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), markOf(it.selisih) + fmtIDR(it.selisih)]),
        // DESAIN-SIMPEL: only the Selisih column carries the change color
        // (red — worsened); the rest of the row stays neutral ink.
        cellColor: (_row, _ri, ci) => (ci === 7 ? C.danger : undefined),
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
      rpt.subhead(`4.2 Membaik \u2014 penurunan selisih nominal terbesar (${currCol} vs ${prevCol})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Satuan' },
          { header: 'Resto' },
          { header: 'Area' },
          { header: `Nominal ${currCol}`, align: 'right' },
          { header: `Nominal ${prevCol}`, align: 'right' },
          { header: 'Selisih', align: 'right' },
        ],
        rows: va.topImproved.map((it, i) => [String(i + 1), it.itemName, it.satuan ?? '\u2014', it.outletCode, it.area, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), markOf(it.selisih) + fmtIDR(it.selisih)]),
        // DESAIN-SIMPEL: only the Selisih column carries the change color
        // (green — improved); the rest of the row stays neutral ink.
        cellColor: (_row, _ri, ci) => (ci === 7 ? C.success : undefined),
      });
    }
  }

  // ============================================================
  //  5 — TREND ITEM MULTI-PERIODE  (EXPORT-PDF — NEW; EXPORT-TRIM: was 9)
  // ============================================================
  if (hasSection('itemTrend') && data.itemTrendMatrix.length > 0) {
    rpt.sectionHeader(5, 'Trend Item Multi-Periode');

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

    // REFINE-1 ("warna heat map buat lebih akurat lagi"): the color scale
    // is anchored at the 90th PERCENTILE of the non-zero cells instead of
    // the global max — one outlier item no longer pushes every other cell
    // into the palest two buckets, and mid-range differences get visible
    // steps (see heatColor: 6-step ramp, saturating above p90).
    const cellVals = topItems
      .flatMap(([, m]) => shownMonths.map((ml) => m.get(ml) ?? 0))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const heatScale = cellVals.length > 0 ? cellVals[Math.floor((cellVals.length - 1) * 0.9)] : 0;
    // FIX-TERPOTONG: trend % carries the ▲/▼ marker (BARU = item muncul
    // baru → treated as an increase).
    const trendPct = (m: Map<string, number>): string => {
      const curIdx = shownMonths.reduce((acc, ml, i) => (m.has(ml) ? i : acc), -1);
      if (curIdx < 1) return '\u2014';
      const cur = m.get(shownMonths[curIdx]) ?? 0;
      const prev = m.get(shownMonths[curIdx - 1]) ?? 0;
      if (prev === 0) return cur === 0 ? '= 0%' : MK_UP + 'BARU';
      const pct = ((cur - prev) / Math.abs(prev)) * 100;
      return markOf(pct) + `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    };

    const monthLabel = (ml: string): string => shortMonth(ml);
    // REFINE-2: per-item satuan (unit of measure) — MAX across the item's
    // period rows ("section yang belum punya satuan tambahain").
    const satuanByItem = new Map<string, string>();
    for (const r of data.itemTrendMatrix) {
      if (r.satuan != null) satuanByItem.set(r.itemName, r.satuan);
    }
    rpt.table({
      cols: [
        { header: 'Item' },
        { header: 'Satuan' },
        ...shownMonths.map((ml) => ({ header: monthLabel(ml), align: 'right' as const })),
        { header: 'Trend', align: 'right' },
      ],
      rows: topItems.map(([name, m]) => [
        name,
        satuanByItem.get(name) ?? '\u2014',
        ...shownMonths.map((ml) => (m.has(ml) ? fmtIDR(m.get(ml)) : '\u2014')),
        trendPct(m),
      ]),
      cellFill: (row, _ri, ci) => {
        // ci 0 = Item, ci 1 = Satuan, last = Trend — no heat fill; the month
        // columns start at ci 2.
        if (ci <= 1 || ci > shownMonths.length + 1) return undefined;
        const ml = shownMonths[ci - 2];
        const val = byItem.get(row[0])?.get(ml) ?? 0;
        return heatColor(val, heatScale);
      },
      rowText: (row) => {
        const t = stripMark(row[row.length - 1]);
        return t.startsWith('+') || t === 'BARU' ? C.danger : t.startsWith('-') ? C.success : undefined;
      },
    });
  }

  // ============================================================
  //  6 — TREND ANTAR PERIODE  (EXPORT-TRIM: was 12)
  //  REFINE-1: Loss / Surplus table columns REMOVED (user: "Trend antar
  //  periode hapuss kolom loss dan surplus") — the loss-vs-surplus line
  //  chart below still carries that composition per period.
  // ============================================================
  if (hasSection('trend') && data.trend.length > 0) {
    rpt.sectionHeader(6, 'Trend Antar Periode');
    rpt.table({
      cols: [
        { header: 'Periode' },
        { header: 'Nominal Deviasi', align: 'right' },
        { header: '% Dev/BOM', align: 'right' },
        { header: 'Nominal Deviasi to Sales', align: 'right' },
      ],
      rows: data.trend.map((t) => [
        t.weekLabel,
        fmtIDR(t.nominal),
        fmtPct(t.devBom, false),
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
          // DESAIN-SIMPEL: per-period legend labels — no "Total" wording
          // (the Total LOSS/SURPLUS metrics were removed by user request).
          { name: 'Loss', values: data.trend.map((t) => t.lossNominal), color: C.danger },
          { name: 'Surplus', values: data.trend.map((t) => t.surplusNominal), color: C.success },
        ],
        yFmt: tickIDR,
      });
      rpt.y += 140 + 16;
    }
  }

  // ============================================================
  //  7 — RESTO DENGAN PENJUALAN KURANG LEBIH SAMA  (REFINE-1 — NEW)
  //  --------------------------------------------------------
  //  User: "Tambahkan section Peer to Peer tapi ganti istilah nya menjadi
  //  'Dengan Total Penjualan yang kurang lebih sama Resto lain menghasilkan
  //  nominal deviasi ini dan ada break down per item nya berapa secara
  //  kuantiti, % to bom'".
  //  7.1 = the similar-sales restos and the nominal deviations they produce
  //        (peer band = sales within ±10% of the target — same-period mode).
  //  7.2 = the per-item breakdown for the target's top items: kuantitas +
  //        % to BOM, vs the peer average.
  //  SALES SECRECY: no sales nominal is ever printed here.
  // ============================================================
  if (hasSection('peer')) {
    rpt.sectionHeader(7, 'Resto dengan Penjualan Kurang Lebih Sama');
    const pc = data.peerComparison;
    if (!pc || pc.peers.length === 0) {
      rpt.noteBox('Data pembanding tidak tersedia untuk filter ini \u2014 pilih satu resto pada Filter Resto (tab Resto Analysis) lalu export ulang.');
    } else {
      const targetLabel = `${pc.targetOutlet.name} (${pc.targetOutlet.code})`;
      // 7.1 — peers' nominal deviations, biggest first; the target row is
      // bold (named in the subhead — factual, no legend needed).
      const sortedPeers = [...pc.peers].sort((a, b) => Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi));
      rpt.subhead(`7.1 Nominal Deviasi per Resto (penjualan kurang lebih sama dengan ${targetLabel}${pc.autoTarget ? ' \u2014 target otomatis: resto deviasi terbesar' : ''})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Resto' },
          { header: 'Area' },
          { header: 'Nominal Deviasi', align: 'right' },
          { header: '% Deviasi To BOM', align: 'right' },
          { header: 'QTY Deviasi', align: 'right' },
        ],
        rows: sortedPeers.map((p, i) => [
          String(i + 1),
          `${p.outletName} (${p.outletCode})`,
          p.area,
          fmtIDR(p.nominalDeviasi),
          fmtPct(p.devBom, false),
          fmtNum(p.qtyDeviasi),
        ]),
        rowBold: (_row, i) => sortedPeers[i]?.isTarget ?? false,
        rowText: (row) => (row[3].startsWith('-') ? C.danger : undefined),
      });

      // 7.2 — per-item breakdown: kuantitas + % to BOM, target vs the
      // average of the similar-sales peers.
      if (pc.items.length > 0) {
        rpt.subhead(`7.2 Breakdown per Item (kuantitas, % to BOM) \u2014 ${targetLabel} vs rata-rata resto setara`, { size: 8.5 });
        rpt.table({
          cols: [
            { header: 'Item' },
            // REFINE-2 ("section yang belum punya satuan tambahain"): unit of
            // measure per item — the QTY columns are satuan-denominated.
            { header: 'Satuan' },
            { header: 'QTY Deviasi', align: 'right' },
            { header: '% Deviasi To BOM', align: 'right' },
            { header: 'Rata-rata QTY Peer', align: 'right' },
            { header: 'Rata-rata % Dev/BOM Peer', align: 'right' },
          ],
          rows: pc.items.map((it) => [
            it.itemName,
            it.satuan ?? '\u2014',
            fmtNum(it.target.qtyDeviasi),
            fmtPct(it.target.devBom, false),
            it.peerAvg != null ? fmtNum(it.peerAvg.qtyDeviasi) : '\u2014',
            it.peerAvg != null ? fmtPct(it.peerAvg.devBom, false) : '\u2014',
          ]),
        });
      }
    }
  }

  // ============================================================
  //  8 — ITEM YANG KEMUNGKINAN PLUS MINUS ANTAR PERIODE  (REFINE-1 — NEW)
  //  --------------------------------------------------------
  //  User: "Tambahkan juga item yang flip flop namun ganti istilah nya
  //  menjadi Item yang kemungkinan Plus Minus antar Periode".
  //  Each row shows an item's most BALANCED sign reversal between two
  //  consecutive same-week periods (e.g. +100 in Jul W4 → -98 in Agu W4):
  //  QTY Deviasi positive = green (plus), negative = red (minus); Net near
  //  zero = the reversal is nearly symmetrical.
  // ============================================================
  if (hasSection('flip')) {
    rpt.sectionHeader(8, 'Item yang Kemungkinan Plus Minus antar Periode');
    const fr = data.flipRanking;
    const flipRows = (fr?.items ?? []).filter((it) => it.topFlips.length > 0).slice(0, 10);
    if (flipRows.length === 0) {
      rpt.noteBox('Tidak ada item dengan pola plus minus antar periode pada scope ini.');
    } else {
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          // REFINE-2 ("section yang belum punya satuan tambahain"): the QTY
          // Deviasi / Net columns are satuan-denominated.
          { header: 'Satuan' },
          { header: 'Periode 1' },
          { header: 'QTY Deviasi P1', align: 'right' },
          { header: 'Periode 2' },
          { header: 'QTY Deviasi P2', align: 'right' },
          { header: 'Net', align: 'right' },
        ],
        rows: flipRows.map((it, i) => {
          const fp = it.topFlips[0];
          return [String(i + 1), it.itemName, it.satuan ?? '\u2014', fp.period1Label, fmtNum(fp.qtyP1), fp.period2Label, fmtNum(fp.qtyP2), fmtNum(fp.net)];
        }),
        // Plus/minus coloring on the two QTY columns — the visual point of
        // the section: green = plus (surplus side), red = minus (loss side).
        cellColor: (_row, ri, ci) => {
          if (ci !== 4 && ci !== 6) return undefined;
          const fp = flipRows[ri]?.topFlips[0];
          if (fp == null) return undefined;
          const v = ci === 4 ? fp.qtyP1 : fp.qtyP2;
          return v < 0 ? C.danger : v > 0 ? C.success : undefined;
        },
      });
    }
  }
}
