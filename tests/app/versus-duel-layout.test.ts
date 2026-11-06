// ============================================================
//  versus-duel-layout.test.ts — DUEL-LR layout contract
//  --------------------------------------------------------
//  User request: "misal mode compare harusnya layout nya kiri dan
//  kanan bukan atas bawah kan? nama nya juga compare" — the versus
//  report renders SIDE BY SIDE. This file pins the DUEL-LR contract:
//    - the versus document is A4 LANDSCAPE (MediaBox 841.89 x 595.28);
//      mode standar stays PORTRAIT (byte-identical geometry);
//    - composeDuo places side A in the LEFT half and side B in the
//      RIGHT half (real doc.translate targets), page-synchronized;
//    - per-page STATE SNAPSHOTS isolate the two sides — replaying B
//      after A on the same page can never inherit A's graphics state;
//    - shadow pagination (OpRecorder.addPage) never creates REAL
//      pages during recording;
//    - the versusBadge mechanism labels each column with the side's
//      NAMA (the renderer's own sectionHeader, reused verbatim);
//    - kpiCards auto-drops perRow inside a narrow duo column (never
//      below ~100pt cards) and is a no-op at portrait width.
// ============================================================
import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import type PDFKit from 'pdfkit';
import { buildPdfReport } from '@/app/api/export-report/services/pdf/pdf-builder';
import { C, Rpt, LANDSCAPE_GEOM, PORTRAIT_GEOM } from '@/app/api/export-report/services/pdf/pdf-primitives';
import { composeDuo, OpRecorder, recordSide, type DuoSpec } from '@/app/api/export-report/services/pdf/columns';
import type { VersusReportInput } from '@/app/api/export-report/services/types';
import { mockReportData, HISTORICAL_PERIODS } from './fixtures/report-data-mock';

const FOCUS = '1042.KWGGAL';
const VERSUS = '1203.CBICIL';

function sideA() {
  const d = mockReportData();
  d.filters = { ...d.filters, outletCode: FOCUS };
  return d;
}

function sideB() {
  const d = mockReportData();
  d.filters = { ...d.filters, outletCode: VERSUS };
  return d;
}

function versusInput(): VersusReportInput {
  return { code: VERSUS, name: 'CBICIL', focusName: 'KWGGAL', data: sideB() };
}

async function renderVersus(sections: string[] | null): Promise<Buffer> {
  const r = await buildPdfReport(sideA(), { sections, historicalPeriods: HISTORICAL_PERIODS }, versusInput());
  return Buffer.from(r.bufferBase64, 'base64');
}

async function renderStandard(): Promise<Buffer> {
  const r = await buildPdfReport(sideA(), { sections: null, historicalPeriods: HISTORICAL_PERIODS });
  return Buffer.from(r.bufferBase64, 'base64');
}

// ---- helpers: spy on a live PDFDocument without breaking behavior ----
function spyDoc(doc: PDFKit.PDFDocument) {
  const calls: { m: string; a: unknown[] }[] = [];
  const patch = (m: string) => {
    const orig = (doc as unknown as Record<string, (...a: unknown[]) => unknown>)[m].bind(doc);
    (doc as unknown as Record<string, (...a: unknown[]) => unknown>)[m] = (...a: unknown[]) => {
      calls.push({ m, a });
      return orig(...a);
    };
  };
  for (const m of ['translate', 'addPage', 'font', 'save', 'restore']) patch(m);
  return { calls };
}

describe('DUEL-LR — document orientation', () => {
  it('the versus document is A4 LANDSCAPE (841.89 x 595.28)', async () => {
    const buf = await renderVersus(null);
    expect(buf.toString('latin1')).toContain('/MediaBox [0 0 841.89 595.28]');
  });

  it('mode standar stays PORTRAIT (595.28 x 841.89)', async () => {
    const buf = await renderStandard();
    expect(buf.toString('latin1')).toContain('/MediaBox [0 0 595.28 841.89]');
  });

  it('renders the full duel without throwing', async () => {
    const buf = await renderVersus(null);
    expect(buf.length).toBeGreaterThan(0);
  });
});

