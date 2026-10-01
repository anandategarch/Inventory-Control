// ============================================================
//  SPLIT-0-A: queryWasteNetwork + pipeline SQL 8-CTE — dipindah
//  VERBATIM dari network.ts (479 LOC; barrel: ./index.ts).
//
//  Detektor spike 2σ hidup di SQL ini (CTE outlet_stats =
//  AVG/STDDEV_SAMP/COUNT baseline window per outlet, CTE
//  monthly_final = flag spike) — baris bulanan ber-flag lalu
//  diolah builders.ts (murni). Header modul lengkap (grain,
//  konvensi sales MODE, sejarah BUGHUNT-R1 FIX 3/4/5/7) ada
//  di ./index.ts bersama barrel.
//
//  W2 (Kronis vs Episodik): SATU-SATUNYA perubahan sejak split —
//  pass murni kedua ./persistence.ts atas baris bulanan yang SAMA
//  (tanpa round-trip SQL tambahan): field optional per-outlet +
//  block `persistence` network-level pada hasil. ADDITIF — tidak
//  ada field lama yang diubah/dihapus.
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../../shared';
import {
  monthWindowBound,
  WASTE_SPIKE_MIN_MONTHS,
  WASTE_SPIKE_SIGMA,
  WASTE_WINDOW_MONTHS,
} from '../shared';
import { buildWasteKpis, buildWasteMonthlyRows, buildWasteOutlets } from './builders';
import { buildWastePersistence } from './persistence';
import type { WasteMonthMeta, WasteMonthlyRawRow, WasteNetworkResult } from './types';

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

  // W2 (Kronis vs Episodik) — pure second pass over the SAME monthly
  // rows: per-outlet persistence metrics (merged ADDITIVELY onto the
  // profile rows; buildWasteOutlets stays untouched — it cannot compute
  // these without the per-month NETWORK medians) + the network-level
  // `persistence` block. No extra SQL round-trip.
  const persistence = buildWastePersistence(monthly);
  const persistenceByCode = new Map(persistence.outlets.map((p) => [p.outletCode, p]));
  const outletsWithPersistence = outlets.map((o) => {
    const p = persistenceByCode.get(o.outletCode);
    // p spreads the W2 optional fields (activeMonths, persistenceClass,
    // …) onto the row; every base field keeps its exact value+order —
    // additive merge, nothing renamed/removed.
    return p ? { ...o, ...p } : o;
  });

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

  return {
    months,
    monthly,
    outlets: outletsWithPersistence,
    kpis,
    persistence: { summary: persistence.summary, medians: persistence.medians },
  };
}
