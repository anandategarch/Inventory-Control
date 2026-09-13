// ============================================================
//  Top Growth — Top-N movers per resto & per barang
//  --------------------------------------------------------
//  Extracted from the former src/lib/queries/growth-drivers.ts
//  monolith (REFACTOR-1-a pure-move split — this file holds the
//  queryTopGrowth family; the queryGrowthDrivers family lives in
//  ./drivers.ts).
//
//  Task H-2c (CHANGE 6): ranking of the biggest movers vs the compare
//  period, in TWO grains:
//    - byOutlet → per resto
//    - byItem   → per barang
//
//  Task H-5: each row carries `contributors` — the top movers ONE
//  LEVEL DEEPER that drive the row's Δ (drill-down).
//
//  TASK H-6 (correctness rework — fixes "drill down menampilkan data
//  yang salah"): the H-5 matrix summed nominalSales at the (outlet ×
//  item) grain, but nominalSales is an OUTLET-LEVEL denormalized
//  field (see drivers.ts aggregateSalesMode's header) — every cell was
//  Sales × rowCount(outlet,item). There is NO per-barang Sales in
//  this data model.
//
//  TASK H-7 (metric switch — user request: "Top Growth (Resto &
//  Barang) pakai nominal deviasi sum kemudian absolute dan signed
//  nilai asli dan drill down nya pakai kuantiti deviasi dan ada
//  nominal juga"): BOTH grains now rank the SAME metric — the SIGNED
//  NET NOMINAL DEVIATION:
//
//    - byOutlet (Per Resto) & byItem (Per Barang) → Δ SUM(nominalDeviasi)
//      in Rp. nominalDeviasi is genuine PER-ROW data (unlike the
//      outlet-level nominalSales that caused the H-6 bug), so the sum
//      is a REAL total at every grouping level and ADDITIVE across
//      grains — the per-outlet sum equals the Σ of its (outlet × item)
//      cells, both grains derive from ONE matrix scan. Sign convention
//      (verified from production data — metrics/deviation.ts):
//      negative = LOSS (over-consumption), positive = SURPLUS
//      (under-consumption) — the SAME signed convention as the
//      Ringkasan Eksekutif "Nominal Deviasi" KPI (dashboard.ts:
//      nominal = SUM(nominalDeviasi) signed) and health-ranking.ts
//      (ABS(SUM) for sorting, signed SUM for display — exactly the
//      pattern requested: |Δ| ranks the list, the SIGNED real value
//      is displayed).
//    - Drill-down (both directions) → contributors ranked by
//      Δ SUM(qtyDeviasi) — KUANTITI DEVIASI, signed, in the barang's
//      satuan — and each contributor ALSO carries Δ SUM(nominalDeviasi)
//      in Rp ("ada nominal juga") — volume AND value side by side.
//
//  ONE matrix scan serves everything: the (outlet × item) cells carry
//  both deviation sums; per-grain nominal sums are derived in JS by
//  additivity (no second query). aggregateSalesMode stays in
//  ./drivers.ts ONLY for queryGrowthDrivers' `sales` Pareto metric.
//
//  Period semantics are IDENTICAL to queryGrowthDrivers: prevWeek/
//  prevMonth come from the pipeline's period resolver (auto = same
//  weekLabel in the previous month, or the user's explicit compare
//  period) — the caller passes whatever it resolved for growth.
//
//  Shaping (pure JS — no extra SQL):
//    - delta = curr − prev                (SIGNED — sacred sign)
//    - pct   = calcGrowth(curr, prev)     (signed (curr−prev)/|prev|,
//                                          null when prev = 0)
//    - isNew = no previous base (prev 0/absent)
//    - noise filter: |Δ nominal| ≥ 1000 Rp — BOTH grains are Rp now
//      (same threshold as the sales/nominalDeviasi metrics above)
//    - sort by |delta| DESC, cap TOP_GROWTH_LIMIT rows per list
//    - contributors: top TOP_GROWTH_CONTRIBUTOR_LIMIT by |Δ QTY
//      deviasi|, NO noise threshold — inside an already-ranked mover,
//      the biggest sub-movers are the story ("penyebab growth"), even
//      when individually tiny (e.g. a brand-new resto built from many
//      small items).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout } from '../shared';
import { calcGrowth } from '@/lib/metrics/growth';
import type { TopGrowthContributor, TopGrowthRow, TopGrowthResult, FilterOpts } from './types';

