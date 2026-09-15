// ============================================================
//  pdf-charts — vector chart primitives for the export PDF
//  --------------------------------------------------------
//  EXPORT-PDF: every chart is drawn with raw PDF vector primitives
//  (rects / lines / circles) — no rasterization, no external chart
//  library, crisp at any zoom. All functions take an explicit rect
//  (x, y, w, h) and NEVER paginate — the caller Rpt.ensure()s the
//  full height first.
//
//  Charts:
//    barChartV        — vertical bars + value labels + y grid. DIVERGING:
//                      negative values grow DOWN from the zero baseline
//                      (BUG-HUNT — was silently clamped to the 0..maxV
//                      scale, mismatching the signed table next to it)
//    hBarChart        — horizontal bars, per-bar color, highlight index
//    stackedBarChartV — stacked vertical bars (composition) + legend
//                      (REFINE-3: Waste/Susut/Trial/Loss-Surplus per week)
//    lineChart        — multi-series lines + dots + legend + y grid
//
//  EXPORT-TRIM: paretoChart / stackedHBar / donutChart / sparkbars /
//  flipPairBars were removed together with their report sections
//  (pareto / peer / breakdown / itemTrend-row mode / flip).
//
//  FIX-TERPOTONG (user request: "jangan sampai ada yang terpotong"):
//    tinyText no longer truncates over-wide labels to an ellipsis —
//    it SHRINKS the font size stepwise to fit (same policy as
//    Rpt.text's `fit`). tinyText also renders the MK_UP/MK_DN ▲/▼
//    change markers (see pdf-primitives) so bar-chart value labels
//    can carry increase/decrease marks.
// ============================================================
import type PDFKit from 'pdfkit';
import { C, sanitizePdfText, takeMark, markerExtra, drawTri, wrapLines } from './pdf-primitives';

// ------------------------------------------------------------
//  Shared helpers
// ------------------------------------------------------------

/** Format a y-axis tick compactly (caller chooses precision). */
export type FmtFn = (v: number) => string;

/** Round max up to a "nice" 1/2/2.5/5 × 10^n ceiling (axis origin 0). */
export function niceMax(v: number): number {
  if (!isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * base) return m * base;
  }
  return 10 * base;
}

function tinyText(
  doc: PDFKit.PDFDocument,
  t: string,
  x: number,
  y: number,
  opts: { size?: number; color?: string; bold?: boolean; align?: 'left' | 'right' | 'center'; maxW?: number } = {},
): void {
  const { size = 6, color = C.muted, bold = false, align = 'left', maxW } = opts;
  const font = bold ? 'Helvetica-Bold' : 'Helvetica';
  const [s, mk] = takeMark(String(t ?? ''));
  const body = sanitizePdfText(s);
  doc.font(font);
  let fs = size;
  if (maxW != null) {
    // FIX-TERPOTONG: shrink-to-fit instead of ellipsize — never cut off.
    const avail = maxW - (mk ? markerExtra(fs) : 0);
    while (fs > 3.6 && doc.fontSize(fs).widthOfString(body) > avail) {
      fs = Math.round((fs - 0.1) * 100) / 100;
    }
  }
  doc.fontSize(fs).fillColor(color);
  const w = doc.widthOfString(body);
  let tx = x;
  if (align === 'right') tx = x - w;
  if (align === 'center') tx = x - w / 2;
  if (mk) {
    const mh = Math.max(3, fs * 0.52);
    const mw = mh * 1.15;
    const cy = y + fs * 0.62 + 0.8;
    if (align === 'left') {
      drawTri(doc, tx, cy, mw, mh, mk === 1, color);
      tx += mw + 1.2;
    } else {
      drawTri(doc, tx - mw - 1.2, cy, mw, mh, mk === 1, color);
    }
    doc.font(font).fontSize(fs).fillColor(color);
  }
  doc.text(body, tx, y, { lineBreak: false });
}

/** FIX-TERPOTONG (hBarChart labels): wrap a label onto up to `maxLines`
 *  lines at a READABLE size instead of shrinking a single line into
 *  illegibility. Finds the largest font size (≤ size, ≥ 4.4pt) whose
 *  greedy word-wrap fits maxLines lines; every wrapped line is guaranteed
 *  to fit maxW except a single unbreakable word (drawn anyway — never
 *  dropped, never ellipsized). */
