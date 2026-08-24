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
import { db } from '@/lib/db';
import { buildSqlFilters } from './shared';

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

interface FilterOpts {
  area?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  picOutletCodes?: string[] | null;
}

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
  const rows = await db.$queryRaw<Array<{ name: string; curr: number | bigint | null; prev: number | bigint | null }>>`
    WITH curr_agg AS (${currCte}),
         prev_agg AS (${prevCte})
    SELECT
      COALESCE(c.name, p.name) as name,
      COALESCE(c.val, 0) as curr,
      COALESCE(p.val, 0) as prev
    FROM curr_agg c
    FULL OUTER JOIN prev_agg p ON c.name = p.name
  `;

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
//  Pareto 80% — identical to existing JS computePareto
//  Sort by |delta| desc, take top 20 with cumulative share ≤ 80%.
// ============================================================
function computePareto(
  arr: Array<{ item: string; delta: number; pct: number }>,
): DriverResult {
  arr.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const totalDelta = arr.reduce((s, d) => s + Math.abs(d.delta), 0);
  if (totalDelta === 0) return { drivers: [], remainderCount: 0, remainderPct: 0 };
  let cumPct = 0;
  const drivers: DriverEntry[] = [];
  const MAX_DRIVERS = 20;
  for (const d of arr) {
    if (drivers.length >= MAX_DRIVERS) break;
    const sharePct = (Math.abs(d.delta) / totalDelta) * 100;
    cumPct += sharePct;
    drivers.push({
      ...d,
      cumPct: Number(cumPct.toFixed(1)),
      sharePct: Number(sharePct.toFixed(1)),
    });
    if (cumPct >= 80) break;
  }
  return {
    drivers,
    remainderCount: arr.length - drivers.length,
    remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)),
  };
}

// ============================================================
//  Main entry — runs 4 metric aggregations in parallel
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

  // Run all 4 metric aggregations in parallel
  const aggregations = await Promise.all(
    metrics.map((m) =>
      aggregateMetric(week, month, prevWeek, prevMonth, filters, m.groupBy, m.field, m.signed)
        .then((map) => ({ ...m, map }))
    )
  );

  return aggregations.map(({ key, label, groupBy, map }) => {
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
      const pct = prev > 0 ? delta / prev : 0;
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
