// ============================================================
//  Top Items queries — by nominal, devBom, deviasiRank, category,
//  historicalCategoryAvg, itemConsistency, deviasiRankForOutlet.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, DIRECTION_FROM_SUM_SQL, withStatementTimeout, type SqlFilterOpts } from '../shared';

export interface TopItemRow {
  itemName: string;
  outletCode: string;
  absNominal: number;
  direction: string;
}

export async function queryTopItemsByNominal(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; absNominal: number; nominalDeviasi: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  // Rev 3: Sort by ABS(nominalDeviasi), but return signed nominalDeviasi for display.
  // Previous version sorted/displayed absNominalLossSurplus (NET) — user wants nominalDeviasi (GROSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; absNominal: number; nominalDeviasi: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      ABS(SUM(ir."nominalDeviasi")) as "absNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      -- FIX VERIFY3-8: direction derived from SUM(nominalLossSurplus) with qtyDeviasi NULL fallback
      -- FIX (RESTORE-SHARED-1): use shared DIRECTION_FROM_SUM_SQL fragment from ../shared
      ${DIRECTION_FROM_SUM_SQL} as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY "absNominal" DESC
    LIMIT ${limit}
  `);
  return rows;
}

export async function queryTopItemsByDevBom(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; devBom: number; devBomAbs: number; tolerance: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 4: Sort by ABS(devBom), but return signed devBom for display.
  // Signed devBom = SUM(qtyDeviasi) / SUM(ABS(qtyBom)) — can be negative (SURPLUS) or positive (LOSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; devBom: number; devBomAbs: number; tolerance: number | null }[]>`
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
  `);
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
  filters: SqlFilterOpts,
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
  filters: SqlFilterOpts,
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

  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; qty: number; nominal: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      SUM(ABS(${qtyRef})) as qty,
      SUM(ABS(${nomRef})) as nominal,
      -- FIX VERIFY3-8: direction derived from SUM(nominalLossSurplus) with qtyDeviasi NULL fallback
      -- FIX (RESTORE-SHARED-1): use shared DIRECTION_FROM_SUM_SQL fragment from ../shared
      ${DIRECTION_FROM_SUM_SQL} as direction
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ${qtyRef} IS NOT NULL AND ${qtyRef} != 0
      ${f}
    GROUP BY i.name, o.code
    ORDER BY qty DESC
    LIMIT ${limit}
  `);
  return rows;
}

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
//  Item Consistency — GROUP BY itemName with outlet count (Phase 4)
//  SYSTEMIC: >=10 outlets, WIDESPREAD: 5-9, ISOLATED: 2-4
// ============================================================
export async function queryItemConsistency(
  week: string,
  month: string,
  filters: SqlFilterOpts
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
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{
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
  `);
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

// ============================================================
//  Pareto 80/20 untuk Item dengan |Dev/BOM| > 50%
//  Group by item, drill-down ke outlet. Konsep seperti Nested Pareto.
// ============================================================

export interface ParetoDevBomOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  devBom: number;
  devBomAbs: number;
  nominalDeviasi: number;
  absNominal: number;
  sharePct: number;
  cumPct: number;
}

export interface ParetoDevBomRow {
  itemName: string;
  outletCount: number;
  devBom: number;
  devBomAbs: number;
  nominalDeviasi: number;
  absNominal: number;
  sharePct: number;
  cumPct: number;
  outlets: ParetoDevBomOutletRow[];
}

export interface ParetoDevBomResult {
  drivers: ParetoDevBomRow[];
  remainderCount: number;
  remainderPct: number;
  totalAbsNominal: number;
  totalCount: number;
  thresholdPct: number;
}

export async function queryParetoByDevBom(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  maxDrivers: number = 20,
  threshold: number = 0.50,
): Promise<ParetoDevBomResult> {
  const f = buildSqlFilters(filters);

  const topItems = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string; outletCount: number; devBom: number; devBomAbs: number;
    nominalDeviasi: number; absNominal: number;
  }>>`
    WITH abnormal_item_outlets AS (
      SELECT i.name as "itemName", ir."outletId",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        ABS(SUM(ir."nominalDeviasi")) as "absNominal",
        SUM(ir."qtyDeviasi") as "totalQtyDeviasi",
        SUM(ABS(ir."qtyBom")) as "totalQtyBom",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBomAbs"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ir."qtyBom" IS NOT NULL AND ir."qtyBom" != 0
        ${f}
      GROUP BY i.name, ir."outletId"
      HAVING CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END > ${threshold}
    )
    SELECT "itemName",
      CAST(COUNT(DISTINCT "outletId") AS INTEGER) as "outletCount",
      CASE WHEN SUM("totalQtyBom") > 0
        THEN SUM("totalQtyDeviasi") / SUM("totalQtyBom") ELSE 0 END as "devBom",
      CASE WHEN SUM("totalQtyBom") > 0
        THEN SUM(ABS("totalQtyDeviasi")) / SUM("totalQtyBom") ELSE 0 END as "devBomAbs",
      SUM("nominalDeviasi") as "nominalDeviasi",
      ABS(SUM("nominalDeviasi")) as "absNominal"
    FROM abnormal_item_outlets
    GROUP BY "itemName"
    ORDER BY "absNominal" DESC
    LIMIT ${maxDrivers}
  `);

  if (topItems.length === 0) {
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: 0, thresholdPct: threshold };
  }

  const grandTotal = topItems.reduce((s, r: any) => s + Number(r.absNominal), 0);
  let cumPct = 0;

  const outletRowsByItem = await Promise.all(topItems.map((item: any) => {
    const itemName = item.itemName;
    return withStatementTimeout((tx) => tx.$queryRaw<Array<{
      outletCode: string; outletName: string; area: string;
      devBom: number; devBomAbs: number; nominalDeviasi: number; absNominal: number;
    }>>`
      SELECT o.code as "outletCode", o.name as "outletName", o.area,
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBomAbs",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        ABS(SUM(ir."nominalDeviasi")) as "absNominal"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ir."qtyBom" IS NOT NULL AND ir."qtyBom" != 0
        AND i.name = ${itemName}
        ${f}
      GROUP BY o.code, o.name, o.area
      HAVING CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END > ${threshold}
      ORDER BY "absNominal" DESC
      LIMIT 20
    `);
  }));

  const drivers: ParetoDevBomRow[] = topItems.map((item: any, idx: number) => {
    const itemName = item.itemName;
    const itemAbsNominal = Number(item.absNominal);
    const sharePct = grandTotal > 0 ? (itemAbsNominal / grandTotal) * 100 : 0;
    cumPct += sharePct;

    const outletRows = outletRowsByItem[idx];
    const outletTotal = outletRows.reduce((s, r: any) => s + Number(r.absNominal), 0);
    let outletCum = 0;
    const outlets: ParetoDevBomOutletRow[] = outletRows.map((r: any) => {
      const oShare = outletTotal > 0 ? (Number(r.absNominal) / outletTotal) * 100 : 0;
      outletCum += oShare;
      return {
        outletCode: r.outletCode,
        outletName: r.outletName,
        area: r.area,
        devBom: Number(r.devBom) || 0,
        devBomAbs: Number(r.devBomAbs) || 0,
        nominalDeviasi: Number(r.nominalDeviasi) || 0,
        absNominal: Number(r.absNominal) || 0,
        sharePct: Number(oShare.toFixed(1)),
        cumPct: Number(outletCum.toFixed(1)),
      };
    });

    return {
      itemName,
      outletCount: Number(item.outletCount),
      devBom: Number(item.devBom) || 0,
      devBomAbs: Number(item.devBomAbs) || 0,
      nominalDeviasi: Number(item.nominalDeviasi) || 0,
      absNominal: itemAbsNominal,
      sharePct: Number(sharePct.toFixed(1)),
      cumPct: Number(cumPct.toFixed(1)),
      outlets,
    };
  });

  return {
    drivers,
    remainderCount: 0,
    remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)),
    totalAbsNominal: grandTotal,
    totalCount: topItems.length,
    thresholdPct: threshold,
  };
}
