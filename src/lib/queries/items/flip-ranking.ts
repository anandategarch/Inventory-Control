// ============================================================
//  Flip Ranking — cross-period flip pattern detection
//  --------------------------------------------------------
//  Scans ALL items and ranks them by "flip pattern" — balanced
//  reversal of qtyDeviasiSigned between same-week periods across
//  different months. A "perfect flip" (sempurna) occurs when an
//  item shows e.g. +100 in Jul W4 and -98 in Agu W4 (signs flip
//  AND magnitudes nearly match) — suspicious because it suggests
//  offsetting adjustments rather than genuine operational swings.
//
//  Formula (same as frontend):
//    For each item, group periods by weekLabel, sort by monthKey.
//    For each consecutive same-week pair (P1=earlier, P2=later):
//      isFlip = sign(qtyDeviasiSigned_P1) !== sign(qtyDeviasiSigned_P2)
//               AND both non-zero
//      net = P1.qtyDeviasiSigned + P2.qtyDeviasiSigned
//      maxMagnitude = MAX(|P1.qtyDeviasiSigned|, |P2.qtyDeviasiSigned|)
//      disparity = |net| / maxMagnitude   (0.0 to 1.0)
//
//  Categories per pair:
//    sempurna  — isFlip AND disparity < 0.10 (0-10%)
//    dominan   — isFlip AND disparity 0.10-0.40
//    parsial   — isFlip AND disparity >= 0.40
//    konsisten — NOT flip
//
//  Item aggregate score:
//    riskScore = min(100, sempurnaCount * 30 + flipCount * 10)
//    riskLevel = sempurnaCount > 0 ? 'high' : flipCount > 0 ? 'moderate' : 'low'
//
//  Implementation notes (mirrors item-trend-rank.ts):
//  - Fetch per-(period, item) SIGNED SUM(qtyDeviasi) aggregates for
//    ALL items via SQL (~153 items × ~8 periods = ~1224 rows — light).
//    Mirrors item-trend-rank's `item_per_period` CTE shape but uses
//    SIGNED SUM(qtyDeviasi) instead of ABS SUM(nominalDeviasi).
//  - Compute flip analysis in JS — sequential pair analysis per
//    (item, week) requires sorting + pair iteration, which is complex
//    to express correctly in SQL. JS is also cheaper for ~1224 rows.
//  - Uses `withStatementTimeout` for the SQL query.
//  - Uses `buildSqlFilters` for area/kelompok/outletCode/picOutletCodes.
//    itemName is NOT passed through filters (this query scans ALL items;
//    buildSqlFilters' LIKE filter would over-match a substring against
//    item names — we want every distinct item to appear in the ranking).
//  - Prisma.sql tagged templates (zero $queryRawUnsafe).
//  - Coerce BigInt/Decimal → Number (Prisma raw returns Decimal for SUM;
//    JSON.stringify would throw on BigInt without coercion — none used
//    here, but Number() is defensive in case the schema adds aggregates).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

// ------------------------------------------------------------
//  Public types
// ------------------------------------------------------------

/** A single flip pair (top 3 most balanced per item returned to client). */
export interface FlipPair {
  /** Short label for P1, e.g. "Jul W4". */
  period1Label: string;
  /** Short label for P2, e.g. "Agu W4". */
  period2Label: string;
  /** weekLabel shared by both periods (e.g. "WEEK 4"). */
  weekLabel: string;
  /** P1 SIGNED qty deviasi (sum across the period). */
  qtyP1: number;
  /** P2 SIGNED qty deviasi (sum across the period). */
  qtyP2: number;
  /** P1 + P2 (closer to 0 = more balanced reversal). */
  net: number;
  /** disparity × 100, rounded to 1 decimal (0.0 to 100.0). */
  disparityPct: number;
  /** 'sempurna' | 'dominan' | 'parsial' — only set for flip pairs. */
  category: string;
}

export interface FlipRankItem {
  itemName: string;
  /** Total same-week consecutive pairs analyzed for this item. */
  totalPairs: number;
  /** Pairs where signs flip AND both non-zero. */
  flipCount: number;
  /** Flips with disparity < 10%. */
  sempurnaCount: number;
  /** Flips with disparity 10-40%. */
  dominanCount: number;
  /** Flips with disparity >= 40%. */
  parsialCount: number;
  /** Non-flip pairs (signs match OR either side is zero). */
  konsistenCount: number;
  /** Mean disparity of flip pairs only (0-1). 0 when no flips. */
  avgDisparity: number;
  /** 0-100. min(100, sempurnaCount * 30 + flipCount * 10). */
  riskScore: number;
  /** 'high' if sempurnaCount > 0, else 'moderate' if flipCount > 0, else 'low'. */
  riskLevel: 'low' | 'moderate' | 'high';
  /** Top 3 most balanced flips (lowest disparityPct first). */
  topFlips: FlipPair[];
}

