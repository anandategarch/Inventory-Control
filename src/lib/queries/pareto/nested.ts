// ============================================================
//  Pareto Nested — Item → Outlet breakdown + generalized parent → child
//  --------------------------------------------------------
//  Two exported queries + two private helpers (getDimensionExpr /
//  getDimensionFilter) used only inside this file.
//
//  - queryParetoNestedItemOutlet: top items (Pareto 80%) → per-item
//    outlet breakdown (Pareto 80% within each item).
//  - queryParetoNested: generalized version with pluggable parent
//    and child dimensions (any combination of item/outlet/area/
//    kelompok/pic).
//
//  Both follow the 2-step query pattern:
//    1. Top parents (Pareto 80% via `maxItems` cap)
//    2. Per-parent child breakdown (parallelized via Promise.all)
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

  // FIX (BUG2-PARETO-2): Parallelize the per-item outlet breakdown queries.
  // Old code ran 10 sequential queries (N+1 pattern) — 3-5s latency.
  // Now runs all 10 in parallel via Promise.all — ~0.5s latency.
  // Also wrap each query in withStatementTimeout (was missing → hang risk under PgBouncer).
  const outletRowsByItem = await Promise.all(topItems.map((item) => {
    const itemName = item.itemName;
    return withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string; outletName: string; area: string; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
      SELECT o.code as "outletCode", o.name as "outletName", o.area,
        ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        SUM(ir."qtyDeviasi") as "qtyDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        -- FIX (BUG2-PARETO-14): use exact match (not LOWER) — the top-items query
        -- already grouped by exact i.name, so we should match the same exact name.
        -- LOWER() could match case-variant items that were grouped separately above.
        AND i.name = ${itemName}
        ${f}
      GROUP BY o.code, o.name, o.area
      HAVING ABS(SUM(ir."nominalDeviasi")) > 0
      ORDER BY "totalAbsNominal" DESC
      LIMIT 20
    `);
  }));

  const items: NestedParetoItem[] = [];
  for (let idx = 0; idx < topItems.length; idx++) {
    const item = topItems[idx];
    const itemName = item.itemName;
    const itemTotal = Number(item.totalAbsNominal);
    const itemNominal = Number(item.nominalDeviasi);
    const itemQtyDeviasi = Number(item.qtyDeviasi);
    const itemOutletCount = Number(item.outletCount);

    const outletRows = outletRowsByItem[idx];

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
//    2. Per-parent child breakdown (parallelized via Promise.all)
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
 * Build a parameterized WHERE fragment (`AND ... = ${value}`) for filtering
 * records by a specific dimension value. Used in Step 2 of queryParetoNested
 * to scope the per-parent child breakdown to one parent's slice.
 *
 * Special case for 'pic' with value 'Unassigned': the group uses
 * `COALESCE(pic.pic, 'Unassigned')`, so the matching filter is
 * `pic.pic IS NULL` (NOT `pic.pic = 'Unassigned'` — would match nothing
 * since the literal 'Unassigned' never appears in the pic column).
 *
 * @param dim Pareto dimension
 * @param value Dimension value to match (e.g. item name, outlet code, area)
 * @returns Prisma.Sql fragment beginning with `AND`
 */
function getDimensionFilter(dim: ParetoDimension, value: string): Prisma.Sql {
  switch (dim) {
    case 'item':
      return Prisma.sql`AND i.name = ${value}`;
    case 'outlet':
      return Prisma.sql`AND o.code = ${value}`;
    case 'area':
      return Prisma.sql`AND o.area = ${value}`;
    case 'kelompok':
      // Must match the group expression exactly so the filter selects the same group
      return Prisma.sql`AND LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) = ${value}`;
    case 'pic':
      // 'Unassigned' is the COALESCE sentinel — match via IS NULL on the underlying column
      if (value === 'Unassigned') {
        return Prisma.sql`AND pic.pic IS NULL`;
      }
      return Prisma.sql`AND pic.pic = ${value}`;
  }
}

/**
 * Generalized nested Pareto: top parents (Pareto 80%) → per-parent child
 * breakdown (Pareto 80% within each parent).
 *
 * 2-step pattern (matches `queryParetoNestedItemOutlet` but with pluggable
 * dimensions):
 *   1. Query top N parents by |nominalDeviasi| (LIMIT maxItems)
 *   2. For each parent, query its top 20 children in parallel (Promise.all)
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

  // Step 2: per-parent child breakdown — parallelized via Promise.all.
  // Same pattern as queryParetoNestedItemOutlet (BUG2-PARETO-2 fix): each
  // child query is wrapped in withStatementTimeout to prevent PgBouncer hangs.
  const childRowsByParent = await Promise.all(
    topParents.map((parent) => {
      const parentName = parent.name;
      const parentFilter = getDimensionFilter(parentDim, parentName);
      return withStatementTimeout((tx) => tx.$queryRaw<
        Array<{
          name: string;
          totalAbsNominal: number;
          nominalDeviasi: number;
          qtyDeviasi: number;
          outletCount: number;
        }>
      >`
        SELECT ${childGroupExpr} as "name",
          ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
          SUM(ir."nominalDeviasi") as "nominalDeviasi",
          SUM(ir."qtyDeviasi") as "qtyDeviasi",
          CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
        FROM "InventoryRecord" ir
        ${childJoins}
        WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
          AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
          ${parentFilter}
          ${f}
        GROUP BY ${childGroupExpr}
        HAVING ABS(SUM(ir."nominalDeviasi")) > 0
        ORDER BY "totalAbsNominal" DESC
        LIMIT 20
      `);
    }),
  );

  // Build result: per-parent share% + cum% + Pareto-80%-filtered children
  const items: NestedParetoResultItem[] = [];
  let parentCumPct = 0;
  for (let idx = 0; idx < topParents.length; idx++) {
    const parent = topParents[idx];
    const parentTotal = Number(parent.totalAbsNominal);
    const childRows = childRowsByParent[idx];

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
