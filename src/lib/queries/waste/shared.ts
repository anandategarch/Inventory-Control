// ============================================================
//  Waste Series — shared constants + helpers (DEEP-WASTE-1/2)
//  --------------------------------------------------------
//  GODSPLIT-W1-B: moved verbatim out of waste-series.ts (was a
//  773-LOC two-pipeline monolith) so that network.ts (pipeline 1,
//  queryWasteNetwork) and peer-zscore.ts (pipeline 2, queryWaste-
//  PeerZScore) can share them. waste-series.ts is now a barrel.
//
//  GRAIN (critical): a "week" is a CUMULATIVE MTD snapshot —
//  the ONLY valid cross-month comparison is SAME weekLabel
//  (identical to outlet-monthly-series.ts / outlet-recurrence.
//  ts). Window = most recent 12 same-week months ending at the
//  running month (monthKey <= currentMonthKey, inclusive; no
//  upper bound when currentMonthKey is null).
//
//  Sales convention: MODE(nominalSales) from OutletPeriodSales
//  (DB-06 precomputed table) — same as DEEP-RESTO-1.
//
//  NOTE (GODSPLIT-A/C audit): toNum + monthWindowBound are also
//  duplicated verbatim in outlets/outlet-monthly-series.ts — that
//  file is intentionally untouched here; consolidate when it gets
//  its own split (SPLIT-NEXT per findings-GODSPLIT-A).
// ============================================================
import { Prisma } from '@prisma/client';

/** Max months in the waste window (incl. running month). */
export const WASTE_WINDOW_MONTHS = 12;

/** P2 rule "waste/sales < 0,1%" — under-recording threshold (fraction). */
export const WASTE_UNDER_RECORD_PCT = 0.001;

/** P2 rule "residual > 80% dari loss" — residual-dominant threshold (fraction). */
export const WASTE_RESIDUAL_DOMINANT_PCT = 0.8;

/** P2 rule "waste explains < 10% of loss" — waste-share floor (fraction). */
export const WASTE_MIN_SHARE = 0.1;

/** Spike rule: waste/sales above mean + SPIKE_SIGMA × std of the outlet's own window. */
export const WASTE_SPIKE_SIGMA = 2;

/** Spike rule: minimum months in the window before a spike can be declared. */
export const WASTE_SPIKE_MIN_MONTHS = 3;

/** Z-score rule (peer band): minimum band size before z is meaningful. */
export const WASTE_ZSCORE_MIN_BAND = 3;

// ------------------------------------------------------------
// Shared helpers (module-private pre-split; exported for the
// sibling pipelines at GODSPLIT-W1-B — NOT re-exported by the
// waste-series.ts barrel, so the public surface is unchanged)
// ------------------------------------------------------------

export const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ------------------------------------------------------------
// Shared SQL fragment: the same-week month window (network-wide
// for the scoped filter set — most recent N months ending at
// currentMonthKey, inclusive).
// ------------------------------------------------------------

export function monthWindowBound(currentMonthKey: string | null): Prisma.Sql {
  return currentMonthKey
    ? Prisma.sql`AND sf."monthKey" <= ${currentMonthKey}`
    : Prisma.empty;
}