function tinyLines(
  doc: PDFKit.PDFDocument,
  t: string,
  x: number,
  y: number,
  opts: { size?: number; color?: string; bold?: boolean; align?: 'left' | 'right'; maxW?: number; maxLines?: number } = {},
): void {
  const { size = 6.5, color = C.inkSoft, bold = false, align = 'right', maxW, maxLines = 2 } = opts;
  if (maxW == null) { tinyText(doc, t, x, y, { size, color, bold, align }); return; }
  const font = bold ? 'Helvetica-Bold' : 'Helvetica';
  const body = sanitizePdfText(String(t ?? ''));
  doc.font(font);
  let fs = size;
  let lines = wrapLines(doc, body, font, fs, maxW);
  while (fs > 4.4 && (lines.length > maxLines || lines.some((ln) => doc.fontSize(fs).widthOfString(ln) > maxW))) {
    fs = Math.round((fs - 0.2) * 100) / 100;
    lines = wrapLines(doc, body, font, fs, maxW);
  }
  // vertical layout: center the line block on the bar track (rowH 18)
  const lineH = fs * 1.18;
  let ly = y + (18 - lines.length * lineH) / 2 + 0.6;
  doc.fontSize(fs).fillColor(color);
  for (const ln of lines) {
    const w = doc.widthOfString(ln);
    const tx = align === 'right' ? x - w : x;
    doc.text(ln, tx, ly, { lineBreak: false });
    ly += lineH;
  }
}

/** Horizontal grid lines + right-aligned tick labels. Returns the plot rect. */
function yGrid(
  doc: PDFKit.PDFDocument,
  px: number, py: number, pw: number, ph: number,
  maxV: number, ticks: number, fmt: FmtFn,
): void {
  doc.lineWidth(0.5);
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV / ticks) * i;
    const gy = py + ph - (ph / ticks) * i;
    doc.strokeColor(i === 0 ? C.border : C.borderSoft)
      .moveTo(px, gy).lineTo(px + pw, gy).stroke();
    tinyText(doc, fmt(v), px - 4, gy - 3, { align: 'right', size: 5.8, color: C.faint });
  }
}

// ------------------------------------------------------------
//  Vertical bar chart
// ------------------------------------------------------------
export function barChartV(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    labels: string[];
    values: number[];
    fmt: FmtFn;
    colors?: string[];
    /** Highlight the last bar (current period) — default true. */
    highlightLast?: boolean;
    barColor?: string;
  },
): void {
  const { x, y, w, h, labels, values, fmt } = o;
  const padL = 38, padB = 20, padT = 14;
  const px = x + padL, py = y + padT, pw = w - padL - 4, ph = h - padT - padB;
  // BUG-HUNT (signed-vs-ABS mismatch): the old 0..maxV scale clamped
  // negative values away — the "Nominal Deviasi per Periode" chart drew an
  // UP bar for a net-negative (LOSS-side) period while its own table row
  // showed "-Rp …". With any negative value the axis now spans a nice
  // negative floor and bars grow DOWN from the zero baseline (danger red);
  // all-positive inputs render EXACTLY as before (same yGrid + scale).
  const hasNeg = values.some((v) => v < 0);
  const maxV = niceMax(Math.max(...values, 0));
  const minV = hasNeg ? -niceMax(-Math.min(...values, 0)) : 0;
  const span = maxV - minV || 1;
  const zeroY = py + ph - ((0 - minV) / span) * ph;
  if (hasNeg) {
    // nice-step ticks across [minV, maxV]; the zero baseline is stroked
    // exactly + darker (the anchor the eye follows).
    // BUG-HUNT (found while verifying this chart): the first draft's
    // `±1e-9` absolute epsilon was at the WRONG SCALE for IDR values —
    // the ulp of 2e7 is ≈3.7e-9, so `maxV - 1e-9` rounded back to maxV
    // and the top tick only rendered by fp luck. Iterate integer steps
    // with a STEP-RELATIVE tolerance instead (k*step is exact fp).
    const rawStep = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? 10 * mag;
    doc.lineWidth(0.5);
    const kStart = Math.ceil(minV / step - 1e-9);
    const kEnd = Math.floor(maxV / step + 1e-9);
    for (let k = kStart; k <= kEnd; k++) {
      const v = k * step;
      const gy = py + ph - ((v - minV) / span) * ph;
      doc.strokeColor(k === 0 ? C.border : C.borderSoft)
        .moveTo(px, gy).lineTo(px + pw, gy).stroke();
      tinyText(doc, fmt(v), px - 4, gy - 3, { align: 'right', size: 5.8, color: C.faint });
    }
  } else {
    yGrid(doc, px, py, pw, ph, maxV, 4, fmt);
  }
  const n = values.length;
  const slot = pw / Math.max(1, n);
  const bw = Math.min(30, slot * 0.6);
  values.forEach((v, i) => {
    const bh = Math.max(0, (Math.abs(v) / span) * ph);
    const bx = px + slot * i + (slot - bw) / 2;
    const isLast = i === n - 1;
    // DESAIN-SIMPEL: neutral gray bars, current period darker (no amber).
    // BUG-HUNT: a NEGATIVE bar is the net-LOSS side — danger red (the same
    // red the Loss line uses), so direction is readable without a legend.
    const color = o.colors?.[i] ?? (v < 0 ? C.danger : o.highlightLast === false ? (o.barColor ?? C.bar) : isLast ? C.barCur : C.bar);
    const by = v >= 0 ? zeroY - bh : zeroY;
    doc.fillColor(color).roundedRect(bx, by, bw, bh, 1.5).fill();
    // value label: above the bar top (positive) / just above the zero
    // baseline in the bar's own empty slot airspace (negative — never
    // collides with the x-axis labels below the plot).
    const labY = v >= 0 ? zeroY - bh - 8 : zeroY - 8;
    tinyText(doc, fmt(v), bx + bw / 2, labY, { align: 'center', size: 5.6, color: C.inkSoft, bold: isLast, maxW: slot });
    tinyText(doc, labels[i] ?? '', bx + bw / 2, py + ph + 5, { align: 'center', size: 5.8, color: isLast ? C.ink : C.muted, bold: isLast, maxW: slot });
  });
}

