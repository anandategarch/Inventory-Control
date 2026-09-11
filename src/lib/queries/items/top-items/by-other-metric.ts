// ============================================================
//  Top Items — Other Metric Queries
//  --------------------------------------------------------
//  Six query functions covering all top-item aggregations EXCEPT
//  the deviasi-rank pair (which lives in ./by-deviasi-rank.ts
//  because it shares a CTE structure):
//
//    1. queryTopItemsByNominal     — top by ABS(nominalDeviasi)
//    2. queryTopItemsByDevBom      — top by ABS(qtyDeviasi / qtyBom)
//    3. queryTopItemsByCategory    — top by Waste/Susut/Trial/LossSurplus
//    4. queryHistoricalCategoryAvg — historical avg per (item,outlet)
//    5. queryItemConsistency       — per-item outlet-count + consistency tier
//    6. queryParetoByDevBom        — Pareto 80/20 for items with |Dev/BOM| > threshold
//
//  Source: split out of src/lib/queries/items/top-items.ts (722 LOC,
//  Task 1-d). All SQL + comments preserved verbatim — pure relocation.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, DIRECTION_FROM_SUM_SQL, withStatementTimeout, type SqlFilterOpts } from '../../shared';
import type { ParetoDevBomResult, ParetoDevBomRow, ParetoDevBomOutletRow } from './types';

