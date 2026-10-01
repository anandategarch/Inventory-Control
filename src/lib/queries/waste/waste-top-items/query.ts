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
//
//  W11 (Paritas Susut & Trial): round 1 gains the susut/trial aggregate
//  columns + Σ|qtyBom| + trialMonthsActive + the two parity population
//  totals (SAME scan — zero extra round trips) and its ORDER BY follows
//  the `metric` param (top-N BY the requested metric — the LIMIT must
//  apply after the ordering, so this cannot be a TS-side re-sort). Round
//  2 gains the per-outlet susut/trial companions; round 3 (W3 quadrant)
//  stays waste-only — documented in place. The fingerprint + trial screen
//  are merged from the PURE ./fingerprint.ts builders at this edge.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../../shared';
import { buildWasteTopItems } from './builders';
import { buildFingerprint, buildTrialScreen } from './fingerprint';
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
  WasteMetric,
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
  // W11 (Paritas Susut & Trial): the metric the top-N is ORDERED by +
  // whose nominal the rows lead with. ADDITIVE with a default — every
  // pre-W11 caller keeps the exact waste behavior.
  metric: WasteMetric = 'waste',
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
    return {
      items: [], populationTotal: 0, lastMonthKey: null, prevMonthKey: null, windowMonths: 0, quadrant: null,
      // W11 additive defaults (empty-window shape).
      metric, susutPopulationTotal: 0, trialPopulationTotal: 0, fingerprint: null, trialScreen: [],
    };
  }
  // Prisma.join requires ≥ 1 element — guaranteed by the early return above.
  const monthInList = Prisma.join(monthKeys);
  const lastMonthKey = monthKeys[0] ?? null;
  const prevMonthKey = monthKeys[1] ?? null;

  // W11: the ORDER BY column of round 1 follows the requested metric —
  // the LIMIT must apply AFTER the ordering (top-N BY the metric), so
  // this cannot be a post-hoc TS re-sort. The fragment interpolates a
  // LITERAL column reference chosen from a closed set (never user text
  // — `metric` arrives zod-validated from the route), so the SQL shape
  // stays static per metric.
  const orderExpr = metric === 'susut'
    ? Prisma.sql`ia."totalSusut"`
    : metric === 'trial'
      ? Prisma.sql`ia."totalTrial"`
      : Prisma.sql`ia."totalWaste"`;

  // Round trip 1 — per-item aggregates over the window. lastMonthWaste /
  // prevMonthWaste pivot the two most recent window months inline (scalar
  // parameters from round 0), populationTotal rides via SUM() OVER ().
  // BUGHUNT-R1 FIX 1: outletsActive / monthsActive count DISTINCT
  // outlet/month ONLY over rows with waste > 0 (FILTER clause) — the UI
  // footer documents the metric as "jumlah distinct outlet/bulan dengan
  // waste > 0", and record-presence counts minted fake SISTEMATIK badges
  // (an item stocked in 343 outlets but wasting in 1 used to read 343).
  //
  // W11 (Paritas Susut & Trial): the SAME scan gains the susut/trial
  // aggregate columns (Σ|nominal| + Σ|qty| each), the Σ|qtyBom| usage
  // basis + trialMonthsActive for the trial screen, and the two parity
  // population totals via SUM() OVER () — one round trip, more columns,
  // ZERO extra round trips. The waste columns and their FILTER clauses
  // are untouched; `sistematik` stays WASTE-semantic (its monthsActive/
  // outletsActive counts remain waste>0-only — generalizing it to the
  // active metric is explicitly out of scope for W11).
  const itemRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemRawRow[]>`
    WITH item_agg AS (
      SELECT
        ir."itemId",
        COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "totalWaste",
        COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "wasteQty",
        COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "totalSusut",
        COALESCE(SUM(ABS(ir."qtySusut")), 0) as "susutQty",
        COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "totalTrial",
        COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "trialQty",
        COALESCE(SUM(ABS(ir."qtyBom")), 0) as "bomQty",
        COUNT(DISTINCT ir."outletId") FILTER (WHERE ABS(ir."nominalWaste") > 0) as "outletsActive",
        COUNT(DISTINCT sf."monthKey") FILTER (WHERE ABS(ir."nominalWaste") > 0) as "monthsActive",
        COUNT(DISTINCT sf."monthKey") FILTER (WHERE ABS(ir."nominalTrial") > 0) as "trialMonthsActive",
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
      ia."totalSusut",
      ia."susutQty",
      ia."totalTrial",
      ia."trialQty",
      ia."bomQty",
      ia."outletsActive",
      ia."monthsActive",
      ia."trialMonthsActive",
      ia."lastMonthWaste",
      ia."prevMonthWaste",
      SUM(ia."totalWaste") OVER () as "populationTotal",
      SUM(ia."totalSusut") OVER () as "susutPopulationTotal",
      SUM(ia."totalTrial") OVER () as "trialPopulationTotal"
    FROM item_agg ia
    JOIN "Item" i ON ia."itemId" = i.id
    ORDER BY ${orderExpr} DESC, i.name ASC
    LIMIT ${boundedLimit}
  `);

  if (itemRows.length === 0) {
    return {
      items: [], populationTotal: 0, lastMonthKey, prevMonthKey, windowMonths, quadrant: null,
      // W11 additive defaults (no-items shape).
      metric, susutPopulationTotal: 0, trialPopulationTotal: 0, fingerprint: null, trialScreen: [],
    };
  }

  // Round trip 2 — per-(item, outlet) breakdown for the top-N items only
  // (Prisma.join for the IN list — same pattern as heatmap.ts item filter).
  // FIX 1 applies here too: monthsActive = distinct months with waste > 0.
  //
  // W11 (additive): two more same-scan SUMs — the per-outlet susut/trial
  // companions of `waste` — so the breakdown line can follow the ACTIVE
  // metric (the builder sorts + caps the top-8 slice on it). monthsActive
  // stays WASTE-semantic (it feeds the waste-flavored "n bln" display).
  const itemIds = itemRows.map((r) => r.itemId);
  const breakdownRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteItemOutletRawRow[]>`
    SELECT
      ir."itemId",
      o.code as "outletCode",
      o.name as "outletName",
      ir.area,
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "waste",
      COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "susut",
      COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "trial",
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
  //
  // W11: this round stays WASTE-ONLY by design — its consumer (the W3
  // quadrant: prevalence/persistence/HHI) is waste-semantic, and a susut
  // distribution variant has no consumer today (documented per the task:
  // extend the sibling rounds ONLY when cheap AND needed).
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

  // The metric rides into the pure builder so the breakdown slice follows
  // the ACTIVE ordering (input order = the SQL's metric order).
  const result = buildWasteTopItems(itemRows, breakdownRows, windowMonths, metric);
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

  // W11 wiring (additive): fingerprint per item + network summary, then
  // the trial-abuse screen over the MERGED rows (the screen reads the
  // fingerprint class for context — hence this order). Both builders are
  // pure; the merge happens here, the impure edge.
  const fingerprint = buildFingerprint(result.items);
  for (const item of result.items) {
    item.fingerprint = fingerprint.perItem.get(item.itemId) ?? null;
  }
  result.fingerprint = fingerprint.summary;
  result.trialScreen = buildTrialScreen(result.items);

  return result;
}
