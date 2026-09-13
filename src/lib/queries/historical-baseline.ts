// ============================================================
//  Historical Baseline Window — shared same-week SQL fragments
//  --------------------------------------------------------
//  AUDIT A2 / MERGE-2-a: the "same-week historical baseline window"
//  convention was implemented 3× across the historical queries with
//  the core predicates scattered:
//    1. ./pareto/historical.ts — `ir."weekLabel" = ${week}` + month
//       exclusion (BUG2-PARETO-1: `sf."monthKey" < ${currentMonthKey}`,
//       with a label-inequality fallback when no monthKey resolves).
//       Now uses sameWeekHistoricalWindow() below.
//    2. ./historical.ts — per-period pins
//       `(ir."monthLabel" = X AND ir."weekLabel" = Y)` over a
//       CALLER-built period list; the caller (analysis fetch-records
//       / export data-fetcher) already applies the same-week +
//       earlier-than-current-month filters when building that list.
//       Now renders each pin via sameWeekPeriodPin() below.
//    3. ./item-trend.ts — deliberately does NOT use this module:
//       its same-week baseline is computed in JS (the query returns
//       ALL periods; the by-week grouping + self-exclusion happen
//       post-query). There is no SQL window predicate to share, and
//       restructuring the query around one would change its shape.
//       Do not "fix" this — see item-trend.ts' header.
//
//  DOMAIN CONVENTION (why "same week" matters):
//  A week is a CUMULATIVE month-to-date snapshot — WEEK 1 = days
//  1-7, WEEK 2 = days 1-14, WEEK 4 = days 1-25 (every record of the
//  month up to that week's cutoff). Because each weekLabel re-bases
//  its window from day 1, weekLabels are NOT comparable to each
//  other within a month (W4 ⊃ W1). The ONLY valid historical
//  comparison is the SAME weekLabel ACROSS months: W4 Juli vs
//  [W4 Mei, W4 Juni] — never W4 vs W1+W2+W4 (mixing snapshots
//  inflates the mean with smaller partial windows → false positive
//  Z-Scores).
//
//  FUTURE-MONTH EXCLUSION (BUG2-PARETO-1):
//  The baseline must only contain months BEFORE the running month.
//  `monthLabel != current` alone still lets FUTURE months (already
//  ingested for later periods) leak into the baseline, inflating /
//  shifting mean + stddev. The correct form compares
//  SourceFile.monthKey ("YYYY-MM") strictly below the current
//  monthKey. The label-inequality form below is only the fallback
//  for callers that cannot resolve a monthKey.
//
//  Style precedent: H-12 (./items/item-outlet-breakdown.ts) and
//  MERGE-1-a (./items/peer-bucket.ts — shared SQL fragment module).
//  Aliases are interpolated via Prisma.raw: they are static SQL
//  identifiers controlled by the call sites (never user input) —
//  the same convention as ./items/top-items/shared-cte.ts. Only
//  week/month/monthKey values are parameterized ($n bind params).
// ============================================================
import { Prisma } from '@prisma/client';

/** Options for {@link sameWeekHistoricalWindow}. */
export interface SameWeekHistoricalWindowOpts {
  /** SQL alias of the record table (e.g. 'ir' — "InventoryRecord"). */
  recordAlias: string;
  /**
   * SQL alias of the SourceFile join (e.g. 'sf'). REQUIRED for the
   * monthKey-based future-month exclusion — the caller must already
   * `JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id` under this
   * alias. When absent, the fragment falls back to the label form.
   */
  sourceFileAlias?: string | null;
  /** Running period's weekLabel (e.g. 'WEEK 4') — the snapshot being baselined. */
  week: string;
  /**
   * Running period's monthKey (e.g. '2026-07', from SourceFile.monthKey).
   * When truthy → future-month exclusion is monthKey-based
   * (BUG2-PARETO-1 correct form: `sf."monthKey" < ${currentMonthKey}`).
   */
  currentMonthKey?: string | null;
  /**
   * Running period's monthLabel (e.g. 'Juli 2026') — FALLBACK month
   * exclusion by label inequality when currentMonthKey is unavailable
   * (pre-BUG2-PARETO-1 form, kept so callers without a resolvable
   * monthKey keep their old behavior). Non-empty at the live call
   * site (the route 400-guards empty month params).
   */
  currentMonthLabel?: string | null;
}

