// ============================================================
//  Pareto Nested — Item → Outlet breakdown + generalized parent → child
//  --------------------------------------------------------
//  FIX (H-12 / nested-Pareto twin merge): there used to be TWO parallel
//  implementations of the item→outlet drilldown — a specialized
//  `queryParetoNestedItemOutlet` (hardcoded SQL) and the generalized
//  `queryParetoNested('item', 'outlet')` — and /api/pareto fired BOTH
//  when a client explicitly requested parentDim=item&childDim=outlet
//  (the same breakdown computed twice).
//
//  Now `queryParetoNested` is the SINGLE core implementation, and:
//    - `queryParetoNestedItemOutlet` is a thin ADAPTER that calls the
//      core with ('item','outlet') and reshapes the rows into the legacy
//      NestedParetoItem shape (itemName + outlets[outletCode, outletName,
//      area, ...]) consumed by the NestedItemToOutlet card. Behavior-
//      equivalent by construction: Outlet.code is @unique, so the core's
//      GROUP BY (parentExpr, o.code) yields exactly the rows the old
//      specialized query grouped by (i.name, o.code, o.name, o.area) —
//      one row per outlet — and outlet display columns (o.name, o.area)
//      ride along via the core's childDetailCols.
//    - `nestedItemOutletToGeneralized` is the inverse pure-JS adapter
//      (legacy → generalized shape) used by /api/pareto when a client
//      explicitly asks for item→outlet — ZERO extra DB work.
//
//  2-step query pattern (both queries):
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
//
//  H-12: thin adapter over queryParetoNested('item','outlet') — see the
//  file header. Kept as its own export so the /api/pareto `nested`
//  payload section + NestedItemToOutlet card keep their shape.
// ============================================================
export async function queryParetoNestedItemOutlet(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  maxItems: number = 10,
): Promise<{ items: NestedParetoItem[]; totalAbsNominal: number }> {
  const { items, totalAbsNominal } = await queryParetoNested(
    week,
    month,
    filters,
    'item',
    'outlet',
    maxItems,
  );

  return {
    totalAbsNominal,
    items: items.map((it) => ({
      itemName: it.name,
      totalAbsNominal: it.totalAbsNominal,
      nominalDeviasi: it.nominalDeviasi,
      qtyDeviasi: it.qtyDeviasi,
      outletCount: it.outletCount,
      sharePct: it.sharePct,
      cumPct: it.cumPct,
      outlets: it.children.map((c) => ({
        // childDim='outlet' → name IS the outlet code; label/area are the
        // o.name/o.area display columns the core selects for outlet children.
        outletCode: c.name,
        outletName: c.label ?? c.name,
        area: c.area ?? '',
        totalAbsNominal: c.totalAbsNominal,
        nominalDeviasi: c.nominalDeviasi,
        qtyDeviasi: c.qtyDeviasi,
        sharePct: c.sharePct,
        cumPct: c.cumPct,
      })),
    })),
  };
}

/**
 * Inverse adapter (H-12): reshape the legacy item→outlet `nested` result
 * into the `nestedGeneralized` response shape — used by /api/pareto when
 * a client explicitly requests parentDim=item&childDim=outlet, so the
 * route DERIVES the generalized payload from the already-computed nested
 * rows instead of running a second identical query.
 *
 * Pure JS — no DB access. Children keep their outlet display columns
 * (label = outlet name, area) alongside name = outlet code.
 */
export function nestedItemOutletToGeneralized(
  nested: { items: NestedParetoItem[]; totalAbsNominal: number },
): {
  items: NestedParetoResultItem[];
  totalAbsNominal: number;
  parentDim: 'item';
  childDim: 'outlet';
} {
  return {
    totalAbsNominal: nested.totalAbsNominal,
    parentDim: 'item',
    childDim: 'outlet',
    items: nested.items.map((it) => ({
      name: it.itemName,
      totalAbsNominal: it.totalAbsNominal,
      nominalDeviasi: it.nominalDeviasi,
      qtyDeviasi: it.qtyDeviasi,
      outletCount: it.outletCount,
      sharePct: it.sharePct,
      cumPct: it.cumPct,
      children: it.outlets.map((o) => ({
        name: o.outletCode,
        label: o.outletName,
        area: o.area,
        totalAbsNominal: o.totalAbsNominal,
        nominalDeviasi: o.nominalDeviasi,
        qtyDeviasi: o.qtyDeviasi,
        sharePct: o.sharePct,
        cumPct: o.cumPct,
      })),
    })),
  };
}

