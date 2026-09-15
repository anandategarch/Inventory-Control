// ============================================================
//  Self-History Anomaly — items deviating from their OWN history
//  --------------------------------------------------------
//  REFINE-3 (user request: "Section Item Anomali vs Riwayat Sendiri").
//  For every (item, outlet) present in the CURRENT period, compares the
//  current SUM(qtyDeviasi) against the SAME (item, outlet)'s historical
//  average — the same same-week-across-prior-months window the report's
//  "Rata-rata Absolute" column uses (flip-ranking / item-trend-matrix /
//  queryHistoricalCategoryAvg convention), so the sections corroborate
//  each other.
//
//  REFINE-4 (user requests: "Rata rata per bulan ini apakah pakai
//  absolute? atau pakai nilai asli? jika pakai nilai asli ganti ke
//  absolute di engine" + "Item Anomali vs Riwayat Sendiri itu di laporan
//  apakah sudah bisa deteksi yang biasanya loss tapi sekarang surplus?
//  kalau belum tambahkan"):
//    - histAvgQty is now the ABSOLUTE average (AVG of per-period |SUM|)
//      — "Rata-Rata Absolute" — matching queryHistoricalCategoryAvg.
//      The signed average is kept SEPARATELY (histSignedAvgQty) purely
//      as the usual-direction signal for flip detection + display.
//    - Magnitude eligibility: | |cur| − histAvgAbs | ≥ 50% of histAvgAbs
//      (the current deviation magnitude departs ≥ 50% from its own
//      typical magnitude — consistent with the ABS baseline).
//    - NEW flip detection ("biasanya loss tapi sekarang surplus" and the
//      reverse). A row is a FLIP when:
//        sign(cur) ≠ sign(histAvgSigned)                [direction reversed]
//        AND |histAvgSigned| ≥ 0.5 × histAvgAbs         [history was
//                                                         predominantly ONE
//                                                         direction — an
//         alternating history is not "biasanya loss"]
//        AND |cur| ≥ 0.25 × histAvgAbs                  [current side is
//                                                         material, not a
//                                                         zero-crossing
//                                                         wiggle]
//      Flips qualify for the result EVEN when their magnitude departure
//      is < 50%, and are returned as a SEPARATE ranked list (flipRows,
//      by |nominal| DESC) so the report's 6.2 table can show them
//      without being crowded out by pure-magnitude rows.
//
// Implementation notes:
//  - per-PERIOD sums first, then AVG across periods — a plain AVG over
//    raw rows would weight months by their row counts.
//  - histCount = the number of historical periods behind each average
//    (carried so the report can state its basis).
//  - withStatementTimeout + buildSqlFilters (area/kelompok/outletCode/
//    picOutletCodes). itemName is NOT filtered (the ranking scans all
//    items — same rationale as item-trend-matrix).
//  - Prisma.sql tagged templates only (zero $queryRawUnsafe).
//  - BigInt/Decimal coercion via Number().
//  - SQLite-portable SQL: no SIGN() builtin — sign comparisons are
//    spelled as explicit `(x > 0 AND y < 0) OR (x < 0 AND y > 0)` forms.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

/** One (item, outlet) row ranked by departure from its own history. */
export interface SelfHistoryAnomalyRow {
  itemName: string;
  outletCode: string;
  area: string;
  /** MAX(ir."satuan") — per-item unit of measure (GROUP BY-safe). */
  satuan: string | null;
  /** Current-period SUM(qtyDeviasi) — SIGNED (positive = surplus side). */
  qty: number;
  /**
   * Own historical average of per-period |SUM(qtyDeviasi)| — ABSOLUTE
   * ("Rata-Rata Absolute", REFINE-4). The magnitude benchmark.
   */
  histAvgQty: number;
  /**
   * Own historical average of per-period SUM(qtyDeviasi) — SIGNED.
   * The usual-DIRECTION signal (flip detection + 6.2 display only;
   * never used as a magnitude benchmark).
   */
  histSignedAvgQty: number;
  /** # historical periods behind the average. */
  histCount: number;
  /** |qty| − histAvgQty — magnitude delta (REFINE-4 semantics). */
  deltaQty: number;
  /**
   * REFINE-4: direction reversal vs own history — 'lossToSurplus'
   * (biasanya loss, kini surplus), 'surplusToLoss' (sebaliknya), or
   * null when the direction held.
   */
  flip: 'lossToSurplus' | 'surplusToLoss' | null;
  /** Current-period SUM(nominalDeviasi) — SIGNED (impact context). */
  nominal: number;
}

