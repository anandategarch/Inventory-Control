// ============================================================
//  SPLIT-0-A: pure builders deret waste jaringan — dipindah
//  VERBATIM dari network.ts (479 LOC; barrel: ./index.ts).
//
//  buildWasteMonthlyRows / buildWasteOutlets / buildWasteKpis —
//  lapisan PURE atas baris SQL (dipakai vitest langsung dari
//  barrel waste-series). Ketiga detektor TS (zeroWasteBigLoss /
//  underRecording / residualDominant) tetap INLINE verbatim di
//  dalam buildWasteOutlets — mereka ekspresi per-outlet atas
//  baris bulanan, bukan fungsi mandiri; mengekstraknya ke
//  detectors.ts terpisah berarti MELENGKUNG ekspresi inline
//  menjadi fungsi = rewrite, bukan split mekanis. Detektor
//  keempat (spike 2σ) hidup di SQL query.ts (CTE outlet_stats +
//  monthly_final). Konstanta ambang tetap di ../shared.ts.
// ============================================================
import {
  toNum,
  WASTE_MIN_SHARE,
  WASTE_RESIDUAL_DOMINANT_PCT,
  WASTE_UNDER_RECORD_PCT,
} from '../shared';
import type {
  WasteKpis,
  WasteMonthlyRawRow,
  WasteMonthlyRow,
  WasteOutletRow,
} from './types';

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

/** Map raw SQL rows → WasteMonthlyRow[] adding the ratios. */
export function buildWasteMonthlyRows(raw: WasteMonthlyRawRow[]): WasteMonthlyRow[] {
  return raw.map((r) => {
    const sales = toNum(r.sales);
    const totalLoss = toNum(r.totalLoss);
    const waste = toNum(r.waste);
    const residual = toNum(r.residual);
    return {
      outletCode: r.outletCode,
      outletName: r.outletName,
      area: r.area,
      monthKey: r.monthKey,
      monthLabel: r.monthLabel,
      sales,
      waste,
      susut: toNum(r.susut),
      trial: toNum(r.trial),
      residual,
      totalLoss,
      totalSurplus: toNum(r.totalSurplus),
      wasteToSales: sales > 0 ? waste / sales : 0,
      wasteShareOfLoss: totalLoss > 0 ? waste / totalLoss : 0,
      residualShare: totalLoss > 0 ? residual / totalLoss : 0,
      spike: Number(r.spike) === 1,
      dqError: Boolean(r.dqError),
      dqErrorCount: toNum(r.dqErrorCount),
    };
  });
}

/**
 * Derive the per-outlet profile rows (with the 4 network detectors +
 * competition rank on waste/sales) from the monthly rows. Pure.
 *
 * BUGHUNT-R1 grain fixes — the first three detectors compare against
 * SINGLE-PERIOD thresholds, so they evaluate per-month rows, never the
 * window sums:
 *   - zeroWasteBigLoss: any month with waste ≤ 1 && that month's loss >
 *     highLossNominal (a 9-month window averaging ~5.6jt/month loss with
 *     zero waste no longer trips the Rp 50jt single-period threshold);
 *   - underRecording: ≥ 2 months EACH with sales > 0 and a per-month
 *     waste/sales < WASTE_UNDER_RECORD_PCT (the old window-aggregate
 *     ratio let one big-sales month mask a year of near-zero recording);
 *   - residualDominant: residual (loss-side since FIX 5) / totalLoss —
 *     same formula, now on a matching-grain numerator.
 */