const TOP_GROWTH_DELTA_THRESHOLD = 1000;
const TOP_GROWTH_LIMIT = 15;
const TOP_GROWTH_CONTRIBUTOR_LIMIT = 5;

// ------------------------------------------------------------
//  TASK H-7: (outlet × item) DEVIATION matrix — ONE query carrying
//  BOTH deviation sums per cell:
//    - nd = SUM(nominalDeviasi)   SIGNED net (Rp)
//    - qd = SUM(qtyDeviasi)       SIGNED net (qty)
//  Both are genuine PER-ROW data (each InventoryRecord row is one
//  outlet × item × week × akun entry), so the sums are real totals at
//  every grouping level and ADDITIVE: per-outlet / per-item nominal
//  sums are derived in JS from the same cells — no second query, no
//  fan-out (contrast with nominalSales, the outlet-level denorm that
//  caused the H-6 bug). FILTER (WHERE field IS NOT NULL) per metric —
//  same convention as aggregateItemMetrics: a group whose rows are
//  NULL for one field still contributes to the other field's sum.
//  The row filter (nd IS NOT NULL OR qd IS NOT NULL) keeps groups
//  that carry deviation data of either kind. `unit` = the record's
//  satuan (MAX of the denormalized InventoryRecord.satuan — same
//  source as the export report's Satuan column).
// ------------------------------------------------------------
interface DeviationCell {
  ndCurr: number;
  ndPrev: number;
  qdCurr: number;
  qdPrev: number;
}

async function aggregateDeviationMatrix(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
): Promise<{
  /** outlet → item → deviation cell. */
  matrix: Map<string, Map<string, DeviationCell>>;
  /** item → satuan (first-seen; satuan is a per-item master value). */
  itemUnits: Map<string, string | null>;
  /** outlet NAME → outlet CODE (NAVLINK-1/B1 — first-seen, navigation only). */
  outletCodes: Map<string, string | null>;
}> {
  const f = buildSqlFilters(filters);

  const sums = Prisma.sql`
    COALESCE(SUM(ir."nominalDeviasi") FILTER (WHERE ir."nominalDeviasi" IS NOT NULL), 0) as nd,
    COALESCE(SUM(ir."qtyDeviasi") FILTER (WHERE ir."qtyDeviasi" IS NOT NULL), 0) as qd
  `;
  const unitExpr = Prisma.sql`
    MAX(ir."satuan") as unit
  `;
  const fromAndGroup = Prisma.sql`
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    JOIN "Item" i ON ir."itemId" = i.id
  `;
  const groupBy = Prisma.sql`
    GROUP BY o.name, i.name
  `;

  const cte = (m: string, w: string) => Prisma.sql`
    SELECT o.name as "outletName", i.name as "itemName", ${unitExpr}, ${sums},
      MIN(o.code) as "outletCode"
    ${fromAndGroup}
    WHERE ir."monthLabel" = ${m} AND ir."weekLabel" = ${w}
      AND (ir."nominalDeviasi" IS NOT NULL OR ir."qtyDeviasi" IS NOT NULL)
      ${f}
    ${groupBy}
  `;
  const currCte = cte(month, week);
  // Empty prev CTE when there is no compare period → every cell is "Baru".
  // NAVLINK-1 (B1): the empty CTE's column list must match the real one
  // (outletName, itemName, unit, nd, qd, outletCode) for the FULL OUTER JOIN.
  const prevCte = prevWeek && prevMonth
    ? cte(prevMonth, prevWeek)
    : Prisma.sql`SELECT NULL::text as "outletName", NULL::text as "itemName", NULL::text as unit, 0::float as nd, 0::float as qd, NULL::text as "outletCode" WHERE 1=0`;

  // Same FULL OUTER JOIN pattern as aggregateSalesMode (AUDIT8-ROLLBACK-1
  // Item 8: wrapped in withStatementTimeout — 2 CTEs over InventoryRecord).
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    outletName: string | null;
    itemName: string | null;
    unit: string | null;
    // NAVLINK-1 (B1): MIN(o.code) per (outletName, itemName) group — additive,
    // grouping/ranking unchanged.
    outletCode: string | null;
    ndCurr: number | bigint | null;
    ndPrev: number | bigint | null;
    qdCurr: number | bigint | null;
    qdPrev: number | bigint | null;
  }>>`
    WITH curr_agg AS (${currCte}),
         prev_agg AS (${prevCte})
    SELECT
      COALESCE(c."outletName", p."outletName") as "outletName",
      COALESCE(c."itemName", p."itemName") as "itemName",
      COALESCE(c.unit, p.unit) as unit,
      COALESCE(c."outletCode", p."outletCode") as "outletCode",
      COALESCE(c.nd, 0) as "ndCurr",
      COALESCE(p.nd, 0) as "ndPrev",
      COALESCE(c.qd, 0) as "qdCurr",
      COALESCE(p.qd, 0) as "qdPrev"
    FROM curr_agg c
    FULL OUTER JOIN prev_agg p
      ON c."outletName" = p."outletName" AND c."itemName" = p."itemName"
  `);

  // Nested map: outlet → item → cell. Rows missing either name
  // (FULL OUTER JOIN null edge) are skipped, mirroring aggregateSalesMode.
  const matrix = new Map<string, Map<string, DeviationCell>>();
  const itemUnits = new Map<string, string | null>();
  // NAVLINK-1 (B1): outlet NAME → outlet CODE (first-seen non-null wins).
  // The SQL groups by o.name — for the (rare) duplicate-name case the codes
  // of both outlets land on one row name; first-seen keeps the link stable.
  // Used ONLY for UI navigation (setFocusOutlet), never for metrics.
  const outletCodes = new Map<string, string | null>();
  for (const r of rows) {
    if (r.outletName == null || r.itemName == null) continue;
    if (!outletCodes.has(r.outletName) && r.outletCode != null) {
      outletCodes.set(r.outletName, r.outletCode);
    }
    let items = matrix.get(r.outletName);
    if (!items) {
      items = new Map<string, DeviationCell>();
      matrix.set(r.outletName, items);
    }
    items.set(r.itemName, {
      ndCurr: Number(r.ndCurr) || 0,
      ndPrev: Number(r.ndPrev) || 0,
      qdCurr: Number(r.qdCurr) || 0,
      qdPrev: Number(r.qdPrev) || 0,
    });
    if (!itemUnits.has(r.itemName)) itemUnits.set(r.itemName, r.unit ?? null);
  }
  return { matrix, itemUnits, outletCodes };
}

