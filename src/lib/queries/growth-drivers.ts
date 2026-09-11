// ============================================================
//  Growth Drivers — Pareto 80% analysis per metric (SQL aggregate)
//  --------------------------------------------------------
//  Replaces computeGrowthDrivers JS function (src/app/api/analysis/
//  services/growth-drivers.ts) which iterated over 35K raw currentRecs
//  + prevRecs in RAM to compute SUM(ABS(field)) or SUM(field) per
//  outlet or per item, then computed delta + Pareto in JS.
//
//  This module pushes the per-group SUM to SQL. The Pareto
//  80% + top-20-driver logic stays in JS (it's a small post-process).
//
//  Metric → group mapping:
//    - sales        → groupBy outlet — TASK H-6 FIX: per-outlet value is
//                     OutletPeriodSales.salesMode (canonical MODE of the
//                     outlet-level denormalized nominalSales), NOT
//                     SUM(nominalSales) over rows — that multiplied Sales
//                     by rowCount (every row of an outlet carries the SAME
//                     outlet-level PENJUALAN value; Master context #30).
//    - bom          → groupBy item   (SUM(ABS(qtyBom)))
//    - qtyDeviasi   → groupBy item   (SUM(qtyDeviasi) — SIGNED)
//    - nominalDeviasi → groupBy item (SUM(ABS(nominalDeviasi)))
//
//  Delta threshold (matches existing JS):
//    - sales / nominalDeviasi: |delta| >= 1000
//    - bom / qtyDeviasi:       |delta| >= 0.01
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, computePareto8020, withStatementTimeout, type SqlFilterOpts } from './shared';
import { calcGrowth } from '@/lib/metrics/growth';

export interface DriverEntry {
  item: string;
  delta: number;
  pct: number;
  cumPct: number;
  sharePct: number;
}
export interface DriverResult {
  drivers: DriverEntry[];
  remainderCount: number;
  remainderPct: number;
}
export interface GrowthDriverMetric {
  metric: string;
  label: string;
  groupBy: 'outlet' | 'item';
  up: DriverResult;
  down: DriverResult;
}

// Shared filter type re-exported from ./shared — kept as a local alias for
// backwards-compat with internal call sites. New code should use SqlFilterOpts
// directly from ./shared.
type FilterOpts = SqlFilterOpts;