export function buildWasteOutlets(
  monthly: WasteMonthlyRow[],
  highLossNominal: number,
): WasteOutletRow[] {
  const byOutlet = new Map<string, WasteMonthlyRow[]>();
  for (const r of monthly) {
    const list = byOutlet.get(r.outletCode);
    if (list) list.push(r);
    else byOutlet.set(r.outletCode, [r]);
  }
  const outlets: WasteOutletRow[] = [];
  for (const [outletCode, rows] of byOutlet) {
    const first = rows[0];
    const sales = rows.reduce((a, r) => a + r.sales, 0);
    const waste = rows.reduce((a, r) => a + r.waste, 0);
    const susut = rows.reduce((a, r) => a + r.susut, 0);
    const trial = rows.reduce((a, r) => a + r.trial, 0);
    const residual = rows.reduce((a, r) => a + r.residual, 0);
    const totalLoss = rows.reduce((a, r) => a + r.totalLoss, 0);
    const totalSurplus = rows.reduce((a, r) => a + r.totalSurplus, 0);
    const months = rows.length;
    const wasteToSales = sales > 0 ? waste / sales : 0;
    // FIX 3: per-month grain — highLossNominal is a single-period
    // threshold (same value used per-month by outlet-recurrence + the
    // HIGH_LOSS_NOMINAL record rule), so only a month that ITSELF lost
    // more than it can flag the outlet.
    const zeroWasteBigLoss = rows.some((r) => r.waste <= 1 && r.totalLoss > highLossNominal);
    // FIX 4: count months with a DEFINED per-month ratio under the
    // threshold (sales > 0 so the ratio exists); flag iff ≥ 2 such months.
    const underRecordMonths = rows.filter(
      (r) => r.sales > 0 && r.waste / r.sales < WASTE_UNDER_RECORD_PCT,
    ).length;
    outlets.push({
      outletCode,
      outletName: first.outletName,
      area: first.area,
      months,
      sales,
      waste,
      susut,
      trial,
      residual,
      totalLoss,
      totalSurplus,
      wasteToSales,
      wasteShareOfLoss: totalLoss > 0 ? waste / totalLoss : 0,
      residualShare: totalLoss > 0 ? residual / totalLoss : 0,
      spikeMonths: rows.filter((r) => r.spike).length,
      zeroWasteBigLoss,
      underRecording: underRecordMonths >= 2,
      residualDominant:
        totalLoss > 0 && residual / totalLoss > WASTE_RESIDUAL_DOMINANT_PCT && waste / totalLoss < WASTE_MIN_SHARE,
      rankWasteToSales: 0,
    });
  }
  // Competition ranking on waste/sales DESC (1 = highest). Ties share a rank.
  outlets.sort((a, b) => b.wasteToSales - a.wasteToSales || a.outletCode.localeCompare(b.outletCode));
  let lastRatio = Number.NaN;
  let lastRank = 0;
  outlets.forEach((o, i) => {
    o.rankWasteToSales = o.wasteToSales === lastRatio ? lastRank : i + 1;
    lastRatio = o.wasteToSales;
    lastRank = o.rankWasteToSales;
  });
  return outlets;
}

/** Derive the network KPIs from the monthly rows + outlet profiles. Pure. */
export function buildWasteKpis(monthly: WasteMonthlyRow[], outlets: WasteOutletRow[]): WasteKpis {
  const kpis: WasteKpis = {
    outlets: outlets.length,
    months: new Set(monthly.map((r) => r.monthKey)).size,
    sales: 0,
    waste: 0,
    susut: 0,
    trial: 0,
    residual: 0,
    totalLoss: 0,
    totalSurplus: 0,
    wasteToSales: 0,
    zeroWasteBigLossOutlets: 0,
    underRecordingOutlets: 0,
    residualDominantOutlets: 0,
    spikeCells: monthly.filter((r) => r.spike).length,
  };
  for (const r of monthly) {
    kpis.sales += r.sales;
    kpis.waste += r.waste;
    kpis.susut += r.susut;
    kpis.trial += r.trial;
    kpis.residual += r.residual;
    kpis.totalLoss += r.totalLoss;
    kpis.totalSurplus += r.totalSurplus;
  }
  kpis.wasteToSales = kpis.sales > 0 ? kpis.waste / kpis.sales : 0;
  kpis.zeroWasteBigLossOutlets = outlets.filter((o) => o.zeroWasteBigLoss).length;
  kpis.underRecordingOutlets = outlets.filter((o) => o.underRecording).length;
  kpis.residualDominantOutlets = outlets.filter((o) => o.residualDominant).length;
  return kpis;
}