/**
 * Build the same-week historical baseline window predicate:
 *
 *   <recordAlias>."weekLabel" = ${week}
 *     AND <sourceFileAlias>."monthKey" < ${currentMonthKey}     (preferred)
 *   — or, when no monthKey resolves —
 *   <recordAlias>."weekLabel" = ${week}
 *     AND <recordAlias>."monthLabel" != ${currentMonthLabel}     (fallback)
 *
 * Encodes the core convention of audit A2: pin the SAME cumulative
 * weekLabel across months + exclude future months (see the module
 * header). Parameter order is (week, monthKey|monthLabel) — identical
 * to the predicate that used to be inlined in ./pareto/historical.ts.
 *
 * Rendered SQL is character-identical to the old inline predicate for
 * every parameter combination the call sites use (MERGE-2-a
 * verification); the only difference in the composed query is the
 * whitespace BETWEEN the two conjuncts (single space instead of the
 * old template's newline + indent) — semantically identical SQL.
 *
 * No leading AND — the call site adds its own conjunction.
 */
export function sameWeekHistoricalWindow(opts: SameWeekHistoricalWindowOpts): Prisma.Sql {
  // Prisma.raw is safe: aliases are static SQL identifiers controlled by the
  // call sites ('ir'/'sf') — never user input (same convention as peer-bucket.ts).
  const rec = Prisma.raw(opts.recordAlias);
  const weekPin = Prisma.sql`${rec}."weekLabel" = ${opts.week}`;
  // FIX (BUG2-PARETO-1): monthKey-based exclusion — excludes the current AND
  // future months in one comparison ("YYYY-MM" is lexicographically ordered).
  if (opts.currentMonthKey && opts.sourceFileAlias) {
    const sf = Prisma.raw(opts.sourceFileAlias);
    return Prisma.sql`${weekPin} AND ${sf}."monthKey" < ${opts.currentMonthKey}`;
  }
  // Pre-BUG2-PARETO-1 fallback: label inequality only (cannot exclude future
  // months that share a different label). Used when currentMonthKey is
  // unavailable (no SourceFile row for the running month).
  if (opts.currentMonthLabel) {
    return Prisma.sql`${weekPin} AND ${rec}."monthLabel" != ${opts.currentMonthLabel}`;
  }
  // No month-exclusion inputs at all: week pin only. No live call site
  // reaches this (pareto always passes currentMonthLabel).
  return weekPin;
}

/**
 * Pin ONE exact historical (month × week) period on the record alias:
 *
 *   (<recordAlias>."monthLabel" = ${monthLabel} AND <recordAlias>."weekLabel" = ${weekLabel})
 *
 * Character-identical to the predicate that used to be inlined in
 * ./historical.ts (queryHistoricalStatsMultiMetric periodConditions).
 * The CALLER owns the same-week window semantics — the period list
 * is built with the SAME weekLabel and months before the running
 * period (analysis fetch-records.ts), so the same-week + no-future
 * convention is enforced by the list itself; this fragment only
 * renders each (month, week) pin.
 *
 * @param recordAlias SQL alias of the record table (e.g. 'ir').
 * @param monthLabel  Historical month label (e.g. 'Juni 2026').
 * @param weekLabel   Same cumulative week label as the running period (e.g. 'WEEK 4').
 */
export function sameWeekPeriodPin(recordAlias: string, monthLabel: string, weekLabel: string): Prisma.Sql {
  const rec = Prisma.raw(recordAlias);
  return Prisma.sql`(${rec}."monthLabel" = ${monthLabel} AND ${rec}."weekLabel" = ${weekLabel})`;
}
