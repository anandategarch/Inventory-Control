// ============================================================
//  Waste Top Items — queryWasteTopItems (DEEP-WASTE-1)
//  --------------------------------------------------------
//  SPLIT-0-B: moved verbatim out of waste-top-items.ts (was a
//  323-LOC monolith). Constants live in ./constants.ts, types
//  in ./types.ts, the sistematik classifier in ./sistematik.ts,
//  the pure builder in ./builders.ts; ./index.ts is the barrel
//  keeping every pre-split import path valid.
//
//  The only import-specifier change in the whole split: the
//  monolith's '../shared' (src/lib/queries/shared.ts) becomes
//  '../../shared' from this one-level-deeper folder — the SAME
//  resolved module, byte-identical behavior.
//

//  Four SQL round trips (same pattern as the nested Pareto), but the
//  months CTE is derived ONCE up front (BUGHUNT-R1 FIX 9 — it used to be
//  rebuilt per round, each a full ~378K-row scan):
//    0. month derivation (cheapest) — the window monthKeys + windowMonths;
//    1. per-item aggregate over the window (+ population total via
//       SUM() OVER ());
//    2. per-(item, outlet) breakdown restricted to the top-N item ids;
//    3. W3 quadrant distribution — per-(item, outlet) waste + BOM>0 flag,
//       GROUP BY outlet with NO cap (the top-8 breakdown slice would
//       truncate the tail and overstate HHI concentration; the BOM flag
//       anchors the prevalence denominator). Added by W3-EXEC following
//       the same style: month derived ONCE first, IN-list month + item
//       filters, withStatementTimeout wrapper.
//  Rounds 1-3 receive the monthKeys as a Prisma.join IN list — identical
//  month set to the old per-round CTE (same WHERE week filter + bound).
//  Cumulative share + share columns are derived in the PURE builder
//  (testable — same compute/classify split as waste-series.ts); the
//  quadrant fields in the PURE ./quadrant.ts builder (same split).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../../shared';
import { buildWasteTopItems } from './builders';
import { buildQuadrant } from './quadrant';
import {
  WASTE_TOP_ITEMS_DEFAULT_LIMIT,
  WASTE_TOP_ITEMS_MAX_LIMIT,
  WASTE_TOP_ITEMS_WINDOW_MONTHS,
} from './constants';
import type {
  WasteItemOutletDistributionRawRow,
  WasteItemOutletRawRow,
  WasteItemRawRow,
  WasteTopItemsResult,
} from './types';

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

  // Round trip 0 — month derivation FIRST (BUGHUNT-R1 FIX 9): the cheapest
  // query of the three yields BOTH the window monthKeys (latest + previous
  // for the trend column) AND windowMonths for the sistematik threshold
  // (FIX 2). Rounds 1-2 then filter on the materialized IN list instead of
  // each rebuilding this identical months CTE (a full ~378K-row scan ×3).
  const monthRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ monthKey: string }>>`
    SELECT sf."monthKey"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${week}
      ${monthBound}
      ${f}
    GROUP BY sf."monthKey"
    ORDER BY sf."monthKey" DESC
    LIMIT ${WASTE_TOP_ITEMS_WINDOW_MONTHS}
  `);
  const monthKeys = monthRows.map((r) => r.monthKey);
  const windowMonths = monthKeys.length;
  if (monthKeys.length === 0) {
    return { items: [], populationTotal: 0, lastMonthKey: null, prevMonthKey: null, windowMonths: 0, quadrant: null };
  }
  // Prisma.join requires ≥ 1 element — guaranteed by the early return above.
  const monthInList = Prisma.join(monthKeys);
  const lastMonthKey = monthKeys[0] ?? null;
  const prevMonthKey = monthKeys[1] ?? null;

  // Round trip 1 — per-item aggregates over the window. lastMonthWaste /
  // prevMonthWaste pivot the two most recent window months inline (scalar
  // parameters from round 0), populationTotal rides via SUM() OVER ().
  // BUGHUNT-R1 FIX 1: outletsActive / monthsActive count DISTINCT
  // outlet/month ONLY over rows with waste > 0 (FILTER clause) — the UI
  // footer documents the metric as "jumlah distinct outlet/bulan dengan
  // waste > 0", and record-presence counts minted fake SISTEMATIK badges
  // (an item stocked in 343 outlets but wasting in 1 used to read 343).
  const itemRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemRawRow[]>`
    WITH item_agg AS (
      SELECT
        ir."itemId",
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "totalWaste",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "wasteQty",
        COUNT(DISTINCT ir."outletId") FILTER (WHERE ABS(ir."nominalWaste") > 0) as "outletsActive",
        COUNT(DISTINCT sf."monthKey") FILTER (WHERE ABS(ir."nominalWaste") > 0) as "monthsActive",
        COALESCE(SUM(CASE WHEN sf."monthKey" = ${lastMonthKey} THEN ABS(ir."nominalWaste") ELSE 0 END), 0) as "lastMonthWaste",
        COALESCE(SUM(CASE WHEN sf."monthKey" = ${prevMonthKey} THEN ABS(ir."nominalWaste") ELSE 0 END), 0) as "prevMonthWaste"
      FROM "InventoryRecord" ir
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        AND sf."monthKey" IN (${monthInList})
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
    return { items: [], populationTotal: 0, lastMonthKey, prevMonthKey, windowMonths, quadrant: null };
  }

  // Round trip 2 — per-(item, outlet) breakdown for the top-N items only
  // (Prisma.join for the IN list — same pattern as heatmap.ts item filter).
  // FIX 1 applies here too: monthsActive = distinct months with waste > 0.
  const itemIds = itemRows.map((r) => r.itemId);
  const breakdownRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemOutletRawRow[]>`
    SELECT
      ir."itemId",
      o.code as "outletCode",
      o.name as "outletName",
      ir.area,
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste",
      COUNT(DISTINCT sf."monthKey") FILTER (WHERE ABS(ir."nominalWaste") > 0) as "monthsActive"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."weekLabel" = ${week}
      AND sf."monthKey" IN (${monthInList})
      AND ir."itemId" IN (${Prisma.join(itemIds)})
      ${f}
    GROUP BY ir."itemId", o.code, o.name, ir.area
  `);

  // Round trip 3 (W3) — the FULL per-(item, outlet) waste distribution +
  // BOM>0 flag, GROUP BY outlet with NO cap (unlike round 2, whose consumer
  // caps the breakdown at top-8 outlets per item; capping HERE would drop
  // tail outlets from HHI and overstate concentration). No JOIN on Outlet:
  // the quadrant math only needs the outlet IDENTITY (grouping key) + waste
  // + the BOM usage flag — skipping the join keeps the 4th round cheaper
  // than round 2 on the same row set. BOM>0 (ABS(qtyBom) > 0, sign
  // convention: BOM rows are negative) = the outlet actually prepped/used
  // the item in the window — the prevalence denominator basis (FIX 1
  // discipline: usage, never mere record presence).
  const distributionRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemOutletDistributionRawRow[]>`
    SELECT
      ir."itemId",
      ir."outletId",
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste",
      MAX(CASE WHEN ABS(ir."qtyBom") > 0 THEN 1 ELSE 0 END) as "hasBom"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${week}
      AND sf."monthKey" IN (${monthInList})
      AND ir."itemId" IN (${Prisma.join(itemIds)})
      ${f}
    GROUP BY ir."itemId", ir."outletId"
  `);

  const result = buildWasteTopItems(itemRows, breakdownRows, windowMonths);
  result.lastMonthKey = lastMonthKey;
  result.prevMonthKey = prevMonthKey;

  // W3 wiring (additive): classify prevalence × persistence per item + the
  // network summary, then merge onto the built rows — buildQuadrant is pure
  // (no mutation), so the assignment happens here, the impure edge.
  const { perItem, summary } = buildQuadrant(result.items, distributionRows, windowMonths);
  for (const item of result.items) {
    const q = perItem.get(item.itemId);
    if (q) item.quadrant = q;
  }
  result.quadrant = summary;

  return result;
}