// ------------------------------------------------------------
//  Horizontal bar chart
// ------------------------------------------------------------
export function hBarChart(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    labels: string[];
    values: number[];
    fmt: FmtFn;
    /** Per-bar colors (fallback barColor). */
    colors?: string[];
    barColor?: string;
    /** Show the formatted value at the bar end (default true). */
    showValues?: boolean;
    labelW?: number;
    /** Width reserved for the end-of-bar value labels (default 52). */
    valW?: number;
    boldLabels?: boolean[];
  },
): void {
  const { x, y, w, labels, values, fmt } = o;
  const labelW = o.labelW ?? 118;
  const valW = o.valW ?? 52;
  const px = x + labelW, pw = w - labelW - valW - 8;
  const rowH = 18;
  const maxV = Math.max(...values.map(Math.abs), 0) || 1;
  labels.forEach((lb, i) => {
    const by = y + rowH * i;
    const v = values[i];
    const bw = (Math.abs(v) / maxV) * pw;
    const color = o.colors?.[i] ?? o.barColor ?? C.bar;
    // FIX (LABEL-ANCHOR — the REAL "masih terpotong"): row labels are
    // right-anchored at the BAR START (px - 2), NOT at the page's left
    // margin (x - 2). The old anchor made every right-aligned label
    // extend LEFT from x≈40 and clip off-page whenever it was wider than
    // 40pt — exactly the cut-off item names in the user's screenshot.
    // FIX-TERPOTONG: label wraps onto ≤2 lines at a readable size.
    tinyLines(doc, lb, px - 2, by, { align: 'right', size: 6.5, color: o.boldLabels?.[i] ? C.ink : C.inkSoft, bold: o.boldLabels?.[i], maxW: labelW - 6 });
    // track
    doc.fillColor(C.borderSoft).roundedRect(px, by + 3, pw, 9, 2.5).fill();
    doc.fillColor(color).roundedRect(px, by + 3, Math.max(2, bw), 9, 2.5).fill();
    if (o.showValues !== false) {
      tinyText(doc, fmt(v), x + w - 2, by + 3.5, { align: 'right', size: 6.2, color: C.ink, maxW: valW });
    }
  });
}

