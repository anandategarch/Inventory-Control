// ============================================================
//  columns — DUEL-LR: the versus report's synchronized two-column engine
//  --------------------------------------------------------
//  User request: "misal mode compare harusnya layout nya kiri dan
//  kanan bukan atas bawah kan? nama nya juga compare" — in mode
//  Versus every per-resto section renders SIDE BY SIDE (resto fokus
//  LEFT column, resto pembanding RIGHT column) instead of stacked
//  top-to-bottom. pdfkit is a single-cursor streaming API (one content
//  stream per page, ops appended in call order), so the engine works
//  in three phases:
//
//    1. RECORD — each side renders through a shadow Rpt whose `doc` is
//       an OpRecorder: the ~15-method PDFDocument surface the report
//       actually uses (verified by grep over pdf-primitives / pdf-charts
//       / sections — no save/restore/translate/dash/polygon anywhere).
//       Vector/text ops are captured per VIRTUAL page; measurement
//       calls (widthOfString / heightOfString) delegate to the REAL doc
//       and every state setter is ALSO applied to the real doc so the
//       measurements stay truthful. The shadow geometry is COLUMN-LOCAL
//       (width = columnW, x from 0, page height = the first duo page's
//       available height) — the table auto-fit therefore sizes columns
//       for the COLUMN width, never the full page.
//    2. COMPOSE — for each virtual page pair the composer translates
//       the real document to (columnX, columnY) and replays the ops
//       verbatim inside doc.save()/restore(). A per-page STATE SNAPSHOT
//       (font/size/fill/stroke/lineWidth) is applied first, so
//       replaying side A then side B onto the SAME real page can never
//       inherit the other side's graphics state.
//    3. CONTINUE — when one side is longer, later real pages carry a
//       small "(lanjutan)" name chip above each column; the shorter
//       side simply leaves its half empty. The real cursor resumes
//       below the taller column's last page.
//
//  The sides' section renderers are reused VERBATIM (the VERSUS-2R
//  versusBadge mechanism): each side's own sectionHeader call renders
//  its NAMA badge at the top of its column, so composeDuo itself draws
//  no header for sections — only the cover (no sectionHeader inside)
//  passes withBadges.
// ============================================================
import type PDFKit from 'pdfkit';
import { C, Rpt, type RptGeom } from './pdf-primitives';

/** One recorded draw call (method name + args, JSON-safe). */
interface Op {
  m: string;
  a: unknown[];
}

/** Graphics state at the START of a virtual page — replayed before the
 *  page's ops so interleaved composition cannot leak state across sides. */
interface GState {
  font: string;
  size: number;
  fill: string;
  stroke: string;
  lw: number;
}

interface RecordedPage {
  state: GState;
  ops: Op[];
}

export interface RecordedSide {
  pages: RecordedPage[];
  /** The side's final cursor (bottom of its LAST virtual page). */
  endY: number;
}

/** One side of the duel, as composeDuo consumes it. */
export interface DuoSpec {
  /** CC-NAMES-1: the resto's NAME (never a generic label). */
  name: string;
  /** Badge chip fill — amber C.focusRow for the focus side, neutral for
   *  the comparator side (the VERSUS-2R convention). */
  fill: string;
  /** Draws this side's content into the shadow (rpt, doc) pair. */
  render: (rpt: Rpt, doc: PDFKit.PDFDocument) => void;
}

const INIT_STATE: GState = { font: 'Helvetica', size: 12, fill: '#000000', stroke: '#000000', lw: 1 };

// ============================================================
//  OpRecorder — the shadow PDFDocument
// ============================================================
export class OpRecorder {
  readonly pages: RecordedPage[] = [];
  private st: GState = { ...INIT_STATE };

  constructor(private readonly real: PDFKit.PDFDocument) {
    this.pages.push({ state: { ...this.st }, ops: [] });
  }

  private push(m: string, ...a: unknown[]): void {
    this.pages[this.pages.length - 1].ops.push({ m, a });
  }

  // ---- state setters: forward to the REAL doc (measurement truth) + record
  font(f: string): this {
    this.real.font(f);
    this.st.font = f;
    this.push('font', f);
    return this;
  }

  fontSize(n: number): this {
    this.real.fontSize(n);
    this.st.size = n;
    this.push('fontSize', n);
    return this;
  }

