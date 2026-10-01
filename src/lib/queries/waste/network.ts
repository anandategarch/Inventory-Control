// ============================================================
//  Waste Network Series — queryWasteNetwork (DEEP-WASTE-1)
//  --------------------------------------------------------
//  GODSPLIT-W1-B: moved verbatim out of waste-series.ts (was a
//  773-LOC two-pipeline monolith). Shared window constants +
//  helpers live in ./shared.ts; the peer z-score pipeline lives
//  in ./peer-zscore.ts; waste-series.ts is now a barrel.
//
//  Multi-month, SAME-weekLabel waste view — the in-app version
//  of the "Profil Waste Outlet" / "Data Bulanan" / "Matriks
//  Bulanan" / "Anomali Waste" / "TJPPLU Fokus" sheets from the
//  offline deep waste analysis report (Analisa-Deep-Waste-Area-1):
//
//  queryWasteNetwork — per (outlet, month) same-week waste
//     aggregates over the most recent 12 months (incl. the
//     running month), scoped by the global filters (area /
//     kelompok / PIC / outletCode): ΣABS nominalWaste/Susut/
//     Trial, LOSS-SIDE ΣABS residualNominal (BUGHUNT-R1 FIX 5:
//     only rows with nominalLossSurplus < 0 — the loss-decomposition
//     consumers, incl. residualShare = residual/totalLoss, need the
//     same grain as the denominator or the share exceeds 1),
//     Total Loss/Surplus (Excel convention), sales (MODE per
//     OutletPeriodSales), waste/sales ratio, and 4 network anomaly
//     detectors:
//       - spike            : waste/sales > mean + 2σ of the
//                            outlet's OWN months in the window
//                            (min 3 months WITH sales > 0 — the
//                            baseline skips sales=0 months rather
//                            than diluting them with forced 0s;
//                            BUGHUNT-R1 FIX 7) and std > 0 — the
//                            "spike waste > 2σ" P2 rule;
//       - zeroWasteBigLoss : ANY window month with waste ≈ 0 (≤ Rp 1)
//                            AND that month's total loss above
//                            HIGH_LOSS_NOMINAL_THRESHOLD (FIX 3:
//                            per-month grain — the threshold is a
//                            single-period value everywhere else);
//       - underRecording   : ≥ 2 months EACH with sales > 0 and
//                            waste/sales < 0.1% (FIX 4: per-month
//                            ratios, not the window aggregate);
//       - residualDominant : loss-side residual > 80% of loss AND
//                            waste explains < 10% of it.
//     The per-outlet profile rows + network KPIs are derived
//     from the monthly rows by PURE builders (testable — same
//     compute/classify split as outlet-monthly-series.ts).
//
//  GRAIN + sales MODE conventions: see ./shared.ts (moved
//  verbatim). PURELY ADDITIVE: feeds the /api/waste-series
//  route used by the Waste tab.
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import {
  monthWindowBound,
  toNum,
  WASTE_MIN_SHARE,
  WASTE_RESIDUAL_DOMINANT_PCT,
  WASTE_SPIKE_MIN_MONTHS,
  WASTE_SPIKE_SIGMA,
  WASTE_UNDER_RECORD_PCT,
  WASTE_WINDOW_MONTHS,
} from './shared';

// ------------------------------------------------------------
// 1. Network waste series — types
// ------------------------------------------------------------

/** Raw SQL row (bigint aggregates coerced in buildWasteMonthlyRows). */
interface WasteMonthlyRawRow {
  outletCode: string;
  outletName: string;
  area: string;
  monthKey: string;
  monthLabel: string;
  sales: number | bigint;
  waste: number | bigint;
  susut: number | bigint;
  trial: number | bigint;
  residual: number | bigint;
  totalLoss: number | bigint;
  totalSurplus: number | bigint;
  spike: number | bigint;
  dqError: boolean;
  dqErrorCount: number | bigint;
}

export interface WasteMonthlyRow {
  outletCode: string;
  outletName: string;
  area: string;
  monthKey: string;
  monthLabel: string;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  /** waste / sales (0 when sales is 0/absent). */
  wasteToSales: number;
  /** waste / totalLoss (0 when totalLoss is 0). */
  wasteShareOfLoss: number;
  /** residual / totalLoss (0 when totalLoss is 0). */
  residualShare: number;
  /** waste/sales > mean + 2σ of the outlet's own window (min 3 months). */
  spike: boolean;
  dqError: boolean;
  dqErrorCount: number;
}

