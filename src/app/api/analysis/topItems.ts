// ============================================================
//  ANALYSIS API — Top items, top outlets, breakdowns, health, DQ, worklist
//  Pure functions over AggRow[] for top-items / breakdowns / loss-vs-surplus.
//  Async SQL-backed functions for health-breakdown, DQ, investigation worklist.
// ============================================================
import type { Client, InValue } from '@libsql/client';
// PERF-FIX Bug #5: thresholds are now passed in from route.ts (read ONCE)
// instead of each function re-reading from DB.
import type { RuntimeThresholds } from '@/lib/settings';
import type {
  AggRow,
  OutletAgg,
  Totals,
  DeviationBreakdown,
  LossVsSurplus,
  HealthBreakdown,
  DqStatus,
  WorklistItem,
  TopItemsBundle,
  TopOutletsBundle,
  Direction,
} from './types';
import { healthSql, dqSql, worklistSql } from './queries';

// ------------------------------------------------------------
//  Top items (pure functions over AggRow[])
// ------------------------------------------------------------

/**
 * Compute the full bundle of top-items-by-* lists (topN each).
 * FIX P1-1: reads TOP_N_ITEMS from Settings (was hardcoded 10).
 * P1-4: STD_WASTE_PCT / STD_SUSUT_PCT / STD_TRIAL_PCT now filter the
 *   waste/susut/trial top-items lists so only items whose waste/susut/trial
 *   as a percentage of BOM exceeds the standard threshold are surfaced.
 * P1-4: FALLBACK_TOLERANCE_PCT is used as the default tolerance for items
 *   whose tolerancePct is null (was null in the API response, which made
 *   breach-detection in the UI always show "—").
 * PERF-FIX Bug #5: thresholds passed as param — no longer reads from DB internally.
 */
export async function computeTopItems(
  rows: AggRow[],
  thresholds: RuntimeThresholds
): Promise<TopItemsBundle> {
  const topN = thresholds.TOP_N_ITEMS || 10;
  const stdWaste = thresholds.STD_WASTE_PCT || 0.05;
  const stdSusut = thresholds.STD_SUSUT_PCT || 0.10;
  const stdTrial = thresholds.STD_TRIAL_PCT || 0.03;
  const fallbackTolerance = thresholds.FALLBACK_TOLERANCE_PCT || 0.05;

  const topItemsByNominal = [...rows]
    .filter((r) => Math.abs(r.nominalDeviasi) > 0)
    .sort((a, b) => Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi))
    .slice(0, topN)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      absNominal: Math.abs(r.nominalDeviasi),
      direction: (r.direction || 'NEUTRAL') as Direction,
    }));

  const topItemsByDevBom = [...rows]
    .filter((r) => r.qtyBom > 0)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      devBom: r.qtyDeviasi / r.qtyBom,
      // FIX P1-3: Use tolerance from SQL (MAX(r.tolerancePct) per item-outlet)
      // P1-4: When tolerancePct is null, fall back to FALLBACK_TOLERANCE_PCT
      // so breach detection works even for items without explicit tolerance.
      tolerance: r.tolerancePct != null ? r.tolerancePct : fallbackTolerance,
    }))
    .sort((a, b) => Math.abs(b.devBom) - Math.abs(a.devBom))
    .slice(0, topN);

  const topItemsByBom = [...rows]
    .filter((r) => r.qtyBom > 0)
    .sort((a, b) => b.qtyBom - a.qtyBom)
    .slice(0, topN)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyBom: r.qtyBom,
      satuan: r.satuan,
    }));

  // P1-4: STD_WASTE_PCT filter — only show items where wastePct = waste/bom > stdWaste
  const topItemsByWaste = [...rows]
    .filter((r) => r.qtyWaste > 0)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyWaste: r.qtyWaste,
      nominalWaste: r.nominalWaste,
      wastePct: r.qtyBom > 0 ? r.qtyWaste / r.qtyBom : 0,
    }))
    .filter((r) => r.wastePct > stdWaste)
    .sort((a, b) => b.qtyWaste - a.qtyWaste)
    .slice(0, topN)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyWaste: r.qtyWaste,
      nominalWaste: r.nominalWaste,
    }));

  // P1-4: STD_SUSUT_PCT filter
  const topItemsBySusut = [...rows]
    .filter((r) => r.qtySusut > 0)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtySusut: r.qtySusut,
      nominalSusut: r.nominalSusut,
      susutPct: r.qtyBom > 0 ? r.qtySusut / r.qtyBom : 0,
    }))
    .filter((r) => r.susutPct > stdSusut)
    .sort((a, b) => b.qtySusut - a.qtySusut)
    .slice(0, topN)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtySusut: r.qtySusut,
      nominalSusut: r.nominalSusut,
    }));

  // P1-4: STD_TRIAL_PCT filter
  const topItemsByTrial = [...rows]
    .filter((r) => r.qtyTrial > 0)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyTrial: r.qtyTrial,
      nominalTrial: r.nominalTrial,
      trialPct: r.qtyBom > 0 ? r.qtyTrial / r.qtyBom : 0,
    }))
    .filter((r) => r.trialPct > stdTrial)
    .sort((a, b) => b.qtyTrial - a.qtyTrial)
    .slice(0, topN)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyTrial: r.qtyTrial,
      nominalTrial: r.nominalTrial,
    }));

  const topItemsByLossSurplus = [...rows]
    .filter((r) => r.qtyLossSurplus > 0)
    .sort((a, b) => b.qtyLossSurplus - a.qtyLossSurplus)
    .slice(0, topN)
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      qtyLossSurplus: r.qtyLossSurplus,
      nominalLossSurplus: r.nominalLossSurplus,
      direction: (r.direction || 'NEUTRAL') as Direction,
    }));

  return {
    topItemsByNominal,
    topItemsByDevBom,
    topItemsByBom,
    topItemsByWaste,
    topItemsBySusut,
    topItemsByTrial,
    topItemsByLossSurplus,
  };
}