export interface SelfHistoryAnomalyResult {
  /** Magnitude-departure ranking (may include flip rows too). */
  rows: SelfHistoryAnomalyRow[];
  /** REFINE-4: sign-flip rows, ranked by |nominal| DESC. */
  flipRows: SelfHistoryAnomalyRow[];
}

/** Raw row shape shared by both SELECTs below. */
interface RawAnomalyRow {
  itemName: string;
  outletCode: string;
  area: string;
  satuan: string | null;
  qty: number | bigint;
  histAvgQty: number | bigint;
  histSignedAvgQty: number | bigint;
  histCount: number | bigint;
  deltaQty: number | bigint;
  flip: string | null;
  nominal: number | bigint;
}

/**
 * Top (item, outlet) rows whose current QTY deviasi departs most from
 * their own same-week historical average, PLUS the rows whose
 * direction flipped vs their own history (REFINE-4).
 *
 * @param opts.week                e.g. "WEEK 1" — the exported week.
 * @param opts.month               e.g. "September 2026" — the exported month.
 * @param opts.historicalPeriods   same-week periods in prior months (the
 *                                 export pipeline's historicalPeriods list).
 * @param opts.filters             dashboard filters (area/kelompok/outlet/
 *                                 pic; itemName is ignored).
 * @param opts.limit               magnitude row cap (TOP_N_ITEMS convention).
 * @param opts.flipLimit           flip row cap (default 10).
 */
