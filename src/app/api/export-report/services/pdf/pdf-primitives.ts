// ============================================================
//  pdf-primitives — low-level layout engine for the export PDF
//  --------------------------------------------------------
//  EXPORT-PDF: the report output switched from .docx (docx-builder.ts,
//  deleted) to .pdf. This module owns everything generic about laying
//  out the report:
//    - PAGE geometry (A4 + margins + content bounds)
//    - C — the report color palette (charcoal ink + amber accent family;
//      deliberately NO blue/indigo, matching the app's amber accent)
//    - sanitizePdfText — WinAnsi-safe text (standard-font PDFs cannot
//      encode arbitrary Unicode; also strips control chars — the same
//      class of bug as the PG 22021 NUL sentinel incident)
//    - truncateToWidth — deterministic single-line cell truncation
//    - Rpt — cursor-based layout wrapper around PDFDocument:
//        ensure()/newPage() pagination, sectionHeader(), subhead(),
//        para(), noteBox(), chip(), kpiCards(), table() with header
//        repetition across page breaks
//
//  Design rules (kept strict so every section looks consistent):
//    - the cursor `y` is the ONLY vertical state; every draw call takes
//      explicit rects — no pdfkit auto-flow (doc.text with x/y + width)
//    - tables are fixed-layout (explicit column widths) + single-line
//      cells (truncateToWidth) → deterministic heights, no reflow
//    - fonts are ONLY the 14 standard PDF fonts (Helvetica family) —
//      zero external font files → works in any Node/bun runtime
// ============================================================
import type PDFKit from 'pdfkit';

// ------------------------------------------------------------
//  Page geometry (A4 portrait, pt)
// ------------------------------------------------------------
export const PAGE = {
  W: 595.28,
  H: 841.89,
  M: 42,          // left/right margin
  TOP: 100,       // content top (below the running header band)
  BOTTOM: 60,     // content bottom (above the footer line)
};
export const CONTENT_W = PAGE.W - PAGE.M * 2; // 511.28pt

// ------------------------------------------------------------
//  Color palette — charcoal ink + amber accent (no blue/indigo)
// ------------------------------------------------------------
export const C = {
  ink: '#111827',
  inkSoft: '#374151',
  muted: '#6B7280',
  faint: '#9CA3AF',
  accent: '#D97706',
  accentDark: '#92400E',
  accentLight: '#FEF3C7',
  accentFaint: '#FFFBEB',
  danger: '#DC2626',
  dangerDark: '#991B1B',
  dangerLight: '#FEE2E2',
  success: '#059669',
  successDark: '#065F46',
  successLight: '#D1FAE5',
  border: '#E5E7EB',
  borderSoft: '#F3F4F6',
  zebra: '#F8FAFC',
  headerBg: '#111827',
  cardBg: '#FAFAF9',
  white: '#FFFFFF',
} as const;

// ------------------------------------------------------------
//  Text sanitization — WinAnsi-safe output for standard fonts
// ------------------------------------------------------------
// Standard-font PDFs encode text with WinAnsiEncoding: Latin-1 (U+0000–
// U+00FF) plus a fixed set of punctuation extras. Anything else (CJK,
// emoji, …) silently renders as NOTHING in pdfkit — and control chars
// (NUL in particular) corrupt the content stream. Map every
// non-encodable char to '?' and strip control chars entirely.
const WINANSI_EXTRA = new Set(
  '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178'.split(''),
);

