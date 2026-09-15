// ============================================================
//  Outlet Recurrence / Persistence history (ANA-1-D)
//  --------------------------------------------------------
//  For EVERY outlet in the current filter scope, aggregate per
//  (outlet, monthKey) at the SAME weekLabel as the running
//  period, over months BEFORE the running period (monthKey <
//  current monthKey; running + future months excluded), capped
//  to the most recent 12 months.
//
//  GRAIN (critical): a "week" is a CUMULATIVE MTD snapshot
//  (W1=day1-7, W2=1-14, W3=1-21, W4=1-25) — the ONLY valid
//  cross-month comparison is SAME weekLabel (W4 vs W4). This
//  query therefore pins `ir."weekLabel" = ${week}` exactly like
//  the historical baseline in resto-recommendations.ts /
//  fetch-records.ts (monthKey-based filtering), and never sums
//  across different weekLabels of the same month.
//
//  "Periode bermasalah" (abnormal month) — definition uses ONLY
//  thresholds that ALREADY exist in the codebase (no new numbers):
//    abnormal = devBom > FALLBACK_TOLERANCE_PCT
//               OR lossNominal > HIGH_LOSS_NOMINAL_THRESHOLD
//  where per outlet+month (same-week snapshot):
//    devBom     = SUM(ABS(qtyDeviasi)) / NULLIF(SUM(ABS(qtyBom)), 0)
//    lossNominal= SUM(CASE WHEN nominalLossSurplus < 0
//                          THEN ABS(nominalLossSurplus) ELSE 0 END)
//  Threshold sources (both resolved at runtime via
//  getRuntimeThresholds(), src/lib/settings — a folder since the
//  SPLIT-D code-motion split; defaults live in settings/definitions.ts):
//    - FALLBACK_TOLERANCE_PCT — default 0.05
//      (settings/definitions.ts;
//      canonical tolerance fallback, same one used by
//      build-resto-profile.ts abnormalCount when an item has no
//      per-item tolerance).
//    - HIGH_LOSS_NOMINAL_THRESHOLD — default 50_000_000
//      (settings/definitions.ts); this IS the P1 nominal threshold
//      (metrics/definitions.ts:196: "P1_NOMINAL_THRESHOLD =
//      HIGH_LOSS_NOMINAL_THRESHOLD (default 50,000,000)").
//
//  FIX (BUG-2-c): `streak` now requires CALENDAR-consecutive months —
//  monthKey is parsed to an absolute month index (YYYY-MM → year*12+month)
//  and a gap of more than 1 month (e.g. abnormal Jan + Feb with no data +
//  abnormal Mar) BREAKS the run. Previously the streak only counted rows
//  that exist, so months without data silently bridged two non-adjacent
//  abnormal months into a fake "streak 2".
//
//  PURELY ADDITIVE: this module computes NOTHING that feeds
//  priorityScore, signal weights, or the existing queries —
//  it only attaches an optional `history` field to each
//  recommendation in /api/recommendations.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

/** Max historical months per outlet in the recurrence window. */
export const OUTLET_RECURRENCE_WINDOW_MONTHS = 12;

/** Recurrence classification:
 *  - REKUREN : abnormal in >= 2 of the available months
 *  - SEKALI  : abnormal in exactly 1 month
 *  - STABIL  : never abnormal */
export type OutletRecurrenceClassification = 'REKUREN' | 'SEKALI' | 'STABIL';

/** Per-outlet recurrence summary (the `history` payload field). */
export interface OutletRecurrenceHistory {
  /** Historical months actually available in the window (same weekLabel, before current). */
  periodCount: number;
  /** Months where devBom > tolerance fallback OR lossNominal > P1 nominal threshold. */
  abnormalCount: number;
  /** Consecutive abnormal run ending at the most recent historical month.
   *  FIX (BUG-2-c): "consecutive" means CALENDAR-consecutive months — a
   *  month with no data breaks the run (abnormal Jan + empty Feb + abnormal
   *  Mar = streak 1, not 2). */
  streak: number;
  classification: OutletRecurrenceClassification;
}

interface OutletRecurrenceRow {
  outletCode: string;
  periodCount: number | bigint;
  abnormalCount: number | bigint;
  streak: number | bigint;
}

/**
 * Query recurrence history for ALL outlets in the current filter scope.
 *
 * @param month            Running period monthLabel (fallback exclusion when currentMonthKey is null)
 * @param week            Running period weekLabel — historical baseline is SAME-weekLabel only
 * @param currentMonthKey  Running period monthKey ("2026-07"); historical = monthKey < this.
 *                         Null → legacy fallback `monthLabel != month` (matches the pattern in
 *                         resto-recommendations.ts; ordering still uses SourceFile.monthKey).
 * @param filters         Same SqlFilterOpts the recommendations route uses (area/kelompok/
 *                         outletCode/PIC/itemName respected via buildSqlFilters)
 * @param toleranceFallback FALLBACK_TOLERANCE_PCT from getRuntimeThresholds (default 0.05)
 * @param highLossNominal   HIGH_LOSS_NOMINAL_THRESHOLD from getRuntimeThresholds (default 50jt)
 * @returns Map keyed by outletCode; outlets without any same-week historical month are absent.
 */
