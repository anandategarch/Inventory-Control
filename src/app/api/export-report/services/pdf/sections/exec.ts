// ============================================================
//  1 — RINGKASAN  (EXPORT-TRIM: renamed from "Ringkasan Eksekutif")
// ============================================================
import { calcGrowth, calcGrowthAbs } from '@/lib/metrics';
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import type { SectionEnv } from '../section-context';
import { chgColor, mkGrowth, negColor } from '../pdf-style';

export function drawExecSection(env: SectionEnv): void {
  const { rpt, data, hasSection, currCol, prevCol } = env;
  if (!hasSection('exec')) return;
  rpt.sectionHeader(1, 'Ringkasan');
  const s = data.executiveSummary;
  const pm = s._prevMetrics;
  const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
  const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
    ? s.nominalDeviasi.previous / s.sales.previous
    : null;
  // [label, current, change value (marker + color source), previous, goodUp]
  // REFINE-1: the Penjualan row is GONE (sales nominal is confidential —
  // its ▲/▼ % change lives on the cover KPI card + the growth bars);
  // % Loss to Sales / % Surplus to Sales rows REMOVED ("gak perlu jadi
  // hapus aja"); "% Nominal Deviasi to Sales" renamed "Nominal Deviasi
  // to Sales" ("rename sesuai headernya").
  // PDFCOLOR-8 (deep-audit sign-quadrant pass): the "Nominal Deviasi to
  // Sales" change is now MAGNITUDE growth (calcGrowthAbs on the signed
  // ratio) — the old SIGNED calcGrowth + goodUp=false inverted on the
  // loss side: a ratio worsening −0.26% → −0.54% printed "▼−106.15%"
  // GREEN while the deviation had DOUBLED (the exact REFINE-4 complaint
  // class, fixed for nominalDeviasi but missed on this signed RATIO).
  // |cur| vs |prev|: worsening = red ▲+107%, improving = green ▼−52%.
  const devToSalesGrowth = devToSalesCur != null && devToSalesPrev != null ? calcGrowthAbs(devToSalesCur, devToSalesPrev) : null;
  const defs: Array<[string, string, number | null, string, boolean]> = [
    ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth, fmtIDR(s.nominalDeviasi.previous), false],
    ['Nominal Deviasi to Sales', fmtPct(devToSalesCur, false), devToSalesGrowth, fmtPct(devToSalesPrev, false), false],
    ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth, fmtNum(s.qtyBom.previous), true],
    ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth, fmtNum(s.qtyDeviasi.previous), false],
    ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, pm?.deviationToBom != null ? fmtPct(pm.deviationToBom, false) : '\u2014', false],
    ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth, fmtNum(s.qtyWaste.previous), false],
    ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth, fmtNum(s.qtySusut.previous), false],
    ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth, fmtNum(s.qtyTrial.previous), false],
    ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth, fmtNum(s.qtyLossSurplus.previous), false],
    ['Loss/Surplus Qty', fmtNum(s.residualLossQty), pm?.residualLossQty != null ? calcGrowth(s.residualLossQty, pm.residualLossQty) : null, pm?.residualLossQty != null ? fmtNum(pm.residualLossQty) : '\u2014', false],
    ['Loss/Surplus %', fmtPct(s.residualLossPct, false), pm?.residualLossPct != null ? calcGrowth(s.residualLossPct, pm.residualLossPct) : null, pm?.residualLossPct != null ? fmtPct(pm.residualLossPct, false) : '\u2014', false],
  ];
  rpt.table({
    cols: [
      { header: 'Metrik' },
      { header: currCol, align: 'right' },
      { header: 'Perubahan', align: 'right' },
      { header: prevCol, align: 'right' },
    ],
    boldFirst: true,
    rows: defs.map((d) => [d[0], d[1], mkGrowth(d[2]), d[3]]),
    // FIX-TERPOTONG: ▲/▼ + semantic color on the Perubahan column only
    // (the rest of the row stays neutral ink).
    // PDFCOLOR-1 (user: "terkait minus atau penurunan harusnya warna
    // merah"): the current/previous VALUE columns are minus-red too — the
    // "Nominal Deviasi" / "Nominal Deviasi to Sales" rows are SIGNED
    // (SUM(nominalDeviasi)), and a "-Rp 4.5 Jt" printed in neutral ink
    // contradicted the minus-red rule the user set in PEERTOP-R1 and every
    // red rendering of the same figure elsewhere (3.1/8.1/8.3/heat/bar
    // chart). Unsigned rows (QTY Waste/Susut/Trial, % Deviasi To BOM …)
    // never print '-' — negColor is a no-op there.
    cellColor: (row, ri, ci) => {
      if (ci === 2) return chgColor(defs[ri]?.[2], defs[ri]?.[4] ?? false);
      if (ci === 1 || ci === 3) return negColor(row[ci]);
      return undefined;
    },
  });
}
