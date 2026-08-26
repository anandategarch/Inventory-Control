// ============================================================
//  ANALYSIS API — Executive summary computation
//  Walks the per-item-outlet AggRow stream and accumulates:
//   - Per-outlet aggregates (byOutlet map) — used by topOutlets
//   - Cumulative totals — used by breakdown, narrative, growth
//   - The executiveSummary object returned in the API response
//  Sales comes from a separate per-outlet MAX query (salesByOutlet)
//  to avoid double-counting the denormalized nominalSales column.
// ============================================================
import type {
  AggRow,
  ExecutiveSummary,
  OutletAgg,
  Totals,
  ExecSummaryBundle,
} from './types';

export interface ComputeExecSummaryArgs {
  rows: AggRow[];
  salesByOutlet: Map<string, number>;
  monthLabel: string | null;
  currentWeek: string | null;
  compareWeek: string | null;
}

/**
 * Compute the executive summary, per-outlet aggregates, and cumulative
 * totals from the per-item-outlet AggRow stream. The returned bundle is
 * consumed by the top-items / breakdown / narrative / growth modules.
 */
export function computeExecutiveSummary(args: ComputeExecSummaryArgs): ExecSummaryBundle {
  const { rows, salesByOutlet, monthLabel, currentWeek, compareWeek } = args;

  const byOutlet = new Map<string, OutletAgg>();
  let totalSales = 0;
  let qtyBomTotal = 0;
  let qtyDeviasiTotal = 0;
  let qtyWasteTotal = 0;
  let qtySusutTotal = 0;
  let qtyTrialTotal = 0;
  let qtyLossSurplusTotal = 0;
  let nomDeviasiTotal = 0;
  let totalLoss = 0;
  let totalSurplus = 0;
  let residualLossQty = 0;

  for (const r of rows) {
    // Per-outlet aggregates for topOutlets
    const prev = byOutlet.get(r.outletCode);
    const absNom = Math.abs(r.nominalDeviasi || 0);
    const absQtyDev = r.qtyDeviasi || 0;
    const outletSales = salesByOutlet.get(r.outletCode) || 0;
    if (!prev) {
      byOutlet.set(r.outletCode, {
        sales: outletSales,
        absNominal: absNom,
        absQtyDev,
        qtyBom: r.qtyBom || 0,
        // FIX P0-1: Direction from QTY DEVIASI (not nominal) per §9
        // "Jangan sampai price movement menyebabkan direction berubah"
        signedQtyDev: r.qtyDeviasi || 0,
        direction: r.direction,
      });
      totalSales += outletSales;
    } else {
      prev.absNominal += absNom;
      prev.absQtyDev += absQtyDev;
      prev.qtyBom += r.qtyBom || 0;
      // FIX P0-1: Accumulate signed QTY deviation (not nominal)
      prev.signedQtyDev += r.qtyDeviasi || 0;
    }

    qtyBomTotal += r.qtyBom || 0;
    qtyDeviasiTotal += r.qtyDeviasi || 0;
    qtyWasteTotal += r.qtyWaste || 0;
    qtySusutTotal += r.qtySusut || 0;
    qtyTrialTotal += r.qtyTrial || 0;
    qtyLossSurplusTotal += r.qtyLossSurplus || 0;
    nomDeviasiTotal += Math.abs(r.nominalDeviasi || 0);

    // Direction from QTY DEVIASI (per §9) — consistent with DB column + aggSql
    if (r.direction === 'LOSS') totalLoss += Math.abs(r.nominalDeviasi || 0);
    else if (r.direction === 'SURPLUS') totalSurplus += Math.abs(r.nominalDeviasi || 0);

    residualLossQty += Math.abs(r.residualQty || 0);
  }

  // FIX P0-1: Derive outlet-level direction from signed QTY DEVIASI sum
  // (not nominal — price movement must not change direction per §9)
  for (const [, v] of byOutlet) {
    v.direction = v.signedQtyDev > 0 ? 'LOSS' : v.signedQtyDev < 0 ? 'SURPLUS' : 'NEUTRAL';
  }

  const totals: Totals = {
    totalSales,
    qtyBomTotal,
    qtyDeviasiTotal,
    qtyWasteTotal,
    qtySusutTotal,
    qtyTrialTotal,
    qtyLossSurplusTotal,
    nomDeviasiTotal,
    totalLoss,
    totalSurplus,
    residualLossQty,
  };

  const execSummary: ExecutiveSummary = {
    period: { monthLabel, weekLabel: currentWeek, comparisonWeek: compareWeek },
    sales: { current: totalSales, previous: null, growth: null },
    nominalDeviasi: { current: nomDeviasiTotal, previous: null, growth: null },
    qtyBom: { current: qtyBomTotal, previous: null, growth: null },
    qtyDeviasi: { current: qtyDeviasiTotal, previous: null, growth: null },
    qtyWaste: { current: qtyWasteTotal, previous: null, growth: null },
    qtySusut: { current: qtySusutTotal, previous: null, growth: null },
    qtyTrial: { current: qtyTrialTotal, previous: null, growth: null },
    qtyLossSurplus: { current: qtyLossSurplusTotal, previous: null, growth: null },
    totalLoss,
    totalSurplus,
    lossToSales: totalSales > 0 ? totalLoss / totalSales : null,
    surplusToSales: totalSales > 0 ? totalSurplus / totalSales : null,
    deviationToBom: qtyBomTotal > 0 ? qtyDeviasiTotal / qtyBomTotal : null,
    residualLossQty,
    residualLossPct: qtyDeviasiTotal > 0 ? residualLossQty / qtyDeviasiTotal : null,
  };

  return { execSummary, byOutlet, totals, salesByOutlet };
}
