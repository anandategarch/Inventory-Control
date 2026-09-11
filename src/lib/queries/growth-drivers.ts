// ============================================================
//  Growth Drivers — Pareto 80% analysis per metric (SQL aggregate)
//  --------------------------------------------------------
//  Replaces computeGrowthDrivers JS function (src/app/api/analysis/
//  services/growth-drivers.ts) which iterated over 35K raw currentRecs
//  + prevRecs in RAM to compute SUM(ABS(field)) or SUM(field) per
//  outlet or per item, then computed delta + Pareto in JS.
//
//  This module pushes the per-group SUM to SQL (4 queries in parallel,
//  one per metric). Each query returns ~19 rows (sales/bom) or ~2K rows
//  (qtyDeviasi/nominalDeviasi) instead of 35K raw records. The Pareto
//  80% + top-20-driver logic stays in JS (it's a small post-process).
//
//  Metric → group mapping (matches existing JS):
//    - sales        → groupBy outlet (SUM(ABS(nominalSales)))
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
//  Per-metric SQL aggregation
//  Returns Map<groupName, { curr: number, prev: number }>
// ============================================================
async function aggregateMetric(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: FilterOpts,
  groupBy: 'outlet' | 'item',
  field: 'nominalSales' | 'qtyBom' | 'qtyDeviasi' | 'nominalDeviasi',
  signed: boolean,
): Promise<Map<string, { curr: number; prev: number }>> {
  const f = buildSqlFilters(filters);
  const hasPrev = !!(prevWeek && prevMonth);

  // Group-by projection — outlet uses o.name; item uses i.name.
  const groupExpr = groupBy === 'outlet'
    ? Prisma.sql`o.name`
    : Prisma.sql`i.name`;
  const joinOutlet = groupBy === 'outlet'
    ? Prisma.sql`JOIN "Outlet" o ON ir."outletId" = o.id`
    : Prisma.empty;
  const joinItem = groupBy === 'item'
    ? Prisma.sql`JOIN "Item" i ON ir."itemId" = i.id`
    : Prisma.empty;

  // Field reference — for signed, use raw value; for ABS, wrap in ABS().
  const fieldRef = Prisma.raw(`ir."${field}"`);
  const sumExpr = signed
    ? Prisma.sql`COALESCE(SUM(${fieldRef}), 0)`
    : Prisma.sql`COALESCE(SUM(ABS(${fieldRef})), 0)`;

  // CTE for current period sums
  const currCte = Prisma.sql`
    SELECT ${groupExpr} as name, ${sumExpr} as val
    FROM "InventoryRecord" ir
    ${joinOutlet}
    ${joinItem}
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      AND ${fieldRef} IS NOT NULL
      ${f}
    GROUP BY ${groupExpr}
  `;

  // CTE for prev period sums (empty if no prev)
  const prevCte = hasPrev
    ? Prisma.sql`
      SELECT ${groupExpr} as name, ${sumExpr} as val
      FROM "InventoryRecord" ir
      ${joinOutlet}
      ${joinItem}
      WHERE ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}
        AND ${fieldRef} IS NOT NULL
        ${f}
      GROUP BY ${groupExpr}
    `
    : Prisma.sql`SELECT NULL::text as name, 0::float as val WHERE 1=0`;

  // FULL OUTER JOIN — combine curr + prev per group name
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
  // (FULL OUTER JOIN on 2 CTEs over InventoryRecord — can be slow on large tables).
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ name: string; curr: number | bigint | null; prev: number | bigint | null }>>`
    WITH curr_agg AS (${currCte}),
         prev_agg AS (${prevCte})
    SELECT
      COALESCE(c.name, p.name) as name,
      COALESCE(c.val, 0) as curr,
      COALESCE(p.val, 0) as prev
    FROM curr_agg c
    FULL OUTER JOIN prev_agg p ON c.name = p.name
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
    { key: 'sales', field: 'nominalSales' as const, label: 'Sales', groupBy: 'outlet' as const, signed: false },
    { key: 'bom', field: 'qtyBom' as const, label: 'BOM', groupBy: 'item' as const, signed: false },
    { key: 'qtyDeviasi', field: 'qtyDeviasi' as const, label: 'QTY Deviasi', groupBy: 'item' as const, signed: true },
    { key: 'nominalDeviasi', field: 'nominalDeviasi' as const, label: 'Nominal Deviasi', groupBy: 'item' as const, signed: false },
  ];

  // Run the outlet-grain metric + the merged item-grain metrics in parallel
  const [salesMap, itemMaps] = await Promise.all([
    aggregateMetric(week, month, prevWeek, prevMonth, filters, 'outlet', 'nominalSales', false),
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
//  Top Growth — Top-N SALES movers per resto & per barang
//  --------------------------------------------------------
//  Task H-2c (CHANGE 6): ranking of the biggest nominal SALES
//  movers vs the compare period, in TWO grains:
//    - byOutlet → per resto  (group o.name)
//    - byItem   → per barang (group i.name)
//
//  Period semantics are IDENTICAL to queryGrowthDrivers: prevWeek/
//  prevMonth come from the pipeline's period resolver (auto = same
//  weekLabel in the previous month, or the user's explicit compare
//  period) — the caller passes whatever it resolved for growth.
//
//  Metric config copied verbatim from the `sales` row of the metrics
//  table above: field 'nominalSales', ABS sum (signed=false).
//
//  Shaping (pure JS — no extra SQL):
//    - delta = curr − prev                (SIGNED — sacred sign)
//    - pct   = calcGrowth(curr, prev)     (signed (curr−prev)/|prev|,
//                                          null when prev = 0)
//    - isNew = no previous base (prev 0/absent)
//    - noise filter |delta| >= 1000       (same threshold as `sales`)
//    - sort by |delta| DESC, cap TOP_GROWTH_LIMIT rows per list
// ============================================================
export interface TopGrowthRow {
  name: string;
  curr: number;
  prev: number;
  /** SIGNED delta = curr − prev (negative = sales shrinking). */
  delta: number;
  /** SIGNED growth (curr − prev)/|prev| — null when prev = 0 (new). */
  pct: number | null;
  /** No previous base — pct cannot be computed, UI shows "Baru". */
  isNew: boolean;
}

export interface TopGrowthResult {
  byOutlet: TopGrowthRow[];
  byItem: TopGrowthRow[];
}

const TOP_GROWTH_DELTA_THRESHOLD = 1000;
const TOP_GROWTH_LIMIT = 15;

function shapeTopGrowthRows(map: Map<string, { curr: number; prev: number }>): TopGrowthRow[] {
  const rows: TopGrowthRow[] = [];
  for (const [name, { curr, prev }] of map) {
    const delta = curr - prev;
    // Noise filter — mirrors the `sales` delta threshold above (|Δ| >= 1000).
    if (Math.abs(delta) < TOP_GROWTH_DELTA_THRESHOLD) continue;
    const isNew = !prev || prev === 0;
    rows.push({ name, curr, prev, delta, pct: calcGrowth(curr, prev), isNew });
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
  // Two grains of the SAME sales metric, run in parallel (2 queries —
  // same cost as the outlet-grain half of queryGrowthDrivers).
  const [outletMap, itemMap] = await Promise.all([
    aggregateMetric(week, month, prevWeek, prevMonth, filters, 'outlet', 'nominalSales', false),
    aggregateMetric(week, month, prevWeek, prevMonth, filters, 'item', 'nominalSales', false),
  ]);
  return {
    byOutlet: shapeTopGrowthRows(outletMap),
    byItem: shapeTopGrowthRows(itemMap),
  };
}
