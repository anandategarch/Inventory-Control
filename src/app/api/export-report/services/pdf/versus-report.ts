// ============================================================
//  versus-report — VERSUS-2R: the "1 Resto vs 1 Resto" report layout
//  --------------------------------------------------------
//  User request: "aku mau sekarang dari poin 1 sampai 12 itu adalah
//  laporan versus jadi Resto BKS gol versus ckg Pak ... jadi ada dua
//  mode yaitu poin 1 sampai 12 nya Resto itu sendiri versus area atau
//  versus Resto lain yang banyak dan mode satunya lagi satu Resto itu
//  versus satu Resto lainnya" — mode 2 turns the WHOLE report into the
//  duel. The route already ran the full data pipeline for BOTH outlets
//  (data-fetcher/versus.ts); THIS module interleaves the two datasets
//  into one document:
//
//    Cover   — "Laporan Versus" band + each side's 4 KPI hero cards
//              under its own NAMA badge (CC-NAMES-1: names, never
//              generic "resto pembanding" labels).
//    1-2     — the numbered versus header, a NEW side-by-side VS table
//              (current values / growth %, both restos + Selisih), then
//              each side's EXISTING renderer under its NAMA badge
//              (Rpt.versusBadge — the renderer's own sectionHeader call
//              becomes the badge, so zero changes inside the renderers).
//    3-10    — the numbered versus header + the two badge blocks (the
//              sections are per-resto lists/tables/charts by nature).
//    11      — ONE league table, BOTH restos highlighted (side A's env
//              carries versusPeerCode — see outlet-league.ts).
//    12      — ONE area table (population-wide; identical data both
//              sides — rendering it twice would be pure duplication).
//    13      — side A's renderer verbatim: the route FORCED side A's
//              comparator set to the versus resto, so the CC-NAMES-1 duo
//              layout prints "13. Komparasi BKSGOL vs CKGPAH" with the
//              per-item head-to-head — the most detailed versus table
//              of the whole report.
//
//  Section numbering stays FIXED (1-13, the pdf-builder map) — the
//  versus mode changes WHO each section compares, not the report's
//  shape. ?sections=/sub-tokens gate every block exactly like mode
//  standar (both envs share the SAME ctx.sections list).
// ============================================================
import type { ReportContext, ReportData, VersusReportInput } from '../types';
import { fmtIDR, fmtNum, fmtPct } from '../format-helpers';
import { C, markOf, type Rpt } from './pdf-primitives';
import { chgColor, mkGrowth, negColor, titleCase } from './pdf-style';
import { createSectionEnv, type SectionEnv } from './section-context';
import { drawExecSection } from './sections/exec';
import { drawGrowthSection } from './sections/growth';
import { drawTopItemsSection } from './sections/top-items';
import { drawVarianceSection } from './sections/variance';
import { drawWasteSection } from './sections/waste';
import { drawTrendMatrixSection } from './sections/trend-matrix';
import { drawAnomalySection } from './sections/anomaly';
import { drawTrendSection } from './sections/trend';
import { drawPeerSection } from './sections/peer';
import { drawFlipSection } from './sections/flip';
import { drawOutletLeagueSection } from './sections/outlet-league';
import { drawAreaCompareSection } from './sections/area-compare';
import { drawCustomCompareSection } from './sections/custom-compare';

/** The two sides of the duel, pre-resolved. */
interface Duel {
  a: { code: string; name: string; data: ReportData; env: SectionEnv };
  b: { code: string; name: string; data: ReportData; env: SectionEnv };
}

/**
 * Run one side's block under its NAMA badge: badge mode swaps the
 * renderer's own sectionHeader for the badge (see Rpt.versusBadge), so
 * the twelve existing section modules are reused VERBATIM. try/finally
 * keeps the mode off even if a renderer throws (the whole PDF build
 * rejects anyway — this is hygiene, not recovery).
 */
function sideBlock(rpt: Rpt, name: string, fill: string, draw: () => void): void {
  rpt.versusBadge = name;
  rpt.restoBadgeFill = fill;
  try {
    draw();
  } finally {
    rpt.versusBadge = null;
    rpt.restoBadgeFill = null;
  }
}