// ------------------------------------------------------------
//  Top outlets (pure function over byOutlet map + rows)
// ------------------------------------------------------------

/**
 * Compute topOutlets (by absolute nominal deviation) and topOutletsBySales.
 * Builds area-average benchmarks from rows so each outlet's devBom can be
 * compared to its area's average.
 * FIX P1-1: reads BENCHMARK_AREA_FACTOR from Settings (was
 * implicitly 1.5 via missing comparison). Adds aboveArea flag per outlet.
 * P1-4: TOP_N_OUTLETS now controls the slice length (was hardcoded 10).
 * P1-4: BENCHMARK_NETWORK_FACTOR — also compute network average devBom
 *   across all outlets and flag outlets whose devBom exceeds
 *   BENCHMARK_NETWORK_FACTOR × network avg. Surfaced via the new
 *   `aboveNetwork` field on TopOutlet.
 * PERF-FIX Bug #5: thresholds passed as param — no longer reads from DB internally.
 */
export async function computeTopOutlets(
  byOutlet: Map<string, OutletAgg>,
  rows: AggRow[],
  thresholds: RuntimeThresholds
): Promise<TopOutletsBundle> {
  // FIX P1-1: read benchmark area factor from settings (was effectively unused)
  const areaFactor = thresholds.BENCHMARK_AREA_FACTOR || 1.5;
  // P1-4: read TOP_N_OUTLETS (was hardcoded 10)
  const topNOutlets = thresholds.TOP_N_OUTLETS || 10;
  // P1-4: read BENCHMARK_NETWORK_FACTOR (was previously unused)
  const networkFactor = thresholds.BENCHMARK_NETWORK_FACTOR || 2.0;

  // Compute area averages for benchmark
  const areaAgg = new Map<string, { totalDev: number; totalBom: number; count: number }>();
  for (const r of rows) {
    if (!r.area) continue;
    const prev = areaAgg.get(r.area) || { totalDev: 0, totalBom: 0, count: 0 };
    prev.totalDev += r.qtyDeviasi || 0;
    prev.totalBom += r.qtyBom || 0;
    prev.count += 1;
    areaAgg.set(r.area, prev);
  }
  const areaAvgMap = new Map<string, number>();
  let networkTotalDev = 0;
  let networkTotalBom = 0;
  for (const [area, agg] of areaAgg) {
    const areaAvg = agg.totalBom > 0 ? agg.totalDev / agg.totalBom : 0;
    areaAvgMap.set(area, areaAvg);
    networkTotalDev += agg.totalDev;
    networkTotalBom += agg.totalBom;
  }
  const networkAvg = networkTotalBom > 0 ? networkTotalDev / networkTotalBom : 0;

  const topOutlets = [...byOutlet.entries()]
    .map(([code, v]) => {
      const firstRow = rows.find((r) => r.outletCode === code);
      const outletName = firstRow?.outletName || code;
      const areaName = firstRow?.area || '';
      const devBom = v.qtyBom > 0 ? v.absQtyDev / v.qtyBom : 0;
      const areaAvg = areaAvgMap.get(areaName) || 0;
      // FIX P1-1: aboveArea flag — true when outlet devBom exceeds
      // BENCHMARK_AREA_FACTOR × area average (was previously never computed)
      const aboveArea = areaAvg > 0 && devBom > areaAvg * areaFactor;
      // P1-4: aboveNetwork flag — true when outlet devBom exceeds
      // BENCHMARK_NETWORK_FACTOR × network average.
      const aboveNetwork = networkAvg > 0 && devBom > networkAvg * networkFactor;
      return {
        outletCode: code,
        outletName,
        area: areaName,
        absNominal: v.absNominal,
        devBom,
        areaAvg,
        direction: (v.direction || 'NEUTRAL') as Direction,
        sales: v.sales,
        aboveArea,
        aboveNetwork,
      };
    })
    .sort((a, b) => b.absNominal - a.absNominal)
    .slice(0, topNOutlets);

  const topOutletsBySales = [...byOutlet.entries()]
    .map(([code, v]) => {
      const firstRow = rows.find((r) => r.outletCode === code);
      return {
        outletCode: code,
        outletName: firstRow?.outletName || code,
        area: firstRow?.area || '',
        sales: v.sales,
        absNominal: v.absNominal,
        devToSalesRatio: v.sales > 0 ? v.absNominal / v.sales : null,
      };
    })
    .sort((a, b) => b.sales - a.sales)
    .slice(0, topNOutlets);

  return { topOutlets, topOutletsBySales };
}

