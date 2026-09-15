// ============================================================
//  Top Items by Other Metric — All-Categories single scan
//  --------------------------------------------------------
//  queryTopItemsByAllCategories + its row types and private
//  helpers (CATEGORY_COLS, directionFromSums, WideCategoryRow).
//
//  Split from ./by-other-metric.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Public
//  symbols stay re-exported from ./by-other-metric.ts.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../../shared';

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
