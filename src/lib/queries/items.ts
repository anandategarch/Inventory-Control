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
): Promise<Array<{ itemName: string; outletCode: string; absNominal: number; nominalDeviasi: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  // Rev 3: Sort by ABS(nominalDeviasi), but return signed nominalDeviasi for display.
  // Previous version sorted/displayed absNominalLossSurplus (NET) — user wants nominalDeviasi (GROSS).
  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; absNominal: number; nominalDeviasi: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      SUM(ir."absNominalDeviasi") as "absNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      CASE WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'SURPLUS'
           ELSE 'NEUTRAL' END as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
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
): Promise<Array<{ itemName: string; outletCode: string; devBom: number; devBomAbs: number; tolerance: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 4: Sort by ABS(devBom), but return signed devBom for display.
  // Signed devBom = SUM(qtyDeviasi) / SUM(ABS(qtyBom)) — can be negative (SURPLUS) or positive (LOSS).
  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; devBom: number; devBomAbs: number; tolerance: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBom",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBomAbs",
      MAX(ir."tolerancePct") as "tolerance"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."pctQtyDeviasiToBom" IS NOT NULL AND ir."qtyBom" != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "devBomAbs" DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ============================================================
//  Top Items by Deviasi Rank — national item ranking
//  Returns per (item, resto) with:
//  - Rank Item Nasional (by abs(nominalDeviasi) DESC)
//  - Rank BOM (by abs(qtyBom) DESC)
//  - qtyDeviasi, qtyWaste, qtyLossSurplus, qtyBom (all signed)
//  - pctLossSurplusToBom = SUM(qtyLossSurplus) / SUM(qtyBom) (signed, tanpa ABS)
//  - avgDeviasiByBom = AVG(ABS(pctQtyDeviasiToBom)) across ALL outlets for that item (network avg)
//  - nominalDeviasi (signed)
//  - PIC, Satuan
// ============================================================
export async function queryTopItemsByDeviasiRank(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 20
): Promise<Array<{
  itemName: string;
  outletCode: string;
  outletName: string;
  pic: string | null;
  satuan: string | null;
  qtyDeviasi: number;
  qtyWaste: number;
  qtyLossSurplus: number;
  pctLossSurplusToBom: number | null;
  qtyBom: number;
  avgDeviasiByBom: number | null;
  nominalDeviasi: number;
  rankNominal: number;
  rankBom: number;
}>> {
  const f = buildSqlFilters(filters);
  const rows = await db.$queryRaw<any[]>`
    WITH item_per_outlet AS (
      SELECT
        i.name as "itemName",
        o.code as "outletCode",
        o.name as "outletName",
        pic.pic,
        MAX(ir."satuan") as "satuan",
        SUM(ir."qtyDeviasi") as "qtyDeviasi",
        SUM(ir."qtyWaste") as "qtyWaste",
        SUM(ir."qtyLossSurplus") as "qtyLossSurplus",
        CASE WHEN SUM(ir."qtyBom") != 0
          THEN SUM(ir."qtyLossSurplus") / SUM(ir."qtyBom")
          ELSE NULL END as "pctLossSurplusToBom",
        SUM(ir."qtyBom") as "qtyBom",
        SUM(ir."nominalDeviasi") as "nominalDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY i.name, o.code, o.name, pic.pic
    ),
    item_network_avg AS (
      -- AVG Deviasi By BOM: network average of ABS(pctQtyDeviasiToBom) per item
      SELECT
        i.name as "itemName",
        AVG(ABS(ir."pctQtyDeviasiToBom")) as "avgDeviasiByBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."pctQtyDeviasiToBom" IS NOT NULL
      GROUP BY i.name
    )
    SELECT
      ipo.*,
      ina."avgDeviasiByBom",
      ROW_NUMBER() OVER (ORDER BY ABS(ipo."nominalDeviasi") DESC) as "rankNominal",
      ROW_NUMBER() OVER (ORDER BY ABS(ipo."qtyBom") DESC) as "rankBom"
    FROM item_per_outlet ipo
    LEFT JOIN item_network_avg ina ON ipo."itemName" = ina."itemName"
    ORDER BY ABS(ipo."nominalDeviasi") DESC
    LIMIT ${limit}
  `;
  // Coerce BigInt/Decimal to Number
  return rows.map((r: any) => ({
    ...r,
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyWaste: Number(r.qtyWaste),
    qtyLossSurplus: Number(r.qtyLossSurplus),
    pctLossSurplusToBom: r.pctLossSurplusToBom != null ? Number(r.pctLossSurplusToBom) : null,
    qtyBom: Number(r.qtyBom),
    avgDeviasiByBom: r.avgDeviasiByBom != null ? Number(r.avgDeviasiByBom) : null,
    nominalDeviasi: Number(r.nominalDeviasi),
    rankNominal: Number(r.rankNominal),
    rankBom: Number(r.rankBom),
  }));
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
//  Historical Category Average — avg QTY/Nominal across historical periods
//  Rev 2: For comparing Waste/Susut/Trial/LossSurplus with historical.
//  Returns a Map keyed by "itemName|outletCode" → { avgQty, avgNominal }
// ============================================================
export async function queryHistoricalCategoryAvg(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
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

  const rows = await db.$queryRaw<{ itemName: string; outletCode: string; avgQty: number; avgNominal: number }[]>`
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
  `;
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