export interface FlipRankResult {
  items: FlipRankItem[];
  /** Count of ALL items scanned (before slicing to `limit`). */
  totalItemsScanned: number;
}

// ------------------------------------------------------------
//  Internal helpers
// ------------------------------------------------------------

/**
 * Short period label "Jul W4" (matches frontend periodShortLabel
 * convention in src/components/dashboard/tabs/ItemTrendTab/periodHelpers.ts).
 *   monthLabel "Juli 2026" → "Jul"
 *   weekLabel "WEEK 4"     → "W4"
 */
function periodShortLabel(monthLabel: string, weekLabel: string): string {
  const mon = monthLabel.slice(0, 3);
  const wk = weekLabel.replace('WEEK ', 'W');
  return `${mon} ${wk}`;
}

/**
 * Categorize a flip pair by disparity ratio (0-1 range):
 *   < 0.10 → 'sempurna'
 *   < 0.40 → 'dominan'
 *   else   → 'parsial'
 */
function categorizeFlip(disparity: number): 'sempurna' | 'dominan' | 'parsial' {
  if (disparity < 0.10) return 'sempurna';
  if (disparity < 0.40) return 'dominan';
  return 'parsial';
}

/** Raw row shape returned by the SQL query. */
interface RawPeriodRow {
  monthLabel: string;
  weekLabel: string;
  monthKey: string | null;
  itemName: string;
  /** SUM(ir."qtyDeviasi") — signed (positive = SURPLUS, negative = LOSS). */
  qtyDeviasiSigned: number;
}

// ------------------------------------------------------------
//  Query function
// ------------------------------------------------------------

/**
 * Scan ALL items and rank them by flip pattern risk.
 *
 * Returns the top `limit` items with the highest risk scores
 * (sempurna flips weighted highest). For each item, computes:
 *   - totalPairs: total same-week consecutive pairs
 *   - flipCount: pairs where signs flip (both non-zero)
 *   - sempurnaCount: flips with disparity < 10%
 *   - riskScore: min(100, sempurnaCount * 30 + flipCount * 10)
 *   - riskLevel: 'high' | 'moderate' | 'low'
 *
 * Approach:
 *   1. SQL fetches per-(period, item) SIGNED SUM(qtyDeviasi) aggregates
 *      for ALL items (~153 items × ~8 periods = ~1224 rows — light).
 *      Filtered to rows where qtyDeviasi IS NOT NULL so periods with
 *      no deviasi data don't pollute the SUM with zeros.
 *   2. JS groups rows by itemName, then by weekLabel, sorts each week
 *      group by monthKey ASC, computes consecutive pairs + flip analysis
 *      per pair, then aggregates per item.
 *   3. Sorts items by riskScore DESC, sempurnaCount DESC, flipCount DESC,
 *      then slices to the top `limit` items.
 *
 * @param filters    Dashboard filters (area, kelompok, outletCode,
 *                   picOutletCodes). itemName in filters is IGNORED —
 *                   this query scans ALL items.
 * @param weekLabel  Optional week filter (e.g. "WEEK 4"). When set, only
 *                   that week across all months is considered (W4 of
 *                   Januari, Februari, Maret, ...). When null, ALL weeks
 *                   are considered.
 * @param monthLabel Optional month filter (e.g. "Juli 2026"). When set,
 *                   only flip pairs where at least one period (P1 or P2)
 *                   matches this month are counted. This scopes the ranking
 *                   to flips involving the user's selected month.
 * @param limit      Max items to return (default 20). Caller is expected
 *                   to cap this (route enforces max 50).
 */