/**
 * TASK H-7: top-N contributors by |Δ QTY deviasi| (no noise threshold —
 * see header comment). Each contributor carries BOTH deviations:
 * qty (signed, satuan — the ranking key) and nominal (signed, Rp —
 * "ada nominal juga"). Unit resolution (plain-data config, no lookup
 * callbacks — the base no-unused-vars rule flags param names inside
 * function-type annotations, the same quirk buildWhere works around):
 *   - unitFromRow false → each contributor's unit = its OWN name's
 *     satuan (byOutlet — contributors are barang).
 *   - unitFromRow true  → every contributor's unit = the ROW item's
 *     satuan (byItem — the qty being ranked is the row item's qty,
 *     wherever it moved).
 */
function topContributors(
  cells: Map<string, DeviationCell>,
  units: Map<string, string | null>,
  unitFromRow: boolean,
  rowName: string,
  // NAVLINK-1 (B1): name → outlet code — only passed for byItem rows
  // (contributors are resto); undefined for byOutlet rows (barang).
  outletCodes?: Map<string, string | null>,
): TopGrowthContributor[] {
  if (cells.size === 0) return [];
  const rowUnit = units.get(rowName) ?? null;
  const list: TopGrowthContributor[] = [...cells].map(([n, cell]) => ({
    name: n,
    qtyCurr: cell.qdCurr,
    qtyPrev: cell.qdPrev,
    qtyDelta: cell.qdCurr - cell.qdPrev,
    nominalCurr: cell.ndCurr,
    nominalPrev: cell.ndPrev,
    nominalDelta: cell.ndCurr - cell.ndPrev,
    isNew: !cell.qdPrev && !cell.ndPrev,
    unit: unitFromRow ? rowUnit : (units.get(n) ?? null),
    code: outletCodes ? (outletCodes.get(n) ?? null) : null,
  }));
  list.sort((a, b) => Math.abs(b.qtyDelta) - Math.abs(a.qtyDelta));
  return list.slice(0, TOP_GROWTH_CONTRIBUTOR_LIMIT);
}

