// ============================================================
//  Pareto Historical — fetch historical stats for Pareto dimensions
//  --------------------------------------------------------
//  For each dimension (item/outlet/area/kelompok/pic), computes the
//  average + stddev of totalAbsNominal across same weekLabel in
//  previous months. Returns a Map<name, { histAvg, histStdDev, histN }>
//  for z-score computation.
//
//  z-score = (current - histAvg) / histStdDev
//  |z| > 2 = ABNORMAL, |z| > 1 = ELEVATED
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import { sameWeekHistoricalWindow } from '../historical-baseline';

export async function queryParetoHistorical(
  week: string,
  month: string,
  dimension: 'item' | 'outlet' | 'area' | 'kelompok' | 'pic',
  filters: SqlFilterOpts,
  // FIX (BUG2-PARETO-1): pass currentMonthKey to filter out FUTURE months.
  // The old code only excluded `monthLabel != ${month}` — included future months
  // if they exist in DB, inflating/shifting the historical mean+stddev.
  currentMonthKey?: string,
): Promise<Map<string, { histAvg: number; histStdDev: number; histN: number }>> {
  const f = buildSqlFilters(filters);

  // Different GROUP BY expression per dimension
  // FIX (BUG-KELOMPOK-EMPTY): kelompok extraction uses LEFT(SUBSTRING(code FROM '[^.]+$'), 3)
  // to get the 3-char prefix of the LAST dot-segment (the name prefix). The old
  // SUBSTRING(... POSITION('.' IN code)+1 FOR 3) grabbed chars after the FIRST dot
  // — wrong for format 2 ("B.1001.MLGPAR" → "100", not "MLG"). Now consistent with
  // buildSqlFilters + queryParetoByKelompok.
  const groupExpr = dimension === 'item'
    ? Prisma.sql`i.name`
    : dimension === 'outlet'
      ? Prisma.sql`o.code`
      : dimension === 'area'
        ? Prisma.sql`o.area`
        : dimension === 'kelompok'
          ? Prisma.sql`LEFT(SUBSTRING(o.code FROM '[^.]+$'), 3)`
          : Prisma.sql`COALESCE(pic.pic, 'Unassigned')`;

  const joinItem = dimension === 'item'
    ? Prisma.sql`JOIN "Item" i ON ir."itemId" = i.id`
    : Prisma.empty;
  const joinOutlet = dimension !== 'item'
    ? Prisma.sql`JOIN "Outlet" o ON ir."outletId" = o.id`
    : Prisma.empty;
  const joinPIC = dimension === 'pic'
    ? Prisma.sql`LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"`
    : Prisma.empty;

  // Two-level aggregation:
  // 1. weekly_dev: per (dimension, month, week) → 1 observation = SUM(absNominalDeviasi)
  // 2. final: per dimension → AVG + STDDEV across weekly observations
  // Filter: same weekLabel, different monthLabel (historical comparison)
  // FIX (BUG2-PARETO-1): JOIN SourceFile + filter sf."monthKey" < currentMonthKey
  // to exclude FUTURE months. The old code only excluded `monthLabel != ${month}`,
  // which included future months if they exist in DB.
  // AUDIT A2 / MERGE-2-a: the week pin + month exclusion now render via the
  // shared fragment (../historical-baseline.ts sameWeekHistoricalWindow) —
  // `ir."weekLabel" = week AND sf."monthKey" < currentMonthKey`, falling
  // back to the `ir."monthLabel" != month` label form when no monthKey
  // resolves (identical rendered SQL to the previous inline predicates).
  const sameWeekWindow = sameWeekHistoricalWindow({
    recordAlias: 'ir',
    sourceFileAlias: 'sf',
    week,
    currentMonthKey,
    currentMonthLabel: month,
  });
  const joinSourceFile = Prisma.sql`JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id`;
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ name: string; histAvg: number; histStdDev: number; histN: number }>>`
    WITH weekly_dev AS (
      SELECT ${groupExpr} as "name",
        ir."monthLabel", ir."weekLabel",
        ABS(SUM(ir."nominalDeviasi")) as "weeklyTotal"
      FROM "InventoryRecord" ir
      ${joinItem}
      ${joinOutlet}
      ${joinPIC}
      ${joinSourceFile}
      WHERE ${sameWeekWindow}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY ${groupExpr}, ir."monthLabel", ir."weekLabel"
    )
    SELECT "name",
      AVG("weeklyTotal") as "histAvg",
      STDDEV_SAMP("weeklyTotal") as "histStdDev",
      CAST(COUNT(*) AS INTEGER) as "histN"
    FROM weekly_dev
    WHERE "weeklyTotal" IS NOT NULL
    GROUP BY "name"
  `);

  const map = new Map<string, { histAvg: number; histStdDev: number; histN: number }>();
  for (const r of rows) {
    const n = Number(r.histN);
    const mean = Number(r.histAvg) || 0;
    const stdDev = Number(r.histStdDev) || 0;
    if (n >= 2) {
      map.set(r.name, { histAvg: mean, histStdDev: stdDev, histN: n });
    }
  }
  return map;
}
