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
//    paretoChart    — bars + cumulative-% line (right axis) + 80% marker
//    stackedHBar    — two-segment (loss/surplus) horizontal bars
//    donutChart     — ring segments (polygon approximation)
//    sparkbars      — tiny axis-less bars (trend matrix rows)
//    flipPairBars   — opposing signed bars around a center axis
// ============================================================
import type PDFKit from 'pdfkit';
import { C, sanitizePdfText, truncateToWidth } from './pdf-primitives';

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
  let s = sanitizePdfText(t);
  if (maxW != null) s = truncateToWidth(doc, s, bold ? 'Helvetica-Bold' : 'Helvetica', size, maxW);
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const w = doc.widthOfString(s);
  let tx = x;
  if (align === 'right') tx = x - w;
  if (align === 'center') tx = x - w / 2;
  doc.text(s, tx, y, { lineBreak: false });
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

// ------------------------------------------------------------
//  Pareto chart — bars + cumulative % line + 80% marker
// ------------------------------------------------------------
export function paretoChart(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    labels: string[];
    values: number[];
    cumPcts: number[]; // 0..100
    fmt: FmtFn;
  },
): void {
  const { x, y, w, labels, values, cumPcts, fmt } = o;
  const padL = 40, padB = 26, padT = 14, padR = 34;
  const PX = x + padL, PY = y + padT, PW = w - padL - padR, PH = o.h - padT - padB;
  const maxV = niceMax(Math.max(...values, 0));
  yGrid(doc, PX, PY, PW, PH, maxV, 4, fmt);
  // right axis (cum %) ticks 0/50/100
  [0, 50, 100].forEach((p) => {
    const gy = PY + PH - (PH / 100) * p;
    tinyText(doc, `${p}%`, PX + PW + 6, gy - 3, { size: 5.6, color: C.faint });
  });
  const n = values.length;
  const slot = PW / Math.max(1, n);
  const bw = Math.min(24, slot * 0.62);
  values.forEach((v, i) => {
    const bh = (v / maxV) * PH;
    const bx = PX + slot * i + (slot - bw) / 2;
    doc.fillColor(i === 0 ? C.danger : '#F59E0B').roundedRect(bx, PY + PH - bh, bw, bh, 1.5).fill();
    tinyText(doc, labels[i] ?? '', bx + bw / 2, PY + PH + 5, { align: 'center', size: 5.4, color: C.muted, maxW: slot + 4 });
    tinyText(doc, `${(cumPcts[i] ?? 0).toFixed(0)}%`, bx + bw / 2, PY + PH - bh - 8, { align: 'center', size: 5.4, color: C.inkSoft, bold: true, maxW: slot + 4 });
  });
  // 80% dashed marker + cumulative line
  const y80 = PY + PH - (PH / 100) * 80;
  doc.save().dash(3, { space: 2 }).lineWidth(0.8).strokeColor(C.faint).moveTo(PX, y80).lineTo(PX + PW, y80).stroke().restore();
  tinyText(doc, '80%', PX - 4, y80 - 3, { align: 'right', size: 5.6, color: C.faint, bold: true });
  doc.lineWidth(1.6).strokeColor(C.successDark);
  const stepX = n > 1 ? PW / (n - 1) : 0;
  cumPcts.forEach((p, i) => {
    const cx = PX + stepX * i;
    const cy = PY + PH - (PH / 100) * Math.min(100, Math.max(0, p));
    if (i === 0) doc.moveTo(cx, cy);
    else doc.lineTo(cx, cy);
  });
  doc.stroke();
  cumPcts.forEach((p, i) => {
    const cx = PX + stepX * i;
    const cy = PY + PH - (PH / 100) * Math.min(100, Math.max(0, p));
    doc.fillColor(C.successDark).circle(cx, cy, 1.8).fill();
  });
}

