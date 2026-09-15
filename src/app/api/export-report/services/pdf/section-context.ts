// ============================================================
//  section-context — the shared environment every PDF section draws in
//  --------------------------------------------------------
//  SPLIT-GOD-FILE: pdf-builder.ts used to hold all 9 sections inline in
//  one 1.341-line drawReport() closure; the section modules under
//  ./sections/ now each own one numbered section. SectionEnv carries
//  everything a section needs: the Rpt layout engine, the raw doc (for
//  charts), the report data, the request context, the section filter and
//  the precomputed dynamic period labels (REFINE-1: the comparator is
//  always NAMED — "AGU 26 W1" column form / "Agustus 2026 Week 1" title
//  form — never the generic word "pembanding").
// ============================================================
import type PDFKit from 'pdfkit';
import type { ReportData, ReportContext } from '../types';
import { Rpt } from './pdf-primitives';
import { shortMonth, periodCol, periodFull } from './pdf-style';

export interface SectionEnv {
  /** Layout engine (cursor, tables, subheads, ensure/page-breaks). */
  rpt: Rpt;
  /** Raw pdfkit document — needed by the chart sections only. */
  doc: PDFKit.PDFDocument;
  data: ReportData;
  ctx: ReportContext;
  /** `?sections=` filter — null = all, [] = cover-only document. */
  hasSection: (key: string) => boolean;
  /** Current period, short month form ("SEP 26"). */
  currLabel: string;
  /** Current period, column-header form ("SEP 26 W1"). */
  currCol: string;
  /** Comparator period, column-header form ("—" when absent). */
  prevCol: string;
  /** Comparator period, full title form ("Agustus 2026 Week 1" | null). */
  cmpFull: string | null;
  /** "1042.KWGGAL" or "Semua Resto". */
  restoName: string;
}

export function createSectionEnv(
  rpt: Rpt,
  doc: PDFKit.PDFDocument,
  data: ReportData,
  ctx: ReportContext,
): SectionEnv {
  const hasSection = (key: string): boolean => !ctx.sections || ctx.sections.includes(key);
  const currLabel = shortMonth(data.period.monthLabel);
  const currCol = periodCol(data.period.monthLabel, data.period.weekLabel);
  const prevCol = data.period.comparisonMonth ? periodCol(data.period.comparisonMonth, data.period.comparisonWeek) : '\u2014';
  const cmpFull = data.period.comparisonMonth ? periodFull(data.period.comparisonMonth, data.period.comparisonWeek) : null;
  const restoName = data.filters.outletCode && data.filters.outletCode !== 'all' ? data.filters.outletCode : 'Semua Resto';
  return { rpt, doc, data, ctx, hasSection, currLabel, currCol, prevCol, cmpFull, restoName };
}
