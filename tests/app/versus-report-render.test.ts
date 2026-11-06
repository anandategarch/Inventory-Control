// ============================================================
//  versus-report-render.test.ts — VERSUS-2R render smoke
//  --------------------------------------------------------
//  VERSUS-AUDIT-4 (P2): the versus mode shipped with ZERO automated
//  coverage (the commit's "8 kasus Zod PASS" was a manual curl pass).
//  This file pins the versus pipeline's RENDER contract with the same
//  mock harness as pdf-subsection-render.test.ts (fixture now shared):
//    - the full duel (sections=null) renders without throwing;
//    - the versus document is LARGER than the standard report of the
//      same sections (every section 1-10 renders TWICE under NAMA
//      badges + the side-by-side VS tables — the observable signal
//      that the interleaving actually happened);
//    - ?sections= gating still works in versus mode;
//    - cover-only versus ([] — BUG-3-a C4 semantics) renders;
//    - the download FILE NAME carries the duel (CC-NAMES-1);
//    - the dual-highlight league path (both restos highlighted +
//      "#N vs #M" subhead) executes.
//  Side A = the fixture as KWGGAL (league row #1), side B = a clone
//  with DIFFERENT KPI magnitudes as CBICIL (league row #2) — both
//  codes exist in the mock's outletLeague so section 11's dual
//  highlight path fires.
// ============================================================
import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { buildPdfReport } from '@/app/api/export-report/services/pdf/pdf-builder';
import { C, Rpt, type TableOpts } from '@/app/api/export-report/services/pdf/pdf-primitives';
import { createSectionEnv } from '@/app/api/export-report/services/pdf/section-context';
import { drawOutletLeagueSection } from '@/app/api/export-report/services/pdf/sections/outlet-league';
import type { VersusReportInput } from '@/app/api/export-report/services/types';
import { mockReportData, HISTORICAL_PERIODS } from './fixtures/report-data-mock';

const FOCUS = '1042.KWGGAL'; // KWGGAL — outletLeague row #1
const VERSUS = '1203.CBICIL'; // CBICIL — outletLeague row #2

/** Side A — the fixture scoped to the focus resto. */
function sideA() {
  const d = mockReportData();
  d.filters = { ...d.filters, outletCode: FOCUS };
  return d;
}

/** Side B — the same pipeline output for the VERSUS resto with DIFFERENT
 *  magnitudes (the duel must be observable in the VS table's Selisih). */
function sideB() {
  const d = mockReportData();
  d.filters = { ...d.filters, outletCode: VERSUS };
  d.executiveSummary = {
    ...d.executiveSummary,
    sales: { current: 800_000, previous: 850_000, growth: -0.06 },
    nominalDeviasi: { current: -120_000, previous: -90_000, growth: 0.33 },
    qtyBom: { current: 60, previous: 55, growth: 0.09 },
    qtyDeviasi: { current: -4, previous: -3, growth: 0.33 },
  };
  return d;
}

function versusInput(): VersusReportInput {
  return { code: VERSUS, name: 'CBICIL', focusName: 'KWGGAL', data: sideB() };
}

async function renderVersus(sections: string[] | null): Promise<{ size: number; fileName: string }> {
  const r = await buildPdfReport(sideA(), { sections, historicalPeriods: HISTORICAL_PERIODS }, versusInput());
  return { size: Buffer.from(r.bufferBase64, 'base64').length, fileName: r.fileName };
}

async function renderStandard(sections: string[] | null): Promise<number> {
  const { bufferBase64 } = await buildPdfReport(sideA(), { sections, historicalPeriods: HISTORICAL_PERIODS });
  return Buffer.from(bufferBase64, 'base64').length;
}

