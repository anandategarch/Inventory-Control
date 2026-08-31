// ============================================================
//  Pareto by Dimension — top contributors accounting for 80% of total deviation
//  --------------------------------------------------------
//  Dimensions: Item, Outlet, Area, Kelompok (3-char outlet code prefix), PIC.
//  Each function returns the Pareto 80/20 result for that dimension,
//  scoped by week/month + the shared SqlFilterOpts (area/kelompok/outlet/
//  picOutletCodes/itemName).
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import { computePareto } from './compute';
import type { ParetoResult } from './types';

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
