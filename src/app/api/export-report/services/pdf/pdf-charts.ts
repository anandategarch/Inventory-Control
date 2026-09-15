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
//    barChartV      — vertical bars + value labels + y grid
//    hBarChart      — horizontal bars, per-bar color, highlight index
//    lineChart      — multi-series lines + dots + legend + y grid
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
import { C, sanitizePdfText, takeMark, markerExtra, drawTri } from './pdf-primitives';

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
  const maxV = niceMax(Math.max(...values, 0));
  yGrid(doc, px, py, pw, ph, maxV, 4, fmt);
  const n = values.length;
  const slot = pw / Math.max(1, n);
  const bw = Math.min(30, slot * 0.6);
  values.forEach((v, i) => {
    const bh = Math.max(0, (v / maxV) * ph);
    const bx = px + slot * i + (slot - bw) / 2;
    const isLast = i === n - 1;
    const color = o.colors?.[i] ?? (o.highlightLast === false ? (o.barColor ?? C.accent) : isLast ? C.accent : '#F59E0B');
    doc.fillColor(color).roundedRect(bx, py + ph - bh, bw, bh, 1.5).fill();
    tinyText(doc, fmt(v), bx + bw / 2, py + ph - bh - 8, { align: 'center', size: 5.6, color: C.inkSoft, bold: isLast, maxW: slot });
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
    const color = o.colors?.[i] ?? o.barColor ?? C.accent;
    tinyText(doc, lb, x - 2, by + 3.5, { align: 'right', size: 6.5, color: o.boldLabels?.[i] ? C.ink : C.inkSoft, bold: o.boldLabels?.[i], maxW: labelW - 6 });
    // track
    doc.fillColor(C.borderSoft).roundedRect(px, by + 3, pw, 9, 2.5).fill();
    doc.fillColor(color).roundedRect(px, by + 3, Math.max(2, bw), 9, 2.5).fill();
    if (o.showValues !== false) {
      tinyText(doc, fmt(v), x + w - 2, by + 3.5, { align: 'right', size: 6.2, color: C.ink, maxW: valW });
    }
  });
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
