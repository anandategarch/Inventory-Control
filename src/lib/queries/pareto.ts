// ============================================================
//  Pareto Analysis Queries — 80/20 rule analysis
//  Returns top contributors that account for 80% of total deviation.
//  Dimensions: Item, Outlet, Area, PIC, and nested Item→Outlet.
// ============================================================
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout } from './shared';
import { Prisma } from '@prisma/client';

interface ParetoRow {
  name: string;
  code?: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
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

function computePareto<T extends { totalAbsNominal: number; name: string; nominalDeviasi: number }>(
  rows: T[],
  threshold: number = 0.80,
  maxDrivers: number = 20,
): ParetoResult {
  rows.sort((a, b) => b.totalAbsNominal - a.totalAbsNominal);
  const totalAbsNominal = rows.reduce((s, r) => s + r.totalAbsNominal, 0);
  if (totalAbsNominal === 0) {
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: rows.length };
  }
  let cumPct = 0;
  const drivers: ParetoRow[] = [];
  for (const r of rows) {
    if (drivers.length >= maxDrivers) break;
    const sharePct = (r.totalAbsNominal / totalAbsNominal) * 100;
    cumPct += sharePct;
    drivers.push({
      ...r,
      sharePct: Number(sharePct.toFixed(1)),
      cumPct: Number(cumPct.toFixed(1)),
    });
    if (cumPct >= threshold * 100) break;
  }
  return {
    drivers,
    remainderCount: rows.length - drivers.length,
    remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)),
    totalAbsNominal,
    totalCount: rows.length,
  };
}

// ============================================================
//  Pareto by Item — top items accounting for 80% of total deviation
// ============================================================
export async function queryParetoByItem(
  week: string,
  month: string,
  filters: { area?: string | null; outletCode?: string | null; picOutletCodes?: string[] | null },
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ itemName: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number }>>`
    SELECT i.name as "itemName",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      SUM(ir."absNominalDeviasi") as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY i.name
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r: any) => ({
    name: r.itemName,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by Outlet — top outlets accounting for 80% of total deviation
// ============================================================
export async function queryParetoByOutlet(
  week: string,
  month: string,
  filters: { area?: string | null; picOutletCodes?: string[] | null },
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string; outletName: string; area: string; totalAbsNominal: number; nominalDeviasi: number }>>`
    SELECT o.code as "outletCode", o.name as "outletName", o.area,
      SUM(ir."absNominalDeviasi") as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY o.code, o.name, o.area
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r: any) => ({
    name: r.outletName,
    code: r.outletCode,
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by Area — top areas accounting for 80% of total deviation
// ============================================================
export async function queryParetoByArea(
  week: string,
  month: string,
  filters: { picOutletCodes?: string[] | null },
): Promise<ParetoResult> {
  const f = buildSqlFilters({ ...filters, area: null });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ area: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number }>>`
    SELECT o.area,
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      SUM(ir."absNominalDeviasi") as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY o.area
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r: any) => ({
    name: r.area,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
  }));
  return computePareto(typed);
}

// ============================================================
//  Pareto by PIC — top PICs accounting for 80% of total deviation (#8)
// ============================================================
export async function queryParetoByPIC(
  week: string,
  month: string,
  filters: { area?: string | null; picOutletCodes?: string[] | null },
): Promise<ParetoResult> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ pic: string; outletCount: number; totalAbsNominal: number; nominalDeviasi: number }>>`
    SELECT COALESCE(pic.pic, 'Unassigned') as "pic",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      SUM(ir."absNominalDeviasi") as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY pic.pic
    ORDER BY "totalAbsNominal" DESC
  `);
  const typed = rows.map((r: any) => ({
    name: r.pic,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
    nominalDeviasi: Number(r.nominalDeviasi),
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
  outletCount: number;
  sharePct: number;
  cumPct: number;
  outlets: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    totalAbsNominal: number;
    nominalDeviasi: number;
    sharePct: number;
    cumPct: number;
  }>;
}

export async function queryParetoNestedItemOutlet(
  week: string,
  month: string,
  filters: { area?: string | null; picOutletCodes?: string[] | null },
  maxItems: number = 10,
): Promise<{ items: NestedParetoItem[]; totalAbsNominal: number }> {
  const f = buildSqlFilters(filters);
  // Step 1: get top items (Pareto 80%)
  const topItems = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ itemName: string; totalAbsNominal: number; nominalDeviasi: number; outletCount: number }>>`
    SELECT i.name as "itemName",
      SUM(ir."absNominalDeviasi") as "totalAbsNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY i.name
    ORDER BY "totalAbsNominal" DESC
    LIMIT ${maxItems}
  `);

  if (topItems.length === 0) return { items: [], totalAbsNominal: 0 };

  const grandTotal = topItems.reduce((s, r: any) => s + Number(r.totalAbsNominal), 0);
  let itemCumPct = 0;

  // Step 2: for each top item, get outlet breakdown (Pareto 80% per item)
  const items: NestedParetoItem[] = [];
  for (const item of topItems) {
    const itemName = (item as any).itemName;
    const itemTotal = Number((item as any).totalAbsNominal);
    const itemNominal = Number((item as any).nominalDeviasi);
    const itemOutletCount = Number((item as any).outletCount);

    const outletRows = await db.$queryRaw<Array<{ outletCode: string; outletName: string; area: string; totalAbsNominal: number; nominalDeviasi: number }>>`
      SELECT o.code as "outletCode", o.name as "outletName", o.area,
        SUM(ir."absNominalDeviasi") as "totalAbsNominal",
        SUM(ir."nominalDeviasi") as "nominalDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND LOWER(i.name) = LOWER(${itemName})
        ${f}
      GROUP BY o.code, o.name, o.area
      ORDER BY "totalAbsNominal" DESC
      LIMIT 20
    `;

    const outletTotal = outletRows.reduce((s, r: any) => s + Number(r.totalAbsNominal), 0);
    let outletCumPct = 0;
    const outlets = outletRows.map((r: any) => {
      const sharePct = outletTotal > 0 ? (Number(r.totalAbsNominal) / outletTotal) * 100 : 0;
      outletCumPct += sharePct;
      return {
        outletCode: r.outletCode,
        outletName: r.outletName,
        area: r.area,
        totalAbsNominal: Number(r.totalAbsNominal),
        nominalDeviasi: Number(r.nominalDeviasi),
        sharePct: Number(sharePct.toFixed(1)),
        cumPct: Number(outletCumPct.toFixed(1)),
      };
    }).filter((_, i) => i === 0 || outlets === undefined || (outletCumPct < 80 && i < 20));

    // Keep outlets until 80% cumulative (keep at least 1)
    const filteredOutlets: typeof outlets = [];
    let cum = 0;
    for (const o of outlets) {
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
      outletCount: itemOutletCount,
      sharePct: Number(itemSharePct.toFixed(1)),
      cumPct: Number(itemCumPct.toFixed(1)),
      outlets: filteredOutlets,
    });
  }

  return { items, totalAbsNominal: grandTotal };
}
