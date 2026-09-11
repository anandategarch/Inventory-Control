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
//    - Returns ≤10 rows (top 5 worsened + top 5 improved via ROW_NUMBER
//      windows — FIX AUDIT-PERF-4; was ~5K rows with JS sort+slice)
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
import { queryOutletAggregateScan } from './outlets/outlet-agg-scan';

// ============================================================
//  Outlet Health Ranking — per-outlet aggregate (GROUP BY outlet)
//  --------------------------------------------------------
//  H-10 (G1 scan-share): the bespoke SQL scan was replaced by the
//  shared queryOutletAggregateScan (q-outlet-agg) — a superset scan
//  that also feeds queryRestoRecommendations. This function now only
//  SHAPES the health projection from the scan rows:
//    - keeps only outlets with ≥1 non-zero-dev record (the old
//      HAVING COUNT(*) FILTER (WHERE NOT zeroDevExpr) > 0);
//    - uses the f-prefixed FILTER (WHERE NOT zeroDev) columns, so the
//      payload is byte-identical to the previous standalone query;
//    - re-sorts by |filtered nominalDeviasi| DESC in JS (≤ ~333 rows).
//  Net effect: the analysis cold path and /api/recommendations share
//  ONE cached scan instead of scanning the ~280K-row period twice.
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
  highLossThreshold?: number,
): Promise<OutletHealthRow[]> {
  const rows = await queryOutletAggregateScan(week, month, filters, highLossThreshold);

  return rows
    .filter((r) => r.nonZeroDevCount > 0)
    .map((r) => ({
      outletId: r.outletId,
      outletCode: r.outletCode,
      outletName: r.outletName,
      area: r.area,
      absNominal: Math.abs(r.fNominalDeviasi),
      nominalDeviasi: r.fNominalDeviasi,
      totalQtyDeviasi: r.fTotalQtyDeviasi,
      totalQtyBom: r.fTotalQtyBom,
      totalQtyWaste: r.fTotalQtyWaste,
      totalQtySusut: r.fTotalQtySusut,
      totalQtyTrial: r.fTotalQtyTrial,
      totalResidualQty: r.fTotalResidualQty,
      lossNominal: r.fLossNominal,
      sales: r.sales,
      zeroDevCount: r.zeroDevCount,
      nonZeroDevCount: r.nonZeroDevCount,
    }))
    .sort((a, b) => b.absNominal - a.absNominal);
}

// ============================================================
//  Variance Analysis — JOIN curr + prev per (outlet, item, akun)
//  FIX (AUDIT-PERF-4): top-N pushdown — transfers 10 rows instead of
//  ~20-35K. The full joined row set was only ever used to sort + slice
//  top 5 worsened + top 5 improved (verified consumers: assemble-response
//  passes {topWorsened, topImproved} through verbatim; export-report's
//  docx-builder reads va.topWorsened.slice(0,10)). The ROW_NUMBER windows
//  (rw = worst-first, ri = improved-first) now enforce the same top-5 +
//  top-5 cap in SQL; JS still sorts/slices the ≤10 returned rows.
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
  // FIX (AUDIT-PERF-4): top-N pushdown — the `variance` CTE holds the original
  // SELECT verbatim (same joins/expressions/filters); the `ranked` CTE computes
  // rw = ROW_NUMBER(ORDER BY delta DESC) and ri = ROW_NUMBER(ORDER BY delta ASC)
  // (both with "itemName"/"outletCode" tie-breaks so results are deterministic
  // across requests — the old JS sort kept DB order for ties, which was
  // nondeterministic). Only rows in either top-5 leave the database.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<VarianceRow[]>`
    WITH variance AS (
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
    ),
    ranked AS (
      SELECT v.*,
        ROW_NUMBER() OVER (ORDER BY v."delta" DESC, v."itemName", v."outletCode") as rw,
        ROW_NUMBER() OVER (ORDER BY v."delta" ASC, v."itemName", v."outletCode") as ri
      FROM variance v
    )
    SELECT
      "itemName", "outletCode", "area", "currentNominal", "previousNominal", "selisih",
      "currentAbsNominal", "previousAbsNominal", "delta", "direction", "varianceDirection"
    FROM ranked
    WHERE rw <= 5 OR ri <= 5
    ORDER BY "delta" DESC, "itemName", "outletCode"
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

  // Sort + slice — rows arrive pre-filtered to the union of both top-5s
  // (≤10 rows), so this is now a cheap no-op-cost ordering over 10 rows.
  // Matches existing computeVarianceAnalysis exactly: topWorsened = largest
  // positive delta (abs deviation grew), topImproved = most negative delta.
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
  qtyDeviasi: number | null; // signed value for display (Z-Score uses ABS)
  // Multi-metric fields (Phase B-1) — use QTY not nominal
  qtyWaste: number | null;
  qtySusut: number | null;
  qtyTrial: number | null;
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
      c."absNominalDeviasi",
      c."qtyDeviasi",
      c."qtyWaste",
      c."qtySusut",
      c."qtyTrial"
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
    qtyDeviasi: r.qtyDeviasi == null ? null : Number(r.qtyDeviasi),
    qtyWaste: r.qtyWaste == null ? null : Number(r.qtyWaste),
    qtySusut: r.qtySusut == null ? null : Number(r.qtySusut),
    qtyTrial: r.qtyTrial == null ? null : Number(r.qtyTrial),
  }));
}
