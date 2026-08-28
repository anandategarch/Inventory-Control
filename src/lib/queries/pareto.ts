// ============================================================
//  Pareto Analysis Queries — 80/20 rule analysis
//  Returns top contributors that account for 80% of total deviation.
//  Dimensions: Item, Outlet, Area, PIC, and nested Item→Outlet.
// ============================================================
import { db } from '@/lib/db';
import { buildSqlFilters, computePareto8020, withStatementTimeout, type SqlFilterOpts } from './shared';
import { Prisma } from '@prisma/client';

interface ParetoRow {
  name: string;
  code?: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number; // SIGNED sum — for display (negative=LOSS, positive=SURPLUS)
  outletCount?: number;
  sharePct: number;
  cumPct: number;
}

interface ParetoResult {
  drivers: ParetoRow[];
  remainderCount: number;
  remainderPct: number;
  totalAbsNominal: number;
  totalCount: number;
}

function computePareto<T extends { totalAbsNominal: number; name: string; nominalDeviasi: number; qtyDeviasi: number }>(
  rows: T[],
  threshold: number = 0.80,
  maxDrivers: number = 20,
): ParetoResult {
  // FIX (RESTORE-SHARED-1): delegate to shared computePareto8020 in ./shared.
  // The shared function uses |getValue(row)| for sorting + share% — pass
  // r.totalAbsNominal (already non-negative) so behaviour matches the
  // previous inline implementation. Map totalMagnitude → totalAbsNominal
  // to preserve the ParetoResult shape consumed by mergeHistoricalIntoPareto.
  const r = computePareto8020(rows, (row) => row.totalAbsNominal, threshold, maxDrivers);
  return {
    drivers: r.drivers as ParetoRow[],
    remainderCount: r.remainderCount,
    remainderPct: r.remainderPct,
    totalAbsNominal: r.totalMagnitude,
    totalCount: r.totalCount,
  };
}

