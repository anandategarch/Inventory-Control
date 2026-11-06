// ============================================================
//  versus-report — the "1 Resto vs 1 Resto" report layout
//  --------------------------------------------------------
//  VERSUS-2R (user request: "aku mau sekarang dari poin 1 sampai 12
//  itu adalah laporan versus jadi Resto BKS gol versus ckg Pak"):
//  mode 2 turns the WHOLE report into the duel. The route already ran
//  the full data pipeline for BOTH outlets (data-fetcher/versus.ts).
//
//  DUEL-LR (user request: "misal mode compare harusnya layout nya
//  kiri dan kanan bukan atas bawah kan? nama nya juga compare"): the
//  versus document is A4 LANDSCAPE and every per-resto section 1-10
//  renders in TWO SYNCHRONIZED COLUMNS — resto fokus LEFT, resto
//  pembanding RIGHT (pdf/columns.ts records each side into a
//  column-local shadow and replays them page-synchronized). The old
//  stacked "A's block above B's block" layout is gone.
//
//    Cover   — "Laporan Versus" band, then each side's 4 KPI hero
//              cards side by side under its NAMA badge (CC-NAMES-1:
//              names, never generic "resto pembanding" labels) with a
//              dark VS emblem in the center gutter.
//    1-2     — the numbered versus header, the full-width side-by-side
//              VS table (current values / growth %, both restos +
//              Selisih), THEN the two sides' own blocks in columns.
//    3-10    — the numbered versus header + the duo columns (the
//              sections are per-resto lists/tables/charts by nature;
//              each column opens with its side's NAMA badge — the
//              renderer's own sectionHeader call, reused verbatim via
//              the versusBadge mechanism).
//    11      — ONE league table, BOTH restos highlighted (the full
//              env carries versusPeerCode — see outlet-league.ts).
//    12      — ONE area table (population-wide; identical data both
//              sides — rendering it twice would be pure duplication).
//    13      — side A's renderer verbatim: the route FORCED side A's
//              comparator set to the versus resto, so the CC-NAMES-1
//              duo layout prints "13. Komparasi A vs B" with the
//              per-item head-to-head — the most detailed versus table
//              of the whole report.
//
//  Section numbering stays FIXED (1-13, the pdf-builder map) — the
//  versus mode changes WHO each section compares, not the report's
//  shape. ?sections=/sub-tokens gate every block exactly like mode
//  standar (both sides share the SAME ctx.sections list).
// ============================================================
import type { ReportContext, ReportData, VersusReportInput } from '../types';
import { fmtIDR, fmtNum, fmtPct } from '../format-helpers';
import { C, markOf, type Rpt } from './pdf-primitives';
import { chgColor, mkGrowth, negColor } from './pdf-style';
import { createSectionEnv, type SectionEnv } from './section-context';
import { composeDuo, type DuoSpec } from './columns';
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

/** The two sides of the duel (data + identity only — the full-width env
 *  lives on side A; each duo column gets its own shadow env at record
 *  time, see duoSpec below). */
interface DuelSide {
  code: string;
  name: string;
  data: ReportData;
}

/**
 * DUEL-LR — build one side's DuoSpec: the renderer runs inside a
 * column-local shadow (see pdf/columns.ts recordSide), with a fresh
 * SectionEnv over the SAME ctx (identical ?sections= gating on both
 * sides). recordSide sets versusBadge mode, so the renderer's own
 * sectionHeader call renders this side's NAMA badge at the top of the
 * column — the twelve section modules are reused VERBATIM.
 */
function duoSpec(
  side: DuelSide,
  fill: string,
  ctx: ReportContext,
  draw: (env: SectionEnv) => void,
): DuoSpec {
  return {
    name: side.name,
    fill,
    render: (rpt, doc) => draw(createSectionEnv(rpt, doc, side.data, ctx)),
  };
}