export async function queryTopItemsByNominal(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10
): Promise<Array<{ itemName: string; outletCode: string; satuan: string | null; absNominal: number; nominalDeviasi: number; direction: string }>> {
  const f = buildSqlFilters(filters);
  // Rev 3: Sort by ABS(nominalDeviasi), but return signed nominalDeviasi for display.
  // Previous version sorted/displayed absNominalLossSurplus (NET) — user wants nominalDeviasi (GROSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; satuan: string | null; absNominal: number; nominalDeviasi: number; direction: string }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      MAX(ir."satuan") as "satuan",
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
): Promise<Array<{ itemName: string; outletCode: string; satuan: string | null; devBom: number; devBomAbs: number; tolerance: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 4: Sort by ABS(devBom), but return signed devBom for display.
  // Signed devBom = SUM(qtyDeviasi) / SUM(ABS(qtyBom)) — can be negative (SURPLUS) or positive (LOSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; satuan: string | null; devBom: number; devBomAbs: number; tolerance: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      MAX(ir."satuan") as "satuan",
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
//  PERF (PAKET B / F2 — scan merge): queryTopItemsByAllCategories
//  --------------------------------------------------------
//  The pipeline called queryTopItemsByCategory 4× (waste/susut/trial/
//  lossSurplus) — 4 scans + 4 transactions of the SAME period with the
//  same joins, differing only in the metric column. This function does
//  ONE scan and ranks per category server-side (ROW_NUMBER OVER the
//  category metric), returning only the union of the 4 top-N sets
//  (≤ 4×N rows, minus overlaps) — same pattern as the variance-analysis
//  and nested-Pareto fixes.
//
//  Semantics parity with the per-category original:
//    - qty/nominal per category use FILTER (WHERE qtyX IS NOT NULL AND
//      qtyX != 0) — identical to the original's row-level WHERE, and
//      SUM(ABS(qty)) > 0 exactly selects the groups the original's
//      WHERE produced.
//    - direction per category replicates DIRECTION_FROM_SUM_SQL's CASE
//      over the SAME filtered row set (SUM(nominalLossSurplus) FILTER,
//      SUM(qtyDeviasi) FILTER fallback) — see directionFromSums below.
//    - top-N per category = ROW_NUMBER() over the category qty DESC,
//      ties are nondeterministic in both variants.
//  The individual queryTopItemsByCategory is kept (tested; used by
//  other callers); the analysis pipeline + export-report now use this.
// ============================================================
export interface TopItemsCategoryRow {
  itemName: string;
  outletCode: string;
  /** H-2b: unit-of-measure for the item (denormalized on InventoryRecord; MAX per group — nullable, GROUP BY-safe). */
  satuan: string | null;
  qty: number;
  nominal: number;
  direction: string;
}
export type TopItemsAllCategories = Record<'waste' | 'susut' | 'trial' | 'lossSurplus', TopItemsCategoryRow[]>;

const CATEGORY_COLS: Record<'waste' | 'susut' | 'trial' | 'lossSurplus', { qty: string; nom: string; tag: string; rank: string }> = {
  waste: { qty: 'qtyWaste', nom: 'nominalWaste', tag: 'waste', rank: 'rw' },
  susut: { qty: 'qtySusut', nom: 'nominalSusut', tag: 'susut', rank: 'rs' },
  trial: { qty: 'qtyTrial', nom: 'nominalTrial', tag: 'trial', rank: 'rt' },
  lossSurplus: { qty: 'qtyLossSurplus', nom: 'nominalLossSurplus', tag: 'ls', rank: 'rl' },
};

/** JS twin of DIRECTION_FROM_SUM_SQL for per-category filtered sums. */
function directionFromSums(nls: number | null, qd: number | null): string {
  if (nls !== null && nls !== undefined) {
    if (nls < 0) return 'LOSS';
    if (nls > 0) return 'SURPLUS';
    return 'NEUTRAL';
  }
  if (qd !== null && qd !== undefined) {
    if (qd < 0) return 'LOSS';
    if (qd > 0) return 'SURPLUS';
  }
  return 'NEUTRAL';
}

interface WideCategoryRow {
  itemName: string;
  outletCode: string;
  satuan: string | null;
  wasteQty: number; wasteNominal: number; wasteNls: number | null; wasteQd: number | null; rw: number;
  susutQty: number; susutNominal: number; susutNls: number | null; susutQd: number | null; rs: number;
  trialQty: number; trialNominal: number; trialNls: number | null; trialQd: number | null; rt: number;
  lsQty: number; lsNominal: number; lsNls: number | null; lsQd: number | null; rl: number;
}

export async function queryTopItemsByAllCategories(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 10,
): Promise<TopItemsAllCategories> {
  const f = buildSqlFilters(filters);

  const catFrag = (cat: 'waste' | 'susut' | 'trial' | 'lossSurplus') => {
    const c = CATEGORY_COLS[cat];
    const qtyRef = Prisma.raw(`ir."${c.qty}"`);
    const nomRef = Prisma.raw(`ir."${c.nom}"`);
    const cond = Prisma.sql`${qtyRef} IS NOT NULL AND ${qtyRef} != 0`;
    return {
      select: Prisma.sql`
        COALESCE(SUM(ABS(${qtyRef})) FILTER (WHERE ${cond}), 0) as "${Prisma.raw(c.tag)}Qty",
        COALESCE(SUM(ABS(${nomRef})) FILTER (WHERE ${cond}), 0) as "${Prisma.raw(c.tag)}Nominal",
        SUM(ir."nominalLossSurplus") FILTER (WHERE ${cond}) as "${Prisma.raw(c.tag)}Nls",
        SUM(ir."qtyDeviasi") FILTER (WHERE ${cond}) as "${Prisma.raw(c.tag)}Qd",
        ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(ABS(${qtyRef})) FILTER (WHERE ${cond}), 0) DESC) as "${Prisma.raw(c.rank)}"`,
    };
  };

  const waste = catFrag('waste');
  const susut = catFrag('susut');
  const trial = catFrag('trial');
  const ls = catFrag('lossSurplus');

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<WideCategoryRow[]>`
    SELECT "itemName", "outletCode", "satuan",
      "wasteQty", "wasteNominal", "wasteNls", "wasteQd", "rw",
      "susutQty", "susutNominal", "susutNls", "susutQd", "rs",
      "trialQty", "trialNominal", "trialNls", "trialQd", "rt",
      "lsQty", "lsNominal", "lsNls", "lsQd", "rl"
    FROM (
      SELECT i.name as "itemName", o.code as "outletCode",
        MAX(ir."satuan") as "satuan",
        ${waste.select},
        ${susut.select},
        ${trial.select},
        ${ls.select}
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
      GROUP BY i.name, o.code
    ) ranked
    WHERE ("rw" <= ${limit} AND "wasteQty" > 0)
       OR ("rs" <= ${limit} AND "susutQty" > 0)
       OR ("rt" <= ${limit} AND "trialQty" > 0)
       OR ("rl" <= ${limit} AND "lsQty" > 0)
  `);

  const byCat: TopItemsAllCategories = { waste: [], susut: [], trial: [], lossSurplus: [] };
  for (const cat of ['waste', 'susut', 'trial', 'lossSurplus'] as const) {
    const c = CATEGORY_COLS[cat];
    byCat[cat] = rows
      .filter((r) => (r[c.rank] as number) <= limit && (r[`${c.tag}Qty` as keyof WideCategoryRow] as number) > 0)
      .sort((a, b) => (b[`${c.tag}Qty` as keyof WideCategoryRow] as number) - (a[`${c.tag}Qty` as keyof WideCategoryRow] as number))
      .map((r) => ({
        itemName: r.itemName,
        outletCode: r.outletCode,
        satuan: r.satuan,
        qty: Number(r[`${c.tag}Qty` as keyof WideCategoryRow]) || 0,
        nominal: Number(r[`${c.tag}Nominal` as keyof WideCategoryRow]) || 0,
        direction: directionFromSums(
          r[`${c.tag}Nls` as keyof WideCategoryRow] as number | null,
          r[`${c.tag}Qd` as keyof WideCategoryRow] as number | null,
        ),
      }));
  }
  return byCat;
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

  const grandTotal = topItems.reduce((s, r) => s + Number(r.absNominal), 0);
  let cumPct = 0;

  // FIX (AUDIT-PERF-2): single query with ROW_NUMBER cap replaces 20 per-item
  // transactions (pool exhaustion). The old code fired ONE withStatementTimeout
  // transaction PER top item (up to 20 parallel full-period scans → ~32
  // concurrent connections vs connection_limit=30 → intermittent pool
  // exhaustion / ECHECKOUTRETRIES stalls, which the frontend then retried,
  // amplifying the problem). This single GROUP BY (item, outlet) query produces
  // the same per-item outlet rows (same WHERE/HAVING expressions, same top-20
  // per item by ABS(nominalDeviasi) DESC) in ONE transaction.
  // topItems.length >= 1 here (empty case early-returned above), so the
  // Prisma.join IN-list always has >= 1 element.
  const topItemNames = topItems.map((t) => t.itemName);
  const outletRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string; outletCode: string; outletName: string; area: string;
    devBom: number; devBomAbs: number; nominalDeviasi: number; absNominal: number;
  }>>`
    WITH per_outlet AS (
      SELECT i.name as "itemName", o.code as "outletCode", o.name as "outletName", o.area,
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
        AND i.name IN (${Prisma.join(topItemNames)})
        ${f}
      GROUP BY i.name, o.code, o.name, o.area
      HAVING CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END > ${threshold}
    ),
    ranked AS (
      -- Top 20 outlets per item by ABS(nominalDeviasi) DESC — same cap the old
      -- per-item query enforced via ORDER BY ... LIMIT 20. "outletCode" is a
      -- deterministic tie-break for equal absNominal (old query's LIMIT
      -- picked ties nondeterministically).
      SELECT per_outlet.*,
        ROW_NUMBER() OVER (PARTITION BY "itemName" ORDER BY "absNominal" DESC, "outletCode") AS rn
      FROM per_outlet
    )
    SELECT "itemName", "outletCode", "outletName", "area", "devBom", "devBomAbs", "nominalDeviasi", "absNominal"
    FROM ranked
    WHERE rn <= 20
    ORDER BY "itemName", "absNominal" DESC, "outletCode"
  `);
  const outletRowsByItem = new Map<string, typeof outletRows>();
  for (const row of outletRows) {
    const list = outletRowsByItem.get(row.itemName) ?? [];
    list.push(row);
    outletRowsByItem.set(row.itemName, list);
  }

  const drivers: ParetoDevBomRow[] = topItems.map((item) => {
    const itemName = item.itemName;
    const itemAbsNominal = Number(item.absNominal);
    const sharePct = grandTotal > 0 ? (itemAbsNominal / grandTotal) * 100 : 0;
    cumPct += sharePct;

    const outletRows = outletRowsByItem.get(itemName) ?? [];
    const outletTotal = outletRows.reduce((s, r) => s + Number(r.absNominal), 0);
    let outletCum = 0;
    const outlets: ParetoDevBomOutletRow[] = outletRows.map((r) => {
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
