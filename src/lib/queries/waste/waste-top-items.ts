// ============================================================
//  Waste Top Items — Pareto (DEEP-WASTE-1)
//  --------------------------------------------------------
//  The in-app version of the offline report's "Top Item Waste"
//  (Pareto + kumulatif + #outlet/#bulan sistematik) + "Item×Outlet"
//  sheets: the TOP-N items by ΣABS nominalWaste over the same-week
//  multi-month window (most recent 12 months, incl. running month),
//  scoped by the global filters, with:
//    - waste qty (ΣABS qtyWaste) + satuan;
//    - SISTEMIK columns: #outlet aktif + #bulan aktif (an item that
//      wastes across many outlets AND months is a recipe/process
//      problem, not a one-off incident);
//    - share of the network's total waste + cumulative share (the
//      80/20 reading);
//    - last-month vs prev-month waste (trend direction);
//    - per-outlet breakdown (top 8 per item, the Item×Outlet matrix).
//
//  Two SQL round trips (same pattern as the nested Pareto):
//    1. per-item aggregate over the window (+ population total via
//       SUM() OVER ());
//    2. per-(item, outlet) breakdown restricted to the top-N item ids.
//  Cumulative share + share columns are derived in the PURE builder
//  (testable — same compute/classify split as waste-series.ts).
//
//  GRAIN: same-weekLabel multi-month window — identical to
//  waste-series.ts (the ONLY valid cross-month comparison).
//  PURELY ADDITIVE: feeds the new /api/waste-top-items route used
//  by the Waste tab's Pareto card.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

/** Max months in the waste window (incl. running month) — shared with waste-series. */
export const WASTE_TOP_ITEMS_WINDOW_MONTHS = 12;

/** Default + max top-N items returned. */
export const WASTE_TOP_ITEMS_DEFAULT_LIMIT = 20;
export const WASTE_TOP_ITEMS_MAX_LIMIT = 50;

/** Per-item outlet breakdown cap (the Item×Outlet matrix width). */
export const WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT = 8;

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

interface WasteItemRawRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number | bigint;
  wasteQty: number | bigint;
  outletsActive: number | bigint;
  monthsActive: number | bigint;
  lastMonthWaste: number | bigint;
  prevMonthWaste: number | bigint;
  populationTotal: number | bigint;
}

interface WasteItemOutletRawRow {
  itemId: number;
  outletCode: string;
  outletName: string;
  area: string;
  waste: number | bigint;
  monthsActive: number | bigint;
}

export interface WasteItemOutletBreakdown {
  outletCode: string;
  outletName: string;
  area: string;
  waste: number;
  monthsActive: number;
  /** waste / item's totalWaste (0 when totalWaste is 0). */
  shareOfItem: number;
}

export interface WasteTopItemRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number;
  wasteQty: number;
  /** #outlet aktif in the window. */
  outletsActive: number;
  /** #bulan aktif in the window. */
  monthsActive: number;
  /** share of the network total waste (0 when population is 0). */
  share: number;
  /** cumulative share from rank 1 (0 when population is 0). */
  cumulativeShare: number;
  /** Waste in the latest window month (0 when the item had none). */
  lastMonthWaste: number;
  /** Waste in the month before the latest (0 when absent). */
  prevMonthWaste: number;
  /** Sistematik = active in ≥ half the window months AND ≥ 2 outlets. */
  sistematik: boolean;
  byOutlet: WasteItemOutletBreakdown[];
}

export interface WasteTopItemsResult {
  items: WasteTopItemRow[];
  /** ΣABS nominalWaste across ALL items in scope (the 100% of the Pareto). */
  populationTotal: number;
  /** Latest + previous monthKeys of the window (for the trend column). */
  lastMonthKey: string | null;
  prevMonthKey: string | null;
}

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Window sistematik flag — recipe/process problem vs one-off incident. */
export function isSistematikWasteItem(monthsActive: number, outletsActive: number): boolean {
  return monthsActive >= Math.ceil(WASTE_TOP_ITEMS_WINDOW_MONTHS / 2) && outletsActive >= 2;
}

/**
 * Merge the per-item rows + per-(item, outlet) breakdown rows into the
 * final Pareto rows (share, cumulative share, sistematik, breakdown cap).
 * Pure.
 */
export function buildWasteTopItems(
  itemRows: WasteItemRawRow[],
  breakdownRows: WasteItemOutletRawRow[],
): WasteTopItemsResult {
  if (itemRows.length === 0) {
    return { items: [], populationTotal: 0, lastMonthKey: null, prevMonthKey: null };
  }
  const populationTotal = toNum(itemRows[0].populationTotal);
  const byItemBreakdown = new Map<number, WasteItemOutletBreakdown[]>();
  for (const b of breakdownRows) {
    const list = byItemBreakdown.get(b.itemId) ?? [];
    list.push({
      outletCode: b.outletCode,
      outletName: b.outletName,
      area: b.area,
      waste: toNum(b.waste),
      monthsActive: toNum(b.monthsActive),
      shareOfItem: 0,
    });
    byItemBreakdown.set(b.itemId, list);
  }
  let cumulative = 0;
  const items: WasteTopItemRow[] = itemRows.map((r) => {
    const totalWaste = toNum(r.totalWaste);
    const share = populationTotal > 0 ? totalWaste / populationTotal : 0;
    cumulative += share;
    const breakdown = (byItemBreakdown.get(r.itemId) ?? [])
      .sort((a, b) => b.waste - a.waste || a.outletCode.localeCompare(b.outletCode))
      .slice(0, WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT)
      .map((b) => ({ ...b, shareOfItem: totalWaste > 0 ? b.waste / totalWaste : 0 }));
    return {
      itemId: r.itemId,
      itemName: r.itemName,
      satuan: r.satuan,
      totalWaste,
      wasteQty: toNum(r.wasteQty),
      outletsActive: toNum(r.outletsActive),
      monthsActive: toNum(r.monthsActive),
      share,
      cumulativeShare: populationTotal > 0 ? cumulative : 0,
      lastMonthWaste: toNum(r.lastMonthWaste),
      prevMonthWaste: toNum(r.prevMonthWaste),
      sistematik: isSistematikWasteItem(toNum(r.monthsActive), toNum(r.outletsActive)),
      byOutlet: breakdown,
    };
  });
  return {
    items,
    populationTotal,
    // Filled by the caller (queryWasteTopItems) from the month keys — the
    // raw rows don't carry them (single source: the SQL window CTE).
    lastMonthKey: null,
    prevMonthKey: null,
  };
}