export async function querySelfHistoryAnomaly(opts: {
  week: string;
  month: string;
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>;
  filters: SqlFilterOpts;
  limit: number;
  flipLimit?: number;
}): Promise<SelfHistoryAnomalyResult> {
  const { week, month, historicalPeriods, filters, limit, flipLimit = 10 } = opts;
  if (historicalPeriods.length === 0) return { rows: [], flipRows: [] };

  // itemName stripped — the ranking must scan all items (same rationale
  // as queryItemTrendMatrix: a LIKE filter would over-match names).
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });
  const historicalMonths = [...new Set(historicalPeriods.map((p) => p.monthLabel))];
  const monthClauses = Prisma.join(historicalMonths, ', ');

  // REFINE-4: the shared projection — ABS + SIGNED averages side by side,
  // the magnitude delta, and the flip classification. The flip CASE is
  // spelled without SQLite-missing SIGN(): explicit sign comparisons.
  const select = Prisma.sql`
    SELECT i.name as "itemName", o.code as "outletCode", o.area,
      c."satuan", c."qty",
      h."histAvgAbs" as "histAvgQty",
      h."histAvgSigned" as "histSignedAvgQty",
      h."histCount",
      (ABS(c."qty") - h."histAvgAbs") as "deltaQty",
      CASE
        WHEN ((c."qty" > 0 AND h."histAvgSigned" < 0) OR (c."qty" < 0 AND h."histAvgSigned" > 0))
          AND ABS(h."histAvgSigned") >= 0.5 * h."histAvgAbs"
          AND ABS(c."qty") >= 0.25 * h."histAvgAbs"
        THEN CASE WHEN c."qty" > 0 THEN 'lossToSurplus' ELSE 'surplusToLoss' END
        ELSE NULL
      END as "flip",
      c."nominal"
    FROM cur c
    JOIN hist h ON h."itemId" = c."itemId" AND h."outletId" = c."outletId"
    JOIN "Item" i ON i.id = c."itemId"
    JOIN "Outlet" o ON o.id = c."outletId"`;

  // Query 1 — magnitude-departure ranking (≥ 50% of the ABS baseline).
  // A flip is also flagged on these rows (shown for cross-reference) but
  // flips do NOT reorder this ranking.
  const magnitudeRows = await withStatementTimeout((tx) => tx.$queryRaw<RawAnomalyRow[]>`
    WITH hist AS (
      SELECT "itemId", "outletId",
        AVG(ABS(perPeriod."qty")) as "histAvgAbs",
        AVG(perPeriod."qty") as "histAvgSigned",
        COUNT(*) as "histCount"
      FROM (
        SELECT ir."itemId", ir."outletId", ir."monthLabel",
          SUM(ir."qtyDeviasi") as "qty"
        FROM "InventoryRecord" ir
        WHERE ir."weekLabel" = ${week}
          AND ir."monthLabel" IN (${monthClauses})
          ${f}
        GROUP BY ir."itemId", ir."outletId", ir."monthLabel"
      ) perPeriod
      GROUP BY "itemId", "outletId"
    ),
    cur AS (
      SELECT ir."itemId", ir."outletId",
        SUM(ir."qtyDeviasi") as "qty",
        SUM(ir."nominalDeviasi") as "nominal",
        MAX(ir."satuan") as "satuan"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."itemId", ir."outletId"
    )
    ${select}
    WHERE h."histAvgAbs" > 0
      AND ABS(ABS(c."qty") - h."histAvgAbs") > 0
      AND ABS(ABS(c."qty") - h."histAvgAbs") >= 0.5 * h."histAvgAbs"
    ORDER BY ABS(ABS(c."qty") - h."histAvgAbs") DESC, ABS(c."qty") DESC
    LIMIT ${limit}
  `);

  // Query 2 — REFINE-4 flip ranking ("biasanya loss tapi sekarang surplus"
  // and the reverse), by |nominal| DESC (biggest current impact first).
  const flipRows = await withStatementTimeout((tx) => tx.$queryRaw<RawAnomalyRow[]>`
    WITH hist AS (
      SELECT "itemId", "outletId",
        AVG(ABS(perPeriod."qty")) as "histAvgAbs",
        AVG(perPeriod."qty") as "histAvgSigned",
        COUNT(*) as "histCount"
      FROM (
        SELECT ir."itemId", ir."outletId", ir."monthLabel",
          SUM(ir."qtyDeviasi") as "qty"
        FROM "InventoryRecord" ir
        WHERE ir."weekLabel" = ${week}
          AND ir."monthLabel" IN (${monthClauses})
          ${f}
        GROUP BY ir."itemId", ir."outletId", ir."monthLabel"
      ) perPeriod
      GROUP BY "itemId", "outletId"
    ),
    cur AS (
      SELECT ir."itemId", ir."outletId",
        SUM(ir."qtyDeviasi") as "qty",
        SUM(ir."nominalDeviasi") as "nominal",
        MAX(ir."satuan") as "satuan"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY ir."itemId", ir."outletId"
    )
    ${select}
    WHERE h."histAvgAbs" > 0
      AND ((c."qty" > 0 AND h."histAvgSigned" < 0) OR (c."qty" < 0 AND h."histAvgSigned" > 0))
      AND ABS(h."histAvgSigned") >= 0.5 * h."histAvgAbs"
      AND ABS(c."qty") >= 0.25 * h."histAvgAbs"
    ORDER BY ABS(c."nominal") DESC, ABS(c."qty") DESC
    LIMIT ${flipLimit}
  `);

  const mapRow = (r: RawAnomalyRow): SelfHistoryAnomalyRow => ({
    itemName: r.itemName,
    outletCode: r.outletCode,
    area: r.area,
    satuan: r.satuan ?? null,
    qty: Number(r.qty) || 0,
    histAvgQty: Number(r.histAvgQty) || 0,
    histSignedAvgQty: Number(r.histSignedAvgQty) || 0,
    histCount: Number(r.histCount) || 0,
    deltaQty: Number(r.deltaQty) || 0,
    flip: r.flip === 'lossToSurplus' || r.flip === 'surplusToLoss' ? r.flip : null,
    nominal: Number(r.nominal) || 0,
  });

  return {
    rows: magnitudeRows.map(mapRow),
    flipRows: flipRows.map(mapRow),
  };
}