function shapeTopGrowthRows(
  // Per-row NOMINAL deviasi sums (signed) — the ranking metric for BOTH
  // grains (derived from the matrix cells by additivity).
  sums: Map<string, { curr: number; prev: number }>,
  // Sub-grain cells for each row name — byOutlet passes the (outlet → items)
  // matrix itself, byItem passes the inverted (item → outlets) map. (Plain
  // map params instead of lookup callbacks: the base no-unused-vars rule
  // flags param names inside function-type annotations — same quirk as
  // buildWhere.)
  subCells: Map<string, Map<string, DeviationCell>>,
  units: Map<string, string | null>,
  /** true → contributor unit keyed by the ROW's name (byItem); false → by the contributor's own name (byOutlet). */
  contributorUnitFromRow: boolean,
  // NAVLINK-1 (B1): rowCode applies to the ROW itself (byOutlet — row is a
  // resto); contributorCodes applies to CONTRIBUTORS (byItem — contributors
  // are resto). Each grain passes only the map it needs.
  opts?: {
    rowCodes?: Map<string, string | null>;
    contributorCodes?: Map<string, string | null>;
  },
): TopGrowthRow[] {
  const rows: TopGrowthRow[] = [];
  for (const [name, { curr, prev }] of sums) {
    const delta = curr - prev;
    // Noise filter — |Δ nominal| ≥ 1000 Rp, both grains.
    if (Math.abs(delta) < TOP_GROWTH_DELTA_THRESHOLD) continue;
    const isNew = !prev || prev === 0;
    const contributors = topContributors(
      subCells.get(name) ?? new Map<string, DeviationCell>(),
      units,
      contributorUnitFromRow,
      name,
      opts?.contributorCodes,
    );
    rows.push({ name, code: opts?.rowCodes ? (opts.rowCodes.get(name) ?? null) : null, curr, prev, delta, pct: calcGrowth(curr, prev), isNew, contributors });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rows.slice(0, TOP_GROWTH_LIMIT);
}

export async function queryTopGrowth(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
): Promise<TopGrowthResult> {
  // ONE scan (TASK H-7): nominalDeviasi + qtyDeviasi are genuine
  // per-row data, so a single (outlet × item) matrix carries real
  // totals at every grouping level — per-outlet and per-item NOMINAL
  // sums are derived in JS by additivity, and the cells feed BOTH
  // drill-down directions (qty + nominal per contributor).
  const { matrix, itemUnits, outletCodes } = await aggregateDeviationMatrix(
    week,
    month,
    prevWeek,
    prevMonth,
    filters,
  );

  // Derive both grains' nominal sums + the inverted (item → outlets)
  // cell map for the Per Barang drill-down — all from the SAME matrix.
  const outletSums = new Map<string, { curr: number; prev: number }>();
  const itemSums = new Map<string, { curr: number; prev: number }>();
  const outletsByItem = new Map<string, Map<string, DeviationCell>>();
  for (const [outlet, items] of matrix) {
    for (const [item, cell] of items) {
      const osum = outletSums.get(outlet) ?? { curr: 0, prev: 0 };
      osum.curr += cell.ndCurr;
      osum.prev += cell.ndPrev;
      outletSums.set(outlet, osum);
      const isum = itemSums.get(item) ?? { curr: 0, prev: 0 };
      isum.curr += cell.ndCurr;
      isum.prev += cell.ndPrev;
      itemSums.set(item, isum);
      let outs = outletsByItem.get(item);
      if (!outs) {
        outs = new Map<string, DeviationCell>();
        outletsByItem.set(item, outs);
      }
      outs.set(outlet, cell);
    }
  }

  return {
    // Per Resto — Δ nominal deviasi (Rp, signed). Drill-down: top barang
    // by Δ kuantiti deviasi inside the resto, each with Δ nominal too.
    // Contributor unit = each barang's own satuan.
    // NAVLINK-1 (B1): rows carry their outlet code → "Buka resto" link.
    byOutlet: shapeTopGrowthRows(outletSums, matrix, itemUnits, false, { rowCodes: outletCodes }),
    // Per Barang — Δ nominal deviasi (Rp, signed). Drill-down: top resto
    // driving that item's deviation — every contributor's unit = the row
    // item's satuan, since the qty being ranked IS that item's qty.
    // NAVLINK-1 (B1): contributors carry their outlet code → resto link-out.
    byItem: shapeTopGrowthRows(itemSums, outletsByItem, itemUnits, true, { contributorCodes: outletCodes }),
    contributorLimit: TOP_GROWTH_CONTRIBUTOR_LIMIT,
    byOutletMetric: 'nominalDeviasi',
    byItemMetric: 'nominalDeviasi',
    contributorRankMetric: 'qtyDeviasi',
  };
}
