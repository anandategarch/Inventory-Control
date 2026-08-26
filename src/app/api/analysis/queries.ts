// ============================================================
//  ANALYSIS API — SQL builders + WHERE clause construction
//  All SQL strings live here as functions of the WHERE clause
//  so the route handler can pass the resolved where string in.
// ============================================================
import type { Client, InValue } from '@libsql/client';
import type { FilterParams, CompareResolution } from './types';

/** Resolved WHERE clause (string + bound args). */
export interface WhereClause {
  where: string;
  args: InValue[];
}

// ------------------------------------------------------------
//  WHERE clause builders
// ------------------------------------------------------------

/**
 * Shared SQL CASE expression for chronological month sorting.
 * FIX BUG #4: Previously hardcoded 'Januari 2026', 'Februari 2026', etc.
 * — only worked for 2026. Now extracts year from monthLabel (last 4 chars)
 * and maps month name independently, so it works for ANY year.
 *
 * Returns a single sortable integer: year × 100 + month_number
 * e.g. "Januari 2026" → 202601, "Desember 2027" → 202712
 */
export const MONTH_SORT_CASE = `
  CAST(SUBSTR(r.monthLabel, LENGTH(r.monthLabel) - 3) AS INTEGER) * 100 +
  CASE
    WHEN r.monthLabel LIKE 'Januari%' THEN 1
    WHEN r.monthLabel LIKE 'Februari%' THEN 2
    WHEN r.monthLabel LIKE 'Maret%' THEN 3
    WHEN r.monthLabel LIKE 'April%' THEN 4
    WHEN r.monthLabel LIKE 'Mei%' THEN 5
    WHEN r.monthLabel LIKE 'Juni%' THEN 6
    WHEN r.monthLabel LIKE 'Juli%' THEN 7
    WHEN r.monthLabel LIKE 'Agustus%' THEN 8
    WHEN r.monthLabel LIKE 'September%' THEN 9
    WHEN r.monthLabel LIKE 'Oktober%' THEN 10
    WHEN r.monthLabel LIKE 'November%' THEN 11
    WHEN r.monthLabel LIKE 'Desember%' THEN 12
    ELSE 99
  END
`;

/**
 * FIX BUG #5: Previously hardcoded 'WEEK 1', 'WEEK 2', etc.
 * Now uses LIKE patterns to match any case + extracts the number,
 * so 'Week 1', 'WEEK 1', 'Minggu 1' (with 'W%' pattern fallback)
 * all sort correctly.
 */
export const WEEK_SORT_CASE = `
  CASE
    WHEN r.weekLabel LIKE '%1' AND r.weekLabel NOT LIKE '%10%' AND r.weekLabel NOT LIKE '%11%' AND r.weekLabel NOT LIKE '%12%' THEN 1
    WHEN r.weekLabel LIKE '%2' AND r.weekLabel NOT LIKE '%12%' AND r.weekLabel NOT LIKE '%20%' AND r.weekLabel NOT LIKE '%21%' THEN 2
    WHEN r.weekLabel LIKE '%3' AND r.weekLabel NOT LIKE '%13%' AND r.weekLabel NOT LIKE '%23%' AND r.weekLabel NOT LIKE '%30%' THEN 3
    WHEN r.weekLabel LIKE '%4' AND r.weekLabel NOT LIKE '%14%' AND r.weekLabel NOT LIKE '%24%' AND r.weekLabel NOT LIKE '%34%' THEN 4
    WHEN r.weekLabel LIKE '%5' AND r.weekLabel NOT LIKE '%15%' AND r.weekLabel NOT LIKE '%25%' THEN 5
    WHEN r.weekLabel = 'WEEK 6' OR r.weekLabel LIKE 'Week 6%' THEN 6
    ELSE 99
  END
`;

/**
 * Build the WHERE clause used by the main per-item-outlet aggregates,
 * sales, health, DQ, worklist, health-ranking, consistency, and area
 * queries. These all filter on month/week/area/outlet/PIC.
 */
