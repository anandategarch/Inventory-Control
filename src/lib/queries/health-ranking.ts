// ============================================================
//  Health Ranking + Variance Analysis — SQL aggregate queries
//  --------------------------------------------------------
//  Replaces computeOutletHealthRanking + computeVarianceAnalysis
//  JS functions (src/engine/analysis/rankingService.ts) which
//  previously iterated over 35K raw currentRecs + prevRecs in RAM.
//
//  queryOutletHealthRanking:
//    - GROUP BY outlet — per-outlet aggregate stats
//    - Sales MODE per outlet (via ROW_NUMBER window, same as outlets.ts)
//    - zeroDevCount + nonZeroDevCount per outlet (for severity math)
//    - Returns ~19 rows (one per outlet) instead of 35K raw records
//
//  queryVarianceAnalysis:
//    - JOIN current + prev per (outletId, itemId, akunPenyesuaian)
//    - Computes selisih (signed delta), delta (abs delta), direction,
//      varianceDirection
//    - Returns ~5K rows (only items with prev match) — JS sorts + slices
//      top 5 worsened + top 5 improved (same as old computeVarianceAnalysis)
//
//  queryHistoricalCriticalItems:
//    - Fetches per-record fields (itemName, outletCode, area,
//      pctQtyDeviasiToBom, absNominalDeviasi) for the records flagged
//      by HISTORICAL_ABNORMAL / HISTORICAL_WARNING rules.
//    - Caller passes the list of (outletId, itemId, akunPenyesuaian)
//      tuples from histFlags (already computed by
//      evaluateHistoricalRulesJs).
//    - Returns rows that JS merges with historicalByOutletItem stats
//      to compute zScore + build criticalItems[] (top 50 by |zScore|).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

// ============================================================
//  Outlet Health Ranking — per-outlet aggregate (GROUP BY outlet)
// ============================================================
export interface OutletHealthRow {
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  absNominal: number;       // ABS(SUM(nominalDeviasi)) — for sorting
  nominalDeviasi: number;   // signed SUM — for display
  totalQtyDeviasi: number;
  totalQtyBom: number;
  totalQtyWaste: number;
  totalQtySusut: number;
  totalQtyTrial: number;
  totalResidualQty: number;
  lossNominal: number;      // SUM(ABS(nominalLossSurplus)) WHERE < 0
  sales: number;            // MODE per outlet
  zeroDevCount: number;     // records where qtyDeviasi=null/0 AND absNominalDeviasi=null/0
  nonZeroDevCount: number;  // records where NOT (above)
}