// ============================================================
//  TASK H-6 — per-outlet SALES from OutletPeriodSales.salesMode
//  --------------------------------------------------------
//  ROOT CAUSE of the user-reported "drill down menampilkan data yang
//  salah": nominalSales is an OUTLET-LEVEL, DENORMALIZED field — the
//  outlet's total PENJUALAN is stamped on EVERY InventoryRecord row of
//  that outlet/period (Master context #30 "Sales merupakan outlet-level
//  field (deduplicated)"; that is exactly why OutletPeriodSales stores
//  the MODE). SUM(nominalSales) over rows = Sales × rowCount — never a
//  real total, at ANY grouping level. The previous aggregateMetric
//  ('outlet', 'nominalSales') did precisely that, and queryTopGrowth's
//  (outlet × item) matrix inherited the bug: every drill-down cell was
//  Sales × rowCount(outlet,item), so contributor Δ could EXCEED the
//  parent resto's Δ and the "top contributors" were ranked by row
//  multiplicity, not by sales.
//
//  Every other sales figure in the app (exec summary, top outlets, peer
//  comparison, trend) already reads ops."salesMode" — this helper brings
//  the growth queries onto the same canonical source.
//
//  Pattern: queryExecSummary's DB-06 shape — the outlet set per period
//  is filtered through InventoryRecord (`f` references `ir.`), then the
//  precomputed salesMode is picked per outlet. curr + prev in ONE round
//  trip (2 CTEs + FULL OUTER JOIN, same skeleton as the old query).
//  OutletPeriodSales is UNIQUE on (outletId, monthLabel, weekLabel)
//  (ON CONFLICT upsert at ingest) — no fan-out.
// ============================================================
async function aggregateSalesMode(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
): Promise<Map<string, { curr: number; prev: number }>> {
  const f = buildSqlFilters(filters);

  // One row per outlet (name via JOIN Outlet — name grouping matches the
  // previous per-grain convention).
  const salesCte = (m: string, w: string) => Prisma.sql`
    SELECT o.name as name, ops."salesMode" as val
    FROM "OutletPeriodSales" ops
    JOIN "Outlet" o ON ops."outletId" = o.id
    WHERE ops."monthLabel" = ${m} AND ops."weekLabel" = ${w}
      AND ops."outletId" IN (
        SELECT DISTINCT ir."outletId"
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${m} AND ir."weekLabel" = ${w}
          ${f}
      )
  `;
  const currCte = salesCte(month, week);
  // Empty prev CTE when there is no compare period (same convention as
  // the old aggregateMetric) → every group becomes "Baru" (prev 0).
  const prevCte = prevWeek && prevMonth
    ? salesCte(prevMonth, prevWeek)
    : Prisma.sql`SELECT NULL::text as name, 0::float as val WHERE 1=0`;

  // FULL OUTER JOIN of the two period CTEs — wrapped in
  // withStatementTimeout (2 CTE scans; AUDIT8-ROLLBACK-1 Item 8 pattern).
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ name: string | null; curr: number | bigint | null; prev: number | bigint | null }>>`
    WITH curr_sales AS (${currCte}),
         prev_sales AS (${prevCte})
    SELECT
      COALESCE(c.name, p.name) as name,
      COALESCE(c.val, 0) as curr,
      COALESCE(p.val, 0) as prev
    FROM curr_sales c
    FULL OUTER JOIN prev_sales p ON c.name = p.name
  `);

  const map = new Map<string, { curr: number; prev: number }>();
  for (const r of rows) {
    if (r.name == null) continue;
    map.set(r.name, {
      curr: Number(r.curr) || 0,
      prev: Number(r.prev) || 0,
    });
  }
  return map;
}

