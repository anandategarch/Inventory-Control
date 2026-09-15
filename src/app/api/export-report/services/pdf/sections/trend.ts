// ============================================================
//  7 — TREND ANTAR PERIODE  (EXPORT-TRIM: was 12; REFINE-3: was 6)
//  REFINE-1: Loss / Surplus table columns REMOVED (user: "Trend antar
//  periode hapuss kolom loss dan surplus") — the loss-vs-surplus line
//  chart below still carries that composition per period.
//  REFINE-3: + the current month's weekly composition chart (user:
//  "Grafik komposisi Waste/Susut/Trial/Loss-Surplus") + the weekly
//  accumulation chart (user: "Tren akumulasi mingguan (Week 1+2+)").
// ============================================================
import { fmtIDR, fmtPct } from '../../format-helpers';
import { barChartV, lineChart, stackedBarChartV } from '../pdf-charts';
import { C, PAGE, CONTENT_W } from '../pdf-primitives';
import { tickIDR, titleCase } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawTrendSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, currLabel } = env;
  if (!hasSection('trend')) return;
  // BUG-HUNT (numbering continuity): empty trend data used to skip the
  // whole section → the numbers jumped. Header + factual note instead.
  rpt.sectionHeader(7, 'Trend Antar Periode');
  if (data.trend.length === 0) {
    rpt.noteBox('Tidak ada data trend antar periode pada scope ini.');
    return;
  }
  rpt.table({
    cols: [
      { header: 'Periode' },
      { header: 'Nominal Deviasi', align: 'right' },
      { header: '% Dev/BOM', align: 'right' },
      { header: 'Nominal Deviasi to Sales', align: 'right' },
    ],
    rows: data.trend.map((t) => [
      t.weekLabel,
      fmtIDR(t.nominal),
      fmtPct(t.devBom, false),
      // BUG-HUNT: SIGNED (was Math.abs — the same metric renders signed
      // in sections 1/2 + the KPI card; an ABS here contradicted the
      // signed "Nominal Deviasi" column right next to it).
      t.sales && t.sales > 0 ? fmtPct(t.nominal / t.sales, false) : '\u2014',
    ]),
  });

  const labels = data.trend.map((t) => t.weekLabel.replace(` ${currLabel.split(' ')[0]}`, '').replace(/\s*$/, '')).map((l, i) => (data.trend.length > 8 && i % 2 === 1 ? '' : l));
  // bar — nominal per period
  // BUG-HUNT: SIGNED values (was Math.abs) + barChartV's new diverging
  // axis — a net-negative period now draws a red bar DOWN from the zero
  // baseline, matching the signed table instead of contradicting it.
  rpt.ensure(160);
  rpt.subhead('Nominal Deviasi per Periode (Rp)', { size: 8.5, gapAfter: 2 });
  barChartV(doc, {
    x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
    labels,
    values: data.trend.map((t) => t.nominal),
    fmt: tickIDR,
  });
  rpt.y += 140 + 16;

  // line — loss vs surplus
  if (data.trend.length >= 2) {
    rpt.ensure(160);
    rpt.subhead('Loss vs Surplus per Periode (Rp)', { size: 8.5, gapAfter: 2 });
    lineChart(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
      xLabels: labels,
      series: [
        // DESAIN-SIMPEL: per-period legend labels — no "Total" wording
        // (the Total LOSS/SURPLUS metrics were removed by user request).
        { name: 'Loss', values: data.trend.map((t) => t.lossNominal), color: C.danger },
        { name: 'Surplus', values: data.trend.map((t) => t.surplusNominal), color: C.success },
      ],
      yFmt: tickIDR,
    });
    rpt.y += 140 + 16;
  }

  // REFINE-3 (user: "Grafik komposisi Waste/Susut/Trial/Loss-Surplus"):
  // per-week composition of the CURRENT month's deviation magnitude —
  // ABS nominal per category (their stack = the week's total deviation
  // magnitude). Weeks after the exported week are already excluded
  // upstream (data-fetcher — same rule as the itemTrend matrix's future
  // months). Palette: 3 neutral grays + danger red on the Loss/Surplus
  // residual (the unexplained remainder is the flag-worthy category).
  const wc = data.weeklyComposition;
  if (wc.length > 0) {
    // BUG-HUNT: reserve subhead (≈14.5) + chart (140) — the old 150 let
    // the chart's bottom edge spill ~4.5pt into the bottom margin.
    rpt.ensure(160);
    rpt.subhead(`Komposisi Deviasi per Minggu — ${titleCase(data.period.monthLabel)} (Rp)`, { size: 8.5, gapAfter: 2 });
    stackedBarChartV(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
      labels: wc.map((r) => `W${r.weekNo}`),
      series: [
        { name: 'Waste', values: wc.map((r) => r.nominalWaste), color: C.inkSoft },
        { name: 'Susut', values: wc.map((r) => r.nominalSusut), color: C.muted },
        { name: 'Trial', values: wc.map((r) => r.nominalTrial), color: C.faint },
        { name: 'Loss/Surplus', values: wc.map((r) => r.nominalLossSurplus), color: C.danger },
      ],
      fmt: tickIDR,
    });
    rpt.y += 140 + 16;

    // REFINE-3 (user: "Tren akumulasi mingguan (Week 1+2+…)"): running
    // total of the month's deviation magnitude — bar j is the cumulative
    // absTotal of weeks 1..j ("W1+2+…"), so the last bar is the
    // month-to-date total as of the exported week (highlighted by
    // barChartV's default last-bar emphasis).
    let acc = 0;
    const cum = wc.map((r) => { acc += r.absTotal; return acc; });
    const cumLabels = wc.map((_r, j) => 'W' + wc.slice(0, j + 1).map((r) => r.weekNo).join('+'));
    rpt.ensure(160);
    rpt.subhead('Akumulasi Mingguan — Total Deviasi (Rp)', { size: 8.5, gapAfter: 2 });
    barChartV(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
      labels: cumLabels,
      values: cum,
      fmt: tickIDR,
    });
    rpt.y += 140 + 16;
  }
}
