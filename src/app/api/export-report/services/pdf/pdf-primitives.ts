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
//    - MK_UP / MK_DN + markOf() — ▲/▼ change markers. Standard PDF fonts
//      (WinAnsi) cannot encode U+25B2/U+25BC, so a marker is a leading
//      sentinel char (\u0001 / \u0002) that Rpt.text / tinyText detect
//      BEFORE sanitization and render as a small vector triangle in the
//      text color (FIX-TERPOTONG: visible increase/decrease sign on every
//      change column, alongside the existing +/- digits).
//    - drawTri — the vector triangle itself
//    - widthOf / measureW — glyph measurement (measureW is marker-aware)
//    - Rpt — cursor-based layout wrapper around PDFDocument:
//        ensure()/newPage() pagination, sectionHeader(), subhead(),
//        para(), noteBox(), chip(), kpiCards(), table() with header
//        repetition across page breaks
//
//  FIX-TERPOTONG (user request: "jangan sampai ada yang terpotong"):
//    - table() is now an AUTO-FIT engine: column widths are derived from
//      the actual content (natural width per column, longest-word
//      minimum), the caller's `w` acts only as a floor, left-aligned
//      text columns WRAP onto multiple lines (variable row height) and
//      headers may wrap to 2+ lines. Cells are NEVER ellipsized — a
//      residual `fit` shrink (font size stepdown) guards the
//      mathematically-unreachable squeeze case.
//    - Rpt.text gained `fit` — shrink-to-width instead of truncation
//      (used by KPI cards + cover band + every table cell).
//
//  Design rules (kept strict so every section looks consistent):
//    - the cursor `y` is the ONLY vertical state; every draw call takes
//      explicit rects — no pdfkit auto-flow (doc.text with x/y + width)
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
// non-encodable char to '?' and strip control chars entirely — EXCEPT
// the MK_UP/MK_DN sentinels, which Rpt.text/tinyText consume BEFORE
// this function runs (see below).
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
//  ▲ / ▼ change markers (FIX-TERPOTONG: "peningkatan beri tanda,
//  penurunan juga")
//  --------------------------------------------------------
//  WinAnsi (the only encoding the 14 standard PDF fonts support) has no
//  ▲ U+25B2 / ▼ U+25BC glyphs. Change values therefore carry an
//  invisible leading sentinel (\u0001 up / \u0002 down); the two text
//  renderers detect it before sanitization and draw a vector triangle
//  in the current text color. Marker sentinels never survive
//  sanitizePdfText on their own, so they can never leak into the
//  content stream un-rendered.
// ------------------------------------------------------------
export const MK_UP = '\u0001';
export const MK_DN = '\u0002';

/** '' | MK_UP | MK_DN for a numeric change (null/NaN/0 → ''). */
export function markOf(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v) || v === 0) return '';
  return v > 0 ? MK_UP : MK_DN;
}

/** Strip a leading marker sentinel (for sign checks on cell strings). */
export function stripMark(s: string): string {
  const cc = s.charCodeAt(0);
  return cc === 1 || cc === 2 ? s.slice(1) : s;
}

/** Horizontal room a rendered marker occupies at `size` (triangle + gap). */
export function markerExtra(size: number): number {
  return Math.max(3.1, size * 0.5) * 1.15 + 1.6;
}

/** Small filled triangle (▲ up / ▼ down) — `cy` is the vertical center. */
export function drawTri(
  doc: PDFKit.PDFDocument,
  x: number, cy: number, w: number, h: number,
  up: boolean, color: string,
): void {
  doc.fillColor(color);
  if (up) {
    doc.moveTo(x, cy + h / 2).lineTo(x + w, cy + h / 2).lineTo(x + w / 2, cy - h / 2).fill();
  } else {
    doc.moveTo(x, cy - h / 2).lineTo(x + w, cy - h / 2).lineTo(x + w / 2, cy + h / 2).fill();
  }
}

/** Detect + strip a leading marker; returns [text, 0|1|2]. */
export function takeMark(t: string): [string, number] {
  const cc = t.charCodeAt(0);
  if (cc === 1 || cc === 2) return [t.slice(1), cc];
  return [t, 0];
}

// ------------------------------------------------------------
//  Measuring (fixed-layout tables need deterministic cell metrics)
// ------------------------------------------------------------
export function widthOf(doc: PDFKit.PDFDocument, text: string, font: string, size: number): number {
  doc.font(font).fontSize(size);
  return doc.widthOfString(sanitizePdfText(text));
}