// ============================================================
//  Generalized Nested Pareto — any parent × child dimension
//  --------------------------------------------------------
//  FIX (RESTORE-BACKEND-2): the generalized multi-nesting function was
//  lost in a force push. Restored here as `queryParetoNested` with
//  pluggable parent/child dimensions.
//
//  2-step query pattern (matches the legacy item→outlet shape):
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
 * 2-step pattern:
 *   1. Query top N parents by |nominalDeviasi| (LIMIT maxItems)
 *   2. ONE combined query for all parents' top-20 children (ROW_NUMBER
 *      PARTITION BY parent group, rn <= 20 — AUDIT-FOLLOWUP-NESTED-N+1;
 *      previously one withStatementTimeout transaction per parent)
 *
 * JOINs are built as a plain space-joined string + wrapped in Prisma.raw().
 * See "SQL safety" comment at top of this section for why we avoid
 * Prisma.empty interpolation.
 *
 * H-12: when childDim='outlet', each child row ALSO carries the outlet's
 * display columns (label = o.name, area = o.area) so the legacy
 * NestedParetoItem adapter can render outlet names without a third query.
 * Non-outlet child dims emit NULL placeholders — the row shape stays
 * uniform (static literal fragments, no parameters, no empty-fragment
 * interpolation; follows the same Prisma.raw convention as the JOINs).
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

  // H-12: outlet child display columns. Both branches are NON-empty static
  // literals (same Prisma.raw convention as the JOINs above) so the child
  // row shape is uniform across dimensions and no empty fragment is ever
  // interpolated.
  const childDetailCols = childDim === 'outlet'
    ? Prisma.raw('o.name as "label", o.area as "area",')
    : Prisma.raw('NULL::text as "label", NULL::text as "area",');
  // H-12 (CRITICAL — Postgres functional dependency): the detail columns are
  // plain (non-aggregated) SELECT columns, so they MUST be in the GROUP BY.
  // Postgres only infers functional dependency from PRIMARY KEYs — and
  // Outlet's PK is `id`, while `code` is merely UNIQUE — so `GROUP BY o.code`
  // alone would raise "column o.name must appear in the GROUP BY clause".
  // This mirrors the old specialized query's GROUP BY (i.name, o.code, o.name,
  // o.area); since o.code is unique the grouping is unchanged (one row per
  // outlet), and non-outlet child dims are untouched.
  const childDetailGroupBy = childDim === 'outlet'
    ? Prisma.raw(', o.name, o.area')
    : Prisma.raw('');

  // Step 1: query top N parents by |nominalDeviasi|.
  // FIX (BUG-2-c): `populationTotal` (SUM(...) OVER () window — evaluated
  // AFTER GROUP BY/HAVING but BEFORE the LIMIT) carries the TOTAL over the
  // WHOLE parent population, not just the top-N slice the LIMIT returns.
  // sharePct/cumPct are now computed against it, matching the by-dimension
  // cards (computePareto8020 over the full population) instead of hitting a
  // misleading 100% at row N when the population is larger than maxItems
  // (e.g. 109 items with maxItems=10 → item #1's share was inflated).
  const topParents = await withStatementTimeout((tx) => tx.$queryRaw<
    Array<{
      name: string;
      totalAbsNominal: number;
      populationTotal: number | null;
      nominalDeviasi: number;
      qtyDeviasi: number;
      outletCount: number;
    }>
  >`
    SELECT ${parentGroupExpr} as "name",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ABS(SUM(ir."nominalDeviasi"))) OVER () as "populationTotal",
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

  // FIX (BUG-2-c): denominator = FULL population total (window column on
  // every row — LIMIT cannot clip it). Defensive fallback to the old
  // top-N subtotal when the window value is unexpectedly null/NaN/0.
  const populationTotal = Number(topParents[0].populationTotal) || 0;
  const grandTotal = populationTotal > 0
    ? populationTotal
    : topParents.reduce((s, r) => s + Number(r.totalAbsNominal), 0);

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
      label: string | null;
      area: string | null;
      totalAbsNominal: number;
      parentChildPopulationTotal: number | null;
      nominalDeviasi: number;
      qtyDeviasi: number;
    }>
  >`
    WITH per_child AS (
      SELECT ${parentGroupExpr} as "parentName", ${childGroupExpr} as "name",
        ${childDetailCols}
        ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
        -- FIX (BUG-2-c): full child population total per parent (window is
        -- evaluated over ALL per_child rows, BEFORE the ranked/rn<=20 cap
        -- and before the parent IN-list LIMIT could clip anything) — the
        -- denominator for honest child sharePct/cumPct.
        SUM(ABS(SUM(ir."nominalDeviasi"))) OVER (PARTITION BY ${parentGroupExpr}) as "parentChildPopulationTotal",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        SUM(ir."qtyDeviasi") as "qtyDeviasi"
      FROM "InventoryRecord" ir
      ${childJoins}
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ${parentGroupExpr} IN (${Prisma.join(parentNames)})
        ${f}
      GROUP BY ${parentGroupExpr}, ${childGroupExpr}${childDetailGroupBy}
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
    SELECT "parentName", "name", "label", "area", "totalAbsNominal", "parentChildPopulationTotal", "nominalDeviasi", "qtyDeviasi"
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

    // FIX (BUG-2-c): child shares are computed against the parent's FULL
    // child population (window column computed pre-cap), with a defensive
    // fallback to the returned-rows subtotal when the window value is
    // unexpectedly null/NaN/0. Child cumPct therefore no longer hits a
    // misleading 100% at the rn<=20 cap, and the Pareto-80% cutoff below
    // stops at an honest 80% of the parent's total deviation.
    const childPopulationTotal = Number(childRows[0]?.parentChildPopulationTotal) || 0;
    const childTotal = childPopulationTotal > 0
      ? childPopulationTotal
      : childRows.reduce((s, r) => s + Number(r.totalAbsNominal), 0);
    let childCumPct = 0;
    const allChildren = childRows.map((r) => {
      const sharePct = childTotal > 0 ? (Number(r.totalAbsNominal) / childTotal) * 100 : 0;
      childCumPct += sharePct;
      return {
        name: r.name,
        label: r.label ?? null,
        area: r.area ?? null,
        totalAbsNominal: Number(r.totalAbsNominal),
        nominalDeviasi: Number(r.nominalDeviasi),
        qtyDeviasi: Number(r.qtyDeviasi),
        sharePct: Number(sharePct.toFixed(1)),
        cumPct: Number(childCumPct.toFixed(1)),
      };
    });

    // Apply Pareto 80% cutoff to children (same pattern as the legacy
    // queryParetoNestedItemOutlet loop — was `.filter(...)` referencing
    // `outlets` before initialization (TDZ error → HTTP 500); simple for-loop).
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