// ============================================================
//  PERF (PAKET B / F6): aggregateItemMetrics
//  --------------------------------------------------------
//  3 of the 4 growth metrics (bom / qtyDeviasi / nominalDeviasi) share
//  the item grain — they each ran aggregateMetric separately, i.e. 3×
//  (curr CTE scan + prev CTE scan + FULL OUTER JOIN + transaction).
//  This merged query computes all 3 metric pairs per item in ONE pair
//  of CTE scans + ONE FULL OUTER JOIN + ONE transaction.
//
//  Semantics parity with per-metric aggregateMetric:
//    - each metric's sum uses FILTER (WHERE <field> IS NOT NULL) —
//      identical to the original's per-metric `AND field IS NOT NULL`
//      row filter (a group whose rows are all NULL for a field gets
//      COALESCE 0 on both curr+prev → delta 0 → filtered by the
//      caller's delta threshold, exactly like the group being absent).
//    - bom/nominalDeviasi use SUM(ABS(field)); qtyDeviasi is SIGNED.
// ============================================================
async function aggregateItemMetrics(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
): Promise<{
  bom: Map<string, { curr: number; prev: number }>;
  qtyDeviasi: Map<string, { curr: number; prev: number }>;
  nominalDeviasi: Map<string, { curr: number; prev: number }>;
}> {
  const f = buildSqlFilters(filters);
  const hasPrev = !!(prevWeek && prevMonth);

  const sums = Prisma.sql`
    i.name as name,
    COALESCE(SUM(ABS(ir."qtyBom")) FILTER (WHERE ir."qtyBom" IS NOT NULL), 0) as bom,
    COALESCE(SUM(ir."qtyDeviasi") FILTER (WHERE ir."qtyDeviasi" IS NOT NULL), 0) as qd,
    COALESCE(SUM(ABS(ir."nominalDeviasi")) FILTER (WHERE ir."nominalDeviasi" IS NOT NULL), 0) as nd
  `;

  const currCte = Prisma.sql`
    SELECT ${sums}
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
    GROUP BY i.name
  `;
  const prevCte = hasPrev
    ? Prisma.sql`
      SELECT ${sums}
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}
        ${f}
      GROUP BY i.name
    `
    : Prisma.sql`SELECT NULL::text as name, 0::float as bom, 0::float as qd, 0::float as nd WHERE 1=0`;

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    name: string;
    bomCurr: number | bigint | null; bomPrev: number | bigint | null;
    qdCurr: number | bigint | null; qdPrev: number | bigint | null;
    ndCurr: number | bigint | null; ndPrev: number | bigint | null;
  }>>`
    WITH curr_agg AS (${currCte}),
         prev_agg AS (${prevCte})
    SELECT
      COALESCE(c.name, p.name) as name,
      COALESCE(c.bom, 0) as "bomCurr", COALESCE(p.bom, 0) as "bomPrev",
      COALESCE(c.qd, 0) as "qdCurr", COALESCE(p.qd, 0) as "qdPrev",
      COALESCE(c.nd, 0) as "ndCurr", COALESCE(p.nd, 0) as "ndPrev"
    FROM curr_agg c
    FULL OUTER JOIN prev_agg p ON c.name = p.name
  `);

  const bom = new Map<string, { curr: number; prev: number }>();
  const qtyDeviasi = new Map<string, { curr: number; prev: number }>();
  const nominalDeviasi = new Map<string, { curr: number; prev: number }>();
  for (const r of rows) {
    if (r.name == null) continue;
    bom.set(r.name, { curr: Number(r.bomCurr) || 0, prev: Number(r.bomPrev) || 0 });
    qtyDeviasi.set(r.name, { curr: Number(r.qdCurr) || 0, prev: Number(r.qdPrev) || 0 });
    nominalDeviasi.set(r.name, { curr: Number(r.ndCurr) || 0, prev: Number(r.ndPrev) || 0 });
  }
  return { bom, qtyDeviasi, nominalDeviasi };
}

// ============================================================
//  Pareto 80% — delegates to shared computePareto8020 in ./shared.
//  Sort by |delta| desc, take top 20 with cumulative share ≤ 80%.
//  FIX (RESTORE-SHARED-1): previously ~25 lines of inline sort+cumsum
//  loop duplicated from pareto.ts; now uses the shared helper. The
//  shared function adds totalMagnitude + totalCount which DriverResult
//  doesn't need — we just pick the 3 fields that DriverResult requires.
// ============================================================
function computePareto(
  arr: Array<{ item: string; delta: number; pct: number }>,
): DriverResult {
  const r = computePareto8020(arr, (d) => d.delta);
  return {
    drivers: r.drivers as DriverEntry[],
    remainderCount: r.remainderCount,
    remainderPct: r.remainderPct,
  };
}