// ============================================================
//  Cover — versus band + both sides' KPI hero cards
// ============================================================
function drawVersusCover(rpt: Rpt, duel: Duel): void {
  const a = duel.a.data;
  const b = duel.b.data;
  const kpisAvailable = duel.a.env.hasSection('exec') || duel.a.env.hasSection('growth');
  const monthWord = titleCase(a.period.monthLabel.split(/\s+/)[0] ?? '');
  rpt.coverBand(
    'Laporan Versus Deviasi',
    `${duel.a.name} vs ${duel.b.name}  \u00B7  ${monthWord}`,
    [],
  );

  if (!kpisAvailable) return;
  // Each side's 4 hero cards (the drawCover set) under its NAMA badge —
  // perRow 4 keeps the cover to ONE card row per side.
  const cardRow = (s: ReportData['executiveSummary'], cmpFull: string | null) => {
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    return [
      {
        label: 'Penjualan',
        value: s.sales.growth != null ? markOf(s.sales.growth) + fmtPct(s.sales.growth, true) : '\u2014',
        valueColor: chgColor(s.sales.growth, true),
        sub: cmpFull ?? undefined,
        subColor: C.muted,
      },
      {
        label: 'Nominal Deviasi',
        value: fmtIDR(s.nominalDeviasi.current),
        valueColor: negColor(fmtIDR(s.nominalDeviasi.current)),
        sub: cmpFull ?? undefined,
        subColor: C.muted,
      },
      {
        label: '% Deviasi To BOM',
        value: fmtPct(s.deviationToBom, false),
        valueColor: negColor(fmtPct(s.deviationToBom, false)),
        sub: cmpFull ?? undefined,
        subColor: C.muted,
      },
      {
        label: 'Nominal Deviasi to Sales',
        value: fmtPct(devToSalesCur, false),
        valueColor: negColor(fmtPct(devToSalesCur, false)),
        sub: cmpFull ?? undefined,
        subColor: C.muted,
      },
    ];
  };
  const cmpFull = duel.a.env.cmpFull;
  rpt.restoBadge(duel.a.name, C.focusRow);
  rpt.kpiCards(cardRow(a.executiveSummary, cmpFull), { perRow: 4 });
  rpt.restoBadge(duel.b.name, C.borderSoft);
  rpt.kpiCards(cardRow(b.executiveSummary, cmpFull), { perRow: 4 });
}

// ============================================================
//  1 — VS KPI table (side-by-side current values + Selisih)
// ============================================================
interface VsRow {
  label: string;
  /** Numeric accessor (null = no value this period). */
  get: (s: ReportData['executiveSummary']) => number | null;
  fmt: (v: number | null) => string;
  /** goodUp convention (chgColor): true = a HIGHER value is favorable
   *  (QTY BOM); false = higher = worse (every deviation metric). */
  goodUp: boolean;
}

function vsValueRows(): VsRow[] {
  const num = (v: number | null) => fmtNum(v);
  const pct = (v: number | null) => fmtPct(v, false);
  return [
    { label: 'Nominal Deviasi', get: (s) => s.nominalDeviasi.current, fmt: fmtIDR, goodUp: false },
    { label: '% Deviasi To BOM', get: (s) => s.deviationToBom, fmt: pct, goodUp: false },
    { label: 'QTY BOM', get: (s) => s.qtyBom.current, fmt: num, goodUp: true },
    { label: 'QTY Deviasi', get: (s) => s.qtyDeviasi.current, fmt: num, goodUp: false },
    { label: 'QTY Waste', get: (s) => s.qtyWaste.current, fmt: num, goodUp: false },
    { label: 'QTY Susut', get: (s) => s.qtySusut.current, fmt: num, goodUp: false },
    { label: 'QTY Trial', get: (s) => s.qtyTrial.current, fmt: num, goodUp: false },
    { label: 'QTY Loss/Surplus', get: (s) => s.qtyLossSurplus.current, fmt: num, goodUp: false },
    {
      label: 'Nominal Deviasi to Sales',
      // SALES SECRECY (REFINE-1): only the RATIO prints — never the
      // nominal. Same rule as sections 1/2/11/12/13.
      get: (s) => (s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null),
      fmt: pct,
      goodUp: false,
    },
  ];
}