export interface WasteOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  months: number;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  wasteShareOfLoss: number;
  residualShare: number;
  /** Months with a waste spike in the window. */
  spikeMonths: number;
  /** 1 = highest waste/sales among the scoped outlets (competition ranking). */
  rankWasteToSales: number;
  zeroWasteBigLoss: boolean;
  underRecording: boolean;
  residualDominant: boolean;
}

export interface WasteMonthMeta {
  monthKey: string;
  monthLabel: string;
  dqError: boolean;
  dqErrorCount: number;
}

export interface WasteKpis {
  outlets: number;
  months: number;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  /** Outlets with waste ≈ 0 but big loss. */
  zeroWasteBigLossOutlets: number;
  /** Outlets with waste/sales < 0.1% for ≥ 2 months. */
  underRecordingOutlets: number;
  /** Outlets whose residual dominates loss while waste explains < 10%. */
  residualDominantOutlets: number;
  /** Total (outlet, month) cells flagged as waste spikes. */
  spikeCells: number;
}

export interface WasteNetworkResult {
  months: WasteMonthMeta[];
  monthly: WasteMonthlyRow[];
  outlets: WasteOutletRow[];
  kpis: WasteKpis;
}

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

// ------------------------------------------------------------
// 1. queryWasteNetwork
// ------------------------------------------------------------

