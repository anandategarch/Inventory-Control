// ============================================================
//  Waste Series — Deep Waste Analysis (DEEP-WASTE-1/2)
//  --------------------------------------------------------
//  Two multi-month, SAME-weekLabel waste views — the in-app
//  versions of the "Profil Waste Outlet" / "Data Bulanan" /
//  "Matriks Bulanan" / "Anomali Waste" / "TJPPLU Fokus" sheets
//  from the offline deep waste analysis report
//  (Analisa-Deep-Waste-Area-1):
//
//  1. queryWasteNetwork — per (outlet, month) same-week waste
//     aggregates over the most recent 12 months (incl. the
//     running month), scoped by the global filters (area /
//     kelompok / PIC / outletCode): ΣABS nominalWaste/Susut/
//     Trial, ΣABS residualNominal, Total Loss/Surplus (Excel
//     convention), sales (MODE per OutletPeriodSales),
//     waste/sales ratio, and 4 network anomaly detectors:
//       - spike            : waste/sales > mean + 2σ of the
//                            outlet's OWN months in the window
//                            (min 3 months, std > 0) — the
//                            "spike waste > 2σ" P2 rule;
//       - zeroWasteBigLoss : waste ≈ 0 (≤ Rp 1) with total loss
//                            above HIGH_LOSS_NOMINAL_THRESHOLD;
//       - underRecording   : waste/sales < 0.1% for ≥ 2 months;
//       - residualDominant : residual > 80% of loss AND waste
//                            explains < 10% of it.
//     The per-outlet profile rows + network KPIs are derived
//     from the monthly rows by PURE builders (testable — same
//     compute/classify split as outlet-monthly-series.ts).
//
//  2. queryWastePeerZScore (DEEP-WASTE-2) — for ONE outlet, per
//     month: the SAME dynamic ±10% sales band as peer-track-
//     record.ts (band membership recomputed per month; kelompok
//     scopes the peer set, the focus outlet is always included),
//     the outlet's waste/sales, its rank inside the band
//     (1 = highest waste/sales), band mean/std, and the outlet's
//     z-score vs the band (only when bandSize ≥ 3 and std > 0).
//
//  GRAIN (critical): a "week" is a CUMULATIVE MTD snapshot —
//  the ONLY valid cross-month comparison is SAME weekLabel
//  (identical to outlet-monthly-series.ts / outlet-recurrence.
//  ts). Window = most recent 12 same-week months ending at the
//  running month (monthKey <= currentMonthKey, inclusive; no
//  upper bound when currentMonthKey is null).
//
//  Sales convention: MODE(nominalSales) from OutletPeriodSales
//  (DB-06 precomputed table) — same as DEEP-RESTO-1.
//
//  PURELY ADDITIVE: feeds the new /api/waste-series +
//  /api/waste-peer-zscore routes used by the Waste tab + the
//  Resto tab's "Profil Waste" card.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

/** Max months in the waste window (incl. running month). */
export const WASTE_WINDOW_MONTHS = 12;

/** P2 rule "waste/sales < 0,1%" — under-recording threshold (fraction). */
export const WASTE_UNDER_RECORD_PCT = 0.001;

/** P2 rule "residual > 80% dari loss" — residual-dominant threshold (fraction). */
export const WASTE_RESIDUAL_DOMINANT_PCT = 0.8;

/** P2 rule "waste explains < 10% of loss" — waste-share floor (fraction). */
export const WASTE_MIN_SHARE = 0.1;

/** Spike rule: waste/sales above mean + SPIKE_SIGMA × std of the outlet's own window. */
export const WASTE_SPIKE_SIGMA = 2;

/** Spike rule: minimum months in the window before a spike can be declared. */
export const WASTE_SPIKE_MIN_MONTHS = 3;

/** Z-score rule (peer band): minimum band size before z is meaningful. */
export const WASTE_ZSCORE_MIN_BAND = 3;

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
// 2. Peer waste z-score — types
// ------------------------------------------------------------

interface WastePeerZScoreRawRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number | bigint;
  waste: number | bigint;
  wasteToSales: number | bigint;
  rankWasteToSales: number | bigint;
  bandSize: number | bigint;
  bandMean: number | bigint;
  bandStd: number | bigint;
  zScore: number | null;
}

export interface WastePeerZScoreRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number;
  waste: number;
  wasteToSales: number;
  /** 1 = highest waste/sales in the band that month. */
  rankWasteToSales: number;
  bandSize: number;
  /** Mean waste/sales across the band (0 when band degenerate). */
  bandMean: number;
  /** StdDev of waste/sales across the band (0 when degenerate). */
  bandStd: number;
  /** (wasteToSales − bandMean) / bandStd — null when bandSize < 3 or std = 0. */
  zScore: number | null;
}