// ============================================================
//  Cover — both sides' KPI hero cards, LEFT/RIGHT
// ============================================================
function drawVersusCover(rpt: Rpt, a: DuelSide, b: DuelSide, envFull: SectionEnv): void {
  const kpisAvailable = envFull.hasSection('exec') || envFull.hasSection('growth');
  // DUEL-CLEAN (rv 23): tanpa judul cover "Laporan Versus Deviasi · X vs
  //  Y · <bulan>" — permintaan user berulang ("gak perlu ada header atau
  //  footer yang gak perlu di laporan PDF"). Halaman 1 kini langsung
  //  dimulai dari konten: badge NAMA kedua sisi + kartu KPI 2×2 per sisi
  //  + emblem VS. Identitas duel cukup terbaca dari badge NAMA, tabel VS
  //  ("Ringkasan — A vs B"), dan nama file unduhan (CC-NAMES-1).
  if (!kpisAvailable) return;
  // Each side's 4 hero cards (the drawCover set) in its own COLUMN —
  // perRow 2 gives a 2x2 grid per side, side by side under the badges.
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
  const cmpFull = envFull.cmpFull;
  composeDuo(
    rpt,
    {
      name: a.name,
      fill: C.focusRow,
      render: (srpt) => {
        srpt.kpiCards(cardRow(a.data.executiveSummary, cmpFull), { perRow: 2 });
      },
    },
    {
      name: b.name,
      fill: C.borderSoft,
      render: (srpt) => {
        srpt.kpiCards(cardRow(b.data.executiveSummary, cmpFull), { perRow: 2 });
      },
    },
    { withBadges: true, gutterEmblem: 'VS' },
  );
}

// ============================================================
//  1 — VS KPI table (full width: current values + Selisih)
// ============================================================
interface VsRow {
  label: string;
  /** Numeric accessor (null = no value this period). */
  get: (s: ReportData["executiveSummary"]) => number | null;
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

/** The full-width VS table leading section 1 (current period values). */
function drawVersusKpiTable(rpt: Rpt, a: DuelSide, b: DuelSide, currCol: string): void {
  const rows = vsValueRows();
  const ea = a.data.executiveSummary;
  const eb = b.data.executiveSummary;
  rpt.subhead(
    `1.VS ${a.name} vs ${b.name} (${currCol}) \u2014 selisih = ${a.name} \u2212 ${b.name}`,
    { size: 8.5 },
  );
  const table = rows.map((r) => {
    const va = r.get(ea);
    const vb = r.get(eb);
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
      { header: a.name, align: 'right' },
      { header: b.name, align: 'right' },
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
        const va = r.get(ea);
        const vb = r.get(eb);
        const d = va != null && vb != null ? va - vb : null;
        return chgColor(d, r.goodUp);
      }
      return undefined;
    },
  });
}