/** The side-by-side VS table leading section 1 (current period values). */
function drawVersusKpiTable(rpt: Rpt, duel: Duel): void {
  const rows = vsValueRows();
  const currCol = duel.a.env.currCol;
  const a = duel.a.data.executiveSummary;
  const b = duel.b.data.executiveSummary;
  rpt.subhead(
    `1.VS ${duel.a.name} vs ${duel.b.name} (${currCol}) \u2014 selisih = ${duel.a.name} \u2212 ${duel.b.name}`,
    { size: 8.5 },
  );
  const table = rows.map((r) => {
    const va = r.get(a);
    const vb = r.get(b);
    const d = va != null && vb != null ? va - vb : null;
    return [
      r.label,
      r.fmt(va),
      r.fmt(vb),
      d != null ? markOf(d) + r.fmt(d) : '\u2014',
    ];
  });
  rpt.table({
    cols: [
      { header: 'Metrik' },
      { header: duel.a.name, align: 'right' },
      { header: duel.b.name, align: 'right' },
      { header: 'Selisih', align: 'right' },
    ],
    boldFirst: true,
    rows: table,
    // PDFCOLOR-1: minus-red on the VALUE columns (the signed rows —
    // Nominal Deviasi, QTY Deviasi, Nominal Deviasi to Sales — actually
    // print '-'; unsigned rows are a no-op). Selisih: chgColor with the
    // metric's goodUp — a positive selisih on a badUp metric means side
    // A deviates MORE (red), on QTY BOM it means A carries more stock
    // (green, the growth-table convention).
    cellColor: (row, ri, ci) => {
      if (ci === 1 || ci === 2) return negColor(row[ci]);
      if (ci === 3) {
        const r = rows[ri];
        const va = r.get(a);
        const vb = r.get(b);
        const d = va != null && vb != null ? va - vb : null;
        return chgColor(d, r.goodUp);
      }
      return undefined;
    },
  });
}

// ============================================================
//  2 — VS growth table (side-by-side growth % vs the compare period)
// ============================================================
function drawVersusGrowthTable(rpt: Rpt, duel: Duel): void {
  const a = duel.a.data.executiveSummary;
  const b = duel.b.data.executiveSummary;
  const defs: Array<{ label: string; ga: number | null; gb: number | null; goodUp: boolean }> = [
    { label: 'Penjualan', ga: a.sales.growth, gb: b.sales.growth, goodUp: true },
    { label: 'Nominal Deviasi', ga: a.nominalDeviasi.growth, gb: b.nominalDeviasi.growth, goodUp: false },
    { label: 'QTY BOM', ga: a.qtyBom.growth, gb: b.qtyBom.growth, goodUp: true },
    { label: 'QTY Deviasi', ga: a.qtyDeviasi.growth, gb: b.qtyDeviasi.growth, goodUp: false },
    { label: 'QTY Waste', ga: a.qtyWaste.growth, gb: b.qtyWaste.growth, goodUp: false },
    { label: 'QTY Susut', ga: a.qtySusut.growth, gb: b.qtySusut.growth, goodUp: false },
    { label: 'QTY Trial', ga: a.qtyTrial.growth, gb: b.qtyTrial.growth, goodUp: false },
  ];
  const withAny = defs.some((d) => d.ga != null || d.gb != null);
  if (!withAny) return;
  rpt.subhead(
    `2.VS Growth % vs periode pembanding \u2014 ${duel.a.name} vs ${duel.b.name}`,
    { size: 8.5 },
  );
  rpt.table({
    cols: [
      { header: 'Metrik' },
      { header: duel.a.name, align: 'right' },
      { header: duel.b.name, align: 'right' },
    ],
    boldFirst: true,
    rows: defs.map((d) => [d.label, mkGrowth(d.ga), mkGrowth(d.gb)]),
    cellColor: (_row, ri, ci) =>
      ci === 1
        ? chgColor(defs[ri]?.ga, defs[ri]?.goodUp ?? false)
        : ci === 2
          ? chgColor(defs[ri]?.gb, defs[ri]?.goodUp ?? false)
          : undefined,
  });
}