export function buildWhereClause(params: FilterParams): WhereClause {
  const conditions: string[] = [];
  const args: InValue[] = [];
  if (params.monthLabel) {
    conditions.push('r.monthLabel = ?');
    args.push(params.monthLabel);
  }
  if (params.weekLabel) {
    conditions.push('r.weekLabel = ?');
    args.push(params.weekLabel);
  }
  if (params.area) {
    conditions.push('r.area = ?');
    args.push(params.area);
  }
  if (params.outletCode) {
    conditions.push('o.code = ?');
    args.push(params.outletCode);
  }
  if (params.pic) {
    // Filter by PIC via subquery on OutletPIC table
    conditions.push('o.code IN (SELECT outletCode FROM OutletPIC WHERE pic = ?)');
    args.push(params.pic);
  }
  return {
    where: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    args,
  };
}

/**
 * Build the WHERE clause used by the trend query (no month/week filter —
 * we want all periods, only constrained by area/outlet/PIC).
 */
export function buildTrendWhereClause(params: {
  area: string | null;
  outletCode: string | null;
  pic: string | null;
}): WhereClause {
  const parts: string[] = [];
  const args: InValue[] = [];
  if (params.area) {
    parts.push('r.area = ?');
    args.push(params.area);
  }
  if (params.outletCode) {
    parts.push('o.code = ?');
    args.push(params.outletCode);
  }
  if (params.pic) {
    parts.push('o.code IN (SELECT outletCode FROM OutletPIC WHERE pic = ?)');
    args.push(params.pic);
  }
  return {
    where: parts.length > 0 ? 'WHERE ' + parts.join(' AND ') : '',
    args,
  };
}

/**
 * Build the WHERE clause for the comparison-period query.
 * Always filters on the compare month+week; optionally on area/outlet/PIC.
 */
export function buildCompareWhereClause(params: {
  cmpMonth: string | null;
  compareWeek: string;
  area: string | null;
  outletCode: string | null;
  pic: string | null;
}): WhereClause {
  const conditions: string[] = [];
  const args: InValue[] = [];
  conditions.push('r.monthLabel = ?');
  args.push(params.cmpMonth);
  conditions.push('r.weekLabel = ?');
  args.push(params.compareWeek);
  if (params.area) {
    conditions.push('r.area = ?');
    args.push(params.area);
  }
  if (params.outletCode) {
    conditions.push('o.code = ?');
    args.push(params.outletCode);
  }
  if (params.pic) {
    conditions.push('o.code IN (SELECT outletCode FROM OutletPIC WHERE pic = ?)');
    args.push(params.pic);
  }
  return {
    where: 'WHERE ' + conditions.join(' AND '),
    args,
  };
}

// ------------------------------------------------------------
//  SQL builders (functions of the WHERE clause string)
// ------------------------------------------------------------

/** QUERY 1: per-item-outlet aggregates (with JOINs). */
export function aggSql(where: string): string {
  return `
    SELECT
      o.code        AS outletCode,
      o.name        AS outletName,
      o.area        AS area,
      i.name        AS itemName,
      i.satuan      AS satuan,
      SUM(ABS(COALESCE(r.qtyBom, 0)))              AS qtyBom,
      SUM(ABS(COALESCE(r.qtyDeviasi, 0)))          AS qtyDeviasi,
      SUM(ABS(COALESCE(r.qtyWaste, 0)))            AS qtyWaste,
      SUM(ABS(COALESCE(r.qtySusut, 0)))            AS qtySusut,
      SUM(ABS(COALESCE(r.qtyTrial, 0)))            AS qtyTrial,
      SUM(ABS(COALESCE(r.qtyLossSurplus, 0)))      AS qtyLossSurplus,
      SUM(COALESCE(r.nominalDeviasi, 0))           AS nominalDeviasi,
      SUM(ABS(COALESCE(r.nominalWaste, 0)))        AS nominalWaste,
      SUM(ABS(COALESCE(r.nominalSusut, 0)))        AS nominalSusut,
      SUM(ABS(COALESCE(r.nominalTrial, 0)))        AS nominalTrial,
      SUM(ABS(COALESCE(r.nominalLossSurplus, 0)))  AS nominalLossSurplus,
      SUM(COALESCE(r.residualQty, 0))              AS residualQty,
      MAX(r.tolerancePct)                           AS tolerancePct,
      AVG(r.avgPrice)                               AS avgPrice,
      CASE
        WHEN SUM(COALESCE(r.qtyDeviasi, 0)) > 0 THEN 'LOSS'
        WHEN SUM(COALESCE(r.qtyDeviasi, 0)) < 0 THEN 'SURPLUS'
        ELSE 'NEUTRAL'
      END                                          AS direction
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    JOIN Item   i ON r.itemId   = i.id
    ${where}
    GROUP BY o.code, o.name, o.area, i.name, i.satuan
  `;
}