// ------------------------------------------------------------
//  Stacked vertical bar chart — composition
//  REFINE-3 (user request: "Grafik komposisi Waste/Susut/Trial/
//  Loss-Surplus"): series stack bottom-up in array order; the label
//  above each bar is the stack TOTAL (not the top segment).
// ------------------------------------------------------------
export function stackedBarChartV(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    labels: string[];
    /** series[i].values[j] — the j-th bar's i-th segment. */
    series: Array<{ name: string; values: number[]; color: string }>;
    fmt: FmtFn;
  },
): void {
  const { x, y, w, h, labels, series, fmt } = o;
  const padL = 38, padB = 20, padT = 14;
  const px = x + padL, py = y + padT, pw = w - padL - 4, ph = h - padT - padB;
  const totals = labels.map((_, j) => series.reduce((s, sr) => s + Math.max(0, sr.values[j] ?? 0), 0));
  const maxV = niceMax(Math.max(...totals, 0));
  yGrid(doc, px, py, pw, ph, maxV, 4, fmt);
  const n = labels.length;
  const slot = pw / Math.max(1, n);
  const bw = Math.min(34, slot * 0.6);
  labels.forEach((lb, j) => {
    const bx = px + slot * j + (slot - bw) / 2;
    let acc = 0;
    series.forEach((sr) => {
      const v = Math.max(0, sr.values[j] ?? 0);
      const segH = (v / maxV) * ph;
      if (segH > 0) doc.fillColor(sr.color).rect(bx, py + ph - acc - segH, bw, segH).fill();
      acc += segH;
    });
    // total label above the stack (marker-aware via tinyText)
    tinyText(doc, fmt(totals[j]), bx + bw / 2, py + ph - (totals[j] / maxV) * ph - 8, { align: 'center', size: 5.6, color: C.inkSoft, maxW: slot });
    tinyText(doc, lb, bx + bw / 2, py + ph + 5, { align: 'center', size: 5.8, color: C.muted, maxW: slot });
  });
  // legend: top-right, small color square + name (lineChart convention)
  if (series.length > 1) {
    let lx = x + w;
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      doc.font('Helvetica').fontSize(6);
      lx -= doc.widthOfString(sanitizePdfText(s.name));
      tinyText(doc, s.name, lx, y + 1, { size: 6, color: C.inkSoft });
      lx -= 13;
      doc.fillColor(s.color).rect(lx, y + 1.5, 8, 4.5).fill();
      lx -= 4;
    }
  }
}

// ------------------------------------------------------------
//  Multi-series line chart
// ------------------------------------------------------------
export function lineChart(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    xLabels: string[];
    series: Array<{ name: string; values: number[]; color: string }>;
    yFmt: FmtFn;
    /** Override the y max (default niceMax of all series). */
    yMax?: number;
    /** Legend position (default top-right). */
    legend?: 'top' | 'none';
  },
): void {
  const { x, y, w, xLabels, series, yFmt } = o;
  const padL = 40, padB = 18, padT = 14, padR = 10;
  const PX = x + padL, PY = y + padT, PW = w - padL - padR, PH = o.h - padT - padB;
  const allVals = series.flatMap((s) => s.values);
  const maxV = o.yMax ?? niceMax(Math.max(...allVals, 0));
  yGrid(doc, PX, PY, PW, PH, maxV, 4, yFmt);
  const n = xLabels.length;
  const stepX = n > 1 ? PW / (n - 1) : 0;
  series.forEach((s) => {
    doc.lineWidth(1.6).strokeColor(s.color);
    s.values.forEach((v, i) => {
      const cx = PX + stepX * i;
      const cy = PY + PH - (Math.max(0, v) / maxV) * PH;
      if (i === 0) doc.moveTo(cx, cy);
      else doc.lineTo(cx, cy);
    });
    doc.stroke();
    s.values.forEach((v, i) => {
      const cx = PX + stepX * i;
      const cy = PY + PH - (Math.max(0, v) / maxV) * PH;
      doc.fillColor(s.color).circle(cx, cy, 2).fill();
    });
  });
  xLabels.forEach((lb, i) => {
    const isLast = i === n - 1;
    tinyText(doc, lb, PX + stepX * i, PY + PH + 5, { align: 'center', size: 5.8, color: isLast ? C.ink : C.muted, bold: isLast, maxW: 46 });
  });
  if (o.legend !== 'none' && series.length > 1) {
    // legend: top-right, small color dash + name
    let lx = x + w;
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      doc.font('Helvetica').fontSize(6);
      const tw = doc.widthOfString(sanitizePdfText(s.name));
      lx -= tw;
      tinyText(doc, s.name, lx, y + 1, { size: 6, color: C.inkSoft });
      lx -= 12;
      doc.lineWidth(2.5).strokeColor(s.color).moveTo(lx, y + 3.5).lineTo(lx + 8, y + 3.5).stroke();
      lx -= 8;
    }
  }
}
