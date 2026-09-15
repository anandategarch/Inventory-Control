// ============================================================
//  Self-History Anomaly — items deviating from their OWN history
//  --------------------------------------------------------
//  REFINE-3 (user request: "Section Item Anomali vs Riwayat Sendiri").
//  For every (item, outlet) present in the CURRENT period, compares the
//  current SUM(qtyDeviasi) against the SAME (item, outlet)'s historical
//  average — the same same-week-across-prior-months window the report's
//  "Rata-rata per Bulan" column uses (flip-ranking / item-trend-matrix /
//  queryHistoricalCategoryAvg convention), so the sections corroborate
//  each other. An item-outlet qualifies as ANOMALI when its departure is
//  ≥ 50% of its own baseline (large in relative terms); rows are ranked
//  by the biggest ABSOLUTE departure (the report's "Terbesar"
//  convention — big-volume items don't get crowded out by noise, noise
//  doesn't get promoted by tiny baselines).
//
//  Implementation notes:
//  - per-PERIOD sums first, then AVG across periods — a plain AVG over
//    raw rows would weight months by their row counts.
//  - histCount = the number of historical periods behind each average
//    (carried so the report can state its basis).
//  - withStatementTimeout + buildSqlFilters (area/kelompok/outletCode/
//    picOutletCodes). itemName is NOT filtered (the ranking scans all
//    items — same rationale as item-trend-matrix).
//  - Prisma.sql tagged templates only (zero $queryRawUnsafe).
//  - BigInt/Decimal coercion via Number().
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
  /** Current-period SUM(qtyDeviasi) — SIGNED. */
  qty: number;
  /** Own historical average of per-period SUM(qtyDeviasi) — SIGNED. */
  histAvgQty: number;
  /** # historical periods behind the average. */
  histCount: number;
  /** qty − histAvgQty. */
  deltaQty: number;
  /** Current-period SUM(nominalDeviasi) — SIGNED (impact context). */
  nominal: number;
}

export interface SelfHistoryAnomalyResult {
  rows: SelfHistoryAnomalyRow[];
}

/**
 * Top (item, outlet) rows whose current QTY deviasi departs most from
 * their own same-week historical average.
 *
 * @param opts.week                e.g. "WEEK 1" — the exported week.
 * @param opts.month               e.g. "September 2026" — the exported month.
 * @param opts.historicalPeriods   same-week periods in prior months (the
 *                                 export pipeline's historicalPeriods list).
 * @param opts.filters             dashboard filters (area/kelompok/outlet/
 *                                 pic; itemName is ignored).
 * @param opts.limit               row cap (TOP_N_ITEMS convention).
 */
export async function querySelfHistoryAnomaly(opts: {
  week: string;
  month: string;
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>;
  filters: SqlFilterOpts;
  limit: number;
}): Promise<SelfHistoryAnomalyResult> {
  const { week, month, historicalPeriods, filters, limit } = opts;
  if (historicalPeriods.length === 0) return { rows: [] };

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

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string;
    outletCode: string;
    area: string;
    satuan: string | null;
    qty: number | bigint;
    histAvgQty: number | bigint;
    histCount: number | bigint;
    deltaQty: number | bigint;
    nominal: number | bigint;
  }>>`
    WITH hist AS (
      SELECT "itemId", "outletId",
        AVG("qty") as "histAvgQty",
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
    SELECT i.name as "itemName", o.code as "outletCode", o.area,
      c."satuan", c."qty", h."histAvgQty", h."histCount",
      (c."qty" - h."histAvgQty") as "deltaQty", c."nominal"
    FROM cur c
    JOIN hist h ON h."itemId" = c."itemId" AND h."outletId" = c."outletId"
    JOIN "Item" i ON i.id = c."itemId"
    JOIN "Outlet" o ON o.id = c."outletId"
    WHERE h."histAvgQty" != 0
      AND ABS(c."qty" - h."histAvgQty") > 0
      AND ABS(c."qty" - h."histAvgQty") >= 0.5 * ABS(h."histAvgQty")
    ORDER BY ABS(c."qty" - h."histAvgQty") DESC
    LIMIT ${limit}
  `);

  return {
    rows: rows.map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      area: r.area,
      satuan: r.satuan ?? null,
      qty: Number(r.qty) || 0,
      histAvgQty: Number(r.histAvgQty) || 0,
      histCount: Number(r.histCount) || 0,
      deltaQty: Number(r.deltaQty) || 0,
      nominal: Number(r.nominal) || 0,
    })),
  };
}