// ============================================================
//  Main entry — 2 aggregations in parallel (PERF PAKET B / F6:
//  was 4 — sales (outlet grain) + the 3 item-grain metrics merged
//  into one query by aggregateItemMetrics)
// ============================================================
export async function queryGrowthDrivers(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
): Promise<GrowthDriverMetric[]> {
  const metrics = [
    // TASK H-6: `sales` is served by aggregateSalesMode (canonical
    // OutletPeriodSales.salesMode) — see the helper's header for why
    // SUM(nominalSales) over rows was wrong (Sales × rowCount).
    { key: 'sales', label: 'Sales', groupBy: 'outlet' as const },
    { key: 'bom', label: 'BOM', groupBy: 'item' as const },
    { key: 'qtyDeviasi', label: 'QTY Deviasi', groupBy: 'item' as const },
    { key: 'nominalDeviasi', label: 'Nominal Deviasi', groupBy: 'item' as const },
  ];

  // Run the outlet-grain SALES metric + the merged item-grain metrics in
  // parallel (PERF PAKET B / F6 shape: sales + aggregateItemMetrics).
  const [salesMap, itemMaps] = await Promise.all([
    aggregateSalesMode(week, month, prevWeek, prevMonth, filters),
    aggregateItemMetrics(week, month, prevWeek, prevMonth, filters),
  ]);
  const maps: Record<string, Map<string, { curr: number; prev: number }>> = {
    sales: salesMap,
    bom: itemMaps.bom,
    qtyDeviasi: itemMaps.qtyDeviasi,
    nominalDeviasi: itemMaps.nominalDeviasi,
  };

  return metrics.map(({ key, label, groupBy }) => {
    const map = maps[key];
    const allKeys = [...map.keys()];
    const positive: Array<{ item: string; delta: number; pct: number }> = [];
    const negative: Array<{ item: string; delta: number; pct: number }> = [];

    // Delta threshold matches existing JS:
    //   sales / nominalDeviasi: 1000
    //   bom / qtyDeviasi:       0.01
    const deltaThreshold = key === 'sales' || key === 'nominalDeviasi' ? 1000 : 0.01;

    for (const name of allKeys) {
      const { curr, prev } = map.get(name)!;
      const delta = curr - prev;
      if (Math.abs(delta) < deltaThreshold) continue;
      // FIX (AUDIT-CALC-SQL BUG-2): was `prev > 0 ? delta / prev : 0` — breaks for signed
      // metrics (qtyDeviasi, nominalDeviasi) where prev can be negative. When prev=-50,
      // curr=-25 (LOSS improving, delta=+25), old formula gave pct = 25/-50 = -0.5 (wrong
      // sign). Now uses |prev| as denominator and |delta| for magnitude pct.
      const absPrev = Math.abs(prev);
      const pct = absPrev > 0 ? Math.abs(delta) / absPrev : 0;
      if (delta > 0) positive.push({ item: name, delta, pct });
      else negative.push({ item: name, delta, pct });
    }

    return {
      metric: key,
      label,
      groupBy,
      up: computePareto(positive),
      down: computePareto(negative),
    };
  });
}

// ============================================================
//  Top Growth — Top-N movers per resto & per barang
//  --------------------------------------------------------
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
//  field (see aggregateSalesMode's header) — every cell was
//  Sales × rowCount(outlet,item). Contributor Δ could EXCEED the
//  parent resto's Δ, and the per-barang "Sales" ranking was really a
//  row-multiplicity ranking. There is NO per-barang Sales in this
//  data model, so each grain now runs on a REAL per-grain source:
//
//    - byOutlet (Per Resto)  → ΔSALES in Rp, from OutletPeriodSales
//      .salesMode (canonical — matches exec summary / top outlets /
//      peer comparison). Drill-down: top barang by Δ pemakaian BOM
//      inside that resto — the demand-side decomposition, since Sales
//      itself has no item-level breakdown.
//    - byItem (Per Barang)   → Δ PEMAKAIAN BOM (SUM(ABS(qtyBom))) in
//      the item's satuan — genuine per-row item data, numerically
//      consistent with the `bom` metric of queryGrowthDrivers above
//      (Growth Comparison's BOM Pareto). Drill-down: top resto
//      driving that item's BOM movement.
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
//    - noise filter: |ΔSales| ≥ 1000 Rp (byOutlet) / |ΔBOM| ≥ 0.01
//      qty (byItem — same thresholds as the sales/bom metrics above)
//    - sort by |delta| DESC, cap TOP_GROWTH_LIMIT rows per list
//    - contributors: top TOP_GROWTH_CONTRIBUTOR_LIMIT by |Δ|, NO noise
//      threshold — inside an already-ranked mover, the biggest sub-
//      movers are the story ("penyebab growth"), even when individually
//      tiny (e.g. a brand-new resto built from many small items).
// ============================================================
export interface TopGrowthContributor {
  name: string;
  curr: number;
  prev: number;
  /** SIGNED delta = curr − prev. */
  delta: number;
  /** SIGNED growth (curr − prev)/|prev| — null when prev = 0 (new). */
  pct: number | null;
  /** No previous base — pct cannot be computed, UI shows "Baru". */
  isNew: boolean;
  /**
   * TASK H-6: unit label (satuan) when this contributor's Δ is a QTY
   * (Δ pemakaian BOM); null when it is currency (ΔSales context).
   */
  unit?: string | null;
}

