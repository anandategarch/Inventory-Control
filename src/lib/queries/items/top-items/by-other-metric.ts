// ============================================================
//  Top Items — Other Metric Queries
//  --------------------------------------------------------
//  Five query functions covering all top-item aggregations EXCEPT
//  the deviasi-rank pair (which lives in ./by-deviasi-rank.ts
//  because it shares a CTE structure):
//
//    1. queryTopItemsByNominal     — top by ABS(nominalDeviasi)
//    2. queryTopItemsByDevBom      — top by ABS(qtyDeviasi / qtyBom)
//    3. queryHistoricalCategoryAvg — historical avg per (item,outlet)
//    4. queryItemConsistency       — per-item outlet-count + consistency tier
//    5. queryParetoByDevBom        — Pareto 80/20 for items with |Dev/BOM| > threshold
//    6. queryAreaCategoryAvg       — per-(item, area) avg category QTY across the
//                                   area's outlets (REFINE-1: "Rata-rata Area"
//                                   column in the export's 3.3-3.6 tables)
//
//  REFINE-1 (user request): queryTopItemsByNominal now also returns devBom
//  (SUM(qtyDeviasi) / SUM|qtyBom| per group — feeds the "% Deviasi To BOM"
//  column added to export table 3.1), and queryTopItemsByDevBom returns
//  nominalDeviasi (feeds the "Nominal Deviasi" column added to 3.2). Both are
//  additive — existing consumers ignore the extra fields.
//
//  (H-10: the standalone queryTopItemsByCategory was removed — zero
//  production callers since queryTopItemsByAllCategories landed.)
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
): Promise<Array<{ itemName: string; outletCode: string; satuan: string | null; absNominal: number; nominalDeviasi: number; direction: string; devBom: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 3: Sort by ABS(nominalDeviasi), but return signed nominalDeviasi for display.
  // Previous version sorted/displayed absNominalLossSurplus (NET) — user wants nominalDeviasi (GROSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // REFINE-1: + devBom per group (NULL when the group has no BOM rows) — feeds
  // the "% Deviasi To BOM" column in export table 3.1.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; satuan: string | null; absNominal: number; nominalDeviasi: number; direction: string; devBom: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      MAX(ir."satuan") as "satuan",
      ABS(SUM(ir."nominalDeviasi")) as "absNominal",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
      SUM(ir."qtyDeviasi") / NULLIF(SUM(ABS(ir."qtyBom")), 0) as "devBom",
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
): Promise<Array<{ itemName: string; outletCode: string; satuan: string | null; devBom: number; devBomAbs: number; tolerance: number | null; nominalDeviasi: number | null }>> {
  const f = buildSqlFilters(filters);
  // Rev 4: Sort by ABS(devBom), but return signed devBom for display.
  // Signed devBom = SUM(qtyDeviasi) / SUM(ABS(qtyBom)) — can be negative (SURPLUS) or positive (LOSS).
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  // REFINE-1: + signed nominalDeviasi per group — feeds the "Nominal Deviasi"
  // column in export table 3.2.
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; outletCode: string; satuan: string | null; devBom: number; devBomAbs: number; tolerance: number | null; nominalDeviasi: number | null }[]>`
    SELECT i.name as "itemName", o.code as "outletCode",
      MAX(ir."satuan") as "satuan",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBom",
      CASE WHEN SUM(ABS(ir."qtyBom")) > 0
        THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
        ELSE 0 END as "devBomAbs",
      SUM(ir."nominalDeviasi") as "nominalDeviasi",
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
//  H-10 dead-code cleanup: the standalone queryTopItemsByCategory was
//  REMOVED (zero production callers — this merged query is the only
//  consumer of the 4-category ranking in both pipelines).
// ============================================================
export interface TopItemsCategoryRow {
  itemName: string;
  outletCode: string;
  /** H-2b: unit-of-measure for the item (denormalized on InventoryRecord; MAX per group — nullable, GROUP BY-safe). */
  satuan: string | null;
  /** REFINE-1: outlet's area (o.area) — drives the "Rata-rata Area" lookup
   *  in the export's 3.3-3.6 tables. */
  area: string;
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
  area: string;
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
    SELECT "itemName", "outletCode", "satuan", "area",
      "wasteQty", "wasteNominal", "wasteNls", "wasteQd", "rw",
      "susutQty", "susutNominal", "susutNls", "susutQd", "rs",
      "trialQty", "trialNominal", "trialNls", "trialQd", "rt",
      "lsQty", "lsNominal", "lsNls", "lsQd", "rl"
    FROM (
      SELECT i.name as "itemName", o.code as "outletCode",
        MAX(ir."satuan") as "satuan",
        MAX(o.area) as "area",
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
        area: r.area,
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

  // PERF (TAHAP-2 / P2-10): previously TWO sequential scans of the same
  // filtered period — (1) GROUP BY (item, outletId) → item-level top-20,
  // then (2) GROUP BY (item, outlet) again with outlet columns + i.name IN
  // (top items) for the drill-down rows. Both scans shared the same WHERE /
  // HAVING / (item × outlet) grouping, so this now runs ONE scan that returns
  // ALL threshold-passing (item, outlet) rows (with the sums needed to
  // re-derive the item level in JS — the same expressions scan 1 used:
  // outletCount = COUNT(DISTINCT outletId) → rows per item;
  // devBom = Σ qtyDeviasi / Σ |qtyBom|; devBomAbs = Σ |Σ qtyDeviasi| / Σ |qtyBom|;
  // absNominal = ABS(Σ nominalDeviasi)).
  // Row volume is bounded by (item × outlet) pairs above the 50% threshold —
  // typically a few hundred rows, far below the period itself.
  // The per-item top-20 outlet cap (old ROW_NUMBER rn <= 20) is a JS sort by
  // (absNominal DESC, outletCode) + slice — same deterministic tie-break.
  const outletRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string; outletCode: string; outletName: string; area: string;
    devBom: number; devBomAbs: number; nominalDeviasi: number; absNominal: number;
    totalQtyDeviasi: number; totalQtyBom: number;
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
        ABS(SUM(ir."nominalDeviasi")) as "absNominal",
        SUM(ir."qtyDeviasi") as "totalQtyDeviasi",
        SUM(ABS(ir."qtyBom")) as "totalQtyBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ir."qtyBom" IS NOT NULL AND ir."qtyBom" != 0
        ${f}
      GROUP BY i.name, o.code, o.name, o.area
      HAVING CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END > ${threshold}
    )
    SELECT "itemName", "outletCode", "outletName", "area", "devBom", "devBomAbs",
      "nominalDeviasi", "absNominal", "totalQtyDeviasi", "totalQtyBom"
    FROM per_outlet
    ORDER BY "itemName", "absNominal" DESC, "outletCode"
  `);

  // Group rows per item (SQL order gives per-item absNominal DESC + outletCode
  // tie-break — the same order the old ROW_NUMBER cap used).
  const rowsByItem = new Map<string, typeof outletRows>();
  for (const row of outletRows) {
    const list = rowsByItem.get(row.itemName) ?? [];
    list.push(row);
    rowsByItem.set(row.itemName, list);
  }

  // Item-level derivation (same expressions the old topItems scan used).
  interface ItemAgg {
    itemName: string;
    outletCount: number;
    devBom: number;
    devBomAbs: number;
    nominalDeviasi: number;
    absNominal: number;
    rows: typeof outletRows;
  }
  const itemAggs: ItemAgg[] = [];
  for (const [itemName, rows] of rowsByItem) {
    let sumQtyDeviasi = 0, sumAbsQtyDeviasi = 0, sumQtyBom = 0, sumNominalDeviasi = 0;
    for (const r of rows) {
      sumQtyDeviasi += Number(r.totalQtyDeviasi) || 0;
      sumAbsQtyDeviasi += Math.abs(Number(r.totalQtyDeviasi) || 0);
      sumQtyBom += Number(r.totalQtyBom) || 0;
      sumNominalDeviasi += Number(r.nominalDeviasi) || 0;
    }
    itemAggs.push({
      itemName,
      outletCount: rows.length,
      devBom: sumQtyBom > 0 ? sumQtyDeviasi / sumQtyBom : 0,
      devBomAbs: sumQtyBom > 0 ? sumAbsQtyDeviasi / sumQtyBom : 0,
      nominalDeviasi: sumNominalDeviasi,
      absNominal: Math.abs(sumNominalDeviasi),
      rows,
    });
  }

  if (itemAggs.length === 0) {
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: 0, thresholdPct: threshold };
  }

  // Top items by absNominal DESC (itemName tie-break for determinism), capped
  // at maxDrivers — same cap + order as the old scan-1 LIMIT.
  const topItems = itemAggs
    .sort((a, b) => (b.absNominal - a.absNominal) || a.itemName.localeCompare(b.itemName))
    .slice(0, maxDrivers);

  // FIX (BUG-2-c): grandTotal is the FULL population total over ALL
  // threshold-passing items (outletRows returns every (item, outlet) row —
  // no SQL LIMIT — so the population is fully materialized here), NOT just
  // the top-N slice. sharePct/cumPct are therefore honest percentages of the
  // population (same semantics as computePareto8020 on the by-dimension
  // cards) instead of inflating to a misleading 100% at row maxDrivers;
  // remainderPct = 100 − cumPct becomes the true "rest of population".
  const grandTotal = itemAggs.reduce((s, r) => s + r.absNominal, 0);
  let cumPct = 0;

  const drivers: ParetoDevBomRow[] = topItems.map((item) => {
    const sharePct = grandTotal > 0 ? (item.absNominal / grandTotal) * 100 : 0;
    cumPct += sharePct;

    // Top 20 outlets per item (old rn <= 20 cap) — rows arrive pre-sorted by
    // (absNominal DESC, outletCode) from the SQL ORDER BY.
    const outletRows = item.rows.slice(0, 20);
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
      itemName: item.itemName,
      outletCount: item.outletCount,
      devBom: Number(item.devBom) || 0,
      devBomAbs: Number(item.devBomAbs) || 0,
      nominalDeviasi: Number(item.nominalDeviasi) || 0,
      absNominal: item.absNominal,
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