// ------------------------------------------------------------
//  Stacked horizontal bar — two segments (loss | surplus)
// ------------------------------------------------------------
export function stackedHBar(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    rows: Array<{ label: string; neg: number; pos: number }>;
    fmt: FmtFn;
    labelW?: number;
    valW?: number;
  },
): void {
  const labelW = o.labelW ?? 108;
  const valW = o.valW ?? 108;
  const rowH = 18;
  const px = o.x + labelW, pw = o.w - labelW - valW - 8;
  const maxTotal = Math.max(...o.rows.map((r) => r.neg + r.pos), 0) || 1;
  o.rows.forEach((r, i) => {
    const by = o.y + rowH * i;
    tinyText(doc, r.label, o.x - 2, by + 3.5, { align: 'right', size: 6.5, color: C.inkSoft, maxW: labelW - 6 });
    doc.fillColor(C.borderSoft).roundedRect(px, by + 3, pw, 9, 2.5).fill();
    let bx = px;
    const segs: Array<[number, string]> = [[r.neg, C.danger], [r.pos, C.success]];
    for (const [v, color] of segs) {
      const bw = (v / maxTotal) * pw;
      if (bw > 0.5) {
        doc.fillColor(color).rect(bx, by + 3, bw, 9).fill();
        bx += bw;
      }
    }
    tinyText(doc, `L ${o.fmt(r.neg)}  ·  S ${o.fmt(r.pos)}`, o.x + o.w - 2, by + 3.5, { align: 'right', size: 6.2, color: C.ink, maxW: valW });
  });
}

// ------------------------------------------------------------
//  Donut chart — ring segments (polygon approximation)
// ------------------------------------------------------------
export function donutChart(
  doc: PDFKit.PDFDocument,
  o: {
    cx: number; cy: number; r: number; thickness: number;
    segments: Array<{ value: number; color: string }>;
    startAngle?: number; // radians, default -PI/2 (12 o'clock)
  },
): void {
  const total = o.segments.reduce((s, g) => s + Math.max(0, g.value), 0);
  if (total <= 0) return;
  const rO = o.r, rI = o.r - o.thickness;
  let a = o.startAngle ?? -Math.PI / 2;
  doc.save();
  for (const seg of o.segments) {
    const sweep = (Math.max(0, seg.value) / total) * Math.PI * 2;
    if (sweep <= 0) continue;
    const aEnd = a + sweep;
    const steps = Math.max(2, Math.ceil(sweep / 0.1));
    // outer arc forward
    for (let i = 0; i <= steps; i++) {
      const t = a + (sweep * i) / steps;
      const xx = o.cx + rO * Math.cos(t);
      const yy = o.cy + rO * Math.sin(t);
      if (i === 0) doc.moveTo(xx, yy);
      else doc.lineTo(xx, yy);
    }
    // inner arc backward
    for (let i = steps; i >= 0; i--) {
      const t = a + (sweep * i) / steps;
      doc.lineTo(o.cx + rI * Math.cos(t), o.cy + rI * Math.sin(t));
    }
    doc.closePath();
    doc.fillColor(seg.color).fill();
    a = aEnd;
  }
  doc.restore();
}

// ------------------------------------------------------------
//  Sparkbars — tiny axis-less bars (trend matrix rows)
// ------------------------------------------------------------
export function sparkbars(
  doc: PDFKit.PDFDocument,
  o: { x: number; y: number; w: number; h: number; values: number[]; color?: string },
): void {
  const { x, y, w, h, values } = o;
  const maxV = Math.max(...values.map(Math.abs), 0) || 1;
  const n = values.length;
  if (n === 0) return;
  const slot = w / n;
  const bw = Math.min(5, slot * 0.55);
  values.forEach((v, i) => {
    const bh = Math.max(0.8, (Math.abs(v) / maxV) * h);
    doc.fillColor(o.color ?? (i === n - 1 ? C.accent : '#FCD34D'))
      .rect(x + slot * i + (slot - bw) / 2, y + h - bh, bw, bh).fill();
  });
}

// ------------------------------------------------------------
//  Flip pair bars — opposing signed bars around a center axis
// ------------------------------------------------------------
export function flipPairBars(
  doc: PDFKit.PDFDocument,
  o: {
    x: number; y: number; w: number; h: number;
    qtyP1: number; qtyP2: number;
  },
): void {
  // two half-height bars sharing one row, center axis at x + w/2
  const cx = o.x + o.w / 2;
  const half = o.w / 2 - 2;
  const maxAbs = Math.max(Math.abs(o.qtyP1), Math.abs(o.qtyP2), 1);
  const drawBar = (v: number, by: number, bh: number): void => {
    const bw = (Math.abs(v) / maxAbs) * half;
    const color = v < 0 ? C.danger : C.success;
    if (v < 0) doc.fillColor(color).rect(cx - bw, by, bw, bh).fill();
    else doc.fillColor(color).rect(cx, by, bw, bh).fill();
  };
  const bh = Math.max(4, (o.h - 6) / 2);
  drawBar(o.qtyP1, o.y + 1, bh);
  drawBar(o.qtyP2, o.y + o.h - bh - 1, bh);
  // center axis
  doc.lineWidth(0.8).strokeColor(C.border).moveTo(cx, o.y).lineTo(cx, o.y + o.h).stroke();
}