export async function queryFlipRanking(
  filters: SqlFilterOpts,
  weekLabel?: string | null,
  monthLabel?: string | null,
  limit: number = 20,
): Promise<FlipRankResult> {
  // itemName is NOT passed to buildSqlFilters — this query scans ALL items.
  // (buildSqlFilters' LIKE filter would over-match a substring against
  // item names; we want every distinct item to appear in the ranking.)
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  // Build week filter — if weekLabel provided, only include that week across
  // all months (e.g. WEEK 4 → only W4 of Januari, Februari, Maret, etc.)
  // Same pattern as item-trend-rank.ts + item-trend.ts.
  const weekFilter = weekLabel
    ? Prisma.sql`AND ir."weekLabel" = ${weekLabel}`
    : Prisma.empty;

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<RawPeriodRow>>`
    SELECT
      ir."monthLabel",
      ir."weekLabel",
      MAX(sf."monthKey") as "monthKey",
      i.name as "itemName",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasiSigned"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    LEFT JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."qtyDeviasi" IS NOT NULL
      ${f}
      ${weekFilter}
    GROUP BY ir."monthLabel", ir."weekLabel", i.name
    ORDER BY i.name ASC, MAX(sf."monthKey") ASC NULLS LAST, ir."weekLabel" ASC
  `);

  // Coerce Decimal → Number (defensive — Prisma raw returns Decimal for SUM).
  const periodRows: RawPeriodRow[] = rows.map((r) => ({
    monthLabel: r.monthLabel,
    weekLabel: r.weekLabel,
    monthKey: r.monthKey ?? null,
    itemName: r.itemName,
    qtyDeviasiSigned: Number(r.qtyDeviasiSigned) || 0,
  }));

  // Group by itemName → list of period rows.
  const byItem = new Map<string, RawPeriodRow[]>();
  for (const r of periodRows) {
    const arr = byItem.get(r.itemName) ?? [];
    arr.push(r);
    byItem.set(r.itemName, arr);
  }

  const items: FlipRankItem[] = [];

  for (const [itemName, itemRows] of byItem) {
    // Group by weekLabel within this item.
    const byWeek = new Map<string, RawPeriodRow[]>();
    for (const r of itemRows) {
      const arr = byWeek.get(r.weekLabel) ?? [];
      arr.push(r);
      byWeek.set(r.weekLabel, arr);
    }

    let totalPairs = 0;
    let flipCount = 0;
    let sempurnaCount = 0;
    let dominanCount = 0;
    let parsialCount = 0;
    let konsistenCount = 0;
    let disparitySum = 0;
    const allFlips: FlipPair[] = [];

    for (const [, weekRows] of byWeek) {
      // Sort by monthKey ASC (nulls last — treat null as chronologically
      // latest so it never sorts before a real monthKey).
      weekRows.sort((a, b) => {
        const ak = a.monthKey ?? '9999-99';
        const bk = b.monthKey ?? '9999-99';
        if (ak < bk) return -1;
        if (ak > bk) return 1;
        return 0;
      });

      // Compute consecutive pairs: (i, i+1).
      // e.g. 3 same-week periods (Jan, Feb, Mar) → 2 pairs (Jan,Feb) + (Feb,Mar).
      for (let i = 0; i + 1 < weekRows.length; i++) {
        const p1 = weekRows[i];
        const p2 = weekRows[i + 1];

        // FIX (USER-REQ): if monthLabel filter is set, only count pairs where
        // at least one period (P1 or P2) matches the selected month. This scopes
        // the ranking to flips involving the user's filtered month.
        if (monthLabel && p1.monthLabel !== monthLabel && p2.monthLabel !== monthLabel) {
          continue;
        }

        const v1 = p1.qtyDeviasiSigned;
        const v2 = p2.qtyDeviasiSigned;

        totalPairs += 1;

        const sign1 = Math.sign(v1);
        const sign2 = Math.sign(v2);
        // isFlip = signs differ AND both non-zero.
        const isFlip = sign1 !== 0 && sign2 !== 0 && sign1 !== sign2;

        if (!isFlip) {
          konsistenCount += 1;
          continue;
        }

        // Compute disparity (0 = perfectly balanced reversal, 1 = one-sided).
        const net = v1 + v2;
        const maxMagnitude = Math.max(Math.abs(v1), Math.abs(v2));
        const disparity = maxMagnitude > 0 ? Math.abs(net) / maxMagnitude : 0;
        const category = categorizeFlip(disparity);

        flipCount += 1;
        disparitySum += disparity;

        if (category === 'sempurna') sempurnaCount += 1;
        else if (category === 'dominan') dominanCount += 1;
        else parsialCount += 1;

        allFlips.push({
          period1Label: periodShortLabel(p1.monthLabel, p1.weekLabel),
          period2Label: periodShortLabel(p2.monthLabel, p2.weekLabel),
          weekLabel: p1.weekLabel,
          qtyP1: v1,
          qtyP2: v2,
          net,
          disparityPct: Number((disparity * 100).toFixed(1)),
          category,
        });
      }
    }

    const avgDisparity = flipCount > 0 ? disparitySum / flipCount : 0;
    const riskScore = Math.min(100, sempurnaCount * 30 + flipCount * 10);
    const riskLevel: 'low' | 'moderate' | 'high' =
      sempurnaCount > 0 ? 'high' : flipCount > 0 ? 'moderate' : 'low';

    // Top 3 most balanced flips = lowest disparityPct ASC (most balanced first).
    allFlips.sort((a, b) => a.disparityPct - b.disparityPct);
    const topFlips = allFlips.slice(0, 3);

    items.push({
      itemName,
      totalPairs,
      flipCount,
      sempurnaCount,
      dominanCount,
      parsialCount,
      konsistenCount,
      avgDisparity: Number(avgDisparity.toFixed(4)),
      riskScore,
      riskLevel,
      topFlips,
    });
  }

  // Sort items by riskScore DESC, sempurnaCount DESC, flipCount DESC.
  items.sort((a, b) => {
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
    if (b.sempurnaCount !== a.sempurnaCount) return b.sempurnaCount - a.sempurnaCount;
    return b.flipCount - a.flipCount;
  });

  const totalItemsScanned = items.length;
  const top = items.slice(0, Math.max(0, limit));

  return { items: top, totalItemsScanned };
}