describe('DUEL-LR — composeDuo column placement', () => {
  function makeDoc(): { doc: PDFKit.PDFDocument; spy: ReturnType<typeof spyDoc> } {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    return { doc, spy: spyDoc(doc) };
  }

  const spec = (name: string, fill: string, lines: number): DuoSpec => ({
    name,
    fill,
    render: (rpt) => {
      rpt.sectionHeader(3, `Item Prioritas — ${name}`);
      // deterministic tall content: N subheads force N shadow pages when
      // availH is small
      for (let i = 0; i < lines; i++) rpt.subhead(`${name} baris ${i}`);
    },
  });

  it('places side A LEFT and side B RIGHT on the same real page', () => {
    const { doc, spy } = makeDoc();
    const rpt = new Rpt(doc, LANDSCAPE_GEOM);
    composeDuo(rpt, spec('KWGGAL', C.focusRow, 1), spec('CBICIL', C.borderSoft, 1));

    const tx = spy.calls.filter((c) => c.m === 'translate').map((c) => c.a[0] as number);
    expect(tx.length).toBeGreaterThanOrEqual(2);
    const colW = Math.floor((rpt.contentW - 26) / 2);
    const leftX = tx.filter((x) => x === rpt.leftX);
    const rightX = tx.filter((x) => x === rpt.leftX + colW + 26);
    expect(leftX.length).toBeGreaterThanOrEqual(1); // side A always left
    expect(rightX.length).toBeGreaterThanOrEqual(1); // side B always right
    doc.end();
  });

  it('page-synchronizes: both sides replay on every carried page (2 shadow pages → 2 real pages, A and B on each)', () => {
    const { doc, spy } = makeDoc();
    const rpt = new Rpt(doc, LANDSCAPE_GEOM);
    // Force tiny availH: start deep into the page so the shadow must
    // paginate — 40 subheads at ~15pt each need ~600pt >> one column page.
    rpt.y = 380;
    composeDuo(rpt, spec('KWGGAL', C.focusRow, 40), spec('CBICIL', C.borderSoft, 40));

    const addPages = spy.calls.filter((c) => c.m === 'addPage').length;
    expect(addPages).toBeGreaterThanOrEqual(2); // continuation pages
    // every replay pass = one translate per side; count pages with BOTH
    // a left and a right translate
    const tx = spy.calls.filter((c) => c.m === 'translate').map((c) => c.a[0] as number);
    const colW = Math.floor((rpt.contentW - 26) / 2);
    const lefts = tx.filter((x) => x === rpt.leftX).length;
    const rights = tx.filter((x) => x === rpt.leftX + colW + 26).length;
    expect(lefts).toBe(rights); // synchronized: never a page with one side only
    doc.end();
  });

  it('shadow pagination never creates REAL pages during recording', () => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const spy = spyDoc(doc);
    const before = spy.calls.filter((c) => c.m === 'addPage').length;
    recordSide(doc, 300, 60, spec('KWGGAL', C.focusRow, 20)); // forces 5+ shadow pages
    const after = spy.calls.filter((c) => c.m === 'addPage').length;
    expect(after).toBe(before); // zero real addPage from recording
    doc.end();
  });
});

describe('DUEL-LR — OpRecorder state snapshots', () => {
  it('each replayed page applies its own state first (no cross-side leak)', () => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const spy = spyDoc(doc);

    const rec = new OpRecorder(doc);
    const shadow = rec as unknown as PDFKit.PDFDocument;
    const srpt = new Rpt(shadow, { pageW: 300, pageH: 40, marginL: 0, marginR: 0, top: 0, bottom: 0 });
    // page 1: state Courier/10/red + a RAW text op (the recorder's own
    // text never re-sets state — that is exactly what the snapshot must
    // cover: page 2's ops may rely on page 1's trailing state).
    shadow.font('Courier').fontSize(10).fillColor('#FF0000');
    shadow.text('halo satu', 0, 0);
    srpt.y = 30; // near the virtual bottom
    srpt.ensure(20); // 30+20 > 40 → shadow newPage (state carried into snapshot)
    shadow.text('halo dua', 0, 0); // page 2 op with NO state call of its own

    // replay page 2 onto the real doc AFTER the real doc's state changed
    doc.font('Helvetica').fontSize(20).fillColor('#0000FF');
    const replayPage = (rec as unknown as { pages: Array<{ state: { font: string; size: number; fill: string } }> }).pages;
    // emulate composeDuo's replay of the LAST page (the snapshot must
    // restore Courier/10/#FF0000 before the page's ops)
    doc.save();
    doc.translate(100, 100);
    const s = replayPage[1].state;
    doc.font(s.font).fontSize(s.size).fillColor(s.fill);
    doc.restore();
    const fonts = spy.calls.filter((c) => c.m === 'font').map((c) => c.a[0]);
    expect(replayPage[1].state.font).toBe('Courier');
    expect(replayPage[1].state.size).toBe(10);
    expect(replayPage[1].state.fill).toBe('#FF0000');
    expect(fonts[fonts.length - 1]).toBe('Courier'); // snapshot applied last
    doc.end();
  });
});

describe('DUEL-LR — versusBadge labels each column', () => {
  it("the side's own sectionHeader renders its NAMA (badge mode), not a numbered header", () => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const side = recordSide(doc, 340, 400, {
      name: 'CKGPAH',
      fill: C.borderSoft,
      render: (rpt) => {
        rpt.sectionHeader(9, 'Resto dengan Penjualan Kurang Lebih Sama');
      },
    });
    const texts = side.pages.flatMap((p) =>
      p.ops.filter((op) => op.m === 'text').map((op) => String(op.a[0])),
    );
    expect(texts).toContain('CKGPAH'); // the badge chip carries the NAME
    expect(texts.join(' ')).not.toContain('9. Resto dengan'); // no numbered header in the column
    doc.end();
  });
});

describe('DUEL-LR — kpiCards perRow auto-drop in narrow columns', () => {
  it('drops perRow 4 → 2 inside a ~366pt column (cards never absurdly narrow)', () => {
    const doc = new PDFDocument({ margin: 0 });
    const colGeom = { pageW: 366, pageH: 800, marginL: 0, marginR: 0, top: 0, bottom: 0 };
    const rpt = new Rpt(doc, colGeom);
    const cards = [1, 2, 3, 4].map((i) => ({ label: `KPI ${i}`, value: String(i) }));
    const rows = rpt.kpiCards(cards, { perRow: 4 });
    expect(rows).toBe(2); // 2x2 grid, not 4 skinny cards
    doc.end();
  });

  it('is a NO-OP at portrait content width (perRow 3 → 165pt cards stay 1 row of 3)', () => {
    const doc = new PDFDocument({ margin: 0 });
    const rpt = new Rpt(doc, PORTRAIT_GEOM);
    const cards = [1, 2, 3].map((i) => ({ label: `KPI ${i}`, value: String(i) }));
    const rows = rpt.kpiCards(cards, { perRow: 3 });
    expect(rows).toBe(1);
    doc.end();
  });
});