/** QUERY 1b: MAX sales per outlet (denormalized → take MAX to avoid dup). */
export function salesSql(where: string): string {
  return `
    SELECT o.code AS outletCode, MAX(r.nominalSales) AS sales
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${where}
    GROUP BY o.code
  `;
}

/** Health-status breakdown grouped by direction.
 *  FIX P0-4: Added ok_count column with catch-all Normal bucket.
 *  Previously, records that didn't match any specific bucket (abnormal,
 *  warning_residual, warning_nominal, normal_zero) were silently dropped,
 *  causing Normal + Warning + Abnormal < Total. Now ok_count catches ALL
 *  records that are not abnormal or warning.
 */
export function healthSql(where: string): string {
  return `
    SELECT
      r.direction,
      COUNT(*) AS cnt,
      SUM(CASE WHEN r.residualRatio > 0.7 THEN 1 ELSE 0 END) AS abnormal,
      SUM(CASE WHEN r.residualRatio > 0.5 AND r.residualRatio <= 0.7 THEN 1 ELSE 0 END) AS warning_residual,
      SUM(CASE WHEN ABS(r.nominalDeviasi) > 1000000 AND (r.residualRatio IS NULL OR r.residualRatio <= 0.5) THEN 1 ELSE 0 END) AS warning_nominal,
      SUM(CASE
        WHEN r.residualRatio > 0.7 THEN 0
        WHEN r.residualRatio > 0.5 AND r.residualRatio <= 0.7 THEN 0
        WHEN ABS(r.nominalDeviasi) > 1000000 AND (r.residualRatio IS NULL OR r.residualRatio <= 0.5) THEN 0
        ELSE 1
      END) AS ok_count
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${where}
    GROUP BY r.direction
  `;
}

/** DQ status — counts of missing BOM / no tolerance / OK.
 *  FIX §27: Also surfaces duplicate records (same outlet+item+week+akunPenyesuaian)
 *  and sales mismatches (same outlet, different nominalSales values across rows).
 */
export function dqSql(where: string): string {
  return `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN r.qtyBom IS NULL OR r.qtyBom = 0 THEN 1 ELSE 0 END) AS missing_bom,
      SUM(CASE WHEN r.toleranceRaw IS NOT NULL AND r.toleranceRaw LIKE '%BELUM ADA TOLERANSI%' THEN 1 ELSE 0 END) AS no_tolerance,
      SUM(CASE WHEN r.qtyDeviasi IS NULL THEN 1 ELSE 0 END) AS null_deviasi,
      SUM(CASE
        WHEN r.qtyBom IS NULL OR r.qtyBom = 0 THEN 0
        WHEN r.toleranceRaw IS NOT NULL AND r.toleranceRaw LIKE '%BELUM ADA TOLERANSI%' THEN 0
        WHEN r.qtyDeviasi IS NULL THEN 0
        ELSE 1
      END) AS ok_count,
      -- FIX §27: Duplicate detection — same outlet+item+week+akunPenyesuaian
      SUM(CASE WHEN r.id IN (
        SELECT MIN(id) FROM InventoryRecord r2
        WHERE r2.outletId = r.outletId AND r2.itemId = r.itemId
          AND r2.weekLabel = r.weekLabel AND r2.monthLabel = r.monthLabel
        GROUP BY r2.outletId, r2.itemId, r2.weekLabel, r2.monthLabel, r2.akunPenyesuaian
        HAVING COUNT(*) > 1
      ) THEN 1 ELSE 0 END) AS duplicates,
      -- FIX §27: Sales mismatch — same outlet, different sales values across rows
      SUM(CASE WHEN r.nominalSales IS NOT NULL AND r.nominalSales != (
        SELECT MAX(r3.nominalSales) FROM InventoryRecord r3
        WHERE r3.outletId = r.outletId AND r3.monthLabel = r.monthLabel AND r3.weekLabel = r.weekLabel
      ) THEN 1 ELSE 0 END) AS sales_mismatch
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${where}
  `;
}