export interface TopGrowthRow {
  name: string;
  curr: number;
  prev: number;
  /** SIGNED delta = curr − prev (negative = shrinking). */
  delta: number;
  /** SIGNED growth (curr − prev)/|prev| — null when prev = 0 (new). */
  pct: number | null;
  /** No previous base — pct cannot be computed, UI shows "Baru". */
  isNew: boolean;
  /**
   * TASK H-5: drill-down — top sub-grain movers driving this row's Δ
   * (items for byOutlet rows, outlets for byItem rows). Always an
   * array (possibly empty) so the field ALWAYS serializes into the
   * cached payload — it doubles as a required payload-shape marker.
   */
  contributors: TopGrowthContributor[];
  /**
   * TASK H-6: unit label (satuan) when this row's Δ is a QTY (byItem /
   * Δ pemakaian BOM); null for byOutlet rows (ΔSales = currency).
   */
  unit?: string | null;
}

export interface TopGrowthResult {
  byOutlet: TopGrowthRow[];
  byItem: TopGrowthRow[];
  /**
   * Cap used for each row's `contributors` list (informational — the
   * UI footnote reads it). ALWAYS serialized; required payload marker.
   */
  contributorLimit: number;
  /**
   * TASK H-6: grain → metric descriptors, ALWAYS serialized (wrapper-
   * level scalars → payload-shape markers). byOutlet rows are ΔSales
   * in Rp (salesMode); byItem rows are Δ pemakaian BOM in satuan.
   */
  byOutletMetric: 'sales';
  byItemMetric: 'bom';
}

const TOP_GROWTH_DELTA_THRESHOLD = 1000;
const TOP_GROWTH_BOM_DELTA_THRESHOLD = 0.01;
const TOP_GROWTH_LIMIT = 15;
const TOP_GROWTH_CONTRIBUTOR_LIMIT = 5;

// ------------------------------------------------------------
//  (outlet × item) BOM-USAGE matrix — curr + prev SUM(ABS(qtyBom))
//  per pair in ONE query (FULL OUTER JOIN of the two period CTEs,
//  grouped on BOTH grains). qtyBom is genuine PER-ROW item data, so
//  the sums are real totals at every grouping level: per-item sums
//  feed the Per Barang grain, and the cells feed BOTH drill-down
//  directions. `unit` = the record's satuan (MAX of the denormalized
//  InventoryRecord.satuan — same source as the export report's
//  Satuan column).
// ------------------------------------------------------------
async function aggregateBomMatrix(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
): Promise<{
  /** outlet → item → {curr, prev} cell sums. */
  matrix: Map<string, Map<string, { curr: number; prev: number }>>;
  /** item → satuan (first-seen; satuan is a per-item master value). */
  itemUnits: Map<string, string | null>;
}> {
  const f = buildSqlFilters(filters);

  const sums = Prisma.sql`
    COALESCE(SUM(ABS(ir."qtyBom")), 0) as val
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
    SELECT o.name as "outletName", i.name as "itemName", ${unitExpr}, ${sums}
    ${fromAndGroup}
    WHERE ir."monthLabel" = ${m} AND ir."weekLabel" = ${w}
      AND ir."qtyBom" IS NOT NULL
      ${f}
    ${groupBy}
  `;
  const currCte = cte(month, week);
  // Empty prev CTE when there is no compare period → every cell is "Baru".
  const prevCte = prevWeek && prevMonth
    ? cte(prevMonth, prevWeek)
    : Prisma.sql`SELECT NULL::text as "outletName", NULL::text as "itemName", NULL::text as unit, 0::float as val WHERE 1=0`;

  // Same FULL OUTER JOIN pattern as aggregateSalesMode (AUDIT8-ROLLBACK-1
  // Item 8: wrapped in withStatementTimeout — 2 CTEs over InventoryRecord).
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    outletName: string | null;
    itemName: string | null;
    unit: string | null;
    curr: number | bigint | null;
    prev: number | bigint | null;
  }>>`
    WITH curr_agg AS (${currCte}),
         prev_agg AS (${prevCte})
    SELECT
      COALESCE(c."outletName", p."outletName") as "outletName",
      COALESCE(c."itemName", p."itemName") as "itemName",
      COALESCE(c.unit, p.unit) as unit,
      COALESCE(c.val, 0) as curr,
      COALESCE(p.val, 0) as prev
    FROM curr_agg c
    FULL OUTER JOIN prev_agg p
      ON c."outletName" = p."outletName" AND c."itemName" = p."itemName"
  `);

  // Nested map: outlet → item → {curr, prev}. Rows missing either name
  // (FULL OUTER JOIN null edge) are skipped, mirroring aggregateSalesMode.
  const matrix = new Map<string, Map<string, { curr: number; prev: number }>>();
  const itemUnits = new Map<string, string | null>();
  for (const r of rows) {
    if (r.outletName == null || r.itemName == null) continue;
    let items = matrix.get(r.outletName);
    if (!items) {
      items = new Map<string, { curr: number; prev: number }>();
      matrix.set(r.outletName, items);
    }
    items.set(r.itemName, { curr: Number(r.curr) || 0, prev: Number(r.prev) || 0 });
    if (!itemUnits.has(r.itemName)) itemUnits.set(r.itemName, r.unit ?? null);
  }
  return { matrix, itemUnits };
}

