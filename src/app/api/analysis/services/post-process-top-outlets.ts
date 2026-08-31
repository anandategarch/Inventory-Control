// ============================================================
//  post-process-top-outlets — Sub-step 7: mapTopOutlets
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    Map top outlet SQL rows to response shape, including areaAvg
//    (joined from areaAnalysisRaw by `area` name).
// ============================================================
import type { QueryResults } from './run-queries';

/**
 * Sub-step 7 — map top outlet SQL rows to response shape, including areaAvg.
 */
export function mapTopOutlets(
  topOutletsRaw: QueryResults['topOutletsRaw'],
  topOutletsSalesRaw: QueryResults['topOutletsSalesRaw'],
  areaAnalysisRaw: QueryResults['areaAnalysisRaw'],
): { topOut: Array<Record<string, unknown>>; topOutletsSales: Array<Record<string, unknown>> } {
  const areaAvgMap = new Map<string, number>(areaAnalysisRaw.map(a => [a.area, a.avgDevBom ?? 0]));
  const topOut = topOutletsRaw.map(o => ({
    outletCode: o.outletCode, outletName: o.outletName, area: o.area,
    absNominal: o.absNominal, nominalDeviasi: o.nominalDeviasi ?? 0,
    devBom: o.devBom, areaAvg: areaAvgMap.get(o.area) ?? 0,
    sales: o.sales, lossAmount: o.lossAmount, surplusAmount: o.surplusAmount, direction: o.direction,
  }));
  const topOutletsSales = topOutletsSalesRaw.map(o => ({
    outletCode: o.outletCode, outletName: o.outletName, area: o.area,
    sales: o.sales, absNominal: o.absNominal, nominalDeviasi: o.nominalDeviasi ?? 0,
    devToSalesRatio: o.sales > 0 ? o.absNominal / o.sales : null,
  }));
  return { topOut, topOutletsSales };
}
