// ============================================================
//  Benchmark Opportunity — "Peluang Perbaikan (Rp)" vs median area
//  --------------------------------------------------------
//  ANA-1-E (roadmap "Benchmark Opportunity"): turns the area
//  benchmark from a comparison into a MEASURED Rp number.
//
//  For the running period (month + week, same filter scope as
//  peer-comparison i.e. kelompok) it computes, per outlet:
//    lossNominal   = SUM(ABS(nominalLossSurplus)) WHERE < 0
//                    (LOSS = negative — EXACT same definition as
//                    dashboard.ts totalLoss, per record)
//    areaMedianLoss = percentile_cont(0.5) of lossNominal over the
//                    outlets sharing the same area (PostgreSQL
//                    ordered-set aggregate)
//    opportunityRp = GREATEST(0, lossNominal − areaMedianLoss)
//
//  Output: total Rp suppressible network-wide (Σ opportunityRp),
//  the number of areas covered, and the top outlets by opportunity.
//  Purely additive read-only query — no mutation, no action/workflow.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

/** One outlet row of the benchmark (post median-join). */
export interface BenchmarkOpportunityOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  /** SUM(ABS(nominalLossSurplus)) WHERE nominalLossSurplus < 0 (dashboard.ts totalLoss). */
  lossNominal: number;
  /** percentile_cont(0.5) of lossNominal across the outlets in the same area. */
  areaMedianLoss: number;
  /** GREATEST(0, lossNominal − areaMedianLoss). */
  opportunityRp: number;
  /** SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom)) — 0 when the outlet has no BOM qty. */
  devBom: number;
}

/** Response of queryBenchmarkOpportunity (also the /api/benchmark-opportunity data payload). */
export interface BenchmarkOpportunityResult {
  /** Σ opportunityRp over ALL outlets in scope. */
  totalOpportunityRp: number;
  /** Distinct areas with ≥1 outlet having records in the period + filter scope. */
  areaCount: number;
  /** Top outlets by opportunityRp (max 8). */
  topOutlets: BenchmarkOpportunityOutlet[];
}

/** Spec: top 8 outlets surfaced (frontend BarList shows top 5 of these). */
const TOP_OUTLETS_LIMIT = 8;

export async function queryBenchmarkOpportunity(
  month: string,
  week: string | null,
  filters: SqlFilterOpts
): Promise<BenchmarkOpportunityResult> {
  // Same cumulative-week semantics as peer-comparison.ts: weeks are MTD
  // snapshots (W1=1-7 … W4=1-25), so a missing week falls back to the
  // LATEST week (MAX weekLabel) of the month instead of summing weeks
  // (which would double-count).
  const weekFilter = week
    ? Prisma.sql`AND ir."weekLabel" = ${week}`
    : Prisma.sql`AND ir."weekLabel" = (
        SELECT MAX(ir2."weekLabel") FROM "InventoryRecord" ir2
        WHERE ir2."monthLabel" = ${month}
      )`;

  // Same filter scope as peer-comparison (kelompok restricts the outlet set).
  const f = buildSqlFilters(filters);

  // Row shape produced by the SELECT below. Aggregates of Float columns come
  // back as double precision (number), but coerce defensively like
  // peer-comparison does (bigint-safe NULLIF'd devBom may also be null).
  interface BenchmarkOpportunityRawRow {
    outletCode: string;
    outletName: string;
    area: string;
    lossNominal: number | bigint | null;
    areaMedianLoss: number | bigint | null;
    opportunityRp: number | bigint | null;
    devBom: number | bigint | null;
  }
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<BenchmarkOpportunityRawRow[]>`
    WITH outlet_loss AS (
      SELECT
        o.code as "outletCode",
        o.name as "outletName",
        -- FIX (BUG-2-c): area from InventoryRecord (ir.area), NOT Outlet.area —
        -- the same source buildSqlFilters filters on and areas.ts groups by.
        -- Production data has drift between the two (outlet reassignments),
        -- so o.area grouped outlets into areas their FILTERED records don't
        -- belong to (an area-filtered outlet could land in a foreign area's
        -- median). MAX(ir.area) keeps GROUP BY o.id unique (one row per
        -- outlet — no double-count in the median when a single outlet's
        -- records span two areas in one period), mirroring areas.ts which
        -- also aggregates on ir.area.
        MAX(ir.area) as "area",
        -- FIX CALC-4 convention (dashboard.ts): LOSS = negative
        -- nominalLossSurplus — take ABS per record, per-outlet SUM.
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "lossNominal",
        SUM(ABS(ir."qtyDeviasi")) / NULLIF(SUM(ABS(ir."qtyBom")), 0) as "devBom"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month}
        ${weekFilter}
        ${f}
      GROUP BY o.id
    ),
    area_median AS (
      -- Median loss per area over the per-outlet CTE (percentile_cont
      -- interpolates between the two middle values for even outlet counts).
      SELECT
        "area",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "lossNominal") as "medianLoss"
      FROM outlet_loss
      GROUP BY "area"
    ),
    outlet_opportunity AS (
      SELECT
        ol."outletCode",
        ol."outletName",
        ol."area",
        COALESCE(ol."lossNominal", 0) as "lossNominal",
        COALESCE(am."medianLoss", 0) as "areaMedianLoss",
        GREATEST(0, COALESCE(ol."lossNominal", 0) - COALESCE(am."medianLoss", 0)) as "opportunityRp",
        COALESCE(ol."devBom", 0) as "devBom"
      FROM outlet_loss ol
      JOIN area_median am ON ol."area" = am."area"
    )
    SELECT
      "outletCode",
      "outletName",
      "area",
      "lossNominal",
      "areaMedianLoss",
      "opportunityRp",
      "devBom"
    FROM outlet_opportunity
    ORDER BY "opportunityRp" DESC, "outletCode" ASC
  `);

  const outlets: BenchmarkOpportunityOutlet[] = rows.map((r) => ({
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area,
    lossNominal: Number(r.lossNominal ?? 0),
    areaMedianLoss: Number(r.areaMedianLoss ?? 0),
    opportunityRp: Number(r.opportunityRp ?? 0),
    devBom: Number(r.devBom ?? 0),
  }));

  const areaCount = new Set(outlets.map((o) => o.area)).size;
  const totalOpportunityRp = outlets.reduce((s, o) => s + o.opportunityRp, 0);
  // Zero-opportunity outlets are never "top" anything — keep the list clean
  // (a total of 0 therefore also yields an empty topOutlets array, which the
  // frontend renders as its friendly no-opportunity state).
  const topOutlets = outlets
    .filter((o) => o.opportunityRp > 0)
    .sort((a, b) => b.opportunityRp - a.opportunityRp)
    .slice(0, TOP_OUTLETS_LIMIT);

  return { totalOpportunityRp, areaCount, topOutlets };
}
