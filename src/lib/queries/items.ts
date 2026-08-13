// ============================================================
//  Item-level queries — top-N items by various metrics, Pareto
//  classification, and item consistency (outlet coverage) analysis.
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters } from './shared';

// ============================================================
//  Top Items by Metric — GROUP BY itemId (Phase 2)
//  Returns N rows instead of 35K
// ============================================================
export interface TopItemRow {
  itemName: string;
  outletCode: string;
  absNominal: number;
  direction: string;
}

export async function queryTopItemsByNominal(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; absNominal: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; absNominal: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      SUM(ir."absNominalLossSurplus") as "absNominal",
      CASE WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "absNominal" DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function queryTopItemsByDevBom(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; devBom: number; tolerance: number | null }>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; devBom: number; tolerance: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBom",
      MAX(ir."tolerancePct") as "tolerance"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."qtyBom" != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "devBom" DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ============================================================
//  Top Items by Waste/Susut/Trial/LossSurplus (Phase 2)
// ============================================================
export async function queryTopItemsByCategory(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  category: 'waste' | 'susut' | 'trial' | 'lossSurplus',
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; qty: number; nominal: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  const qtyCol = category === 'waste' ? 'qtyWaste'
    : category === 'susut' ? 'qtySusut'
    : category === 'trial' ? 'qtyTrial'
    : 'qtyLossSurplus';
  const nomCol = category === 'waste' ? 'nominalWaste'
    : category === 'susut' ? 'nominalSusut'
    : category === 'trial' ? 'nominalTrial'
    : 'nominalLossSurplus';

  // Build column reference safely
  const qtyRef = Prisma.raw(`ir."${qtyCol}"`);
  const nomRef = Prisma.raw(`ir."${nomCol}"`);

  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; qty: number; nominal: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      SUM(ABS(${qtyRef})) as qty,
      SUM(ABS(${nomRef})) as nominal,
      CASE WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ${qtyRef} IS NOT NULL AND ${qtyRef} != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY qty DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ============================================================
//  Pareto Analysis — window function (Phase 4)
//  Returns top N items + total item count + class A stats (across ALL items)
// ============================================================
export async function queryPareto(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 50
): Promise<{
  items: Array<{ rank: number; itemName: string; outletCode: string; absNominal: number; cumulative: number; cumulativePct: number; classification: 'A' | 'B' | 'C' }>;
  classACount: number; classACost: number; classAPct: number;
  classBCount: number; classBCost: number; classBPct: number;
  classCCount: number; classCCost: number; classCPct: number;
  totalItems: number; totalAbsNominal: number;
  // Phase 4: true class A stats across ALL items (not capped by LIMIT)
  classACountFull: number; classAPctFull: number;
}> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{
    rank: number; itemName: string; outletCode: string; absNominal: number;
    cumulative: number; cumulativePct: number; classification: 'A' | 'B' | 'C';
    totalItems: number; grandTotal: number;
    classACountFull: number; classAPctFull: number;
  }[]>`
    WITH item_totals AS (
      SELECT i.name as "itemName",
        SUM(ir."absNominalLossSurplus") as "absNominal"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
        ${f}
      GROUP BY i.name
    ),
    ranked AS (
      SELECT "itemName", "absNominal",
        CAST(ROW_NUMBER() OVER (ORDER BY "absNominal" DESC) AS INTEGER) as rank,
        SUM("absNominal") OVER (ORDER BY "absNominal" DESC) as cumulative,
        SUM("absNominal") OVER () as grand_total,
        CAST(COUNT(*) OVER () AS INTEGER) as total_items
      FROM item_totals
    ),
    class_a_stats AS (
      SELECT
        CAST(COUNT(*) AS INTEGER) as class_a_count,
        COALESCE(MAX(cumulative / NULLIF(grand_total, 0)), 0) as class_a_pct
      FROM ranked
      WHERE cumulative / NULLIF(grand_total, 0) <= 0.70
    )
    SELECT r.rank, r."itemName", CAST(NULL AS TEXT) as "outletCode", r."absNominal", r.cumulative,
      (r.cumulative / NULLIF(r.grand_total, 0)) * 100 as "cumulativePct",
      CASE
        WHEN (r.cumulative / NULLIF(r.grand_total, 0)) * 100 <= 70 THEN 'A'
        WHEN (r.cumulative / NULLIF(r.grand_total, 0)) * 100 <= 90 THEN 'B'
        ELSE 'C'
      END as classification,
      r.total_items as "totalItems",
      r.grand_total as "grandTotal",
      (SELECT class_a_count FROM class_a_stats) as "classACountFull",
      (SELECT class_a_pct FROM class_a_stats) as "classAPctFull"
    FROM ranked r
    ORDER BY r.rank
    LIMIT ${limit}
  `;

  const items = rows;
  const grandTotal = items.length > 0 ? items[0].grandTotal : 0;
  const totalItemsCount = items.length > 0 ? items[0].totalItems : 0;
  const classACountFull = items.length > 0 ? items[0].classACountFull : 0;
  const classAPctFull = items.length > 0 ? items[0].classAPctFull : 0;

  // Class A/B/C stats WITHIN returned items (for backward compat)
  const classA = items.filter(i => i.classification === 'A');
  const classB = items.filter(i => i.classification === 'B');
  const classC = items.filter(i => i.classification === 'C');

  return {
    items,
    classACount: classA.length,
    classACost: classA.reduce((s, i) => s + i.absNominal, 0),
    classAPct: grandTotal > 0 ? classA.reduce((s, i) => s + i.absNominal, 0) / grandTotal : 0,
    classBCount: classB.length,
    classBCost: classB.reduce((s, i) => s + i.absNominal, 0),
    classBPct: grandTotal > 0 ? classB.reduce((s, i) => s + i.absNominal, 0) / grandTotal : 0,
    classCCount: classC.length,
    classCCost: classC.reduce((s, i) => s + i.absNominal, 0),
    classCPct: grandTotal > 0 ? classC.reduce((s, i) => s + i.absNominal, 0) / grandTotal : 0,
    totalItems: totalItemsCount,
    totalAbsNominal: grandTotal,
    classACountFull,
    classAPctFull,
  };
}

// ============================================================
//  Item Consistency — GROUP BY itemName with outlet count (Phase 4)
//  SYSTEMIC: >=10 outlets, WIDESPREAD: 5-9, ISOLATED: 2-4
// ============================================================
export async function queryItemConsistency(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  }
): Promise<Array<{
  itemName: string;
  outletCount: number;
  lossOutlets: number;
  surplusOutlets: number;
  totalAbsNominal: number;
  avgDevBom: number;
  consistency: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
}>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<{
    itemName: string;
    outletCount: number;
    lossOutlets: number;
    surplusOutlets: number;
    totalAbsNominal: number;
    avgDevBom: number;
    consistency: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
  }[]>`
    WITH item_outlets AS (
      SELECT i.name as "itemName",
        CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
        CAST(COUNT(DISTINCT CASE WHEN ir.direction = 'LOSS' THEN ir."outletId" END) AS INTEGER) as "lossOutlets",
        CAST(COUNT(DISTINCT CASE WHEN ir.direction = 'SURPLUS' THEN ir."outletId" END) AS INTEGER) as "surplusOutlets",
        SUM(ir."absNominalLossSurplus") as "totalAbsNominal",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "avgDevBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
        ${f}
      GROUP BY i.name
    )
    SELECT "itemName", "outletCount", "lossOutlets", "surplusOutlets",
      "totalAbsNominal", COALESCE("avgDevBom", 0) as "avgDevBom",
      CASE
        WHEN "outletCount" >= 10 THEN 'SYSTEMIC'
        WHEN "outletCount" >= 5 THEN 'WIDESPREAD'
        ELSE 'ISOLATED'
      END as consistency
    FROM item_outlets
    ORDER BY "totalAbsNominal" DESC
  `;
  return rows;
}
