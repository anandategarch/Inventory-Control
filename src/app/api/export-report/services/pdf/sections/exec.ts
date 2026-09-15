// ============================================================
//  1 — RINGKASAN  (EXPORT-TRIM: renamed from "Ringkasan Eksekutif")
// ============================================================
import { calcGrowth } from '@/lib/metrics';
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import type { SectionEnv } from '../section-context';
import { chgColor, mkGrowth } from '../pdf-style';

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
  const defs: Array<[string, string, number | null, string, boolean]> = [
    ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth, fmtIDR(s.nominalDeviasi.previous), false],
    ['Nominal Deviasi to Sales', fmtPct(devToSalesCur, false), devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null, fmtPct(devToSalesPrev, false), false],
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
    cellColor: (row, ri, ci) => (ci === 2 ? chgColor(defs[ri]?.[2], defs[ri]?.[4] ?? false) : undefined),
  });
}