export async function queryWasteNetwork(
  week: string,
  currentMonthKey: string | null,
  filters: SqlFilterOpts,
  highLossNominal: number,
): Promise<WasteNetworkResult> {
  const f = buildSqlFilters(filters);
  // Shape:
  //   months          — DISTINCT same-week monthKeys in scope, most recent 12
  //   month_labels    — monthKey → label + DQ (BOOL_OR over the month's files)
  //   per_month       — per (outlet, month) waste aggregates (same week)
  //   sales           — per (outlet, month) MODE sales (OutletPeriodSales)
  //   monthly_raw     — per_period LEFT JOIN sales
  //   monthly_ratios  — + wasteToSales ratio (needs its own level so the
  //                     stats CTE can aggregate the ratio)
  //   outlet_stats    — per outlet mean/stddev_samp/count of wasteToSales
  //                     over the window (the spike baseline)
  //   monthly_final   — + shares + spike flag + DQ, ordered
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<WasteMonthlyRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        ${monthWindowBound(currentMonthKey)}
        ${f}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${WASTE_WINDOW_MONTHS}
    ),
    month_labels AS (
      SELECT sf."monthKey",
        MIN(sf."monthLabel") as "monthLabel",
        COALESCE(BOOL_OR(sf."dqStatus" = 'ERROR'), false) as "dqError",
        COALESCE(SUM(sf."dqErrorCount"), 0) as "dqErrorCount"
      FROM "SourceFile" sf
      WHERE sf."monthKey" IN (SELECT "monthKey" FROM months)
      GROUP BY sf."monthKey"
    ),
    per_month AS (
      SELECT
        o.code as "outletCode",
        o.name as "outletName",
        ir.area,
        sf."monthKey",
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste",
        COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "susut",
        COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "trial",
        -- BUGHUNT-R1 FIX 5: residual is the UNEXPLAINED PART OF LOSS — sum
        -- ABS(residualNominal) only over loss-side records, matching the
        -- totalLoss denominator. The old two-sided sum made residualShare
        -- exceed 1 for 343/343 outlets (median 2.34) and the >0.8 guard
        -- filtered nothing. Every consumer of this field (KPI "Σ Residual",
        -- profile/matrix/decomposition displays, residualShare) reads it
        -- in a loss-decomposition context, so no separate two-sided
        -- magnitude field is exposed.
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."residualNominal") ELSE 0 END), 0) as "residual",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END), 0) as "totalLoss",
        COALESCE(SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END), 0) as "totalSurplus"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."weekLabel" = ${week}
        AND sf."monthKey" IN (SELECT "monthKey" FROM months)
        ${f}
      GROUP BY o.code, o.name, ir.area, sf."monthKey"
    ),
    sales AS (
      SELECT
        o.code as "outletCode",
        ml."monthKey",
        MAX(ops."salesMode") as sales
      FROM "OutletPeriodSales" ops
      JOIN "Outlet" o ON ops."outletId" = o.id
      JOIN month_labels ml ON ml."monthLabel" = ops."monthLabel"
      WHERE ops."weekLabel" = ${week}
      GROUP BY o.code, ml."monthKey"
    ),
    monthly_raw AS (
      SELECT
        pm."outletCode", pm."outletName", pm.area, pm."monthKey",
        COALESCE(s.sales, 0) as "sales",
        pm."waste", pm."susut", pm."trial", pm."residual",
        pm."totalLoss", pm."totalSurplus"
      FROM per_month pm
      LEFT JOIN sales s
        ON s."outletCode" = pm."outletCode"
        AND s."monthKey" = pm."monthKey"
    ),
    monthly_ratios AS (
      SELECT mr.*,
        -- BUGHUNT-R1 FIX 7: sales=0 months emit NULL (not a forced 0) so
        -- the outlet_stats AVG/STDDEV/COUNT baseline below SKIPS them —
        -- forced 0s deflated the mean and crushed the σ, manufacturing
        -- fake "spikes" on any month with sales. The response ratio is
        -- recomputed in TS (buildWasteMonthlyRows guards sales=0 → 0).
        CASE WHEN mr.sales > 0 THEN mr.waste / mr.sales END as "wasteToSales"
      FROM monthly_raw mr
    ),
    outlet_stats AS (
      SELECT "outletCode",
        AVG("wasteToSales") as "wtsMean",
        COALESCE(STDDEV_SAMP("wasteToSales"), 0) as "wtsStd",
        COUNT("wasteToSales") as n
      FROM monthly_ratios
      GROUP BY "outletCode"
    ),
    monthly_final AS (
      SELECT
        mr."outletCode", mr."outletName", mr.area, mr."monthKey",
        ml."monthLabel",
        mr.sales, mr."waste", mr."susut", mr."trial", mr."residual",
        mr."totalLoss", mr."totalSurplus",
        mr."wasteToSales",
        CASE WHEN mr."totalLoss" > 0 THEN mr.waste / mr."totalLoss" ELSE 0 END as "wasteShareOfLoss",
        CASE WHEN mr."totalLoss" > 0 THEN mr.residual / mr."totalLoss" ELSE 0 END as "residualShare",
        CASE
          WHEN os.n >= ${WASTE_SPIKE_MIN_MONTHS}
            AND os."wtsStd" > 0
            AND mr."wasteToSales" > os."wtsMean" + ${WASTE_SPIKE_SIGMA} * os."wtsStd"
          THEN 1 ELSE 0 END as "spike",
        ml."dqError",
        ml."dqErrorCount"
      FROM monthly_ratios mr
      JOIN outlet_stats os ON os."outletCode" = mr."outletCode"
      JOIN month_labels ml ON ml."monthKey" = mr."monthKey"
    )
    SELECT "outletCode", "outletName", area, "monthKey", "monthLabel",
      sales, waste, susut, trial, residual, "totalLoss", "totalSurplus",
      spike, "dqError", "dqErrorCount"
    FROM monthly_final
    ORDER BY "outletCode" ASC, "monthKey" ASC
  `);

  const monthly = buildWasteMonthlyRows(rows);
  const outlets = buildWasteOutlets(monthly, highLossNominal);
  const kpis = buildWasteKpis(monthly, outlets);

  // Month metadata: derived from the monthly rows (keeps ONE SQL round
  // trip). A month absent from ALL outlet rows can't exist — per_month is
  // the same scope as the months CTE.
  const monthMap = new Map<string, WasteMonthMeta>();
  for (const r of monthly) {
    if (!monthMap.has(r.monthKey)) {
      monthMap.set(r.monthKey, {
        monthKey: r.monthKey,
        monthLabel: r.monthLabel,
        dqError: r.dqError,
        dqErrorCount: r.dqErrorCount,
      });
    }
  }
  const months = [...monthMap.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));

  return { months, monthly, outlets, kpis };
}