/** Investigation worklist — top anomalies.
 *  FIX P1-1: Sort by priority first (P1→P2→P3), then by nominal within priority.
 *  Before: purely by ABS(nominalDeviasi) DESC — P1 items buried under high-nominal P3.
 *  After: P1 items always at top, regardless of nominal magnitude.
 */
export function worklistSql(where: string): string {
  return `
    SELECT
      o.code AS outletCode,
      o.name AS outletName,
      o.area AS area,
      i.name AS itemName,
      r.direction AS direction,
      r.nominalDeviasi AS nominalDeviasi,
      ABS(r.nominalDeviasi) AS absNominalDeviasi,
      r.residualRatio AS residualRatio,
      r.pctQtyDeviasiToBom AS pctQtyDeviasiToBom,
      r.tolerancePct AS tolerancePct,
      r.qtyBom AS qtyBom,
      r.qtyDeviasi AS qtyDeviasi
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    JOIN Item   i ON r.itemId   = i.id
    ${where}
    ORDER BY
      CASE
        WHEN ABS(r.nominalDeviasi) > 50000000 OR r.residualRatio > 0.7 THEN 1
        WHEN ABS(r.nominalDeviasi) > 10000000 OR r.residualRatio > 0.5 THEN 2
        ELSE 3
      END,
      ABS(r.nominalDeviasi) DESC
    LIMIT 50
  `;
}

/** Trend — per-week aggregates (devBom computed downstream).
 *  FIX P0-1: Sort chronologically (Jan→Dec) not alphabetically.
 */
export function trendSql(trendWhere: string): string {
  return `
    SELECT
      r.monthLabel AS monthLabel,
      r.weekLabel  AS weekLabel,
      SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS nominal,
      SUM(ABS(COALESCE(r.qtyDeviasi, 0)))    AS qtyDeviasi,
      SUM(ABS(COALESCE(r.qtyBom, 0)))        AS qtyBom
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${trendWhere}
    GROUP BY r.monthLabel, r.weekLabel
    ORDER BY ${MONTH_SORT_CASE}, ${WEEK_SORT_CASE}
  `;
}

/** Trend sales — MAX per outlet, summed per period downstream. */
export function trendSalesSql(trendWhere: string): string {
  return `
    SELECT
      r.monthLabel AS monthLabel,
      r.weekLabel  AS weekLabel,
      MAX(r.nominalSales) AS sales
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${trendWhere}
    GROUP BY r.monthLabel, r.weekLabel, r.outletId
  `;
}

/** Comparison-period aggregates (BOM/deviasi/nominal — no sales). */
export function cmpSql(cmpWhere: string): string {
  return `
    SELECT
      SUM(ABS(COALESCE(r.qtyBom, 0))) AS qtyBom,
      SUM(ABS(COALESCE(r.qtyDeviasi, 0))) AS qtyDeviasi,
      SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS nominalDeviasi,
      AVG(r.avgPrice) AS avgPrice
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${cmpWhere}
  `;
}

/** Comparison-period sales — SUM of MAX-per-outlet subquery. */
export function cmpSalesSql(cmpWhere: string): string {
  return `
    SELECT SUM(s.per_outlet_sales) AS sales
    FROM (
      SELECT MAX(r.nominalSales) AS per_outlet_sales
      FROM InventoryRecord r
      JOIN Outlet o ON r.outletId = o.id
      ${cmpWhere}
      GROUP BY r.outletId
    ) s
  `;
}

