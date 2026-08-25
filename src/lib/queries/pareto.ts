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
  const typed = rows.map((r: any) => ({
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
  filters: { area?: string | null; picOutletCodes?: string[] | null },
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
  const typed = rows.map((r: any) => ({
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
  filters: { picOutletCodes?: string[] | null },
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
  const typed = rows.map((r: any) => ({
    name: r.area,
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
  filters: { area?: string | null; picOutletCodes?: string[] | null },
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
  const typed = rows.map((r: any) => ({
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
  filters: { area?: string | null; picOutletCodes?: string[] | null },
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

  const grandTotal = topItems.reduce((s, r: any) => s + Number(r.totalAbsNominal), 0);
  let itemCumPct = 0;

  // Step 2: for each top item, get outlet breakdown (Pareto 80% per item)
  const items: NestedParetoItem[] = [];
  for (const item of topItems) {
    const itemName = (item as any).itemName;
    const itemTotal = Number((item as any).totalAbsNominal);
    const itemNominal = Number((item as any).nominalDeviasi);
    const itemQtyDeviasi = Number((item as any).qtyDeviasi);
    const itemOutletCount = Number((item as any).outletCount);

    const outletRows = await db.$queryRaw<Array<{ outletCode: string; outletName: string; area: string; totalAbsNominal: number; nominalDeviasi: number; qtyDeviasi: number }>>`
      SELECT o.code as "outletCode", o.name as "outletName", o.area,
        ABS(SUM(ir."nominalDeviasi")) as "totalAbsNominal",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        SUM(ir."qtyDeviasi") as "qtyDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND LOWER(i.name) = LOWER(${itemName})
        ${f}
      GROUP BY o.code, o.name, o.area
      HAVING ABS(SUM(ir."nominalDeviasi")) > 0
      ORDER BY "totalAbsNominal" DESC
      LIMIT 20
    `;

    const outletTotal = outletRows.reduce((s, r: any) => s + Number(r.totalAbsNominal), 0);
    let outletCumPct = 0;
    const allOutlets = outletRows.map((r: any) => {
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
  dimension: 'item' | 'outlet' | 'area' | 'pic',
  filters: { area?: string | null; picOutletCodes?: string[] | null },
): Promise<Map<string, { histAvg: number; histStdDev: number; histN: number }>> {
  const f = buildSqlFilters(filters);

  // Different GROUP BY expression per dimension
  const groupExpr = dimension === 'item'
    ? Prisma.sql`i.name`
    : dimension === 'outlet'
      ? Prisma.sql`o.code`
      : dimension === 'area'
        ? Prisma.sql`o.area`
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
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ name: string; histAvg: number; histStdDev: number; histN: number }>>`
    WITH weekly_dev AS (
      SELECT ${groupExpr} as "name",
        ir."monthLabel", ir."weekLabel",
        ABS(SUM(ir."nominalDeviasi")) as "weeklyTotal"
      FROM "InventoryRecord" ir
      ${joinItem}
      ${joinOutlet}
      ${joinPIC}
      WHERE ir."weekLabel" = ${week}
        AND ir."monthLabel" != ${month}
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