  fillColor(c: string): this {
    this.real.fillColor(c);
    this.st.fill = c;
    this.push('fillColor', c);
    return this;
  }

  strokeColor(c: string): this {
    this.real.strokeColor(c);
    this.st.stroke = c;
    this.push('strokeColor', c);
    return this;
  }

  lineWidth(n: number): this {
    this.real.lineWidth(n);
    this.st.lw = n;
    this.push('lineWidth', n);
    return this;
  }

  // ---- measurement: REAL doc only (never recorded, never translated)
  widthOfString(s: string, o?: Record<string, unknown>): number {
    return this.real.widthOfString(s, o as PDFKit.Mixins.TextOptions);
  }

  heightOfString(s: string, o?: Record<string, unknown>): number {
    return this.real.heightOfString(s, o as PDFKit.Mixins.TextOptions);
  }

  // ---- draw ops: recorded only (replayed under a translated CTM)
  text(t: string, x: number, y: number, o?: Record<string, unknown>): this {
    this.push('text', t, x, y, o);
    return this;
  }

  moveTo(x: number, y: number): this {
    this.push('moveTo', x, y);
    return this;
  }

  lineTo(x: number, y: number): this {
    this.push('lineTo', x, y);
    return this;
  }

  rect(x: number, y: number, w: number, h: number): this {
    this.push('rect', x, y, w, h);
    return this;
  }

  roundedRect(x: number, y: number, w: number, h: number, r: number): this {
    this.push('roundedRect', x, y, w, h, r);
    return this;
  }

  circle(x: number, y: number, r: number): this {
    this.push('circle', x, y, r);
    return this;
  }

  fill(): this {
    this.push('fill');
    return this;
  }

  stroke(): this {
    this.push('stroke');
    return this;
  }

  // ---- shadow pagination: a VIRTUAL page, never a real addPage
  addPage(): this {
    this.pages.push({ state: { ...this.st }, ops: [] });
    return this;
  }
}

// ============================================================
//  recordSide — render one side into a column-local shadow
// ============================================================
export function recordSide(
  realDoc: PDFKit.PDFDocument,
  columnW: number,
  pageAvailH: number,
  spec: DuoSpec,
): RecordedSide {
  const rec = new OpRecorder(realDoc);
  const shadowDoc = rec as unknown as PDFKit.PDFDocument;
  // column-local geometry: x in [0, columnW], y in [0, pageAvailH] —
  // replay is then a pure translation, and the table auto-fit / charts
  // size themselves for the COLUMN, not the full page.
  const geom: RptGeom = {
    pageW: columnW,
    pageH: pageAvailH,
    marginL: 0,
    marginR: 0,
    top: 0,
    bottom: 0,
  };
  const srpt = new Rpt(shadowDoc, geom);
  // VERSUS-2R badge mode: the renderer's own sectionHeader call renders
  // this side's NAMA badge at the top of the column (zero changes inside
  // the twelve section modules).
  srpt.versusBadge = spec.name;
  srpt.restoBadgeFill = spec.fill;
  spec.render(srpt, shadowDoc);
  return { pages: rec.pages, endY: srpt.y };
}

// ============================================================
//  Replay — one recorded page into a translated column box
// ============================================================
function replayPage(
  doc: PDFKit.PDFDocument,
  page: RecordedPage | undefined,
  tx: number,
  ty: number,
): void {
  if (!page || page.ops.length === 0) return;
  doc.save();
  doc.translate(tx, ty);
  const s = page.state;
  doc.font(s.font).fontSize(s.size).fillColor(s.fill).strokeColor(s.stroke).lineWidth(s.lw);
  for (const op of page.ops) {
    (doc as unknown as Record<string, (...a: unknown[]) => unknown>)[op.m](...op.a);
  }
  doc.restore();
}

// ============================================================
//  composeDuo — the page-synchronized left/right composition
// ============================================================
export interface DuoOpts {
  /** Draw the two NAMA chips above the columns (the cover — its content
   *  has no sectionHeader, hence no in-column badge). Default false. */
  withBadges?: boolean;
  /** Small dark emblem centered in the gutter (e.g. 'VS'). Default 'VS'. */
  gutterEmblem?: string | null;
}