/** Variance analysis — current-period signed nominal per item-outlet. */
export function vaCurrentSql(opts: {
  area: string | null;
  outletCode: string | null;
  pic: string | null;
}): string {
  return `
    SELECT
      o.code AS outletCode, o.name AS outletName,
      i.name AS itemName,
      SUM(COALESCE(r.nominalDeviasi, 0)) AS nominal,
      SUM(COALESCE(r.qtyDeviasi, 0)) AS qtyDeviasi
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    JOIN Item i ON r.itemId = i.id
    WHERE r.monthLabel = ? AND r.weekLabel = ?
      ${opts.area ? 'AND r.area = ?' : ''}
      ${opts.outletCode ? 'AND o.code = ?' : ''}
      ${opts.pic ? 'AND o.code IN (SELECT outletCode FROM OutletPIC WHERE pic = ?)' : ''}
    GROUP BY o.code, o.name, i.name
  `;
}

/** Variance analysis — previous-period signed nominal per item-outlet. */
export function vaPrevSql(opts: {
  area: string | null;
  outletCode: string | null;
  pic: string | null;
}): string {
  return `
    SELECT
      o.code AS outletCode,
      o.name AS outletName,
      i.name AS itemName,
      SUM(COALESCE(r.nominalDeviasi, 0)) AS nominal,
      SUM(COALESCE(r.qtyDeviasi, 0)) AS qtyDeviasi
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    JOIN Item i ON r.itemId = i.id
    WHERE r.monthLabel = ? AND r.weekLabel = ?
      ${opts.area ? 'AND r.area = ?' : ''}
      ${opts.outletCode ? 'AND o.code = ?' : ''}
      ${opts.pic ? 'AND o.code IN (SELECT outletCode FROM OutletPIC WHERE pic = ?)' : ''}
    GROUP BY o.code, i.name
  `;
}

/** Outlet-health-ranking — per-outlet metrics for scoring. */
export function healthRankSql(where: string): string {
  return `
    SELECT
      o.code AS outletCode,
      o.name AS outletName,
      o.area AS area,
      SUM(ABS(COALESCE(r.qtyBom, 0))) AS qtyBom,
      SUM(ABS(COALESCE(r.qtyDeviasi, 0))) AS qtyDeviasi,
      SUM(ABS(COALESCE(r.residualQty, 0))) AS residualQty,
      SUM(CASE WHEN r.nominalDeviasi > 0 THEN r.nominalDeviasi ELSE 0 END) AS totalLoss,
      MAX(r.nominalSales) AS sales,
      SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS absNominalDeviasi,
      SUM(CASE WHEN r.residualRatio > 0.7 THEN 1 ELSE 0 END) AS abnormalCount,
      COUNT(*) AS totalItemCount
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${where}
    GROUP BY o.code, o.name, o.area
  `;
}

/** Item consistency — items appearing in ≥2 outlets. */
export function consistencySql(where: string): string {
  return `
    SELECT
      i.name AS itemName,
      i.satuan AS satuan,
      COUNT(DISTINCT o.code) AS outletCount,
      SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS totalAbsNominal,
      AVG(CASE WHEN r.qtyBom > 0 THEN ABS(r.qtyDeviasi) / r.qtyBom ELSE NULL END) AS avgDevBom,
      SUM(CASE WHEN r.direction = 'LOSS' THEN 1 ELSE 0 END) AS lossOutlets,
      SUM(CASE WHEN r.direction = 'SURPLUS' THEN 1 ELSE 0 END) AS surplusOutlets
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    JOIN Item i ON r.itemId = i.id
    ${where}
    GROUP BY i.name, i.satuan
    HAVING COUNT(DISTINCT o.code) >= 2
    ORDER BY SUM(ABS(COALESCE(r.nominalDeviasi, 0))) DESC
    LIMIT 15
  `;
}

/** Area-level aggregates. */
export function areaSql(where: string): string {
  return `
    SELECT
      r.area AS area,
      COUNT(DISTINCT o.code) AS outletCount,
      SUM(ABS(COALESCE(r.qtyBom, 0))) AS qtyBom,
      SUM(ABS(COALESCE(r.qtyDeviasi, 0))) AS qtyDeviasi,
      SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS absNominal,
      SUM(CASE WHEN r.nominalDeviasi > 0 THEN r.nominalDeviasi ELSE 0 END) AS totalLoss
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${where}
    GROUP BY r.area
    ORDER BY SUM(ABS(COALESCE(r.nominalDeviasi, 0))) DESC
  `;
}