/**
 * Shape one contributor (sub-grain mover) — same math as the row itself.
 * TASK H-6: carries the contributor's unit label (satuan) when its Δ is
 * a QTY (BOM drill-down); null for currency contexts.
 */
function shapeContributor(
  name: string,
  curr: number,
  prev: number,
  unit: string | null,
): TopGrowthContributor {
  return {
    name,
    curr,
    prev,
    delta: curr - prev,
    pct: calcGrowth(curr, prev),
    isNew: !prev || prev === 0,
    unit,
  };
}

/**
 * Top-N contributors by |Δ| (no noise threshold — see header comment).
 * TASK H-6: plain-data unit config (no lookup callbacks — the base
 * no-unused-vars rule flags param names inside function-type
 * annotations, the same quirk buildWhere works around):
 *   - units: item → satuan map (itemUnits).
 *   - unitFromRow: false → each contributor's unit = its OWN name's
 *     satuan (byOutlet — contributors are barang); true → every
 *     contributor's unit = the ROW item's satuan (byItem — the qty
 *     being ranked is the row item's qty, wherever it moved).
 */
function topContributors(
  m: Map<string, { curr: number; prev: number }>,
  units: Map<string, string | null>,
  unitFromRow: boolean,
  rowName: string,
): TopGrowthContributor[] {
  if (m.size === 0) return [];
  const rowUnit = units.get(rowName) ?? null;
  const list = [...m].map(([n, v]) =>
    shapeContributor(n, v.curr, v.prev, unitFromRow ? rowUnit : (units.get(n) ?? null)));
  list.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return list.slice(0, TOP_GROWTH_CONTRIBUTOR_LIMIT);
}