// ------------------------------------------------------------
//  Deviation breakdown + loss-vs-surplus (pure)
// ------------------------------------------------------------

/**
 * Deviation breakdown — M5 fix: residual is sum-of-absolutes (not abs of sum),
 * so each component (waste/susut/trial/residual) contributes positively.
 */
export function computeDeviationBreakdown(totals: Totals): DeviationBreakdown {
  return {
    waste: totals.qtyWasteTotal,
    susut: totals.qtySusutTotal,
    trial: totals.qtyTrialTotal,
    residual: totals.residualLossQty,
    total: totals.qtyDeviasiTotal,
  };
}

/** Loss vs surplus split (direction-based, summed from raw rows). */
export function computeLossVsSurplus(rows: AggRow[]): LossVsSurplus {
  let lossQty = 0;
  let surplusQty = 0;
  let lossNominal = 0;
  let surplusNominal = 0;
  for (const r of rows) {
    if (r.direction === 'LOSS') {
      lossQty += r.qtyDeviasi || 0;
      lossNominal += Math.abs(r.nominalDeviasi || 0);
    } else if (r.direction === 'SURPLUS') {
      surplusQty += r.qtyDeviasi || 0;
      surplusNominal += Math.abs(r.nominalDeviasi || 0);
    }
  }
  return { loss: lossQty, surplus: surplusQty, lossNominal, surplusNominal };
}

// ------------------------------------------------------------
//  Health breakdown (SQL)
// ------------------------------------------------------------

/**
 * Health status breakdown — counts records by severity bucket
 * (abnormal / warning / normal) using residualRatio and nominalDeviasi.
 */