// ============================================================
//  Main entry — drawReportVersus
// ============================================================
export function drawReportVersus(
  rpt: Rpt,
  doc: PDFKit.PDFDocument,
  dataA: ReportData,
  ctx: ReportContext,
  versus: VersusReportInput,
): void {
  const focusCode =
    dataA.filters.outletCode && dataA.filters.outletCode !== 'all'
      ? dataA.filters.outletCode
      : versus.code;
  const duel: Duel = {
    a: {
      code: focusCode,
      name: versus.focusName,
      data: dataA,
      env: createSectionEnv(rpt, doc, dataA, ctx),
    },
    b: {
      code: versus.code,
      name: versus.name,
      data: versus.data,
      env: createSectionEnv(rpt, doc, versus.data, ctx),
    },
  };
  // Section 11 highlights BOTH restos — side A's env carries the
  // comparator code (side B's env renders nothing population-wide).
  duel.a.env.versusPeerCode = versus.code;

  const a = () => sideBlock(rpt, duel.a.name, C.focusRow, () => drawExecSection(duel.a.env));
  const b = () => sideBlock(rpt, duel.b.name, C.borderSoft, () => drawExecSection(duel.b.env));

  drawVersusCover(rpt, duel);

  // 1 — Ringkasan: VS table + both sides' exec tables.
  if (duel.a.env.hasSection('exec')) {
    rpt.sectionHeader(1, `Ringkasan \u2014 ${duel.a.name} vs ${duel.b.name}`);
    drawVersusKpiTable(rpt, duel);
    a();
    b();
  }

  // 2 — Perubahan vs periode pembanding: VS growth table + both sides.
  if (duel.a.env.hasSection('growth')) {
    const cmpTitle = duel.a.env.cmpFull ? ` vs ${duel.a.env.cmpFull}` : '';
    rpt.sectionHeader(2, `Perubahan${cmpTitle} \u2014 ${duel.a.name} vs ${duel.b.name}`);
    drawVersusGrowthTable(rpt, duel);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawGrowthSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawGrowthSection(duel.b.env));
  }

  // 3-10 — the per-resto sections: numbered versus header + the two
  // badge blocks (each renderer early-returns on its ?sections= gate).
  if (duel.a.env.hasSection('topItems')) {
    rpt.sectionHeader(3, `Item Prioritas (Top Items) \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawTopItemsSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawTopItemsSection(duel.b.env));
  }
  if (duel.a.env.hasSection('variance')) {
    const cmp = duel.a.env.cmpFull ? ` (vs ${duel.a.env.cmpFull})` : '';
    rpt.sectionHeader(4, `Perubahan Item${cmp} \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawVarianceSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawVarianceSection(duel.b.env));
  }
  if (duel.a.env.hasSection('waste')) {
    rpt.sectionHeader(5, `Analisis Waste \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawWasteSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawWasteSection(duel.b.env));
  }
  if (duel.a.env.hasSection('itemTrend')) {
    rpt.sectionHeader(6, `Trend Item Multi-Periode \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawTrendMatrixSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawTrendMatrixSection(duel.b.env));
  }
  if (duel.a.env.hasSection('anomali')) {
    rpt.sectionHeader(7, `Item Anomali vs Riwayat Sendiri \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawAnomalySection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawAnomalySection(duel.b.env));
  }
  if (duel.a.env.hasSection('trend')) {
    rpt.sectionHeader(8, `Trend Antar Periode \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawTrendSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawTrendSection(duel.b.env));
  }
  if (duel.a.env.hasSection('peer')) {
    rpt.sectionHeader(9, `Resto dengan Penjualan Kurang Lebih Sama \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawPeerSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawPeerSection(duel.b.env));
  }
  if (duel.a.env.hasSection('flip')) {
    rpt.sectionHeader(10, `Item yang Kemungkinan Plus Minus antar Periode \u2014 ${duel.a.name} vs ${duel.b.name}`);
    sideBlock(rpt, duel.a.name, C.focusRow, () => drawFlipSection(duel.a.env));
    sideBlock(rpt, duel.b.name, C.borderSoft, () => drawFlipSection(duel.b.env));
  }

  // 11 — ONE league table; outlet-league.ts highlights BOTH restos
  // (side A's env carries versusPeerCode). Badge mode stays OFF — the
  // renderer draws its own numbered header + population subhead.
  drawOutletLeagueSection(duel.a.env);

  // 12 — ONE area table (population-wide; identical rows on both sides).
  drawAreaCompareSection(duel.a.env);

  // 13 — side A verbatim: the forced comparator set makes the
  // CC-NAMES-1 duo layout print "13. Komparasi A vs B" + the per-item
  // head-to-head (13.3).
  drawCustomCompareSection(duel.a.env);
}
