// ============================================================
//  Pareto Nested — Item → Outlet breakdown + generalized parent → child
//  --------------------------------------------------------
//  Two exported queries + one private helper (getDimensionExpr) used
//  only inside this file.
//
//  - queryParetoNestedItemOutlet: top items (Pareto 80%) → per-item
//    outlet breakdown (Pareto 80% within each item).
//  - queryParetoNested: generalized version with pluggable parent
//    and child dimensions (any combination of item/outlet/area/
//    kelompok/pic).
//
//  Both follow the 2-step query pattern:
//    1. Top parents (Pareto 80% via `maxItems` cap)
//    2. Per-parent child breakdown — ONE combined query using
//       ROW_NUMBER() OVER (PARTITION BY parent) rn <= 20 cap
//       (AUDIT-FOLLOWUP-NESTED-N+1: previously one withStatementTimeout
//       transaction PER parent — up to 10 concurrent transactions/
//       connections per request, ×7 pareto queries on the same page →
//       needless pool pressure against connection_limit=30)
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import type { NestedParetoItem, NestedParetoResultItem, ParetoDimension, DimensionExpr } from './types';

// ============================================================
//  Pareto Nested: Item → Outlet breakdown (#3)
//  For each top item (80% Pareto), returns the outlets that contribute
//  80% of that item's total deviation.
// ============================================================
export async function queryParetoNestedItemOutlet(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  maxItems: number = 10,
): Promise<{ items: NestedParetoItem[]; totalAbsNominal: number }> {
  const f = buildSqlFilters(filters);
  // Step 1: get top items (Pareto 80%)
  const topItems = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ itemName: string; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number; outletCount: number }>>`
    SELECT i.name as "itemName",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY i.name
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
    LIMIT ${maxItems}
  `);

  if (topItems.length === 0) return { items: [], totalAbsNominal: 0 };

  const grandTotal = topItems.reduce((s, r) => s + Number(r.totalAbsNominal), 0);
  let itemCumPct = 0;

  // FIX (AUDIT-FOLLOWUP-NESTED-N+1): single query replaces the 10 parallel
  // per-item withStatementTimeout transactions (each call = its own
  // interactive transaction → its own pooled connection). Same approach as
  // the AUDIT-PERF-2 fix in by-other-metric.ts: one GROUP BY (item, outlet)
  // query with ROW_NUMBER() capped at 20 outlets per item produces the same
  // rows (same WHERE/HAVING, exact i.name match per BUG2-PARETO-14, top-20
  // per item by ABS(nominalDeviasi) DESC) in ONE transaction.
  // topItems.length >= 1 here (empty case early-returned above), so the
  // Prisma.join IN-list always has >= 1 element.
  const topItemNames = topItems.map((t) => t.itemName);
  const outletRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string; outletCode: string; outletName: string; area: string;
    totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number;
  }>>`
    WITH per_outlet AS (
      SELECT i.name as "itemName", o.code as "outletCode", o.name as "outletName", o.area,
        ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        SUM(ir."qtyDeviasi") as "qtyDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        -- Exact match (BUG2-PARETO-14): mirrors the Step-1 GROUP BY on exact i.name.
        AND i.name IN (${Prisma.join(topItemNames)})
        ${f}
      GROUP BY i.name, o.code, o.name, o.area
      HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ),
    ranked AS (
      -- Top 20 outlets per item by ABS(nominalDeviasi) DESC — same cap the old
      -- per-item query enforced via ORDER BY ... LIMIT 20. "outletCode" is a
      -- deterministic tie-break for equal totals (old LIMIT picked ties
      -- nondeterministically).
      SELECT per_outlet.*,
        ROW_NUMBER() OVER (PARTITION BY "itemName" ORDER BY "totalAbsNominal" DESC, "outletCode") AS rn
      FROM per_outlet
    )
    SELECT "itemName", "outletCode", "outletName", "area", "totalAbsNominal", "nominalDeviasi", "qtyDeviasi"
    FROM ranked
    WHERE rn <= 20
    ORDER BY "itemName", "totalAbsNominal" DESC, "outletCode"
  `);
  const outletRowsByItem = new Map<string, typeof outletRows>();
  for (const row of outletRows) {
    const list = outletRowsByItem.get(row.itemName) ?? [];
    list.push(row);
    outletRowsByItem.set(row.itemName, list);
  }

  const items: NestedParetoItem[] = [];
  for (let idx = 0; idx < topItems.length; idx++) {
    const item = topItems[idx];
    const itemName = item.itemName;
    const itemTotal = Number(item.totalAbsNominal);
    const itemNominal = Number(item.nominalDeviasi);
    const itemQtyDeviasi = Number(item.qtyDeviasi);
    const itemOutletCount = Number(item.outletCount);

    // Map lookup (not index) — rows arrive grouped by itemName from the
    // combined query; ordering within each item is preserved by the
    // ORDER BY "itemName", "totalAbsNominal" DESC, "outletCode" above.
    const outletRows = outletRowsByItem.get(itemName) ?? [];

    const outletTotal = outletRows.reduce((s, r) => s + Number(r.totalAbsNominal), 0);
    let outletCumPct = 0;
    const allOutlets = outletRows.map((r) => {
      const sharePct = outletTotal > 0 ? (Number(r.totalAbsNominal) / outletTotal) * 100 : 0;
      outletCumPct += sharePct;
      return {
        outletCode: r.outletCode,
        outletName: r.outletName,
        area: r.area,
        totalAbsNominal: Number(r.totalAbsNominal),
        nominalDeviasi: Number(r.nominalDeviasi),
        qtyDeviasi: Number(r.qtyDeviasi),
        sharePct: Number(sharePct.toFixed(1)),
        cumPct: Number(outletCumPct.toFixed(1)),
      };
    });

    // FIX: was `.filter((_, i) => i === 0 || outlets === undefined || ...)` — referenced
    // `outlets` before initialization (TDZ error → HTTP 500). Now uses simple for-loop.
    const filteredOutlets: typeof allOutlets = [];
    let cum = 0;
    for (const o of allOutlets) {
      filteredOutlets.push(o);
      cum = o.cumPct;
      if (cum >= 80) break;
    }

    const itemSharePct = grandTotal > 0 ? (itemTotal / grandTotal) * 100 : 0;
    itemCumPct += itemSharePct;

    items.push({
      itemName,
      totalAbsNominal: itemTotal,
      nominalDeviasi: itemNominal,
      qtyDeviasi: itemQtyDeviasi,
      outletCount: itemOutletCount,
      sharePct: Number(itemSharePct.toFixed(1)),
      cumPct: Number(itemCumPct.toFixed(1)),
      outlets: filteredOutlets,
    });
  }

  return { items, totalAbsNominal: grandTotal };
}