export async function computeHealthBreakdown(
  client: Client,
  where: string,
  args: InValue[]
): Promise<HealthBreakdown> {
  const res = await client.execute({ sql: healthSql(where), args });
  let normal = 0;
  let warning = 0;
  let abnormal = 0;
  for (const h of res.rows as Array<Record<string, unknown>>) {
    abnormal += Number(h.abnormal) || 0;
    warning += Number(h.warning_residual) || 0;
    warning += Number(h.warning_nominal) || 0;
    // FIX P0-4: use ok_count (catch-all normal) instead of normal_zero
    // normal_zero only caught zero-deviation records, missing low-deviation ones
    normal += Number(h.ok_count) || 0;
  }
  return { normal, warning, abnormal };
}

// ------------------------------------------------------------
//  DQ status (SQL)
// ------------------------------------------------------------

/**
 * DQ status — counts of records with missing BOM / no tolerance.
 * OK is computed directly in SQL to avoid double-counting records that
 * have BOTH issues (FIX Bug #6).
 * FIX §27: Also surfaces duplicates + sales_mismatch counts (added in dqSql).
 */
export async function computeDqStatus(
  client: Client,
  where: string,
  args: InValue[]
): Promise<DqStatus> {
  const res = await client.execute({ sql: dqSql(where), args });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  const errors = Number(row?.missing_bom) || 0;
  const warnings = Number(row?.no_tolerance) || 0;
  const ok = Number(row?.ok_count) || 0;
  const duplicates = Number(row?.duplicates) || 0;
  const salesMismatch = Number(row?.sales_mismatch) || 0;
  return { ok, warnings, errors, duplicates, salesMismatch };
}

// ------------------------------------------------------------
//  Investigation worklist (SQL)
// ------------------------------------------------------------

/**
 * Investigation worklist — top 20 anomalies with priority (P1/P2/P3) and
 * a rule-based issue + recommendedAction string. Filters source rows down
 * to actual anomalies (|nominal| > 100k OR residual > warn% OR |devBom| > std%).
 * FIX P0-5: Now reads residual/tolerance thresholds from Settings.
 * FIX P1-1: Reads HIGH_LOSS_NOMINAL_THRESHOLD from Settings (was hardcoded
 *   50_000_000 for P1 / 10_000_000 for P2). P1 = threshold × 50, P2 = threshold × 10.
 * FIX §24: Populates new fields (metric, benchmark, possibleCause, status)
 *   to give investigators richer context per anomaly.
 * PERF-FIX Bug #5: thresholds passed as param — no longer reads from DB internally.
 */