export function composeDuo(
  rpt: Rpt,
  a: DuoSpec,
  b: DuoSpec,
  opts: DuoOpts = {},
): void {
  const realDoc = rpt.doc;
  const GUTTER = 26;
  const colW = Math.floor((rpt.contentW - GUTTER) / 2);
  const colAX = rpt.leftX;
  const colBX = rpt.leftX + colW + GUTTER;
  const midX = colAX + colW + GUTTER / 2;

  // A duo first page needs room for at least a badge + one table row —
  // otherwise break to a fresh page now (availH would be silly-small).
  rpt.ensure(140);

  let colTop0 = rpt.y;
  if (opts.withBadges) {
    // both NAMA chips at their column heads + hairline to the column edge
    const badgeY = rpt.y;
    badgeOverColumn(rpt, realDoc, colAX, colW, a.name, a.fill);
    badgeOverColumn(rpt, realDoc, colBX, colW, b.name, b.fill);
    colTop0 = badgeY + 22;
  }

  // Record both sides against page 0's available height (uniform virtual
  // page height — continuation real pages get a few pt MORE room, which
  // simply stays blank at their bottom).
  const availH = rpt.bottomY - colTop0;
  const sideA = recordSide(realDoc, colW, availH, a);
  const sideB = recordSide(realDoc, colW, availH, b);

  // gutter emblem at the head of the duel (aligned with the in-column
  // badges / the withBadges row)
  const emblemY = opts.withBadges ? colTop0 - 22 : colTop0;
  drawGutterEmblem(rpt, realDoc, midX, emblemY, opts.gutterEmblem ?? 'VS');

  // ---- page-synchronized replay ----
  const n = Math.max(sideA.pages.length, sideB.pages.length);
  const contTop = rpt.geom.top + 20; // continuation pages: below the chip strip
  for (let p = 0; p < n; p++) {
    if (p > 0) {
      rpt.newPage();
      // "(lanjutan)" chips re-label each column on every carried page
      continuationChip(rpt, realDoc, colAX, colW, rpt.geom.top, a.name, a.fill);
      continuationChip(rpt, realDoc, colBX, colW, rpt.geom.top, b.name, b.fill);
    }
    const colTop = p === 0 ? colTop0 : contTop;
    // center divider — the visual spine of the duel
    realDoc.moveTo(midX, colTop - 6)
      .lineTo(midX, rpt.bottomY)
      .lineWidth(0.7).strokeColor(C.border).stroke();
    replayPage(realDoc, sideA.pages[p], colAX, colTop);
    replayPage(realDoc, sideB.pages[p], colBX, colTop);
  }

  // resume the real cursor below the taller column's last page
  const lastTop = n === 1 ? colTop0 : contTop;
  rpt.y = lastTop + Math.max(sideA.endY, sideB.endY) + 14;
}

// ============================================================
//  Small column furniture (badges / chips / emblem)
// ============================================================
function badgeOverColumn(
  rpt: Rpt,
  doc: PDFKit.PDFDocument,
  colX: number,
  colW: number,
  name: string,
  fill: string,
): void {
  const w = rpt.chip(name, colX, rpt.y, fill, C.ink, { size: 7.5 });
  doc.moveTo(colX + w + 6, rpt.y + 6).lineTo(colX + colW, rpt.y + 6)
    .lineWidth(0.5).strokeColor(C.border).stroke();
}

function continuationChip(
  rpt: Rpt,
  doc: PDFKit.PDFDocument,
  colX: number,
  colW: number,
  y: number,
  name: string,
  fill: string,
): void {
  const label = `${name} (lanjutan)`;
  const w = rpt.chip(label, colX, y, fill, C.ink, { size: 6 });
  doc.moveTo(colX + w + 6, y + 5).lineTo(colX + colW, y + 5)
    .lineWidth(0.5).strokeColor(C.border).stroke();
}

function drawGutterEmblem(
  rpt: Rpt,
  doc: PDFKit.PDFDocument,
  midX: number,
  y: number,
  emblem: string,
): void {
  if (!emblem) return;
  doc.font('Helvetica-Bold').fontSize(7);
  const tw = doc.widthOfString(emblem);
  const w = tw + 10;
  doc.fillColor(C.ink).roundedRect(midX - w / 2, y, w, 13.5, 3).fill();
  rpt.text(emblem, midX - w / 2, y + 2.8, {
    font: 'Helvetica-Bold', size: 7, color: C.white, align: 'center', width: w,
  });
}