// ============================================================
//  Pareto by Item — top items accounting for 80% of total deviation
// ============================================================
export async function queryParetoByItem(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ itemName: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
    SELECT i.name as "itemName",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY i.name
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r) => ({
    name: r.itemName,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
    qtyDeviasi: Number(r.qtyDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by Outlet — top outlets accounting for 80% of total deviation
// ============================================================
export async function queryParetoByOutlet(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string; outletName: string; area: string; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
    SELECT o.code as "outletCode", o.name as "outletName", o.area,
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY o.code, o.name, o.area
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r) => ({
    name: r.outletName,
    code: r.outletCode,
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
    qtyDeviasi: Number(r.qtyDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by Area — top areas accounting for 80% of total deviation
// ============================================================
export async function queryParetoByArea(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<ParetoResult> {
  const f = buildSqlFilters({ ...filters, area: null });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ area: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
    SELECT o.area,
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY o.area
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r) => ({
    name: r.area,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
    qtyDeviasi: Number(r.qtyDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by Kelompok — top outlet prefixes (3-char) accounting for 80%
//  Kelompok = 3-char prefix from outlet code (e.g. "MLG" from "1016.MLGJAK")
// ============================================================
export async function queryParetoByKelompok(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  // FIX (BUG-KELOMPOK-EMPTY): Use LEFT(SUBSTRING(code FROM '[^.]+$'), 3) to extract
  // the kelompok from the LAST dot-segment (the name prefix), consistent with
  // buildSqlFilters + /api/status. POSITION('.' IN code)+1 returns the position
  // after the FIRST dot — wrong for format 2 ("B.1001.MLGPAR" → "100", not "MLG").
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ kelompok: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
    SELECT LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3) as "kelompok",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3)
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r) => ({
    name: r.kelompok,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
    qtyDeviasi: Number(r.qtyDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by PIC — top PICs accounting for 80% of total deviation (#8)
// ============================================================
export async function queryParetoByPIC(
  week: string,
  month: string,
  filters: SqlFilterOpts,
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ pic: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
    SELECT COALESCE(pic.pic, 'Unassigned') as "pic",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") as "qtyDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY pic.pic
    HAVING ABS(SUM(ir."nominalDeviasi")) > 0
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r) => ({
    name: r.pic,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
    qtyDeviasi: Number(r.qtyDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto Nested: Item → Outlet breakdown (#3)
//  For each top item (80% Pareto), returns the outlets that contribute
//  80% of that item's total deviation.
// ============================================================
export interface NestedParetoItem {
  itemName: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  outlets: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    totalAbsNominal: number;
    nominalDeviasi: number;
    qtyDeviasi: number;
    sharePct: number;
    cumPct: number;
  }>;
}

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
//  Pareto Historical — fetch historical stats for Pareto dimensions
//  For each dimension (item/outlet/area/pic), computes the average +
//  stddev of totalAbsNominal across same weekLabel in previous months.
//  Returns a Map<name, { histAvg, histStdDev, histN }> for z-score computation.
//
//  z-score = (current - histAvg) / histStdDev
//  |z| > 2 = ABNORMAL, |z| > 1 = ELEVATED
// ============================================================
export async function queryParetoHistorical(
  week: string,
  month: string,
  dimension: 'item' | 'outlet' | 'area' | 'kelompok' | 'pic',
  filters: SqlFilterOpts,
  // FIX (BUG2-PARETO-1): pass currentMonthKey to filter out FUTURE months.
  // The old code only excluded `monthLabel != ${month}` — included future months
  // if they exist in DB, inflating/shifting the historical mean+stddev.
  currentMonthKey?: string,
): Promise<Map<string, { histAvg: number; histStdDev: number; histN: number }>> {
  const f = buildSqlFilters(filters);

  // Different GROUP BY expression per dimension
  // FIX (BUG-KELOMPOK-EMPTY): kelompok extraction uses LEFT(SUBSTRING(code FROM '[^.]+$'), 3)
  // to get the 3-char prefix of the LAST dot-segment (the name prefix). The old
  // SUBSTRING(... POSITION('.' IN code)+1 FOR 3) grabbed chars after the FIRST dot
  // — wrong for format 2 ("B.1001.MLGPAR" → "100", not "MLG"). Now consistent with
  // buildSqlFilters + queryParetoByKelompok.
  const groupExpr = dimension === 'item'
    ? Prisma.sql`i.name`
    : dimension === 'outlet'
      ? Prisma.sql`o.code`
      : dimension === 'area'
        ? Prisma.sql`o.area`
        : dimension === 'kelompok'
          ? Prisma.sql`LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3)`
          : Prisma.sql`COALESCE(pic.pic, 'Unassigned')`;

  const joinItem = dimension === 'item'
    ? Prisma.sql`JOIN "Item" i ON ir."itemId" = i.id`
    : Prisma.empty;
  const joinOutlet = dimension !== 'item'
    ? Prisma.sql`JOIN "Outlet" o ON ir."outletId" = o.id`
    : Prisma.empty;
  const joinPIC = dimension === 'pic'
    ? Prisma.sql`LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"`
    : Prisma.empty;

  // Two-level aggregation:
  // 1. weekly_dev: per (dimension, month, week) → 1 observation = SUM(absNominalDeviasi)
  // 2. final: per dimension → AVG + STDDEV across weekly observations
  // Filter: same weekLabel, different monthLabel (historical comparison)
  // FIX (BUG2-PARETO-1): JOIN SourceFile + filter sf."monthKey" < currentMonthKey
  // to exclude FUTURE months. The old code only excluded `monthLabel != ${month}`,
  // which included future months if they exist in DB.
  const futureFilter = currentMonthKey
    ? Prisma.sql`AND sf."monthKey" < ${currentMonthKey}`
    : Prisma.sql`AND ir."monthLabel" != ${month}`;
  const joinSourceFile = Prisma.sql`JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id`;
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ name: string; histAvg: number; histStdDev: number; histN: number }>>`
    WITH weekly_dev AS (
      SELECT ${groupExpr} as "name",
        ir."monthLabel", ir."weekLabel",
        ABS(SUM(ir."nominalDeviasi")) as "weeklyTotal"
      FROM "InventoryRecord" ir
      ${joinItem}
      ${joinOutlet}
      ${joinPIC}
      ${joinSourceFile}
      WHERE ir."weekLabel" = ${week}
        ${futureFilter}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY ${groupExpr}, ir."monthLabel", ir."weekLabel"
    )
    SELECT "name",
      AVG("weeklyTotal") as "histAvg",
      STDDEV_SAMP("weeklyTotal") as "histStdDev",
      CAST(COUNT(*) AS INTEGER) as "histN"
    FROM weekly_dev
    WHERE "weeklyTotal" IS NOT NULL
    GROUP BY "name"
  `);

  const map = new Map<string, { histAvg: number; histStdDev: number; histN: number }>();
  for (const r of rows) {
    const n = Number(r.histN);
    const mean = Number(r.histAvg) || 0;
    const stdDev = Number(r.histStdDev) || 0;
    if (n >= 2) {
      map.set(r.name, { histAvg: mean, histStdDev: stdDev, histN: n });
    }
  }
  return map;
}

// ============================================================
//  Merge historical stats into Pareto results
//  Adds histAvg, zScore, histN to each driver row
// ============================================================
export function mergeHistoricalIntoPareto(
  pareto: ParetoResult,
  historical: Map<string, { histAvg: number; histStdDev: number; histN: number }>,
): ParetoResult {
  return {
    ...pareto,
    drivers: pareto.drivers.map(d => {
      const hist = historical.get(d.name) || historical.get(d.code || '');
      if (!hist || hist.histStdDev <= 0) {
        return { ...d, histAvg: hist?.histAvg ?? null, zScore: null, histN: hist?.histN ?? 0 };
      }
      const zScore = (d.totalAbsNominal - hist.histAvg) / hist.histStdDev;
      return {
        ...d,
        histAvg: hist.histAvg,
        zScore: Number(zScore.toFixed(2)),
        histN: hist.histN,
      };
    }),
  };
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

export type ParetoDimension = 'item' | 'outlet' | 'area' | 'kelompok' | 'pic';

interface DimensionExpr {
  /** SQL fragment for GROUP BY + SELECT alias. Bare identifier or expression. */
  groupExpr: string;
  /** JOIN "Item" ... clause, or '' if not needed for this dimension. */
  joinItem: string;
  /** JOIN "Outlet" ... clause, or '' if not needed. */
  joinOutlet: string;
  /** LEFT JOIN "OutletPIC" ... clause, or '' if not needed. */
  joinPIC: string;
}

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

export interface NestedParetoResultItem {
  name: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  children: Array<{
    name: string;
    totalAbsNominal: number;
    nominalDeviasi: number;
    qtyDeviasi: number;
    sharePct: number;
    cumPct: number;
  }>;
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
