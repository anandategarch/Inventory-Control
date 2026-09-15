// ============================================================
//  Top Items by Other Metric — Category averages (benchmarks)
//  --------------------------------------------------------
//  The two category-AVERAGE benchmark queries:
//    1. queryHistoricalCategoryAvg — historical avg per (item,outlet)
//    2. queryAreaCategoryAvg       — per-(item, area) avg (REFINE-1
//                                   "Rata-rata Area" column)
//
//  Split from ./by-other-metric.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Public
//  symbols stay re-exported from ./by-other-metric.ts.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../../shared';

// ============================================================
//  Historical Category Average — avg QTY/Nominal across historical periods
//  Rev 2: For comparing Waste/Susut/Trial/LossSurplus with historical.
//  Returns a Map keyed by "itemName|outletCode" → { avgQty, avgNominal }
// ============================================================
export async function queryHistoricalCategoryAvg(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts,
  category: 'waste' | 'susut' | 'trial' | 'lossSurplus',
): Promise<Map<string, { avgQty: number; avgNominal: number }>> {
  if (historicalPeriods.length === 0) return new Map();
  const f = buildSqlFilters(filters);
  const qtyCol = category === 'waste' ? 'qtyWaste'
    : category === 'susut' ? 'qtySusut'
    : category === 'trial' ? 'qtyTrial'
    : 'qtyLossSurplus';
  const nomCol = category === 'waste' ? 'nominalWaste'
    : category === 'susut' ? 'nominalSusut'
    : category === 'trial' ? 'nominalTrial'
    : 'nominalLossSurplus';
  const qtyRef = Prisma.raw(`ir."${qtyCol}"`);
  const nomRef = Prisma.raw(`ir."${nomCol}"`);

  // Build (monthLabel, weekLabel) pairs for the IN filter
  // Use a simpler approach: filter by weekLabel + any of the historical monthLabels
  const historicalMonths = [...new Set(historicalPeriods.map(p => p.monthLabel))];
  const monthClauses = Prisma.join(historicalMonths, ', ');

  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; avgQty: number; avgNominal: number }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      AVG(ABS(${qtyRef})) as "avgQty",
      AVG(ABS(${nomRef})) as "avgNominal"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."weekLabel" = ${historicalPeriods[0].weekLabel}
      AND ir."monthLabel" IN (${monthClauses})
      AND ${qtyRef} IS NOT NULL AND ${qtyRef} != 0
      ${f}
    GROUP BY i.name, o.code
  `);
  const map = new Map<string, { avgQty: number; avgNominal: number }>();
  for (const r of rows) {
    map.set(`${r.itemName}|${r.outletCode}`, {
      avgQty: Number(r.avgQty) || 0,
      avgNominal: Number(r.avgNominal) || 0,
    });
  }
  return map;
}

// ============================================================
//  Area Category Average — REFINE-1 (user request: "tambahkan juga
//  rata rata area di mana resto itu berada")
//  --------------------------------------------------------
//  Per-(item, area) average category QTY across ALL outlets in that
//  area for the CURRENT period — the "Rata-rata Area" benchmark column
//  in the export's 3.3-3.6 tables.
//
//  Grain: first per-OUTLET sums (same FILTER (qty IS NOT NULL AND
//  qty != 0) convention as queryTopItemsByAllCategories), then
//  AVG over the outlets whose per-outlet qty is > 0 — a conditional
//  average, so the benchmark answers "berapa typical resto di area ini
//  yang mengalami metric ini untuk item yang sama". Outlets with no
//  rows for the metric do not dilute the average to ~0.
//
//  Deliberately NOT scoped by kelompok/outlet/pic/itemName filters:
//  the benchmark is the FULL area population ("rata-rata area di mana
//  resto itu berada"), independent of which resto the report focuses
//  on. The optional `area` param only scopes WHICH areas are computed
//  (when the export itself is area-filtered, every row is inside it
//  anyway — the filter just trims the row count).
//
//  Returns a Map keyed "itemName|area" → the 4 category averages
//  (null when no outlet in the area has the metric for that item).
// ============================================================
export interface AreaCategoryAvg {
  waste: number | null;
  susut: number | null;
  trial: number | null;
  lossSurplus: number | null;
}

export async function queryAreaCategoryAvg(
  week: string,
  month: string,
  area: string | null,
): Promise<Map<string, AreaCategoryAvg>> {
  const areaFilter = area ? Prisma.sql`AND ir."area" = ${area}` : Prisma.empty;

  const catAvg = (qtyCol: string) => {
    const qtyRef = Prisma.raw(`ir."${qtyCol}"`);
    const cond = Prisma.sql`${qtyRef} IS NOT NULL AND ${qtyRef} != 0`;
    // inner: per-outlet sum (wide); outer: AVG over outlets with qty > 0
    return {
      inner: Prisma.sql`COALESCE(SUM(ABS(${qtyRef})) FILTER (WHERE ${cond}), 0)`,
      outer: (col: string) => Prisma.sql`AVG(${Prisma.raw(col)}) FILTER (WHERE ${Prisma.raw(col)} > 0)`,
    };
  };

  const cats = {
    waste: catAvg('qtyWaste'),
    susut: catAvg('qtySusut'),
    trial: catAvg('qtyTrial'),
    lossSurplus: catAvg('qtyLossSurplus'),
  };

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
    itemName: string; area: string;
    avgWaste: number | null; avgSusut: number | null; avgTrial: number | null; avgLossSurplus: number | null;
  }[]>`
    SELECT "itemName", "area",
      ${cats.waste.outer('perOutlet."wasteQty"')} as "avgWaste",
      ${cats.susut.outer('perOutlet."susutQty"')} as "avgSusut",
      ${cats.trial.outer('perOutlet."trialQty"')} as "avgTrial",
      ${cats.lossSurplus.outer('perOutlet."lsQty"')} as "avgLossSurplus"
    FROM (
      SELECT i.name as "itemName", o.area,
        ${cats.waste.inner} as "wasteQty",
        ${cats.susut.inner} as "susutQty",
        ${cats.trial.inner} as "trialQty",
        ${cats.lossSurplus.inner} as "lsQty"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${areaFilter}
      GROUP BY i.name, o.area, o.code
    ) perOutlet
    GROUP BY "itemName", "area"
  `);

  const map = new Map<string, AreaCategoryAvg>();
  for (const r of rows) {
    map.set(`${r.itemName}|${r.area}`, {
      waste: r.avgWaste == null ? null : Number(r.avgWaste) || 0,
      susut: r.avgSusut == null ? null : Number(r.avgSusut) || 0,
      trial: r.avgTrial == null ? null : Number(r.avgTrial) || 0,
      lossSurplus: r.avgLossSurplus == null ? null : Number(r.avgLossSurplus) || 0,
    });
  }
  return map;
}