// ============================================================
//  2 — VS growth table (full width: growth % vs the compare period)
// ============================================================
function drawVersusGrowthTable(rpt: Rpt, a: DuelSide, b: DuelSide): void {
  const ea = a.data.executiveSummary;
  const eb = b.data.executiveSummary;
  const defs: Array<{ label: string; ga: number | null; gb: number | null; goodUp: boolean }> = [
    { label: 'Penjualan', ga: ea.sales.growth, gb: eb.sales.growth, goodUp: true },
    { label: 'Nominal Deviasi', ga: ea.nominalDeviasi.growth, gb: eb.nominalDeviasi.growth, goodUp: false },
    { label: 'QTY BOM', ga: ea.qtyBom.growth, gb: eb.qtyBom.growth, goodUp: true },
    { label: 'QTY Deviasi', ga: ea.qtyDeviasi.growth, gb: eb.qtyDeviasi.growth, goodUp: false },
    { label: 'QTY Waste', ga: ea.qtyWaste.growth, gb: eb.qtyWaste.growth, goodUp: false },
    { label: 'QTY Susut', ga: ea.qtySusut.growth, gb: eb.qtySusut.growth, goodUp: false },
    { label: 'QTY Trial', ga: ea.qtyTrial.growth, gb: eb.qtyTrial.growth, goodUp: false },
  ];
  const withAny = defs.some((d) => d.ga != null || d.gb != null);
  if (!withAny) return;
  rpt.subhead(
    `2.VS Growth % vs periode pembanding \u2014 ${a.name} vs ${b.name}`,
    { size: 8.5 },
  );
  rpt.table({
    cols: [
      { header: 'Metrik' },
      { header: a.name, align: 'right' },
      { header: b.name, align: 'right' },
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
//  Main entry — drawReportVersus (DUEL-LR landscape layout)
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
  const a: DuelSide = { code: focusCode, name: versus.focusName, data: dataA };
  const b: DuelSide = { code: versus.code, name: versus.name, data: versus.data };

  // Full-width env (side A) — section gating + the population-wide
  // sections 11-13. Section 11 highlights BOTH restos via versusPeerCode.
  const envFull = createSectionEnv(rpt, doc, dataA, ctx);
  envFull.versusPeerCode = versus.code;

  // The two column specs (focus LEFT amber, comparator RIGHT neutral).
  const focus = (draw: (env: SectionEnv) => void): DuoSpec => duoSpec(a, C.focusRow, ctx, draw);
  const cmp = (draw: (env: SectionEnv) => void): DuoSpec => duoSpec(b, C.borderSoft, ctx, draw);

  drawVersusCover(rpt, a, b, envFull);

  // 1 — Ringkasan: full-width VS table, then both sides in columns.
  if (envFull.hasSection('exec')) {
    rpt.sectionHeader(1, `Ringkasan \u2014 ${a.name} vs ${b.name}`);
    drawVersusKpiTable(rpt, a, b, envFull.currCol);
    composeDuo(rpt, focus(drawExecSection), cmp(drawExecSection));
  }

  // 2 — Perubahan vs periode pembanding: VS growth table + columns.
  if (envFull.hasSection('growth')) {
    const cmpTitle = envFull.cmpFull ? ` vs ${envFull.cmpFull}` : '';
    rpt.sectionHeader(2, `Perubahan${cmpTitle} \u2014 ${a.name} vs ${b.name}`);
    drawVersusGrowthTable(rpt, a, b);
    composeDuo(rpt, focus(drawGrowthSection), cmp(drawGrowthSection));
  }

  // 3-10 — the per-resto sections: numbered versus header + the duo
  // columns (each renderer early-returns on its ?sections= gate).
  if (envFull.hasSection('topItems')) {
    rpt.sectionHeader(3, `Item Prioritas (Top Items) \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawTopItemsSection), cmp(drawTopItemsSection));
  }
  if (envFull.hasSection('variance')) {
    const cmpP = envFull.cmpFull ? ` (vs ${envFull.cmpFull})` : '';
    rpt.sectionHeader(4, `Perubahan Item${cmpP} \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawVarianceSection), cmp(drawVarianceSection));
  }
  if (envFull.hasSection('waste')) {
    rpt.sectionHeader(5, `Analisis Waste \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawWasteSection), cmp(drawWasteSection));
  }
  if (envFull.hasSection('itemTrend')) {
    rpt.sectionHeader(6, `Trend Item Multi-Periode \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawTrendMatrixSection), cmp(drawTrendMatrixSection));
  }
  if (envFull.hasSection('anomali')) {
    rpt.sectionHeader(7, `Item Anomali vs Riwayat Sendiri \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawAnomalySection), cmp(drawAnomalySection));
  }
  if (envFull.hasSection('trend')) {
    rpt.sectionHeader(8, `Trend Antar Periode \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawTrendSection), cmp(drawTrendSection));
  }
  if (envFull.hasSection('peer')) {
    rpt.sectionHeader(9, `Resto dengan Penjualan Kurang Lebih Sama \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawPeerSection), cmp(drawPeerSection));
  }
  if (envFull.hasSection('flip')) {
    rpt.sectionHeader(10, `Item yang Kemungkinan Plus Minus antar Periode \u2014 ${a.name} vs ${b.name}`);
    composeDuo(rpt, focus(drawFlipSection), cmp(drawFlipSection));
  }

  // 11 — ONE league table; outlet-league.ts highlights BOTH restos
  // (the full env carries versusPeerCode). Badge mode stays OFF — the
  // renderer draws its own numbered header + population subhead.
  drawOutletLeagueSection(envFull);

  // 12 — ONE area table (population-wide; identical rows on both sides).
  drawAreaCompareSection(envFull);

  // 13 — side A verbatim: the forced comparator set makes the
  // CC-NAMES-1 duo layout print "13. Komparasi A vs B" + the per-item
  // head-to-head (13.3).
  drawCustomCompareSection(envFull);
}
