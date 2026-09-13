// ============================================================
//  Growth Drivers — Pareto 80% analysis per metric (SQL aggregate)
//  --------------------------------------------------------
//  Extracted from the former src/lib/queries/growth-drivers.ts
//  monolith (REFACTOR-1-a pure-move split — this file holds the
//  queryGrowthDrivers family; the queryTopGrowth family lives in
//  ./top-growth.ts).
//
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
import { buildSqlFilters, computePareto8020, withStatementTimeout } from '../shared';
import type { DriverEntry, DriverResult, GrowthDriverMetric, FilterOpts } from './types';

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
//  Pareto 80% — delegates to shared computePareto8020 in ../shared.
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