/** Marker-aware glyph width — the rendered triangle reserves its slot. */
export function measureW(doc: PDFKit.PDFDocument, text: string, font: string, size: number): number {
  const [t, mk] = takeMark(String(text ?? ''));
  return widthOf(doc, t, font, size) + (mk ? markerExtra(size) : 0);
}

/** Truncate `text` to `maxW` with an ellipsis (WinAnsi U+2026). */
// Retained for API compatibility; the report pipeline itself no longer
// truncates anything (FIX-TERPOTONG) — it wraps (tables) or shrinks
// the font size (fit) instead.
export function truncateToWidth(doc: PDFKit.PDFDocument, text: string, font: string, size: number, maxW: number): string {
  const t = sanitizePdfText(text);
  if (widthOf(doc, t, font, size) <= maxW) return t;
  let s = t;
  while (s.length > 1 && widthOf(doc, `${s}\u2026`, font, size) > maxW) {
    s = s.slice(0, -1);
  }
  return `${s}\u2026`;
}

/** Greedy word-wrap into lines that each fit `maxW` (single words are
 *  never split — the column-width engine guarantees they fit). */
export function wrapLines(doc: PDFKit.PDFDocument, text: string, font: string, size: number, maxW: number): string[] {
  const words = sanitizePdfText(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    const t = cur ? `${cur} ${wd}` : wd;
    if (!cur || widthOf(doc, t, font, size) <= maxW) cur = t;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------
//  Table renderer — AUTO-FIT (FIX-TERPOTONG: nothing is ever cut off)
// ------------------------------------------------------------
export interface TCol {
  header: string;
  /** Width floor (pt). The engine widens columns beyond this whenever
   *  the content needs more room — content is never truncated. */
  w?: number;
  align?: 'left' | 'right' | 'center';
  /** Allow multi-line wrapping (default: left-aligned columns). */
  wrap?: boolean;
}

/** A table row: pre-formatted strings, one cell per column. */
export type TRow = string[];

export interface TableOpts {
  cols: TCol[];
  rows: TRow[];
  /** Body font size UPPER BOUND (default 7.5). The engine steps down in
   *  0.25 increments only when minimum required widths would overflow
   *  the page — otherwise the requested size is kept exactly. */
  fontSize?: number;
  /** Header background (default C.headerBg). */
  headerFill?: string;
  /** Zebra stripe even rows (default true). */
  zebra?: boolean;
  /** Per-row text color override (e.g. red for a negative total row). */
  rowText?: (row: TRow, i: number) => string | undefined;
  /** Per-cell background override (wins over zebra; e.g. heat cells).
   *  (row, rowIndex, colIndex). */
  cellFill?: (_row: TRow, _ri: number, _ci: number) => string | undefined;
  /** Per-cell text color override (wins over rowText; e.g. ▲ red / ▼ green
   *  on a change column while the rest of the row stays neutral).
   *  (row, rowIndex, colIndex). */
  cellColor?: (_row: TRow, _ri: number, _ci: number) => string | undefined;
  /** Bold the first column (default false). */
  boldFirst?: boolean;
  /** Per-row bold (e.g. TOTAL row). */
  rowBold?: (row: TRow, i: number) => boolean;
  /** Minimum row height (default derived from the wrapped line count). */
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
  /** Draw a single line at an explicit position (no auto-flow).
   *  A leading MK_UP/MK_DN sentinel renders as a ▲/▼ vector triangle
   *  in the text color. With `fit`, over-wide text SHRINKS (font-size
   *  stepdown) instead of truncating — used by every fixed-width cell. */
  text(
    t: string,
    x: number,
    y: number,
    opts: {
      font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center';
      width?: number; ellipsize?: boolean; fit?: boolean;
    } = {},
  ): void {
    const { font = 'Helvetica', color = C.ink, align = 'left', width, ellipsize = false, fit = false } = opts;
    let size = opts.size ?? 9;
    let [s, mk] = takeMark(String(t ?? ''));
    s = sanitizePdfText(s);
    if (width != null) {
      const avail = width - (mk ? markerExtra(size) : 0);
      if (fit) {
        this.doc.font(font);
        while (size > 4.4 && this.doc.fontSize(size).widthOfString(s) > avail) {
          size = Math.round((size - 0.1) * 100) / 100;
        }
      } else if (ellipsize) {
        s = truncateToWidth(this.doc, s, font, size, avail);
      }
    }
    this.doc.font(font).fontSize(size).fillColor(color);
    const tw = this.doc.widthOfString(s);
    const w = width ?? tw;
    let tx = x;
    if (align === 'right') tx = x + w - tw;
    if (align === 'center') tx = x + (w - tw) / 2;
    if (mk) {
      const mh = Math.max(3.1, size * 0.5);
      const mw = mh * 1.15;
      const cy = y + size * 0.62;
      if (align === 'left') {
        drawTri(this.doc, tx, cy, mw, mh, mk === 1, color);
        tx += mw + 1.6;
      } else {
        drawTri(this.doc, tx - mw - 1.6, cy, mw, mh, mk === 1, color);
      }
      this.doc.font(font).fontSize(size).fillColor(color);
    }
    // lineBreak:false keeps pdfkit from wrapping mid-call; the explicit
    // x/y (not doc.x/doc.y) makes this position-stable.
    this.doc.text(s, tx, y, { lineBreak: false, width: tw + 2 });
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
        // FIX-TERPOTONG: fit (shrink) instead of ellipsize — nothing cut
        this.text(c.label.toUpperCase(), x + 9, top + 10, { size: 6, color: C.muted, fit: true, width: cardW - 18 });
        this.text(c.value, x + 9, top + 21, { font: 'Helvetica-Bold', size: 13.5, color: C.ink, fit: true, width: cardW - 18 });
        if (c.sub != null) {
          this.text(c.sub, x + 9, top + 39, { size: 6.8, color: c.subColor ?? C.muted, fit: true, width: cardW - 18 });
        }
      });
      this.y += cardH + gap;
      rows += 1;
    }
    return rows;
  }

  // ----------------------------------------------------------
  //  Table with header repetition across page breaks
  //  (AUTO-FIT — see module header; no cell is ever truncated)
  // ----------------------------------------------------------
  table(opts: TableOpts): void {
    const {
      cols, rows,
      fontSize: baseSize = 7.5,
      headerFill = C.headerBg,
      zebra = true,
      rowText, cellFill, cellColor, boldFirst = false, rowBold,
      rowH: rowHMin = 0,
      minRowsFirstPage = 2,
    } = opts;
    const PADX = 8; // 4pt left + 4pt right cell padding
    const bodyFont = 'Helvetica';
    const headFont = 'Helvetica-Bold';

    // ---- 1. pick the largest font size whose MINIMUM required widths
    //         (longest unbreakable word per column, marker-aware) fit
    //         the content width --------------------------------------
    type Plan = { size: number; widths: number[]; isWrap: boolean[] };
    let plan: Plan | null = null;
    for (let size = baseSize; size >= 5.2 - 1e-9; size = Math.round((size - 0.25) * 100) / 100) {
      const isWrap = cols.map((c) => c.wrap ?? (c.align ?? 'left') === 'left');
      const hSize = Math.max(size - 0.5, 4.5);
      // natural width: widest single line the column would need
      const nat = cols.map((c, ci) => {
        let mx = measureW(this.doc, c.header.toUpperCase(), headFont, hSize);
        for (const row of rows) mx = Math.max(mx, measureW(this.doc, row[ci] ?? '', bodyFont, size));
        return mx + PADX;
      });
      // minimum width: longest single WORD (wrappable columns may wrap
      // their words onto extra lines, but never split a word)
      const need = cols.map((c, ci) => {
        if (!isWrap[ci]) return nat[ci];
        let lw = 0;
        for (const src of [c.header.toUpperCase(), ...rows.map((r) => stripMark(String(r[ci] ?? '')))]) {
          for (const wd of sanitizePdfText(src).split(/\s+/)) {
            lw = Math.max(lw, widthOf(this.doc, wd, bodyFont, size));
          }
        }
        return lw + PADX;
      });
      if (need.reduce((a, b) => a + b, 0) > CONTENT_W + 0.01) continue;

      // caller `w` acts as a width floor (kept only while it all fits)
      let widths = need.map((nd, i) => Math.max(nd, cols[i].w ?? 0));
      let sumW = widths.reduce((a, b) => a + b, 0);
      if (sumW > CONTENT_W + 0.01) { widths = need; sumW = need.reduce((a, b) => a + b, 0); }

      // grow columns toward their natural width first (widest deficit
      // gains most), then spread any remaining surplus proportionally
      let free = CONTENT_W - sumW;
      if (free > 0.01) {
        const deficit = nat.map((n, i) => Math.max(0, n - widths[i]));
        const sumDef = deficit.reduce((a, b) => a + b, 0);
        if (sumDef > 0.01) {
          const give = Math.min(free, sumDef);
          widths = widths.map((w, i) => w + give * deficit[i] / sumDef);
          free -= give;
        }
        if (free > 0.01) {
          const sw = widths.reduce((a, b) => a + b, 0);
          widths = widths.map((w) => w + free * w / sw);
        }
      }
      plan = { size, widths, isWrap };
      break;
    }
    if (!plan) {
      // unreachable in practice (5.2pt minimums fit every current
      // table) — proportional squeeze + per-line `fit` shrink guard
      const size = 5.2;
      const nat = cols.map((c, ci) => {
        let mx = measureW(this.doc, c.header.toUpperCase(), headFont, size - 0.5);
        for (const row of rows) mx = Math.max(mx, measureW(this.doc, row[ci] ?? '', bodyFont, size));
        return mx + PADX;
      });
      const sum = nat.reduce((a, b) => a + b, 0) || 1;
      plan = { size, widths: nat.map((w) => (w / sum) * CONTENT_W), isWrap: cols.map((c) => c.wrap ?? (c.align ?? 'left') === 'left') };
    }
    const { size, widths, isWrap } = plan;
    const hSize = Math.max(size - 0.5, 4.5);
    const lineH = size * 1.25;          // body line advance
    const hLineH = hSize * 1.25;       // header line advance
    const totalW = widths.reduce((a, b) => a + b, 0);

    // ---- 2. pre-wrap: header lines + body cell lines ----------------
    const headerLines = cols.map((c, ci) =>
      wrapLines(this.doc, c.header.toUpperCase(), headFont, hSize, widths[ci] - PADX));
    const hLines = Math.max(1, ...headerLines.map((l) => l.length));
    const headerH = hLines * hLineH + 12;
    const cellLines: string[][][] = rows.map((row) => cols.map((c, ci) =>
      isWrap[ci]
        ? wrapLines(this.doc, String(row[ci] ?? ''), bodyFont, size, widths[ci] - PADX)
        : [String(row[ci] ?? '')]));
    const rowHs = rows.map((_, ri) => {
      const ml = Math.max(1, ...cellLines[ri].map((l) => l.length));
      return Math.max(rowHMin, ml * lineH + 10);
    });

    const drawHeader = (): void => {
      this.doc.fillColor(headerFill).rect(PAGE.M, this.y, totalW, headerH).fill();
      let hx = PAGE.M;
      cols.forEach((c, ci) => {
        const lines = headerLines[ci];
        const blockH = lines.length * hLineH;
        let ly = this.y + (headerH - blockH) / 2 + 0.5;
        for (const ln of lines) {
          this.text(ln, hx + 4, ly, {
            font: headFont, size: hSize, color: C.white,
            align: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left',
            width: widths[ci] - PADX, fit: true,
          });
          ly += hLineH;
        }
        hx += widths[ci];
      });
      this.y += headerH;
    };

    this.ensure(headerH + (lineH + 10) * Math.max(1, minRowsFirstPage));
    drawHeader();

    rows.forEach((row, i) => {
      const rowH = rowHs[i];
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
        const cellBg = cellFill?.(row, i, ci);
        if (cellBg) this.doc.fillColor(cellBg).rect(x, this.y, widths[ci], rowH).fill();
        const isBold = bold || (boldFirst && ci === 0);
        const color = cellColor?.(row, i, ci) ?? (ci === 0 ? C.ink : fill ?? C.inkSoft);
        const lines = cellLines[i][ci];
        const blockH = lines.length * lineH;
        let ly = this.y + (rowH - blockH) / 2 + (lineH - size - 3.4) / 2;
        for (const ln of lines) {
          this.text(ln, x + 4, ly, {
            font: isBold ? 'Helvetica-Bold' : 'Helvetica',
            size, color,
            align: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left',
            width: widths[ci] - PADX, fit: true,
          });
          ly += lineH;
        }
        x += widths[ci];
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
    this.text(title, PAGE.M + 18, top + 16, { font: 'Helvetica-Bold', size: 19, color: C.white, fit: true, width: CONTENT_W - 210 });
    this.text(subtitle, PAGE.M + 18, top + 44, { font: 'Helvetica-Bold', size: 11.5, color: C.accent, fit: true, width: CONTENT_W - 210 });
    // right-aligned meta lines (fit: shrink, never cut)
    rightLines.forEach((ln, i) => {
      this.text(ln, PAGE.M + CONTENT_W - 190, top + 16 + i * 12, {
        size: 7, color: i === 0 ? C.faint : '#D1D5DB', align: 'right', width: 172, fit: true,
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