// ============================================================
//  Generalized Nested Pareto — any parent × child dimension
//  --------------------------------------------------------
//  FIX (RESTORE-BACKEND-2): the generalized multi-nesting function was
//  lost in a force push. Restored here as `queryParetoNested` with
//  pluggable parent/child dimensions.
//
//  2-step query pattern (matches `queryParetoNestedItemOutlet` above):
//    1. Top parents (Pareto 80% via `maxItems` cap)
//    2. Per-parent child breakdown — ONE combined query (ROW_NUMBER
//       PARTITION BY parent, rn <= 20; see AUDIT-FOLLOWUP-NESTED-N+1)
//
//  SQL safety: JOINs are built as a plain string joined with space,
//  then wrapped in `Prisma.raw()`. We do NOT interpolate `Prisma.empty`
//  fragments into the tagged template — that pattern caused subtle SQL
//  composition bugs before (empty fragments shifted parameter positions
//  in PgBouncer's prepared-statement cache, intermittently raising
//  "bind message has X result formats but 0 parameters" errors).
//  Plain-string JOINs via Prisma.raw() are deterministic + safe
//  because the JOIN fragments are static literals (no user input).
// ============================================================

/**
 * Build the SQL fragments (groupExpr + 3 JOIN clauses) for a Pareto dimension.
 *
 * CRITICAL: the 'pic' case MUST include `joinOutlet` (NOT Prisma.empty / ''),
 * because the PIC LEFT JOIN references `o.code` (the Outlet alias). Emitting
 * `LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"` without first
 * joining Outlet would raise "missing FROM-clause entry for table o".
 *
 * @param dim Pareto dimension
 * @returns DimensionExpr with static SQL fragments (safe to interpolate via Prisma.raw)
 */
function getDimensionExpr(dim: ParetoDimension): DimensionExpr {
  switch (dim) {
    case 'item':
      return {
        groupExpr: 'i.name',
        joinItem: 'JOIN "Item" i ON ir."itemId" = i.id',
        joinOutlet: '',
        joinPIC: '',
      };
    case 'outlet':
      return {
        groupExpr: 'o.code',
        joinItem: '',
        joinOutlet: 'JOIN "Outlet" o ON ir."outletId" = o.id',
        joinPIC: '',
      };
    case 'area':
      return {
        groupExpr: 'o.area',
        joinItem: '',
        joinOutlet: 'JOIN "Outlet" o ON ir."outletId" = o.id',
        joinPIC: '',
      };
    case 'kelompok':
      // Same LEFT(SUBSTRING(...)) expression as buildSqlFilters + queryParetoByKelompok
      return {
        groupExpr: "LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3)",
        joinItem: '',
        joinOutlet: 'JOIN "Outlet" o ON ir."outletId" = o.id',
        joinPIC: '',
      };
    case 'pic':
      // CRITICAL: joinOutlet MUST be present — the pic LEFT JOIN references o.code.
      return {
        groupExpr: "COALESCE(pic.pic, 'Unassigned')",
        joinItem: '',
        joinOutlet: 'JOIN "Outlet" o ON ir."outletId" = o.id',
        joinPIC: 'LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"',
      };
  }
}

