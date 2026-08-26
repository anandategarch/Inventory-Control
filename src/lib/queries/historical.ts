// ============================================================
//  Historical Stats — per outlet+item, ONE OBSERVATION PER WEEK
//  --------------------------------------------------------
//  FIX (audit issues #1, #2): Each week is 1 observation using
//  aggregate Dev/BOM = SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom)).
//  Then mean/stddev computed across weekly observations.
//
//  Previously: AVG(ABS(pctQtyDeviasiToBom)) across ALL records →
//  weeks with more rows got more weight, and n = row count not
//  week count → HISTORICAL_MIN_WEEKS check was meaningless.
//
//  Returns ~N rows (outlet+item pairs) instead of 540K raw records
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, type SqlFilterOpts } from './shared';

export async function queryHistoricalStats(
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>,
  filters: SqlFilterOpts
): Promise<Map<string, { mean: number; stdDev: number; n: number }>> {
  if (historicalPeriods.length === 0) return new Map();

  const f = buildSqlFilters(filters);

  // P0-3 fix: use OR conditions instead of string concat for index usage
  const periodConditions = historicalPeriods.map((p) =>
    Prisma.sql`(ir."monthLabel" = ${p.monthLabel} AND ir."weekLabel" = ${p.weekLabel})`
  );
  const periodFilter = Prisma.join(periodConditions, ' OR ');

  // Two-level aggregation:
  // 1. weekly_dev: per outlet+item+week → 1 observation = SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom))
  // 2. final: per outlet+item → mean/stddev/n across weekly observations
  const rows = await db.$queryRaw<{
    outletId: number; itemId: number; mean: number; sumSq: number; n: number;
  }[]>`
    WITH weekly_dev AS (
      SELECT ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "weeklyDevBom"
      FROM "InventoryRecord" ir
      WHERE (${periodFilter})
        ${f}
      GROUP BY ir."outletId", ir."itemId", ir."monthLabel", ir."weekLabel"
    )
    SELECT "outletId", "itemId",
      AVG("weeklyDevBom") as mean,
      SUM("weeklyDevBom" * "weeklyDevBom") as "sumSq",
      CAST(COUNT(*) AS INTEGER) as n
    FROM weekly_dev
    WHERE "weeklyDevBom" IS NOT NULL
    GROUP BY "outletId", "itemId"
  `;

  const map = new Map<string, { mean: number; stdDev: number; n: number }>();
  for (const r of rows) {
    // Sample variance (N-1, Bessel's correction) — same as STDDEV_SAMP
    // Var = (Σx² - n·mean²) / (n-1)
    // Coerce to Number — SQLite returns BigInt for COUNT/SUM, JSON can't serialize BigInt
    const n = Number(r.n);
    const mean = Number(r.mean) || 0;
    const sumSq = Number(r.sumSq) || 0;
    const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
    const stdDev = Math.sqrt(variance);
    map.set(`${r.outletId}|${r.itemId}`, { mean, stdDev, n });
  }
  return map;
}
