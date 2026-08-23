// ============================================================
//  Exec Summary Builder — builds ExecutiveSummary from SQL rows
//  Extracted from analysis/route.ts (Phase 3 refactor)
// ============================================================
import { calcGrowth, computeNominalDeviationGrowth } from '@/lib/metrics';
import type { ExecutiveSummary } from '@/types/inventory';

interface ExecSummaryRow {
  sales: number; nominalDeviasi: number; qtyBom: number; qtyDeviasi: number;
  qtyWaste: number; qtySusut: number; qtyTrial: number; qtyLossSurplus: number;
  totalLoss: number; totalSurplus: number; residualLossQty: number; residualLossNominal: number;
  qtyDeviasiLoss: number;
}

export function buildExecSummaryFromSql(
  curr: ExecSummaryRow | null,
  prev: ExecSummaryRow | null,
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null,
): ExecutiveSummary {
  const c = curr ?? {
    sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0,
    qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0,
    residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0,
  };
  const salesPrev = prev?.sales ?? null;
  const nominalDeviasiPrev = prev?.nominalDeviasi ?? null;
  const qtyBomPrev = prev?.qtyBom ?? null;
  const qtyDeviasiPrev = prev?.qtyDeviasi ?? null;
  const qtyWastePrev = prev?.qtyWaste ?? null;
  const qtySusutPrev = prev?.qtySusut ?? null;
  const qtyTrialPrev = prev?.qtyTrial ?? null;
  const qtyLossSurplusPrev = prev?.qtyLossSurplus ?? null;

  return {
    period: { monthLabel, weekLabel, comparisonWeek: prevWeekLabel },
    sales: { current: c.sales, previous: salesPrev, growth: calcGrowth(c.sales, salesPrev) },
    nominalDeviasi: { current: c.nominalDeviasi, previous: nominalDeviasiPrev, growth: computeNominalDeviationGrowth(c.nominalDeviasi, nominalDeviasiPrev) },
    qtyBom: { current: c.qtyBom, previous: qtyBomPrev, growth: calcGrowth(c.qtyBom, qtyBomPrev) },
    qtyDeviasi: { current: c.qtyDeviasi, previous: qtyDeviasiPrev, growth: calcGrowth(c.qtyDeviasi, qtyDeviasiPrev) },
    qtyWaste: { current: c.qtyWaste, previous: qtyWastePrev, growth: calcGrowth(c.qtyWaste, qtyWastePrev) },
    qtySusut: { current: c.qtySusut, previous: qtySusutPrev, growth: calcGrowth(c.qtySusut, qtySusutPrev) },
    qtyTrial: { current: c.qtyTrial, previous: qtyTrialPrev, growth: calcGrowth(c.qtyTrial, qtyTrialPrev) },
    qtyLossSurplus: { current: c.qtyLossSurplus, previous: qtyLossSurplusPrev, growth: calcGrowth(c.qtyLossSurplus, qtyLossSurplusPrev) },
    totalLoss: c.totalLoss,
    totalSurplus: c.totalSurplus,
    lossToSales: c.sales > 0 ? c.totalLoss / c.sales : null,
    surplusToSales: c.sales > 0 ? c.totalSurplus / c.sales : null,
    deviationToBom: c.qtyBom !== 0 ? c.qtyDeviasi / Math.abs(c.qtyBom) : null,
    residualLossQty: c.residualLossQty,
    residualLossPct: c.qtyDeviasiLoss > 0 ? c.residualLossQty / c.qtyDeviasiLoss : null,
  };
}