export async function queryOutletRecurrence(
  month: string,
  week: string,
  currentMonthKey: string | null,
  filters: SqlFilterOpts,
  toleranceFallback: number,
  highLossNominal: number,
): Promise<Map<string, OutletRecurrenceHistory>> {
  const f = buildSqlFilters(filters);

  // Same query pattern as resto-recommendations.ts: Prisma tagged template
  // + buildSqlFilters + withStatementTimeout (30s kill switch).
  //
  // SQL shape:
  //   monthly  — per (outlet, monthKey) same-week sums + abnormal flag
  //   ordered  — ROW_NUMBER() descending by monthKey (most recent = 1) +
  //              the absolute month index parsed from "YYYY-MM"
  //   chained  — FIX (BUG-2-c): flags the rows that BREAK the consecutive
  //              abnormal run: normal months AND calendar gaps > 1 month
  //              (LAG over rnDesc compares each month with the one before
  //              it, i.e. the more recent one — months without data no
  //              longer bridge the streak)
  //   final    — windowed to the last 12 months, then per outlet:
  //     periodCount  = months actually available
  //     abnormalCount= abnormal months
  //     streak       = consecutive abnormal run ending at the most recent
  //                   month = (rnDesc of first chain-breaking month − 1);
  //                   when no month breaks the chain there is none → all of
  //                   them (COUNT(*))
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<OutletRecurrenceRow[]>`
    WITH monthly AS (
      SELECT
        o.code as "outletCode",
        sf."monthKey" as "monthKey",
        CASE WHEN
          (SUM(ABS(ir."qtyDeviasi")) / NULLIF(SUM(ABS(ir."qtyBom")), 0)) > ${toleranceFallback}
          OR SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) > ${highLossNominal}
        THEN TRUE ELSE FALSE END as "abnormal"
      FROM "InventoryRecord" ir
      JOIN "Outlet" o ON ir."outletId" = o.id
      JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
      WHERE ir."weekLabel" = ${week}
        ${currentMonthKey
          ? Prisma.sql`AND sf."monthKey" < ${currentMonthKey}`
          : Prisma.sql`AND ir."monthLabel" != ${month}`
        }
        ${f}
      GROUP BY o.code, sf."monthKey"
    ),
    ordered AS (
      SELECT
        "outletCode",
        "abnormal",
        "monthKey",
        ROW_NUMBER() OVER (PARTITION BY "outletCode" ORDER BY "monthKey" DESC) as "rnDesc",
        -- FIX (BUG-2-c): monthKey "YYYY-MM" → absolute month index
        -- (year*12 + month) so calendar adjacency is a plain −1 check.
        (CAST(split_part("monthKey", '-', 1) AS INTEGER) * 12
          + CAST(split_part("monthKey", '-', 2) AS INTEGER)) as "mIdx"
      FROM monthly
    ),
    chained AS (
      SELECT
        "outletCode",
        "abnormal",
        "rnDesc",
        -- FIX (BUG-2-c): chain-breakers — normal months AND months whose
        -- calendar gap to the previous (more recent) month is > 1 (a month
        -- with NO data simply doesn't appear as a row, so the gap check is
        -- what stops it from silently bridging two non-adjacent abnormals).
        -- rnDesc = 1 only breaks when it is itself normal (streak 0); it is
        -- never a calendar-gap breaker because the chain STARTS there.
        CASE
          WHEN "rnDesc" = 1 THEN NOT "abnormal"
          WHEN NOT "abnormal" THEN TRUE
          WHEN "mIdx" <> LAG("mIdx") OVER (PARTITION BY "outletCode" ORDER BY "rnDesc") - 1 THEN TRUE
          ELSE FALSE
        END as "breaksChain"
      FROM ordered
    )
    SELECT
      "outletCode",
      CAST(COUNT(*) AS INTEGER) as "periodCount",
      CAST(COUNT(*) FILTER (WHERE "abnormal") AS INTEGER) as "abnormalCount",
      CAST(COALESCE(MIN(CASE WHEN "breaksChain" THEN "rnDesc" END) - 1, COUNT(*)) AS INTEGER) as "streak"
    FROM chained
    WHERE "rnDesc" <= ${OUTLET_RECURRENCE_WINDOW_MONTHS}
    GROUP BY "outletCode"
  `);

  const map = new Map<string, OutletRecurrenceHistory>();
  for (const r of rows) {
    const periodCount = Number(r.periodCount) || 0;
    const abnormalCount = Number(r.abnormalCount) || 0;
    const streak = Math.max(0, Math.min(Number(r.streak) || 0, periodCount));
    map.set(r.outletCode, {
      periodCount,
      abnormalCount,
      streak,
      classification: abnormalCount >= 2 ? 'REKUREN' : abnormalCount === 1 ? 'SEKALI' : 'STABIL',
    });
  }
  return map;
}