/** Area-level sales (MAX per outlet, then summed per area). */
export function areaSalesSql(where: string): string {
  return `
    SELECT r.area AS area, MAX(r.nominalSales) AS sales, r.outletId
    FROM InventoryRecord r
    JOIN Outlet o ON r.outletId = o.id
    ${where}
    GROUP BY r.area, r.outletId
  `;
}

// ------------------------------------------------------------
//  Auto-compare period resolution
// ------------------------------------------------------------

/**
 * AUTO-COMPARE: if no compareWeek is provided, find the chronologically
 * previous (monthLabel, weekLabel) pair relative to the current period.
 * Returns the resolved compareWeek/compareMonth and the compareMode flag.
 */
export async function resolveAutoComparePeriod(
  client: Client,
  monthLabel: string | null,
  currentWeek: string | null,
  compareWeekRaw: string | null
): Promise<CompareResolution> {
  let compareWeek: string | null = null;
  let compareMonth: string | null = null;
  let compareMode: 'auto' | 'manual' = 'manual';

  if (compareWeekRaw && compareWeekRaw.includes('|||')) {
    const [wk, ml] = compareWeekRaw.split('|||');
    compareWeek = wk;
    compareMonth = ml;
  } else if (compareWeekRaw) {
    compareWeek = compareWeekRaw;
  } else {
    compareMode = 'auto';
  }

  if (compareMode === 'auto' && monthLabel && currentWeek) {
    try {
      // FIX BUG #4/#5: Use LIKE patterns (not hardcoded year) for multi-year support
      const periodsRes = await client.execute(`
        SELECT DISTINCT monthLabel, weekLabel
        FROM InventoryRecord
        ORDER BY
          CAST(SUBSTR(monthLabel, LENGTH(monthLabel) - 3) AS INTEGER) * 100 +
          CASE
            WHEN monthLabel LIKE 'Januari%' THEN 1
            WHEN monthLabel LIKE 'Februari%' THEN 2
            WHEN monthLabel LIKE 'Maret%' THEN 3
            WHEN monthLabel LIKE 'April%' THEN 4
            WHEN monthLabel LIKE 'Mei%' THEN 5
            WHEN monthLabel LIKE 'Juni%' THEN 6
            WHEN monthLabel LIKE 'Juli%' THEN 7
            WHEN monthLabel LIKE 'Agustus%' THEN 8
            WHEN monthLabel LIKE 'September%' THEN 9
            WHEN monthLabel LIKE 'Oktober%' THEN 10
            WHEN monthLabel LIKE 'November%' THEN 11
            WHEN monthLabel LIKE 'Desember%' THEN 12
            ELSE 99
          END,
          CASE
            WHEN weekLabel LIKE '%1' AND weekLabel NOT LIKE '%10%' AND weekLabel NOT LIKE '%11%' AND weekLabel NOT LIKE '%12%' THEN 1
            WHEN weekLabel LIKE '%2' AND weekLabel NOT LIKE '%12%' AND weekLabel NOT LIKE '%20%' AND weekLabel NOT LIKE '%21%' THEN 2
            WHEN weekLabel LIKE '%3' AND weekLabel NOT LIKE '%13%' AND weekLabel NOT LIKE '%23%' AND weekLabel NOT LIKE '%30%' THEN 3
            WHEN weekLabel LIKE '%4' AND weekLabel NOT LIKE '%14%' AND weekLabel NOT LIKE '%24%' AND weekLabel NOT LIKE '%34%' THEN 4
            WHEN weekLabel LIKE '%5' AND weekLabel NOT LIKE '%15%' AND weekLabel NOT LIKE '%25%' THEN 5
            ELSE 99
          END
      `);
      const periods = periodsRes.rows as unknown as Array<{ monthLabel: string; weekLabel: string }>;
      const currentIdx = periods.findIndex(
        (p) => p.monthLabel === monthLabel && p.weekLabel === currentWeek
      );
      if (currentIdx > 0) {
        const prev = periods[currentIdx - 1];
        compareWeek = prev.weekLabel;
        compareMonth = prev.monthLabel;
      }
    } catch (e) {
      // Non-fatal — growth comparison will just be null
      console.error('[analysis] Auto-compare failed:', e);
    }
  }

  return { compareWeek, compareMonth, compareMode };
}