export async function computeInvestigationWorklist(
  client: Client,
  where: string,
  args: InValue[],
  thresholds: RuntimeThresholds
): Promise<WorklistItem[]> {
  // FIX P0-5: Read thresholds from settings
  const residualHigh = thresholds.RESIDUAL_LOSS_HIGH_PCT;   // 0.70
  const residualWarn = thresholds.RESIDUAL_LOSS_WARN_PCT;   // 0.50
  const devBomThreshold = thresholds.STD_DEVIASI_BOM_PCT;   // 0.05
  // FIX P1-1: Read HIGH_LOSS_NOMINAL_THRESHOLD (was hardcoded 50M / 10M)
  const highLossThreshold = thresholds.HIGH_LOSS_NOMINAL_THRESHOLD || 1_000_000;
  const p1Threshold = highLossThreshold * 50;  // P1 = 50× threshold
  const p2Threshold = highLossThreshold * 10;  // P2 = 10× threshold

  const res = await client.execute({ sql: worklistSql(where), args });
  return (res.rows as Array<Record<string, unknown>>)
    .filter((r) => {
      const absNom = Number(r.absNominalDeviasi) || 0;
      const residual = Number(r.residualRatio) || 0;
      const devBom = Number(r.pctQtyDeviasiToBom) || 0;
      // Filter: only include actual anomalies
      return absNom > 100000 || residual > residualWarn || Math.abs(devBom) > devBomThreshold;
    })
    .slice(0, 20)
    .map((r) => {
      const absNom = Number(r.absNominalDeviasi) || 0;
      const residual = Number(r.residualRatio) || 0;
      const devBom = Number(r.pctQtyDeviasiToBom) || 0;
      const direction = (r.direction || 'NEUTRAL') as Direction;

      // FIX P1-1: Determine priority using settings-based thresholds
      // (was hardcoded absNom > 50_000_000 / 10_000_000)
      let priority: 'P1' | 'P2' | 'P3' = 'P3';
      if (absNom > p1Threshold || residual > residualHigh) priority = 'P1';
      else if (absNom > p2Threshold || residual > residualWarn) priority = 'P2';

      // Determine issue + recommended action
      let issue = 'Anomali deviation terdeteksi';
      let recommendedAction = 'Review source data dan konfirmasi dengan outlet';
      // FIX §24: New fields — default fallbacks (must always have a value)
      let metric = `Nominal: Rp ${absNom.toLocaleString()}`;
      let benchmark = `Threshold: Rp ${p1Threshold.toLocaleString()} (HIGH_LOSS_NOMINAL_THRESHOLD × 50)`;
      let possibleCause = 'Anomali deviation terdeteksi — perlu investigasi lebih lanjut';

      if (residual > residualHigh) {
        issue = `Residual loss tinggi (${(residual * 100).toFixed(0)}% deviation tidak terjelaskan)`;
        recommendedAction =
          'Investigasi sumber deviation: cek apakah ada pencatatan waste/susut/trial yang tertinggal';
        // FIX §24: residual issue context
        metric = `Residual: ${(residual * 100).toFixed(0)}%`;
        benchmark = `Threshold: ${(residualHigh * 100).toFixed(0)}% (RESIDUAL_LOSS_HIGH_PCT)`;
        possibleCause =
          'Waste/susut/trial tidak tercatat, receiving discrepancy, UOM issue, atau transfer belum tercatat';
      } else if (absNom > p1Threshold) {
        issue = `Nominal deviation sangat tinggi (Rp ${(absNom / 1_000_000).toFixed(1).replace('.', ',')}Jt)`;
        recommendedAction = 'Audit langsung ke outlet, verifikasi pencatatan BOM dan COM';
        // FIX §24: nominal issue context
        metric = `Nominal: Rp ${absNom.toLocaleString()}`;
        benchmark = `Threshold: Rp ${p1Threshold.toLocaleString()} (HIGH_LOSS_NOMINAL_THRESHOLD × 50)`;
        possibleCause =
          'Over-consumption vs SOC, quality issue, over-portion, atau administrative error';
      } else if (Math.abs(devBom) > devBomThreshold) {
        issue = `Deviation/BOM ratio tinggi (${(Math.abs(devBom) * 100).toFixed(1)}%)`;
        recommendedAction = 'Cek apakah BOM perlu update atau ada masalah proses produksi';
        // FIX §24: devBom issue context
        metric = `Dev/BOM: ${(Math.abs(devBom) * 100).toFixed(1)}%`;
        benchmark = `Threshold: ${(devBomThreshold * 100).toFixed(1)}% (STD_DEVIASI_BOM_PCT)`;
        possibleCause =
          'BOM perlu update, over-portion, quality issue, atau proses produksi bermasalah';
      }

      const qtyBom = Number(r.qtyBom) || 0;
      const qtyDeviasi = Number(r.qtyDeviasi) || 0;

      return {
        priority,
        outletCode: String(r.outletCode),
        outletName: String(r.outletName),
        area: String(r.area),
        itemName: String(r.itemName),
        issue,
        evidence: `Nominal: Rp ${absNom.toLocaleString()}, Residual: ${(residual * 100).toFixed(0)}%, Dev/BOM: ${(Math.abs(devBom) * 100).toFixed(1)}%`,
        recommendedAction,
        ruleCodes: [] as string[],
        absNominalDeviasi: absNom,
        deviationToBom: qtyBom > 0 ? qtyDeviasi / qtyBom : null,
        direction,
        // FIX §24: new fields
        metric,
        benchmark,
        possibleCause,
        status: 'OPEN' as const,
      };
    });
}