export interface WastePeerZScoreSummary {
  monthsTracked: number;
  /** Average z across months with a defined z (null when none). */
  avgZ: number | null;
  /** Months with z > 1. */
  monthsZAbove1: number;
  /** Months with z > 2. */
  monthsZAbove2: number;
  /** Months ranked #1 highest waste/sales in the band. */
  monthsHighestWaste: number;
  /** First → last month target sales growth (fraction; null when not computable). */
  salesGrowth: number | null;
  /** "Paradox" outlet: sales grew AND avg z > 1. */
  paradox: boolean;
  lastMonthLabel: string | null;
  lastWasteToSales: number | null;
  lastRankWasteToSales: number | null;
  lastZScore: number | null;
  lastBandSize: number | null;
}

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
      zeroWasteBigLoss: waste <= 1 && totalLoss > highLossNominal,
      underRecording: wasteToSales < WASTE_UNDER_RECORD_PCT && sales > 0 && months >= 2,
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

/** Peer z-score summary (pure) — averages, worst-month counts, paradox flag. */
export function summarizeWastePeerZScore(rows: WastePeerZScoreRow[]): WastePeerZScoreSummary {
  if (rows.length === 0) {
    return {
      monthsTracked: 0,
      avgZ: null,
      monthsZAbove1: 0,
      monthsZAbove2: 0,
      monthsHighestWaste: 0,
      salesGrowth: null,
      paradox: false,
      lastMonthLabel: null,
      lastWasteToSales: null,
      lastRankWasteToSales: null,
      lastZScore: null,
      lastBandSize: null,
    };
  }
  const zs = rows.map((r) => r.zScore).filter((z): z is number => z != null);
  const avgZ = zs.length > 0 ? zs.reduce((a, z) => a + z, 0) / zs.length : null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const salesGrowth = first.targetSales > 0 && last.targetSales > 0
    ? last.targetSales / first.targetSales - 1
    : null;
  const monthsHighestWaste = rows.filter((r) => r.rankWasteToSales === 1).length;
  return {
    monthsTracked: rows.length,
    avgZ,
    monthsZAbove1: zs.filter((z) => z > 1).length,
    monthsZAbove2: zs.filter((z) => z > 2).length,
    monthsHighestWaste,
    salesGrowth,
    // "Paradox" (the offline report's TJPPLU case): sales grew while the
    // outlet's waste/sales stayed extreme vs its sales band.
    paradox: Boolean(salesGrowth != null && salesGrowth > 0 && (avgZ == null ? false : avgZ > 1)),
    lastMonthLabel: last.monthLabel,
    lastWasteToSales: last.wasteToSales,
    lastRankWasteToSales: last.rankWasteToSales,
    lastZScore: last.zScore,
    lastBandSize: last.bandSize,
  };
}

// ------------------------------------------------------------
// Shared SQL fragment: the same-week month window (network-wide
// for the scoped filter set — most recent N months ending at
// currentMonthKey, inclusive).
// ------------------------------------------------------------