/**
 * Generalized nested Pareto: top parents (Pareto 80%) → per-parent child
 * breakdown (Pareto 80% within each parent).
 *
 * 2-step pattern (matches `queryParetoNestedItemOutlet` but with pluggable
 * dimensions):
 *   1. Query top N parents by |nominalDeviasi| (LIMIT maxItems)
 *   2. ONE combined query for all parents' top-20 children (ROW_NUMBER
 *      PARTITION BY parent group, rn <= 20 — AUDIT-FOLLOWUP-NESTED-N+1;
 *      previously one withStatementTimeout transaction per parent)
 *
 * JOINs are built as a plain space-joined string + wrapped in Prisma.raw().
 * See "SQL safety" comment at top of this section for why we avoid
 * Prisma.empty interpolation.
 *
 * @param week Current week label
 * @param month Current month label
 * @param filters Shared SQL filter opts (area/kelompok/outletCode/picOutletCodes/itemName)
 * @param parentDim Top-level dimension ('item' | 'outlet' | 'area' | 'kelompok' | 'pic')
 * @param childDim Inner dimension (same enum as parentDim)
 * @param maxItems Max number of parents to return (default 10)
 * @returns { items, totalAbsNominal, parentDim, childDim } — items have .children arrays
 */
export async function queryParetoNested(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  parentDim: ParetoDimension,
  childDim: ParetoDimension,
  maxItems: number = 10,
): Promise<{
  items: NestedParetoResultItem[];
  totalAbsNominal: number;
  parentDim: ParetoDimension;
  childDim: ParetoDimension;
}> {
  const f = buildSqlFilters(filters);
  const parentExpr = getDimensionExpr(parentDim);
  const childExpr = getDimensionExpr(childDim);

  // Build JOIN strings — plain space-joined string, wrapped in Prisma.raw().
  // Empty strings filter out so we don't emit stray double-spaces (cosmetic).
  const parentJoinsRaw = [parentExpr.joinItem, parentExpr.joinOutlet, parentExpr.joinPIC]
    .filter(Boolean)
    .join(' ');
  // FIX (BUG4-DATA-2 / FEAT-PARETO-NEST-BUG): child query needs JOINs from
  // BOTH parent (for parentFilter) AND child (for groupExpr). Merge + dedupe
  // by using a Set to avoid duplicate JOINs (e.g., both parent+child need Outlet).
  const allChildJoins = [
    parentExpr.joinItem, parentExpr.joinOutlet, parentExpr.joinPIC,
    childExpr.joinItem, childExpr.joinOutlet, childExpr.joinPIC,
  ].filter(Boolean);
  const childJoinsRaw = [...new Set(allChildJoins)].join(' ');
  const parentJoins = Prisma.raw(parentJoinsRaw);
  const childJoins = Prisma.raw(childJoinsRaw);
  const parentGroupExpr = Prisma.raw(parentExpr.groupExpr);
  const childGroupExpr = Prisma.raw(childExpr.groupExpr);

  // Step 1: query top N parents by |nominalDeviasi|
  const topParents = await withStatementTimeout((tx) => tx.$queryRaw<
    Array<{
      name: string;
      totalAbsNominal: number;
      nominalDeviasi: number;
      qtyDeviasi: number;
      outletCount: number;
    }>
  >`
    SELECT ${parentGroupExpr} as "name",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
    FROM "InventoryRecord" ir
    ${parentJoins}
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY ${parentGroupExpr}
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
    LIMIT ${maxItems}
  `);

  if (topParents.length === 0) {
    return { items: [], totalAbsNominal: 0, parentDim, childDim };
  }

  const grandTotal = topParents.reduce((s, r) => s + Number(r.totalAbsNominal), 0);

  // Step 2: per-parent child breakdown — ONE combined query for ALL parents
  // (AUDIT-FOLLOWUP-NESTED-N+1; previously one withStatementTimeout
  // transaction per parent → up to 10 concurrent connections per request).
  //
  // Scoping trick: instead of a per-parent `${groupExpr} = ${value}` filter
  // (the old getDimensionFilter helper), we filter `${parentGroupExpr} IN
  // (top parent names)` and ALSO select it as "parentName" — the exact same
  // expression Step 1 grouped by, so the two steps can never disagree.
  // For parentDim='pic' this is strictly MORE consistent than the old
  // per-parent filter: 'Unassigned' now matches every row the Step-1
  // COALESCE group counted (pic IS NULL ∪ pic = 'Unassigned'), whereas the
  // old `pic.pic IS NULL` filter silently dropped the literal-'Unassigned'
  // subset (children could sum to less than the parent total).
  //
  // Child rows keep their old shape; the unused `outletCount` column the
  // per-parent query computed is dropped (post-processing never read it).
  // topParents.length >= 1 here (empty case early-returned above), so the
  // Prisma.join IN-list always has >= 1 element.
  const parentNames = topParents.map((p) => p.name);
  const childRows = await withStatementTimeout((tx) => tx.$queryRaw<
    Array<{
      parentName: string;
      name: string;
      totalAbsNominal: number;
      nominalDeviasi: number;
      qtyDeviasi: number;
    }>
  >`
    WITH per_child AS (
      SELECT ${parentGroupExpr} as "parentName", ${childGroupExpr} as "name",
        ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        SUM(ir."qtyDeviasi") as "qtyDeviasi"
      FROM "InventoryRecord" ir
      ${childJoins}
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ${parentGroupExpr} IN (${Prisma.join(parentNames)})
        ${f}
      GROUP BY ${parentGroupExpr}, ${childGroupExpr}
      HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ),
    ranked AS (
      -- Top 20 children per parent by ABS(nominalDeviasi) DESC — same cap
      -- the old per-parent query enforced via ORDER BY ... LIMIT 20. Child
      -- "name" is a deterministic tie-break (old LIMIT picked ties
      -- nondeterministically).
      SELECT per_child.*,
        ROW_NUMBER() OVER (PARTITION BY "parentName" ORDER BY "totalAbsNominal" DESC, "name") AS rn
      FROM per_child
    )
    SELECT "parentName", "name", "totalAbsNominal", "nominalDeviasi", "qtyDeviasi"
    FROM ranked
    WHERE rn <= 20
    ORDER BY "parentName", "totalAbsNominal" DESC, "name"
  `);
  const childRowsByParent = new Map<string, typeof childRows>();
  for (const row of childRows) {
    const list = childRowsByParent.get(row.parentName) ?? [];
    list.push(row);
    childRowsByParent.set(row.parentName, list);
  }

  // Build result: per-parent share% + cum% + Pareto-80%-filtered children
  const items: NestedParetoResultItem[] = [];
  let parentCumPct = 0;
  for (let idx = 0; idx < topParents.length; idx++) {
    const parent = topParents[idx];
    const parentTotal = Number(parent.totalAbsNominal);
    // Map lookup (not index) — rows arrive grouped by parentName from the
    // combined query; ordering within each parent is preserved by the
    // ORDER BY "parentName", "totalAbsNominal" DESC, "name" above.
    const childRows = childRowsByParent.get(parent.name) ?? [];

    const childTotal = childRows.reduce((s, r) => s + Number(r.totalAbsNominal), 0);
    let childCumPct = 0;
    const allChildren = childRows.map((r) => {
      const sharePct = childTotal > 0 ? (Number(r.totalAbsNominal) / childTotal) * 100 : 0;
      childCumPct += sharePct;
      return {
        name: r.name,
        totalAbsNominal: Number(r.totalAbsNominal),
        nominalDeviasi: Number(r.nominalDeviasi),
        qtyDeviasi: Number(r.qtyDeviasi),
        sharePct: Number(sharePct.toFixed(1)),
        cumPct: Number(childCumPct.toFixed(1)),
      };
    });

    // Apply Pareto 80% cutoff to children (same pattern as queryParetoNestedItemOutlet)
    const filteredChildren: typeof allChildren = [];
    let cum = 0;
    for (const c of allChildren) {
      filteredChildren.push(c);
      cum = c.cumPct;
      if (cum >= 80) break;
    }

    const parentSharePct = grandTotal > 0 ? (parentTotal / grandTotal) * 100 : 0;
    parentCumPct += parentSharePct;

    items.push({
      name: parent.name,
      totalAbsNominal: parentTotal,
      nominalDeviasi: Number(parent.nominalDeviasi),
      qtyDeviasi: Number(parent.qtyDeviasi),
      outletCount: Number(parent.outletCount),
      sharePct: Number(parentSharePct.toFixed(1)),
      cumPct: Number(parentCumPct.toFixed(1)),
      children: filteredChildren,
    });
  }

  return { items, totalAbsNominal: grandTotal, parentDim, childDim };
}