export function sanitizePdfText(input: unknown): string {
  if (input == null) return '';
  const s = String(input);
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20) continue; // strip ALL control chars (incl. NUL)
    if (cp === 0x7F) continue;
    if (cp <= 0xff || WINANSI_EXTRA.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

// ------------------------------------------------------------
//  Measuring + truncation (fixed-layout tables need deterministic
//  single-line cells)
// ------------------------------------------------------------
export function widthOf(doc: PDFKit.PDFDocument, text: string, font: string, size: number): number {
  doc.font(font).fontSize(size);
  return doc.widthOfString(sanitizePdfText(text));
}

/** Truncate `text` to `maxW` with an ellipsis (WinAnsi U+2026). */
export function truncateToWidth(doc: PDFKit.PDFDocument, text: string, font: string, size: number, maxW: number): string {
  const t = sanitizePdfText(text);
  if (widthOf(doc, t, font, size) <= maxW) return t;
  let s = t;
  while (s.length > 1 && widthOf(doc, `${s}\u2026`, font, size) > maxW) {
    s = s.slice(0, -1);
  }
  return `${s}\u2026`;
}

// ------------------------------------------------------------
//  Table renderer
// ------------------------------------------------------------
export interface TCol {
  header: string;
  /** Fixed column width (pt). Caller guarantees Σw ≤ CONTENT_W. */
  w: number;
  align?: 'left' | 'right' | 'center';
}

/** A table row: pre-formatted strings, one cell per column. */
export type TRow = string[];

export interface TableOpts {
  cols: TCol[];
  rows: TRow[];
  /** Body font size (default 7.5). */
  fontSize?: number;
  /** Header background (default C.headerBg). */
  headerFill?: string;
  /** Zebra stripe even rows (default true). */
  zebra?: boolean;
  /** Per-row text color override (e.g. red for a negative total row). */
  rowText?: (row: TRow, i: number) => string | undefined;
  /** Per-cell background override (wins over zebra; e.g. heat cells). */
  cellFill?: (row: TRow, i: number) => string | undefined;
  /** Bold the first column (default false). */
  boldFirst?: boolean;
  /** Per-row bold (e.g. TOTAL row). */
  rowBold?: (row: TRow, i: number) => boolean;
  /** Row height override (default derived from fontSize). */
  rowH?: number;
  /** Rows to keep together with the header before the first break (default 2). */
  minRowsFirstPage?: number;
}

// ------------------------------------------------------------
//  KPI card spec
// ------------------------------------------------------------
export interface KpiCard {
  label: string;
  value: string;
  /** Optional third line (usually the growth/delta, colored). */
  sub?: string;
  subColor?: string;
  /** Card accent — thin top bar color (default C.accent). */
  accent?: string;
}

// ============================================================
//  Rpt — cursor-based report layout
// ============================================================
export class Rpt {
  readonly doc: PDFKit.PDFDocument;
  /** Vertical cursor (top of the next block). */
  y: number;

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc;
    this.y = PAGE.TOP;
  }

  // ----------------------------------------------------------
  //  Pagination
  // ----------------------------------------------------------
  /** Add a page when the remaining space < h. */
  ensure(h: number): void {
    if (this.y + h > PAGE.H - PAGE.BOTTOM) this.newPage();
  }

  newPage(): void {
    this.doc.addPage();
    this.y = PAGE.TOP;
  }

  gap(px: number): void {
    this.y += px;
  }

  // ----------------------------------------------------------
  //  Typography
  // ----------------------------------------------------------
  /** Draw a single line at an explicit position (no auto-flow). */
  text(
    t: string,
    x: number,
    y: number,
    opts: {
      font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center';
      width?: number; ellipsize?: boolean;
    } = {},
  ): void {
    const { font = 'Helvetica', size = 9, color = C.ink, align = 'left', width, ellipsize = false } = opts;
    let s = sanitizePdfText(t);
    if (ellipsize && width != null) s = truncateToWidth(this.doc, s, font, size, width);
    this.doc.font(font).fontSize(size).fillColor(color);
    const w = width ?? this.doc.widthOfString(s);
    let tx = x;
    if (align === 'right') tx = x + w - this.doc.widthOfString(s);
    if (align === 'center') tx = x + (w - this.doc.widthOfString(s)) / 2;
    // lineBreak:false keeps pdfkit from wrapping mid-call; the explicit
    // x/y (not doc.x/doc.y) makes this position-stable.
    this.doc.text(s, tx, y, { lineBreak: false, width: this.doc.widthOfString(s) + 2 });
  }

  /** Wrapped paragraph starting at the cursor, full content width. */
  para(
    t: string,
    opts: { size?: number; color?: string; bold?: boolean; x?: number; width?: number; gapAfter?: number } = {},
  ): void {
    const { size = 8.5, color = C.inkSoft, bold = false, x = PAGE.M, width = CONTENT_W, gapAfter = 4 } = opts;
    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    const s = sanitizePdfText(t);
    this.doc.font(font).fontSize(size).fillColor(color);
    const h = this.doc.heightOfString(s, { width });
    this.ensure(h + gapAfter);
    this.doc.text(s, x, this.y, { width });
    this.y += h + gapAfter;
  }

  /** Numbered section header: amber chip + title + rule. */
  sectionHeader(no: number, title: string, subtitle?: string): void {
    this.ensure(58);
    const top = this.y;
    // amber number chip
    this.doc.fillColor(C.accent).roundedRect(PAGE.M, top, 22, 22, 5).fill();
    this.text(String(no).padStart(2, '0'), PAGE.M, top + 6.5, { font: 'Helvetica-Bold', size: 10, color: C.white, align: 'center', width: 22 });
    // title
    this.text(title, PAGE.M + 30, top + 1, { font: 'Helvetica-Bold', size: 13, color: C.ink });
    let y2 = top + 17;
    if (subtitle) {
      this.text(subtitle, PAGE.M + 30, top + 18, { size: 7.5, color: C.muted });
      y2 = top + 29;
    }
    // rule
    this.doc.moveTo(PAGE.M, y2 + 4).lineTo(PAGE.W - PAGE.M, y2 + 4).lineWidth(1.2).strokeColor(C.accent).stroke();
    this.y = y2 + 12;
  }

  /** Small bold sub-heading (e.g. "6.1 Top Nominal"). */
  subhead(t: string, opts: { color?: string; size?: number; gapAfter?: number } = {}): void {
    const { color = C.ink, size = 9.5, gapAfter = 4 } = opts;
    this.ensure(size + 6 + gapAfter);
    this.text(t, PAGE.M, this.y, { font: 'Helvetica-Bold', size, color });
    this.y += size + 4 + gapAfter;
  }

  /** Light amber fact/note box (single wrapped paragraph). */
  noteBox(t: string, opts: { fill?: string; border?: string; color?: string } = {}): void {
    const { fill = C.accentFaint, border = C.accentLight, color = C.accentDark } = opts;
    const s = sanitizePdfText(t);
    this.doc.font('Helvetica').fontSize(8);
    const h = this.doc.heightOfString(s, { width: CONTENT_W - 20 });
    const boxH = h + 14;
    this.ensure(boxH + 6);
    this.doc.fillColor(fill).roundedRect(PAGE.M, this.y, CONTENT_W, boxH, 5).fill();
    this.doc.lineWidth(0.8).strokeColor(border).roundedRect(PAGE.M, this.y, CONTENT_W, boxH, 5).stroke();
    this.doc.fillColor(color).text(s, PAGE.M + 10, this.y + 7, { width: CONTENT_W - 20 });
    this.y += boxH + 6;
  }

  /** Small rounded badge (chip). Returns the drawn width. */
  chip(t: string, x: number, y: number, fill: string, color: string, opts: { size?: number } = {}): number {
    const { size = 6.5 } = opts;
    const s = sanitizePdfText(t);
    this.doc.font('Helvetica-Bold').fontSize(size);
    const tw = this.doc.widthOfString(s);
    const w = tw + 10;
    this.doc.fillColor(fill).roundedRect(x, y, w, size + 5.5, 3).fill();
    this.text(s, x, y + 2.4, { font: 'Helvetica-Bold', size, color, align: 'center', width: w });
    return w;
  }

  // ----------------------------------------------------------
  //  KPI cards — up to 3 per row
  // ----------------------------------------------------------
  /** Grid of rounded KPI cards. Returns the number of rows drawn. */
  kpiCards(cards: KpiCard[]): number {
    const perRow = 3;
    const gap = 8;
    const cardW = (CONTENT_W - gap * (perRow - 1)) / perRow;
    const cardH = 54;
    let rows = 0;
    for (let i = 0; i < cards.length; i += perRow) {
      const rowCards = cards.slice(i, i + perRow);
      this.ensure(cardH + gap);
      const top = this.y;
      rowCards.forEach((c, j) => {
        const x = PAGE.M + j * (cardW + gap);
        this.doc.fillColor(C.white).roundedRect(x, top, cardW, cardH, 7).fill();
        this.doc.lineWidth(0.8).strokeColor(C.border).roundedRect(x, top, cardW, cardH, 7).stroke();
        // accent top bar
        this.doc.fillColor(c.accent ?? C.accent).roundedRect(x, top, cardW, 3.2, 1.6).fill();
        this.text(c.label.toUpperCase(), x + 9, top + 10, { size: 6, color: C.muted, ellipsize: true, width: cardW - 18 });
        this.text(c.value, x + 9, top + 21, { font: 'Helvetica-Bold', size: 13.5, color: C.ink, ellipsize: true, width: cardW - 18 });
        if (c.sub != null) {
          this.text(c.sub, x + 9, top + 39, { size: 6.8, color: c.subColor ?? C.muted, ellipsize: true, width: cardW - 18 });
        }
      });
      this.y += cardH + gap;
      rows += 1;
    }
    return rows;
  }

  // ----------------------------------------------------------
  //  Table with header repetition across page breaks
  // ----------------------------------------------------------
  table(opts: TableOpts): void {
    const {
      cols, rows,
      fontSize = 7.5,
      headerFill = C.headerBg,
      zebra = true,
      rowText, cellFill, boldFirst = false, rowBold,
      rowH = Math.ceil(fontSize * 1.9) + 4,
      minRowsFirstPage = 2,
    } = opts;
    const totalW = cols.reduce((s, c) => s + c.w, 0);
    const headerH = rowH + 3;
    const drawHeader = (): void => {
      this.doc.fillColor(headerFill).rect(PAGE.M, this.y, totalW, headerH).fill();
      let hx = PAGE.M;
      cols.forEach((c) => {
        this.text(c.header.toUpperCase(), hx + 4, this.y + 4, {
          font: 'Helvetica-Bold', size: fontSize - 0.5, color: C.white,
          align: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left',
          width: c.w - 8, ellipsize: true,
        });
        hx += c.w;
      });
      this.y += headerH;
    };

    this.ensure(headerH + rowH * minRowsFirstPage);
    drawHeader();

    rows.forEach((row, i) => {
      if (this.y + rowH > PAGE.H - PAGE.BOTTOM) {
        this.newPage();
        drawHeader();
      }
      const fill = rowText?.(row, i);
      const bold = rowBold?.(row, i) ?? false;
      if (zebra && i % 2 === 1) {
        this.doc.fillColor(C.zebra).rect(PAGE.M, this.y, totalW, rowH).fill();
      }
      let x = PAGE.M;
      cols.forEach((c, ci) => {
        const cellBg = cellFill?.(row, ci);
        if (cellBg) this.doc.fillColor(cellBg).rect(x, this.y, c.w, rowH).fill();
        const isBold = bold || (boldFirst && ci === 0);
        this.text(row[ci] ?? '', x + 4, this.y + (rowH - fontSize - 3.4) / 2, {
          font: isBold ? 'Helvetica-Bold' : 'Helvetica',
          size: fontSize,
          color: ci === 0 ? C.ink : fill ?? C.inkSoft,
          align: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left',
          width: c.w - 8, ellipsize: true,
        });
        x += c.w;
      });
      // bottom border
      this.doc.moveTo(PAGE.M, this.y + rowH).lineTo(PAGE.M + totalW, this.y + rowH)
        .lineWidth(0.5).strokeColor(C.borderSoft).stroke();
      this.y += rowH;
    });
    this.y += 6;
  }

  // ----------------------------------------------------------
  //  Cover header band (page 1 only)
  // ----------------------------------------------------------
  /** Full-width dark band with the report title. Height fixed 92pt. */
  coverBand(title: string, subtitle: string, rightLines: string[]): void {
    const top = 36;
    const h = 92;
    this.doc.fillColor(C.ink).roundedRect(PAGE.M, top, CONTENT_W, h, 10).fill();
    // amber left accent
    this.doc.fillColor(C.accent).roundedRect(PAGE.M, top, 5, h, 2.5).fill();
    this.text(title, PAGE.M + 18, top + 16, { font: 'Helvetica-Bold', size: 19, color: C.white });
    this.text(subtitle, PAGE.M + 18, top + 44, { font: 'Helvetica-Bold', size: 11.5, color: C.accent });
    // right-aligned meta lines
    rightLines.forEach((ln, i) => {
      this.text(ln, PAGE.M + CONTENT_W - 190, top + 16 + i * 12, {
        size: 7, color: i === 0 ? C.faint : '#D1D5DB', align: 'right', width: 172, ellipsize: true,
      });
    });
    this.y = top + h + 10;
  }

  /** Thin running header for pages ≥ 2 (drawn post-hoc via switchToPage). */
  static runningHeader(doc: PDFKit.PDFDocument, label: string): void {
    doc.fillColor(C.ink).rect(0, 0, PAGE.W, 26).fill();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.white);
    doc.text(sanitizePdfText(label), PAGE.M, 9, { lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor('#9CA3AF');
    const t = 'Inventory Control';
    doc.text(t, PAGE.W - PAGE.M - doc.widthOfString(t), 10, { lineBreak: false });
    // amber baseline
    doc.moveTo(0, 26).lineTo(PAGE.W, 26).lineWidth(1.5).strokeColor(C.accent).stroke();
  }

  /** Footer line (drawn post-hoc on every page via switchToPage). */
  static footer(doc: PDFKit.PDFDocument, pageIdx: number, pageCount: number, label: string): void {
    const y = PAGE.H - 42;
    doc.moveTo(PAGE.M, y).lineTo(PAGE.W - PAGE.M, y).lineWidth(0.7).strokeColor(C.border).stroke();
    doc.font('Helvetica').fontSize(6.8).fillColor(C.muted);
    doc.text(sanitizePdfText(label), PAGE.M, y + 5, { lineBreak: false });
    const mid = `Halaman ${pageIdx + 1} dari ${pageCount}`;
    doc.text(mid, (PAGE.W - doc.widthOfString(mid)) / 2, y + 5, { lineBreak: false });
    const r = sanitizePdfText('Laporan Audit Inventory');
    doc.text(r, PAGE.W - PAGE.M - doc.widthOfString(r), y + 5, { lineBreak: false });
  }
}