describe('buildPdfReport — VERSUS-2R (mode "Versus — 1 Resto vs 1 Resto")', () => {
  it('renders the full duel (sections=null) without throwing', async () => {
    const r = await renderVersus(null);
    expect(r.size).toBeGreaterThan(0);
  });

  it('the versus document is LARGER than the standard report of the same sections', async () => {
    // Sections 1-10 render TWICE (per-resto badge blocks) + the VS KPI +
    // VS growth tables lead sections 1/2 — the duel must add bytes over
    // the single-dataset standard layout.
    const standard = await renderStandard(null);
    const versus = await renderVersus(null);
    expect(versus.size).toBeGreaterThan(standard);
  });

  it('versus exec-only still beats standard exec-only (VS table + both sides)', async () => {
    const standard = await renderStandard(['exec']);
    const versus = await renderVersus(['exec']);
    expect(versus.size).toBeGreaterThan(standard);
  });

  it('?sections= gating works in versus mode (fewer sections → smaller output)', async () => {
    const all = await renderVersus(null);
    const execOnly = await renderVersus(['exec']);
    expect(execOnly.size).toBeLessThan(all.size);
  });

  it('renders the cover-only duel (sections=[] — BUG-3-a C4 semantics)', async () => {
    const r = await renderVersus([]);
    expect(r.size).toBeGreaterThan(0);
  });

  it('the file NAME carries the duel (CC-NAMES-1 — names, not generic labels)', async () => {
    const { fileName } = await renderVersus(['exec']);
    expect(fileName.startsWith('Laporan_Versus_KWGGAL_vs_CBICIL_')).toBe(true);
    expect(fileName.endsWith('.pdf')).toBe(true);
  });

  it('section 11 executes the DUAL-highlight path (both restos of the duel)', async () => {
    // Byte-size is NOT a reliable signal at single-table granularity (the
    // versus bold row WIDENS the auto-fit columns and the PDF's coordinate
    // literals shift by bytes both ways — observed live: versus league
    // rendered 61 bytes SMALLER despite more content). Capture the
    // renderer's own calls instead: the subhead must name BOTH restos with
    // their ranks, and rowBold/cellFill must fire for BOTH league rows.
    const doc = new PDFDocument();
    const rpt = new Rpt(doc);
    const subheads: string[] = [];
    let tableOpts: TableOpts | null = null;
    rpt.sectionHeader = () => undefined;
    rpt.subhead = (t: string) => { subheads.push(t); };
    rpt.table = (opts: TableOpts) => { tableOpts = opts; };

    const data = sideA(); // outletLeague: KWGGAL #1, CBICIL #2
    const env = createSectionEnv(rpt, doc, data, {
      sections: ['outletLeague'],
      historicalPeriods: HISTORICAL_PERIODS,
    });
    env.versusPeerCode = VERSUS; // what drawReportVersus sets on side A
    drawOutletLeagueSection(env);

    // CC-NAMES-1: the subhead names the duel with NAMES + ranks.
    expect(subheads.join(' ')).toContain('KWGGAL #1 vs CBICIL #2 ter-highlight');
    expect(tableOpts).not.toBeNull();
    const rows = data.outletLeague;
    const bold = rows.map((r, i) => tableOpts!.rowBold?.([], i) ?? false);
    const fills = rows.map((r, i) => tableOpts!.cellFill?.([], i, 0));
    expect(bold).toEqual([true, true]);
    expect(fills).toEqual([C.focusRow, C.focusRow]);

    // Standard mode (no versusPeerCode): only the focus row highlights and
    // the subhead carries the CODE form — the pre-VERSUS-2R behavior.
    const subheadsStd: string[] = [];
    let tableOptsStd: TableOpts | null = null;
    rpt.subhead = (t: string) => { subheadsStd.push(t); };
    rpt.table = (opts: TableOpts) => { tableOptsStd = opts; };
    const envStd = createSectionEnv(rpt, doc, sideA(), {
      sections: ['outletLeague'],
      historicalPeriods: HISTORICAL_PERIODS,
    });
    drawOutletLeagueSection(envStd);
    expect(subheadsStd.join(' ')).toContain('1042.KWGGAL ter-highlight');
    const boldStd = rows.map((r, i) => tableOptsStd!.rowBold?.([], i) ?? false);
    expect(boldStd).toEqual([true, false]);
  });

  it('section 13 renders in versus mode (the forced-comparator auto-duo layout)', async () => {
    const r = await renderVersus(['customCompare']);
    expect(r.size).toBeGreaterThan(0);
  });
});
