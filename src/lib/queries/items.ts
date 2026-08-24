// ============================================================
//  Item-level queries — top-N items by various metrics
//  and item consistency (outlet coverage) analysis.
//  All aggregation done in SQL (PostgreSQL + SQLite portable).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout } from './shared';

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
      -- FIX VERIFY3-8: add qtyDeviasi NULL fallback for direction computation
      CASE WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
           WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
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
      -- FIX FUNC-3: use MIN for LOSS (strictest tolerance), MAX for SURPLUS (was: MAX always)
      CASE
        WHEN SUM(ir."nominalLossSurplus") < 0 THEN MIN(ir."tolerancePct")
        ELSE MAX(ir."tolerancePct")
      END as "tolerance"
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
  //
  // FIX M-J (AUDIT-3): bucket_avg CTE was self-joining item_per_outlet × item_per_outlet
  // (ALL ~36K pairs) but only top-50 were returned. Refactored to compute bucket_avg
  // only for the top-50 (ranked CTE + top_items filter). Reduces self-join from
  // N×N to 50×N — ~720× less work for the bucket_avg step.
  //
  // FIX H4 (AUDIT-7): wrap in withStatementTimeout to enforce 30s query timeout
  // (PgBouncer tx mode strips the URL-level statement_timeout param).
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<any[]>`
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
        -- FIX Bug 3A: use ABS(qtyLossSurplus) so percentage is always positive (signed display handled by direction)
        -- FIX CALC-11: use SUM(ABS(qtyBom)) > 0 (not SUM(qtyBom) != 0 — can be 0 with canceling +/- values)
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN ABS(SUM(ir."qtyLossSurplus")) / SUM(ABS(ir."qtyBom"))
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
    -- Add rank to each row (rankNominal = by ABS(nominalDeviasi) DESC)
    ranked AS (
      SELECT ipo.*,
        ROW_NUMBER() OVER (ORDER BY ABS(ipo."nominalDeviasi") DESC) as "rankNominal",
        CASE WHEN ipo."qtyBom" != 0
          THEN ROW_NUMBER() OVER (PARTITION BY CASE WHEN ipo."qtyBom" != 0 THEN 1 ELSE 0 END ORDER BY ABS(ipo."qtyBom") DESC)
          ELSE NULL END as "rankBom"
      FROM item_per_outlet ipo
    ),
    -- FIX M-J: only compute bucket_avg for top-N items (not all 36K pairs)
    top_items AS (
      SELECT * FROM ranked WHERE "rankNominal" <= ${limit}
    ),
    -- Bucket average: for each top-N item, average ABS(qtyDeviasi) of OTHER outlets
    -- with same itemName AND qtyBom within ±50% range. Self-join is now top_items ×
    -- item_per_outlet (50 × N) instead of N × N.
    bucket_avg AS (
      SELECT
        ti."itemName",
        ti."outletCode",
        AVG(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN ipo2."absQtyDeviasi" END) as "avgDeviasiByBom",
        SUM(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN 1 ELSE 0 END) as "otherCount"
      FROM top_items ti
      JOIN item_per_outlet ipo2
        ON ipo2."itemName" = ti."itemName"
        AND ABS(ti."qtyBom") > 0  -- FIX CALC-7: skip BOM=0 items
        AND ABS(ipo2."qtyBom") > 0
        AND ABS(ipo2."qtyBom") BETWEEN ABS(ti."qtyBom") * 0.5 AND ABS(ti."qtyBom") * 1.5
      GROUP BY ti."itemName", ti."outletCode"
    )
    SELECT
      ti."itemName", ti."outletCode", ti."outletName", ti.pic, ti."satuan",
      ti."qtyDeviasi", ti."qtyWaste", ti."qtyLossSurplus", ti."pctLossSurplusToBom",
      ti."qtyBom", ti."nominalDeviasi",
      -- avgDeviasiByBom: only if at least 1 OTHER resto exists in the bucket
      -- FIX CALC-7: BOM=0 items get NULL (bucket concept doesn't apply)
      CASE WHEN ti."qtyBom" != 0 AND ba."otherCount" > 0 THEN ba."avgDeviasiByBom" ELSE NULL END as "avgDeviasiByBom",
      ti."rankNominal",
      ti."rankBom"
    FROM top_items ti
    LEFT JOIN bucket_avg ba
      ON ti."itemName" = ba."itemName"
     AND ti."outletCode" = ba."outletCode"
    ORDER BY ti."rankNominal"
  `);
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
//  Top Items by Deviasi Rank — PER OUTLET (top N for a specific outlet)
//  Returns the selected outlet's top-N items (by ABS(nominalDeviasi)),
//  enriched with:
//  - rankNominal: NATIONAL rank (across ALL outlets) — so the user sees
//    where this item ranks nationally, not just within the outlet
//  - rankBom: NATIONAL rank by ABS(qtyBom)
//  - avgDeviasiByBom: peer benchmark (other outlets with same item + BOM ±50%)
//  - All signed qty/nominal fields for display
//
//  Used by RankingNasionalCard when a resto is selected for analysis.
//  Differs from queryTopItemsByDeviasiRank (national top-50 across all
//  outlets) — this returns the selected outlet's top-N items, with
//  national rank + peer benchmark attached.
// ============================================================
export async function queryTopItemsByDeviasiRankForOutlet(
  week: string,
  month: string,
  outletCode: string,
  limit: number = 30
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
  // Compute per-(item,outlet) aggregates for ALL outlets (needed for national
  // rank + peer benchmark), then filter to the target outlet's top-N.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<any[]>`
    WITH all_item_per_outlet AS (
      SELECT
        i.name as "itemName",
        o.code as "outletCode",
        o.name as "outletName",
        pic.pic,
        MAX(ir."satuan") as "satuan",
        SUM(ir."qtyDeviasi") as "qtyDeviasi",
        SUM(ir."qtyWaste") as "qtyWaste",
        SUM(ir."qtyLossSurplus") as "qtyLossSurplus",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN ABS(SUM(ir."qtyLossSurplus")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "pctLossSurplusToBom",
        SUM(ir."qtyBom") as "qtyBom",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        ABS(SUM(ir."qtyDeviasi")) as "absQtyDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      GROUP BY i.name, o.code, o.name, pic.pic
    ),
    -- National rank across ALL outlets
    ranked_all AS (
      SELECT ipo.*,
        ROW_NUMBER() OVER (ORDER BY ABS(ipo."nominalDeviasi") DESC) as "rankNominal",
        CASE WHEN ipo."qtyBom" != 0
          THEN ROW_NUMBER() OVER (PARTITION BY CASE WHEN ipo."qtyBom" != 0 THEN 1 ELSE 0 END ORDER BY ABS(ipo."qtyBom") DESC)
          ELSE NULL END as "rankBom"
      FROM all_item_per_outlet ipo
    ),
    -- Target outlet's top-N items (ranked within outlet by ABS(nominalDeviasi))
    outlet_top AS (
      SELECT * FROM (
        SELECT ra.*,
          ROW_NUMBER() OVER (PARTITION BY ra."outletCode" ORDER BY ABS(ra."nominalDeviasi") DESC) as "outletRank"
        FROM ranked_all ra
        WHERE ra."outletCode" = ${outletCode}
      ) t WHERE "outletRank" <= ${limit}
    ),
    -- Peer benchmark: for each outlet_top item, average ABS(qtyDeviasi) of OTHER
    -- outlets with same itemName AND qtyBom within ±50% range.
    bucket_avg AS (
      SELECT
        ti."itemName",
        ti."outletCode",
        AVG(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN ipo2."absQtyDeviasi" END) as "avgDeviasiByBom",
        SUM(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN 1 ELSE 0 END) as "otherCount"
      FROM outlet_top ti
      JOIN all_item_per_outlet ipo2
        ON ipo2."itemName" = ti."itemName"
        AND ABS(ti."qtyBom") > 0
        AND ABS(ipo2."qtyBom") > 0
        AND ABS(ipo2."qtyBom") BETWEEN ABS(ti."qtyBom") * 0.5 AND ABS(ti."qtyBom") * 1.5
      GROUP BY ti."itemName", ti."outletCode"
    )
    SELECT
      ti."itemName", ti."outletCode", ti."outletName", ti.pic, ti."satuan",
      ti."qtyDeviasi", ti."qtyWaste", ti."qtyLossSurplus", ti."pctLossSurplusToBom",
      ti."qtyBom", ti."nominalDeviasi",
      CASE WHEN ti."qtyBom" != 0 AND ba."otherCount" > 0 THEN ba."avgDeviasiByBom" ELSE NULL END as "avgDeviasiByBom",
      ti."rankNominal",
      ti."rankBom"
    FROM outlet_top ti
    LEFT JOIN bucket_avg ba
      ON ti."itemName" = ba."itemName"
     AND ti."outletCode" = ba."outletCode"
    ORDER BY ti."outletRank"
  `);
  // Coerce BigInt/Decimal to Number (matches queryTopItemsByDeviasiRank coercion)
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
      -- FIX VERIFY3-8: add qtyDeviasi NULL fallback for direction computation
      CASE WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
           WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
           WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
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

// ============================================================
//  Network Item Risk — per-item scoring across ALL outlets
//  --------------------------------------------------------
//  Instead of per-(item × outlet) ranking, this scores each ITEM
//  across the entire network to surface SYSTEMIC issues:
//    - How many outlets have this item with deviation?
//    - What's the total financial impact (SUM |nominalDeviasi|)?
//    - What's the avg / max deviation ratio (Dev/BOM)?
//    - Is this systemic (many outlets) or isolated (few outlets)?
//
//  Scoring (computed in JS — keeps SQL portable + testable):
//    systemicScore     = min(100, (deviatingOutlets / totalOutlets) * 200)
//    financialImpact   = min(100, totalAbsNominal / 100_000_000 * 100)
//    riskScore         = round(systemic*0.4 + financial*0.4 + avgDevBom*100*0.2)
//    riskLevel         = >=55 TINGGI | >=30 SEDANG | else RENDAH
//
//  `deviationThreshold` = STD_DEVIASI_BOM_PCT (passed from runtime thresholds)
//  so an outlet is counted as "deviating" when its abs(Dev/BOM) > threshold.
// ============================================================
export interface NetworkItemRiskOutlet {
  outletCode: string;
  outletName: string;
  nominalDeviasi: number;
  devBom: number;
}

export interface NetworkItemRisk {
  itemName: string;
  satuan: string;
  outletCount: number;          // how many outlets have this item
  deviatingOutlets: number;     // how many have deviation > threshold
  totalAbsNominal: number;      // SUM of |nominalDeviasi| across all outlets
  avgDevBom: number;            // avg deviation ratio
  maxDevBom: number;            // max deviation ratio (worst outlet)
  systemicScore: number;        // 0-100 (higher = more systemic)
  financialImpact: number;      // 0-100 (higher = more financial impact)
  riskScore: number;            // 0-100 (weighted combination)
  riskLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  topDeviatingOutlets: NetworkItemRiskOutlet[];
}

// Raw row shape returned by SQL (before JS risk-score computation).
// `topDeviatingOutlets` comes back as a JSON string from PostgreSQL json_agg.
interface NetworkItemRiskRawRow {
  itemName: string;
  satuan: string | null;
  outletCount: number;
  deviatingOutlets: number;
  totalAbsNominal: number;
  avgDevBom: number;
  maxDevBom: number;
  totalOutlets: number;
  topDeviatingOutlets: string | NetworkItemRiskOutlet[] | null;
}

export async function queryNetworkItemRisk(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10,
  deviationThreshold: number = 0.05,
): Promise<NetworkItemRisk[]> {
  const f = buildSqlFilters(filters);
  // Single query strategy:
  //   CTE 1 (item_per_outlet): per (item, outlet) — sum absNominalDeviasi,
  //     compute signed + abs Dev/BOM. Filters to rows with deviation > 0
  //     so outletCount only counts outlets that actually have this item with
  //     a non-zero deviation.
  //   CTE 2 (total_outlets): count DISTINCT outlets in the (filtered) period
  //     so systemicScore has the right denominator.
  //   CTE 3 (top_outlets): per item, top 3 outlets by ABS(nominalDeviasi)
  //     via ROW_NUMBER window — collected into JSON via json_agg.
  //   Final: GROUP BY item — aggregate across outlets, LEFT JOIN top_outlets
  //     JSON. Risk scores computed in JS (Math.min/round keeps SQL portable
  //     across PostgreSQL + SQLite).
  const rows = await db.$queryRaw<NetworkItemRiskRawRow[]>`
    WITH item_per_outlet AS (
      SELECT i.id as "itemId", i.name as "itemName", MAX(ir."satuan") as "satuan",
        ir."outletId",
        SUM(ir."absNominalDeviasi") as "nominalDeviasi",
        -- FIX CALC-11: use SUM(ABS(qtyBom)) > 0 (consistent with other queries)
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "absDevBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY i.id, i.name, ir."outletId"
    ),
    item_outlet_full AS (
      SELECT ipo.*, o.code as "outletCode", o.name as "outletName"
      FROM item_per_outlet ipo
      JOIN "Outlet" o ON ipo."outletId" = o.id
    ),
    total_outlets AS (
      SELECT CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "totalOutlets"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
    ),
    top_outlets AS (
      SELECT "itemId",
        json_agg(json_build_object(
          'outletCode', "outletCode",
          'outletName', "outletName",
          'nominalDeviasi', "nominalDeviasi",
          'devBom', "devBom"
        ) ORDER BY ABS("nominalDeviasi") DESC) as "topDeviatingOutlets"
      FROM (
        SELECT "itemId", "outletCode", "outletName", "nominalDeviasi", "devBom",
          ROW_NUMBER() OVER (
            PARTITION BY "itemId"
            ORDER BY ABS("nominalDeviasi") DESC
          ) as rn
        FROM item_outlet_full
      ) ranked
      WHERE rn <= 3
      GROUP BY "itemId"
    ),
    item_aggs AS (
      SELECT "itemId", "itemName", MAX("satuan") as "satuan",
        CAST(COUNT(DISTINCT "outletId") AS INTEGER) as "outletCount",
        CAST(COUNT(DISTINCT CASE WHEN "absDevBom" > ${deviationThreshold} THEN "outletId" END) AS INTEGER) as "deviatingOutlets",
        COALESCE(SUM(ABS("nominalDeviasi")), 0) as "totalAbsNominal",
        AVG("absDevBom") as "avgDevBom",
        MAX("absDevBom") as "maxDevBom"
      FROM item_outlet_full
      GROUP BY "itemId", "itemName"
    )
    SELECT ia."itemName", ia."satuan",
      ia."outletCount", ia."deviatingOutlets",
      ia."totalAbsNominal",
      COALESCE(ia."avgDevBom", 0) as "avgDevBom",
      COALESCE(ia."maxDevBom", 0) as "maxDevBom",
      COALESCE((SELECT "totalOutlets" FROM total_outlets), 0) as "totalOutlets",
      COALESCE(to2."topDeviatingOutlets", '[]'::json) as "topDeviatingOutlets"
    FROM item_aggs ia
    LEFT JOIN top_outlets to2 ON ia."itemId" = to2."itemId"
    ORDER BY ia."totalAbsNominal" DESC
  `;

  // Compute risk scores in JS — keeps SQL portable + testable.
  const FINANCIAL_IMPACT_DENOMINATOR = 100_000_000; // Rp 100jt = score 100

  const results: NetworkItemRisk[] = rows.map((r) => {
    const outletCount = Number(r.outletCount) || 0;
    const deviatingOutlets = Number(r.deviatingOutlets) || 0;
    const totalOutlets = Number(r.totalOutlets) || 0;
    const totalAbsNominal = Number(r.totalAbsNominal) || 0;
    const avgDevBom = Number(r.avgDevBom) || 0;
    const maxDevBom = Number(r.maxDevBom) || 0;

    // systemicScore: 100 if >50% of outlets deviate, else proportional.
    // Formula: min(100, deviatingOutlets / totalOutlets * 200)
    const systemicScore = totalOutlets > 0
      ? Math.min(100, (deviatingOutlets / totalOutlets) * 200)
      : 0;

    // financialImpact: 100 if totalAbsNominal >= Rp 100jt, else proportional.
    const financialImpact = Math.min(100, (totalAbsNominal / FINANCIAL_IMPACT_DENOMINATOR) * 100);

    // riskScore: weighted combination (40% systemic + 40% financial + 20% avgDevBom×100)
    const riskScore = Math.round(
      systemicScore * 0.4 + financialImpact * 0.4 + Math.min(100, avgDevBom * 100) * 0.2
    );

    // riskLevel thresholds
    const riskLevel: NetworkItemRisk['riskLevel'] =
      riskScore >= 55 ? 'TINGGI'
      : riskScore >= 30 ? 'SEDANG'
      : 'RENDAH';

    // Parse topDeviatingOutlets — PostgreSQL returns json as string, SQLite may return object.
    let parsedOutlets: NetworkItemRiskOutlet[] = [];
    if (r.topDeviatingOutlets) {
      if (typeof r.topDeviatingOutlets === 'string') {
        try {
          parsedOutlets = JSON.parse(r.topDeviatingOutlets);
        } catch {
          parsedOutlets = [];
        }
      } else if (Array.isArray(r.topDeviatingOutlets)) {
        parsedOutlets = r.topDeviatingOutlets as NetworkItemRiskOutlet[];
      }
    }
    // Coerce numeric fields (BigInt/Decimal safety)
    parsedOutlets = parsedOutlets.map((o) => ({
      outletCode: String(o.outletCode ?? ''),
      outletName: String(o.outletName ?? ''),
      nominalDeviasi: Number(o.nominalDeviasi ?? 0),
      devBom: Number(o.devBom ?? 0),
    }));

    return {
      itemName: String(r.itemName ?? ''),
      satuan: r.satuan ? String(r.satuan) : '',
      outletCount,
      deviatingOutlets,
      totalAbsNominal,
      avgDevBom,
      maxDevBom,
      systemicScore: Math.round(systemicScore),
      financialImpact: Math.round(financialImpact),
      riskScore,
      riskLevel,
      topDeviatingOutlets: parsedOutlets,
    };
  });

  // Sort by riskScore DESC (then by totalAbsNominal DESC for tie-break) and slice top N
  results.sort((a, b) =>
    b.riskScore - a.riskScore || b.totalAbsNominal - a.totalAbsNominal
  );
  return results.slice(0, limit);
}

// ============================================================
//  Global Item Search — cross-outlet view for a single item
//  --------------------------------------------------------
//  When user searches "CABAI" and selects an item, this query
//  returns that item's deviation across ALL outlets (not just
//  the selected one). Surfaces systemic patterns: which outlets
//  have the worst deviation for this specific item.
//
//  Returns per-(item, outlet) rows with:
//    - outlet code/name/area/pic
//    - signed qtyDeviasi, qtyBom, nominalDeviasi (for display)
//    - abs(qtyDeviasi) for sorting
//    - devBom ratio (signed)
//    - direction (LOSS/SURPLUS/NEUTRAL)
//
//  Note: `itemNameFilter` is the EXACT item name (already resolved
//  by the caller via /api/item-search?q=...). We filter by exact
//  match on i.name (case-insensitive via LOWER) to avoid partial
//  matches crossing items (e.g. "CABAI" matching "CABAI FROZEN"
//  AND "CABAI MERAH" — caller should pick one).
// ============================================================
export interface GlobalItemSearchRow {
  itemName: string;
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  satuan: string | null;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
  absNominalDeviasi: number;
  devBom: number | null;
  direction: string;
}

export async function queryGlobalItemSearch(
  week: string,
  month: string,
  itemNameFilter: string,
  filters: {
    area?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 100
): Promise<GlobalItemSearchRow[]> {
  // Filter by exact item name (case-insensitive). Outlet filter is intentionally
  // NOT applied — this is a CROSS-OUTLET view (user wants to see the item in
  // ALL outlets). Area + PIC filters are still respected (narrow the outlet scope).
  const f = buildSqlFilters({
    area: filters.area,
    outletCode: null, // cross-outlet: no outlet filter
    itemName: null,   // itemName handled by exact match below
    picOutletCodes: filters.picOutletCodes,
  });
  const rows = await db.$queryRaw<Array<GlobalItemSearchRow>>`
    SELECT
      i.name as "itemName",
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      pic.pic,
      MAX(ir."satuan") as "satuan",
      COALESCE(SUM(ir."qtyBom"), 0) as "qtyBom",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasi",
      COALESCE(SUM(ir."qtyWaste"), 0) as "qtyWaste",
      COALESCE(SUM(ir."qtySusut"), 0) as "qtySusut",
      COALESCE(SUM(ir."qtyTrial"), 0) as "qtyTrial",
      COALESCE(SUM(ir."qtyLossSurplus"), 0) as "qtyLossSurplus",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      COALESCE(SUM(ir."nominalLossSurplus"), 0) as "nominalLossSurplus",
      COALESCE(SUM(ir."absNominalDeviasi"), 0) as "absNominalDeviasi",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE NULL END as "devBom",
      CASE
        WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
        WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
        WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
        WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
        ELSE 'NEUTRAL'
      END as "direction"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND LOWER(i.name) = LOWER(${itemNameFilter})
      ${f}
    GROUP BY i.name, o.code, o.name, o.area, pic.pic
    ORDER BY "absNominalDeviasi" DESC
    LIMIT ${limit}
  `;
  // Coerce BigInt/Decimal to Number (PostgreSQL SUM returns bigint for integer columns)
  return rows.map((r: any) => ({
    ...r,
    qtyBom: Number(r.qtyBom),
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyWaste: Number(r.qtyWaste),
    qtySusut: Number(r.qtySusut),
    qtyTrial: Number(r.qtyTrial),
    qtyLossSurplus: Number(r.qtyLossSurplus),
    nominalDeviasi: Number(r.nominalDeviasi),
    nominalLossSurplus: Number(r.nominalLossSurplus),
    absNominalDeviasi: Number(r.absNominalDeviasi),
    devBom: r.devBom != null ? Number(r.devBom) : null,
  }));
}

// ============================================================
//  Item Autocomplete — for the global search bar (Cmd+K)
//  Returns up to `limit` item names matching `q` (case-insensitive).
//  Ranked by total absNominalDeviasi DESC so high-impact items
//  surface first.
// ============================================================
export async function queryItemAutocomplete(
  week: string,
  month: string,
  q: string,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCount: number; totalAbsNominal: number }>> {
  const rows = await db.$queryRaw<Array<{ itemName: string; outletCount: number; totalAbsNominal: number | bigint }>>`
    SELECT
      i.name as "itemName",
      CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "outletCount",
      COALESCE(SUM(ir."absNominalDeviasi"), 0) as "totalAbsNominal"
    FROM "Item" i
    JOIN "InventoryRecord" ir ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      AND LOWER(i.name) LIKE LOWER(${'%' + q + '%'})
    GROUP BY i.name
    ORDER BY "totalAbsNominal" DESC
    LIMIT ${limit}
  `;
  return rows.map((r: any) => ({
    itemName: r.itemName,
    outletCount: Number(r.outletCount),
    totalAbsNominal: Number(r.totalAbsNominal),
  }));
}

// ============================================================
//  Item Trend Analysis — per-(period, outlet) for 1 item across ALL periods
//  --------------------------------------------------------
//  Returns the item's deviation across ALL months × weeks in the DB,
//  grouped by outlet. Used for trend line chart in GlobalItemSearchModal.
//
//  Each row = 1 period × 1 outlet:
//    - monthLabel, weekLabel (for X-axis sorting)
//    - outletCode, outletName, area (for line identification)
//    - nominalDeviasi (signed, for Y-axis)
//    - devBom (signed, for alternative Y-axis)
//    - direction (LOSS/SURPLUS/NEUTRAL)
//
//  Sorted by period (chronological) then outlet.
//  Uses index @@index([monthLabel, weekLabel, outletId]) for fast scan.
// ============================================================
export interface ItemTrendRow {
  monthLabel: string;
  weekLabel: string;
  outletCode: string;
  outletName: string;
  area: string;
  nominalDeviasi: number;
  devBom: number | null;
  direction: string;
}

export async function queryItemTrend(
  itemNameFilter: string,
  filters: {
    area?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 500
): Promise<ItemTrendRow[]> {
  // No month/week filter — we want ALL periods. Only area + PIC filters apply.
  const f = buildSqlFilters({
    area: filters.area,
    outletCode: null,
    itemName: null, // handled by exact match below
    picOutletCodes: filters.picOutletCodes,
  });
  const rows = await db.$queryRaw<Array<ItemTrendRow>>`
    SELECT
      ir."monthLabel",
      ir."weekLabel",
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE NULL END as "devBom",
      CASE
        WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
        WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
        WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
        WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
        ELSE 'NEUTRAL'
      END as "direction"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE LOWER(i.name) = LOWER(${itemNameFilter})
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY ir."monthLabel", ir."weekLabel", o.code, o.name, o.area
    ORDER BY ir."monthLabel", ir."weekLabel", o.code
    LIMIT ${limit}
  `;
  return rows.map((r: any) => ({
    ...r,
    nominalDeviasi: Number(r.nominalDeviasi),
    devBom: r.devBom != null ? Number(r.devBom) : null,
  }));
}
