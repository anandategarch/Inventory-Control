// ============================================================
//  Item-level queries — top-N items by various metrics
//  and item consistency (outlet coverage) analysis.
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
      CASE WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
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
  // OPTIMIZE-ENGINE: replaced 2 correlated subqueries (EXISTS + AVG, each
  // per-row) with a single CTE + LEFT JOIN. The CTE computes per-(item,outlet)
  // bucket averages in ONE pass; the main SELECT just reads them via JOIN.
  // Old query ran ~500 sub-executions per call; new query is 1 hash-join.
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
        -- FIX CALC-11: use SUM(ABS(qtyBom)) > 0 (not SUM(qtyBom) != 0 — can be 0 with canceling +/- values)
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ir."qtyLossSurplus") / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "pctLossSurplusToBom",
        SUM(ir."qtyBom") as "qtyBom",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        -- Store ABS qtyDeviasi for dynamic bucket average
        ABS(SUM(ir."qtyDeviasi")) as "absQtyDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY i.name, o.code, o.name, pic.pic
    ),
    -- Pre-compute dynamic-bucket average per (item, outlet).
    -- Self-join: for each row, average ABS(qtyDeviasi) of OTHER outlets with
    -- same itemName AND qtyBom within ±50% range. COUNT tracks how many OTHER
    -- outlets are in the bucket — if 0, avgDeviasiByBom is NULL.
    -- FIX CALC-7: Exclude BOM=0 items from bucket — the ±50% range becomes
    -- degenerate (BETWEEN 0 AND 0) and the "Dev By BOM" concept doesn't apply.
    bucket_avg AS (
      SELECT
        ipo."itemName",
        ipo."outletCode",
        AVG(CASE WHEN ipo2."outletCode" != ipo."outletCode"
                 THEN ipo2."absQtyDeviasi" END) as "avgDeviasiByBom",
        SUM(CASE WHEN ipo2."outletCode" != ipo."outletCode"
                 THEN 1 ELSE 0 END) as "otherCount"
      FROM item_per_outlet ipo
      JOIN item_per_outlet ipo2
        ON ipo2."itemName" = ipo."itemName"
        AND ABS(ipo."qtyBom") > 0  -- FIX CALC-7: skip BOM=0 items
        AND ABS(ipo2."qtyBom") > 0
        AND ABS(ipo2."qtyBom") BETWEEN ABS(ipo."qtyBom") * 0.5 AND ABS(ipo."qtyBom") * 1.5
      GROUP BY ipo."itemName", ipo."outletCode"
    )
    SELECT
      ipo."itemName", ipo."outletCode", ipo."outletName", ipo.pic, ipo."satuan",
      ipo."qtyDeviasi", ipo."qtyWaste", ipo."qtyLossSurplus", ipo."pctLossSurplusToBom",
      ipo."qtyBom", ipo."nominalDeviasi",
      -- avgDeviasiByBom: only if at least 1 OTHER resto exists in the bucket
      -- FIX CALC-7: BOM=0 items get NULL (bucket concept doesn't apply)
      CASE WHEN ipo."qtyBom" != 0 AND ba."otherCount" > 0 THEN ba."avgDeviasiByBom" ELSE NULL END as "avgDeviasiByBom",
      ROW_NUMBER() OVER (ORDER BY ABS(ipo."nominalDeviasi") DESC) as "rankNominal",
      -- FIX CALC-6: BOM=0 items get NULL rankBom (not ranked last — concept doesn't apply)
      CASE WHEN ipo."qtyBom" != 0
        THEN ROW_NUMBER() OVER (PARTITION BY CASE WHEN ipo."qtyBom" != 0 THEN 1 ELSE 0 END ORDER BY ABS(ipo."qtyBom") DESC)
        ELSE NULL END as "rankBom"
    FROM item_per_outlet ipo
    LEFT JOIN bucket_avg ba
      ON ipo."itemName" = ba."itemName"
     AND ipo."outletCode" = ba."outletCode"
    ORDER BY "rankNominal"
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
      CASE WHEN SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
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
        -- FIX CALC-3: use nominalLossSurplus < 0 (LOSS) instead of stored ir.direction (which may be inverted)
        CAST(COUNT(DISTINCT CASE WHEN ir."nominalLossSurplus" < 0 THEN ir."outletId" END) AS INTEGER) as "lossOutlets",
        CAST(COUNT(DISTINCT CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."outletId" END) AS INTEGER) as "surplusOutlets",
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