export async function queryOutletHealthRanking(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<OutletHealthRow[]> {
  const f = buildSqlFilters(filters);

  // Zero-dev classification matches the existing JS check exactly:
  //   zeroDev = (qtyDeviasi IS NULL OR = 0) AND (absNominalDeviasi IS NULL OR = 0)
  const zeroDevExpr = Prisma.sql`(
    (ir."qtyDeviasi" IS NULL OR ir."qtyDeviasi" = 0)
    AND (ir."absNominalDeviasi" IS NULL OR ir."absNominalDeviasi" = 0)
  )`;

  // Sales MODE per outlet (sub-CTE — same pattern as outlets.ts queryTopOutlets)
  // NOTE: we apply the zero-dev filter here too to match the existing JS
  // `dedupSalesByOutlet(recsWithFlags.map(r => r.curr))` which only considers
  // non-zero-dev records. (Sales is outlet-level denormalized so the MODE
  // is the same regardless, but we match the existing behaviour exactly.)
  // DEEP-AUDIT-BACKEND C4: wrap in withStatementTimeout — 3 CTEs with window funcs
  // can hang under PgBouncer tx mode.
  //
  // DB-06: sales_counts → ranked_sales → sales_mode CTE pipeline replaced
  // with pre-computed OutletPeriodSales table. Per the comment above (and
  // the INVESTIGATE report's edge-case analysis), nominalSales is outlet-level
  // denormalized so the precomputed MODE matches the inline CTE output even
  // when the inline CTE applied the `NOT zeroDevExpr` filter. The LEFT JOIN
  // to OutletPeriodSales naturally yields NULL (→ COALESCE 0) for outlets
  // with no sales records — same behaviour as the original LEFT JOIN to
  // sales_mode.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<OutletHealthRow[]>`
    WITH -- Per-outlet counts of zero-dev vs non-zero-dev records (over ALL records,
    -- not just non-zero-dev — zeroDevCount needs the unfiltered count).
    outlet_counts AS (
      SELECT ir."outletId",
        COUNT(*) FILTER (WHERE ${zeroDevExpr}) as "zeroDevCount",
        COUNT(*) FILTER (WHERE NOT ${zeroDevExpr}) as "nonZeroDevCount"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."outletId"
    ),
    -- Per-outlet aggregate over NON-zero-dev records only (matches existing JS
    -- which iterates recsWithFlags, an array that excludes zero-dev).
    outlet_aggs AS (
      SELECT ir."outletId",
        COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
        SUM(ABS(ir."qtyDeviasi")) as "totalQtyDeviasi",
        SUM(ABS(ir."qtyBom")) as "totalQtyBom",
        SUM(ABS(ir."qtyWaste")) as "totalQtyWaste",
        SUM(ABS(ir."qtySusut")) as "totalQtySusut",
        SUM(ABS(ir."qtyTrial")) as "totalQtyTrial",
        SUM(ABS(ir."residualQty")) as "totalResidualQty",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "lossNominal"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND NOT ${zeroDevExpr}
        ${f}
      GROUP BY ir."outletId"
    )
    SELECT oa."outletId",
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      ABS(oa."nominalDeviasi") as "absNominal",
      oa."nominalDeviasi",
      COALESCE(oa."totalQtyDeviasi", 0) as "totalQtyDeviasi",
      COALESCE(oa."totalQtyBom", 0) as "totalQtyBom",
      COALESCE(oa."totalQtyWaste", 0) as "totalQtyWaste",
      COALESCE(oa."totalQtySusut", 0) as "totalQtySusut",
      COALESCE(oa."totalQtyTrial", 0) as "totalQtyTrial",
      COALESCE(oa."totalResidualQty", 0) as "totalResidualQty",
      COALESCE(oa."lossNominal", 0) as "lossNominal",
      COALESCE(ops."salesMode", 0) as sales,
      COALESCE(oc."zeroDevCount", 0) as "zeroDevCount",
      COALESCE(oc."nonZeroDevCount", 0) as "nonZeroDevCount"
    FROM outlet_aggs oa
    JOIN "Outlet" o ON oa."outletId" = o.id
    LEFT JOIN "OutletPeriodSales" ops
      ON ops."outletId" = oa."outletId"
      AND ops."monthLabel" = ${month}
      AND ops."weekLabel" = ${week}
    LEFT JOIN outlet_counts oc ON oa."outletId" = oc."outletId"
    ORDER BY "absNominal" DESC
  `);

  // Coerce BigInt → Number (PostgreSQL COUNT returns bigint; SUM returns numeric)
  return rows.map((r) => ({
    outletId: Number(r.outletId),
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area,
    absNominal: Number(r.absNominal) || 0,
    nominalDeviasi: Number(r.nominalDeviasi) || 0,
    totalQtyDeviasi: Number(r.totalQtyDeviasi) || 0,
    totalQtyBom: Number(r.totalQtyBom) || 0,
    totalQtyWaste: Number(r.totalQtyWaste) || 0,
    totalQtySusut: Number(r.totalQtySusut) || 0,
    totalQtyTrial: Number(r.totalQtyTrial) || 0,
    totalResidualQty: Number(r.totalResidualQty) || 0,
    lossNominal: Number(r.lossNominal) || 0,
    sales: Number(r.sales) || 0,
    zeroDevCount: Number(r.zeroDevCount) || 0,
    nonZeroDevCount: Number(r.nonZeroDevCount) || 0,
  }));
}

// ============================================================
//  Variance Analysis — JOIN curr + prev per (outlet, item, akun)
//  Returns ~5K rows; JS sorts + slices top 5 worsened + top 5 improved
//  (same shape as computeVarianceAnalysis JS function).
// ============================================================
export interface VarianceRow {
  itemName: string;
  outletCode: string;
  area: string;
  currentNominal: number;
  previousNominal: number;
  selisih: number;        // signed delta (currentNominal - previousNominal)
  currentAbsNominal: number;
  previousAbsNominal: number;
  delta: number;          // abs delta (currentAbs - previousAbs)
  direction: string;      // LOSS | SURPLUS | NEUTRAL (from current)
  varianceDirection: string;  // WORSENED | IMPROVED | STABLE
}

export async function queryVarianceAnalysis(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
): Promise<{ topWorsened: VarianceRow[]; topImproved: VarianceRow[] }> {
  if (!prevWeek || !prevMonth) {
    return { topWorsened: [], topImproved: [] };
  }
  // FIX (DEEP-AUDIT-IR): pass alias='c' — this query uses "InventoryRecord" c
  // (current) JOIN "InventoryRecord" p (prev). buildSqlFilters defaults to 'ir'
  // which doesn't exist in this query's FROM clause → "missing FROM-clause entry
  // for table ir" error when any filter (area/outlet/pic/item) is active.
  const f = buildSqlFilters(filters, 'c');

  // DEEP-AUDIT-BACKEND C4: wrap in withStatementTimeout — self-join on 272K rows.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<VarianceRow[]>`
    SELECT
      i.name as "itemName",
      o.code as "outletCode",
      c.area,
      COALESCE(c."nominalDeviasi", 0) as "currentNominal",
      COALESCE(p."nominalDeviasi", 0) as "previousNominal",
      COALESCE(c."nominalDeviasi", 0) - COALESCE(p."nominalDeviasi", 0) as "selisih",
      c."absNominalDeviasi" as "currentAbsNominal",
      p."absNominalDeviasi" as "previousAbsNominal",
      c."absNominalDeviasi" - p."absNominalDeviasi" as "delta",
      CASE
        WHEN c."nominalLossSurplus" IS NOT NULL AND c."nominalLossSurplus" < 0 THEN 'LOSS'
        WHEN c."nominalLossSurplus" IS NOT NULL AND c."nominalLossSurplus" > 0 THEN 'SURPLUS'
        WHEN c."nominalLossSurplus" IS NULL AND c."qtyDeviasi" < 0 THEN 'LOSS'
        WHEN c."nominalLossSurplus" IS NULL AND c."qtyDeviasi" > 0 THEN 'SURPLUS'
        ELSE 'NEUTRAL'
      END as "direction",
      CASE
        -- FIX (DEEP-AUDIT-LOGIC #4 + AUDIT-CALC-SQL EDGE-2): detect direction flip.
        -- SURPLUS→LOSS = deterioration (WORSENED) — was positive, now negative.
        -- LOSS→SURPLUS = recovery (IMPROVED) — was negative, now positive.
        -- Previously both flips were WORSENED — recovery was misclassified.
        WHEN (c."nominalLossSurplus" < 0 AND p."nominalLossSurplus" > 0) THEN 'WORSENED'
        WHEN (c."nominalLossSurplus" > 0 AND p."nominalLossSurplus" < 0) THEN 'IMPROVED'
        WHEN (c."absNominalDeviasi" - p."absNominalDeviasi") > 0 THEN 'WORSENED'
        WHEN (c."absNominalDeviasi" - p."absNominalDeviasi") < 0 THEN 'IMPROVED'
        ELSE 'STABLE'
      END as "varianceDirection"
    FROM "InventoryRecord" c
    JOIN "InventoryRecord" p
      ON p."outletId" = c."outletId"
      AND p."itemId" = c."itemId"
      AND p."akunPenyesuaian" IS NOT DISTINCT FROM c."akunPenyesuaian"
      AND p."monthLabel" = ${prevMonth}
      AND p."weekLabel" = ${prevWeek}
    JOIN "Item" i ON c."itemId" = i.id
    JOIN "Outlet" o ON c."outletId" = o.id
    WHERE c."monthLabel" = ${month}
      AND c."weekLabel" = ${week}
      AND c."absNominalDeviasi" IS NOT NULL
      AND p."absNominalDeviasi" IS NOT NULL
      ${f}
  `);

  const typed = rows.map((r) => ({
    itemName: r.itemName,
    outletCode: r.outletCode,
    area: r.area,
    currentNominal: Number(r.currentNominal) || 0,
    previousNominal: Number(r.previousNominal) || 0,
    selisih: Number(r.selisih) || 0,
    currentAbsNominal: Number(r.currentAbsNominal) || 0,
    previousAbsNominal: Number(r.previousAbsNominal) || 0,
    delta: Number(r.delta) || 0,
    direction: r.direction,
    varianceDirection: r.varianceDirection,
  }));

  // Sort + slice — matches existing computeVarianceAnalysis exactly.
  const topWorsened = [...typed].sort((a, b) => b.delta - a.delta).slice(0, 5);
  const topImproved = [...typed].sort((a, b) => a.delta - b.delta).slice(0, 5);
  return { topWorsened, topImproved };
}

// ============================================================
//  Historical Critical Items — fetch per-record fields for items
//  flagged by HISTORICAL_ABNORMAL / HISTORICAL_WARNING rules.
//
//  Caller passes the list of (outletId, itemId, akunPenyesuaian)
//  tuples extracted from histFlags. We run a single SQL query that
//  returns the per-record fields needed to build criticalItems[]
//  (itemName, outletCode, area, pctQtyDeviasiToBom, absNominalDeviasi).
//
//  The caller then merges with historicalByOutletItem stats + computes
//  zScore in JS (using the same calcZScoreFromStats helper as the old
//  computeHistoricalAnalysis function).
// ============================================================
export interface HistoricalCriticalRow {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
  itemName: string;
  outletCode: string;
  area: string;
  pctQtyDeviasiToBom: number | null;
  absNominalDeviasi: number | null;
}

export async function queryHistoricalCriticalItems(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  flaggedKeys: Array<{ outletId: number; itemId: number; akunPenyesuaian: string | null }>,
): Promise<HistoricalCriticalRow[]> {
  if (flaggedKeys.length === 0) return [];
  // FIX (DEEP-AUDIT-IR): pass alias='c' — this query uses "InventoryRecord" c
  // (current). buildSqlFilters defaults to 'ir' which doesn't exist here.
  const f = buildSqlFilters(filters, 'c');

  // Build a VALUES list of (outletId, itemId, akunPenyesuaian) tuples.
  // PostgreSQL supports IS NOT DISTINCT FROM for NULL-safe equality on akun.
  // We use Prisma.join with a list of (Prisma.sql) fragments — each tuple
  // is rendered as `(outletId, itemId, akunOrNull)`.
  const tupleValues = flaggedKeys.map((k) =>
    Prisma.sql`(${k.outletId}, ${k.itemId}, ${k.akunPenyesuaian})`
  );
  const tuples = Prisma.join(tupleValues, ', ');

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<HistoricalCriticalRow[]>`
    SELECT
      c."outletId",
      c."itemId",
      c."akunPenyesuaian",
      i.name as "itemName",
      o.code as "outletCode",
      c.area,
      c."pctQtyDeviasiToBom",
      c."absNominalDeviasi"
    FROM "InventoryRecord" c
    JOIN "Item" i ON c."itemId" = i.id
    JOIN "Outlet" o ON c."outletId" = o.id
    JOIN (VALUES ${tuples}) AS v(outletId, itemId, akunPenyesuaian)
      ON c."outletId" = v.outletId
      AND c."itemId" = v.itemId
      AND c."akunPenyesuaian" IS NOT DISTINCT FROM v.akunPenyesuaian
    WHERE c."monthLabel" = ${month}
      AND c."weekLabel" = ${week}
      ${f}
  `);

  return rows.map((r) => ({
    outletId: Number(r.outletId),
    itemId: Number(r.itemId),
    akunPenyesuaian: r.akunPenyesuaian,
    itemName: r.itemName,
    outletCode: r.outletCode,
    area: r.area,
    pctQtyDeviasiToBom: r.pctQtyDeviasiToBom == null ? null : Number(r.pctQtyDeviasiToBom),
    absNominalDeviasi: r.absNominalDeviasi == null ? null : Number(r.absNominalDeviasi),
  }));
}