function monthWindowBound(currentMonthKey: string | null): Prisma.Sql {
  return currentMonthKey
    ? Prisma.sql`AND sf."monthKey" <= ${currentMonthKey}`
    : Prisma.empty;
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
        COALESCE(SUM(ABS(ir."residualNominal")), 0) as "residual",
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
        CASE WHEN mr.sales > 0 THEN mr.waste / mr.sales ELSE 0 END as "wasteToSales"
      FROM monthly_raw mr
    ),
    outlet_stats AS (
      SELECT "outletCode",
        AVG("wasteToSales") as "wtsMean",
        COALESCE(STDDEV_SAMP("wasteToSales"), 0) as "wtsStd",
        COUNT(*) as n
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

// ------------------------------------------------------------
// 2. queryWastePeerZScore
// ------------------------------------------------------------

export async function queryWastePeerZScore(
  outletCode: string,
  week: string,
  currentMonthKey: string | null,
  kelompok?: string | null,
): Promise<{ rows: WastePeerZScoreRow[]; summary: WastePeerZScoreSummary }> {
  // kelompok scopes the PEER set only — the focus outlet is always
  // included (same predicate as peer-track-record.ts).
  const peerKelompokFilter = kelompok
    ? Prisma.sql`AND (o.code = ${outletCode} OR LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = UPPER(${kelompok}))`
    : Prisma.empty;

  // Shape (mirrors queryPeerTrackRecord with the waste metric):
  //   months / month_labels — the window for THIS outlet
  //   metrics        — per (outlet, month) ΣABS nominalWaste for ALL
  //                    outlets in scope (band candidates)
  //   sales          — per (outlet, month) MODE sales
  //   target_sales   — the focus outlet's sales per month
  //   band           — outlets with sales within ±10% of the target's
  //                    sales THAT month (dynamic, sales > 0)
  //   band_ratio     — band + wasteToSales ratio per member
  //   stats          — per month band mean/stddev_samp/count of the ratio
  //   ranked         — RANK() per month on waste/sales DESC (1 = highest)
  //   final          — target outlet's rows, chronological
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<WastePeerZScoreRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE o.code = ${outletCode}
        AND ir."weekLabel" = ${week}
        ${monthWindowBound(currentMonthKey)}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${WASTE_WINDOW_MONTHS}
    ),
    month_labels AS (
      SELECT sf."monthKey", MIN(sf."monthLabel") as "monthLabel"
      FROM "SourceFile" sf
      WHERE sf."monthKey" IN (SELECT "monthKey" FROM months)
      GROUP BY sf."monthKey"
    ),
    metrics AS (
      SELECT
        o.code as "outletCode",
        sf."monthKey",
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        AND sf."monthKey" IN (SELECT "monthKey" FROM months)
        ${peerKelompokFilter}
      GROUP BY o.code, sf."monthKey"
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
    target_sales AS (
      SELECT "monthKey", MAX(sales) as "targetSales"
      FROM sales
      WHERE "outletCode" = ${outletCode}
      GROUP BY "monthKey"
    ),
    band AS (
      SELECT
        m."outletCode",
        m."monthKey",
        COALESCE(s.sales, 0) as "sales",
        m.waste,
        ts."targetSales"
      FROM metrics m
      JOIN target_sales ts ON ts."monthKey" = m."monthKey"
      LEFT JOIN sales s
        ON s."outletCode" = m."outletCode"
        AND s."monthKey" = m."monthKey"
      WHERE COALESCE(s.sales, 0) > 0
        AND ABS(COALESCE(s.sales, 0) - ts."targetSales") <= ts."targetSales" * 0.1
    ),
    band_ratio AS (
      SELECT b.*,
        b.waste / b.sales as "wasteToSales"
      FROM band b
    ),
    stats AS (
      SELECT "monthKey",
        AVG("wasteToSales") as "bandMean",
        COALESCE(STDDEV_SAMP("wasteToSales"), 0) as "bandStd",
        COUNT(*) as "bandSize"
      FROM band_ratio
      GROUP BY "monthKey"
    ),
    ranked AS (
      SELECT
        b."outletCode",
        b."monthKey",
        b."targetSales",
        b.waste,
        b."wasteToSales",
        RANK() OVER (PARTITION BY b."monthKey" ORDER BY b."wasteToSales" DESC) as "rankWasteToSales",
        COUNT(*) OVER (PARTITION BY b."monthKey") as "bandSize"
      FROM band_ratio b
    )
    SELECT
      r."monthKey",
      ml."monthLabel",
      r."targetSales",
      r.waste,
      r."wasteToSales",
      r."rankWasteToSales",
      r."bandSize",
      COALESCE(st."bandMean", 0) as "bandMean",
      COALESCE(st."bandStd", 0) as "bandStd",
      CASE
        WHEN st."bandSize" >= ${WASTE_ZSCORE_MIN_BAND} AND st."bandStd" > 0
          THEN (r."wasteToSales" - st."bandMean") / st."bandStd"
        ELSE NULL END as "zScore"
    FROM ranked r
    JOIN month_labels ml ON ml."monthKey" = r."monthKey"
    LEFT JOIN stats st ON st."monthKey" = r."monthKey"
    WHERE r."outletCode" = ${outletCode}
    ORDER BY r."monthKey" ASC
  `);

  const mapped: WastePeerZScoreRow[] = rows.map((r) => ({
    monthKey: r.monthKey,
    monthLabel: r.monthLabel,
    targetSales: toNum(r.targetSales),
    waste: toNum(r.waste),
    wasteToSales: toNum(r.wasteToSales),
    rankWasteToSales: toNum(r.rankWasteToSales),
    bandSize: toNum(r.bandSize),
    bandMean: toNum(r.bandMean),
    bandStd: toNum(r.bandStd),
    zScore: r.zScore == null ? null : Number(r.zScore),
  }));
  return { rows: mapped, summary: summarizeWastePeerZScore(mapped) };
}