// ------------------------------------------------------------
// queryWasteTopItems
// ------------------------------------------------------------

export async function queryWasteTopItems(
  week: string,
  currentMonthKey: string | null,
  filters: SqlFilterOpts,
  limit: number = WASTE_TOP_ITEMS_DEFAULT_LIMIT,
): Promise<WasteTopItemsResult> {
  const f = buildSqlFilters(filters);
  const boundedLimit = Math.min(Math.max(1, limit), WASTE_TOP_ITEMS_MAX_LIMIT);
  const monthBound = currentMonthKey
    ? Prisma.sql`AND sf."monthKey" <= ${currentMonthKey}`
    : Prisma.empty;

  // Round trip 1 — per-item aggregates over the window. lastMonthWaste /
  // prevMonthWaste pivot the two most recent window months inline (scalar
  // subqueries on the months CTE), populationTotal rides via SUM() OVER ().
  const itemRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        ${monthBound}
        ${f}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${WASTE_TOP_ITEMS_WINDOW_MONTHS}
    ),
    last_month AS (
      SELECT MAX("monthKey") as "monthKey" FROM months
    ),
    prev_month AS (
      SELECT MAX(m."monthKey") as "monthKey"
      FROM months m, last_month lm
      WHERE m."monthKey" < lm."monthKey"
    ),
    item_agg AS (
      SELECT
        ir."itemId",
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "totalWaste",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "wasteQty",
        COUNT(DISTINCT ir."outletId") as "outletsActive",
        COUNT(DISTINCT sf."monthKey") as "monthsActive",
        COALESCE(SUM(CASE WHEN sf."monthKey" = (SELECT "monthKey" FROM last_month) THEN ABS(ir."nominalWaste") ELSE 0 END), 0) as "lastMonthWaste",
        COALESCE(SUM(CASE WHEN sf."monthKey" = (SELECT "monthKey" FROM prev_month) THEN ABS(ir."nominalWaste") ELSE 0 END), 0) as "prevMonthWaste"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        AND sf."monthKey" IN (SELECT "monthKey" FROM months)
        ${f}
      GROUP BY ir."itemId"
    )
    SELECT
      ia."itemId",
      i.name as "itemName",
      i.satuan,
      ia."totalWaste",
      ia."wasteQty",
      ia."outletsActive",
      ia."monthsActive",
      ia."lastMonthWaste",
      ia."prevMonthWaste",
      SUM(ia."totalWaste") OVER () as "populationTotal"
    FROM item_agg ia
    JOIN "Item" i ON ia."itemId" = i.id
    ORDER BY ia."totalWaste" DESC, i.name ASC
    LIMIT ${boundedLimit}
  `);

  if (itemRows.length === 0) {
    return { items: [], populationTotal: 0, lastMonthKey: null, prevMonthKey: null };
  }

  // Round trip 2 — per-(item, outlet) breakdown for the top-N items only
  // (Prisma.join for the IN list — same pattern as heatmap.ts item filter).
  const itemIds = itemRows.map((r) => r.itemId);
  const breakdownRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemOutletRawRow[]>`
    WITH months AS (
      SELECT sf."monthKey"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        ${monthBound}
        ${f}
      GROUP BY sf."monthKey"
      ORDER BY sf."monthKey" DESC
      LIMIT ${WASTE_TOP_ITEMS_WINDOW_MONTHS}
    )
    SELECT
      ir."itemId",
      o.code as "outletCode",
      o.name as "outletName",
      ir.area,
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste",
      COUNT(DISTINCT sf."monthKey") as "monthsActive"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."weekLabel" = ${week}
      AND sf."monthKey" IN (SELECT "monthKey" FROM months)
      AND ir."itemId" IN (${Prisma.join(itemIds)})
      ${f}
    GROUP BY ir."itemId", o.code, o.name, ir.area
  `);

  const result = buildWasteTopItems(itemRows, breakdownRows);

  // Window month keys (latest + previous) for the trend column — one cheap
  // scalar query rather than threading them through the aggregates.
  const windowMonths = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ monthKey: string }>>`
    SELECT sf."monthKey"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${week}
      ${monthBound}
      ${f}
    GROUP BY sf."monthKey"
    ORDER BY sf."monthKey" DESC
    LIMIT 2
  `);
  result.lastMonthKey = windowMonths[0]?.monthKey ?? null;
  result.prevMonthKey = windowMonths[1]?.monthKey ?? null;

  return result;
}