function shapeTopGrowthRows(
  sums: Map<string, { curr: number; prev: number }>,
  // Sub-grain cells for each row name — byOutlet passes the (outlet → items)
  // matrix itself, byItem passes the inverted (item → outlets) map. (Plain
  // map params instead of lookup callbacks: the base no-unused-vars rule
  // flags param names inside function-type annotations — same quirk as
  // buildWhere.)
  subMaps: Map<string, Map<string, { curr: number; prev: number }>>,
  opts: {
    /** Noise floor for parent rows: |Δ| >= threshold (Rp for sales, qty for BOM). */
    threshold: number;
    /** Row → satuan map when the row Δ is a QTY (byItem: itemUnits); null → currency rows (byOutlet). */
    rowUnits: Map<string, string | null> | null;
    /** Contributor → satuan map (itemUnits — both grains rank BOM movement). */
    contributorUnits: Map<string, string | null>;
    /** true → contributor unit keyed by the ROW's name (byItem); false → by the contributor's own name (byOutlet). */
    contributorUnitFromRow: boolean;
  },
): TopGrowthRow[] {
  const rows: TopGrowthRow[] = [];
  for (const [name, { curr, prev }] of sums) {
    const delta = curr - prev;
    // Noise filter — mirrors the sales/bom delta thresholds above.
    if (Math.abs(delta) < opts.threshold) continue;
    const isNew = !prev || prev === 0;
    const contributors = topContributors(
      subMaps.get(name) ?? new Map<string, { curr: number; prev: number }>(),
      opts.contributorUnits,
      opts.contributorUnitFromRow,
      name,
    );
    rows.push({ name, curr, prev, delta, pct: calcGrowth(curr, prev), isNew, unit: opts.rowUnits?.get(name) ?? null, contributors });
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
  // TWO scans (TASK H-6), each on a REAL per-grain source:
  //   1. per-outlet SALES — OutletPeriodSales.salesMode (canonical;
  //      nominalSales is outlet-level denormalized — summing it by row
  //      was the "drill down salah" bug: every number was Sales ×
  //      rowCount).
  //   2. (outlet × item) BOM-usage matrix — qtyBom is per-row item
  //      data; per-item sums feed the Per Barang grain and the cells
  //      feed BOTH drill-down directions.
  const [salesMap, bom] = await Promise.all([
    aggregateSalesMode(week, month, prevWeek, prevMonth, filters),
    aggregateBomMatrix(week, month, prevWeek, prevMonth, filters),
  ]);
  const { matrix, itemUnits } = bom;

  // Invert the matrix (item → outlets) for the Per Barang drill-down.
  const itemSums = new Map<string, { curr: number; prev: number }>();
  const outletsByItem = new Map<string, Map<string, { curr: number; prev: number }>>();
  for (const [outlet, items] of matrix) {
    for (const [item, cell] of items) {
      const isum = itemSums.get(item) ?? { curr: 0, prev: 0 };
      isum.curr += cell.curr;
      isum.prev += cell.prev;
      itemSums.set(item, isum);
      let outs = outletsByItem.get(item);
      if (!outs) {
        outs = new Map<string, { curr: number; prev: number }>();
        outletsByItem.set(item, outs);
      }
      outs.set(outlet, { curr: cell.curr, prev: cell.prev });
    }
  }

  return {
    // Per Resto — ΔSales in Rp (salesMode; rowUnits null → currency rows).
    // Drill-down: top barang by Δ pemakaian BOM inside the resto
    // (demand-side decomposition — Sales has no item-level breakdown in
    // this data model). Contributor unit = each barang's own satuan.
    byOutlet: shapeTopGrowthRows(salesMap, matrix, {
      threshold: TOP_GROWTH_DELTA_THRESHOLD,
      rowUnits: null,
      contributorUnits: itemUnits,
      contributorUnitFromRow: false,
    }),
    // Per Barang — Δ pemakaian BOM in the item's satuan (rowUnits =
    // itemUnits). Drill-down: top resto driving that item's BOM
    // movement — every contributor's unit = the row item's satuan,
    // since the qty being ranked IS that item's qty.
    byItem: shapeTopGrowthRows(itemSums, outletsByItem, {
      threshold: TOP_GROWTH_BOM_DELTA_THRESHOLD,
      rowUnits: itemUnits,
      contributorUnits: itemUnits,
      contributorUnitFromRow: true,
    }),
    contributorLimit: TOP_GROWTH_CONTRIBUTOR_LIMIT,
    byOutletMetric: 'sales',
    byItemMetric: 'bom',
  };
}
