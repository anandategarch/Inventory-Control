// ============================================================
//  2 — PERUBAHAN VS <PERIODE PEMBANDING DINAMAI>
//  REFINE-1: the title names the actual selected comparator period
//  ("Perubahan vs Agustus 2026 Week 1") — user: "Kata pembanding jadi Kata
//  periode yang terpilih menjadi pembanding. Misal Agustus 2026 week 1".
// ============================================================
import { calcGrowth, calcGrowthAbs } from '@/lib/metrics';
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { hBarChart } from '../pdf-charts';
import { C, PAGE, CONTENT_W, markOf } from '../pdf-primitives';
import { chgColor, fmtPp, mkGrowth, negColor } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawGrowthSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, currCol, prevCol, cmpFull } = env;
  if (!hasSection('growth')) return;
  rpt.sectionHeader(2, cmpFull ? `Perubahan vs ${cmpFull}` : 'Perubahan');
  const s = data.executiveSummary;
  const pm = s._prevMetrics;
  const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
  const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
    ? s.nominalDeviasi.previous / s.sales.previous
    : null;
  type GRow = { cells: string[]; g: number | null; goodUp: boolean };
  // PDFCOLOR-8 (deep-audit sign-quadrant pass): "Nominal Deviasi to
  // Sales" is a SIGNED ratio — its change column is MAGNITUDE growth
  // now (calcGrowthAbs), matching the exec row + cover KPI sub. The old
  // signed calcGrowth + goodUp=false inverted on the loss side (ratio
  // worsening −0.26% → −0.54% painted GREEN "▼−106%" — deviation had
  // doubled; the REFINE-4 complaint class missed on this ratio).
  const devToSalesGrowth = devToSalesCur != null && devToSalesPrev != null ? calcGrowthAbs(devToSalesCur, devToSalesPrev) : null;
  const vr = (label: string, cur: number | null, prev: number | null, fmt: typeof fmtIDR, growth: number | null, goodUp: boolean): GRow => ({
    cells: [
      label, fmt(cur), fmt(prev),
      cur != null && prev != null ? markOf(cur - prev) + fmt(cur - prev) : '\u2014',
      mkGrowth(growth),
    ],
    g: growth, goodUp,
  });
  const rr = (label: string, cur: number | null, prev: number | null, growth: number | null, goodUp: boolean): GRow => ({
    cells: [
      label, fmtPct(cur, false), fmtPct(prev, false),
      cur != null && prev != null ? markOf(cur - prev) + fmtPp(cur - prev) : '\u2014',
      mkGrowth(growth),
    ],
    g: growth, goodUp,
  });
  // REFINE-1: Penjualan (Rp) row REMOVED (sales nominal confidential — the
  // % change lives on the cover card + the growth bars below); % Loss to
  // Sales / % Surplus to Sales rows REMOVED; "% Nominal Deviasi to Sales"
  // renamed "Nominal Deviasi to Sales".
  const defs: GRow[] = [
    vr('Nominal Deviasi (Rp)', s.nominalDeviasi.current, s.nominalDeviasi.previous, fmtIDR, s.nominalDeviasi.growth, false),
    vr('QTY BOM', s.qtyBom.current, s.qtyBom.previous, fmtNum, s.qtyBom.growth, true),
    vr('QTY Deviasi', s.qtyDeviasi.current, s.qtyDeviasi.previous, fmtNum, s.qtyDeviasi.growth, false),
    vr('QTY Waste', s.qtyWaste.current, s.qtyWaste.previous, fmtNum, s.qtyWaste.growth, false),
    vr('QTY Susut', s.qtySusut.current, s.qtySusut.previous, fmtNum, s.qtySusut.growth, false),
    vr('QTY Trial', s.qtyTrial.current, s.qtyTrial.previous, fmtNum, s.qtyTrial.growth, false),
    rr('% Deviasi To BOM', s.deviationToBom, pm?.deviationToBom ?? null, pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, false),
    rr('Nominal Deviasi to Sales', devToSalesCur, devToSalesPrev, devToSalesGrowth, false),
  ];
  rpt.table({
    cols: [
      { header: 'Metrik' },
      { header: currCol, align: 'right' },
      { header: prevCol, align: 'right' },
      { header: 'Selisih', align: 'right' },
      { header: 'Growth %', align: 'right' },
    ],
    boldFirst: true,
    rows: defs.map((d) => d.cells),
    // ▲/▼ + semantic color on the Selisih and Growth % columns.
    // PDFCOLOR-1 (user: "terkait minus atau penurunan harusnya warna
    // merah"): the current/previous VALUE columns are minus-red — the
    // "Nominal Deviasi (Rp)" / "Nominal Deviasi to Sales" rows are
    // SIGNED, and their "-Rp …" / "-x.xx%" cells were neutral ink
    // (same class as section 1's fix). Unsigned rows are a no-op.
    cellColor: (row, ri, ci) => {
      if (ci === 3 || ci === 4) return chgColor(defs[ri]?.g, defs[ri]?.goodUp ?? false);
      if (ci === 1 || ci === 2) return negColor(row[ci]);
      return undefined;
    },
  });

  // growth % horizontal bars — sales/BOM up = green (good); deviation
  // metrics up = red (bad). Factual coloring by metric direction.
  // REFINE-1: the Penjualan BAR stays — it IS "tampilkan aja persentasi
  // kenaikan" (a % change, not a nominal). % Loss/% Surplus bars REMOVED.
  const withGrowth = [
    { label: 'Penjualan', g: s.sales.growth, goodUp: true },
    { label: 'Nominal Deviasi', g: s.nominalDeviasi.growth, goodUp: false },
    { label: 'QTY BOM', g: s.qtyBom.growth, goodUp: true },
    { label: 'QTY Deviasi', g: s.qtyDeviasi.growth, goodUp: false },
    { label: 'QTY Waste', g: s.qtyWaste.growth, goodUp: false },
    { label: 'QTY Susut', g: s.qtySusut.growth, goodUp: false },
    { label: 'QTY Trial', g: s.qtyTrial.growth, goodUp: false },
    { label: '% Dev/BOM', g: pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, goodUp: false },
  ].filter((r) => r.g != null) as Array<{ label: string; g: number; goodUp: boolean }>;
  if (withGrowth.length > 0) {
    rpt.ensure(18 * withGrowth.length + 24);
    rpt.subhead('Growth % per Metrik', { size: 8.5, gapAfter: 2 });
    hBarChart(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * withGrowth.length,
      labels: withGrowth.map((r) => r.label),
      values: withGrowth.map((r) => r.g * 100),
      fmt: (v) => markOf(v) + `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
      colors: withGrowth.map((r) => (r.g > 0 ? (r.goodUp ? C.success : C.danger) : r.goodUp ? C.danger : C.success)),
      labelW: 118, valW: 52,
    });
    rpt.y += 18 * withGrowth.length + 6;
  }
}
