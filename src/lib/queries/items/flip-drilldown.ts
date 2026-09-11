// ============================================================
//  Flip Drill-down — per-outlet breakdown for ONE flip pair
//  --------------------------------------------------------
//  Companion to flip-ranking.ts. When the user clicks a flip
//  pair in the Flip Ranking widget, this query fetches the
//  per-outlet SIGNED QTY + nominal + direction breakdown for
//  BOTH periods (P1 + P2) so they can see WHICH outlets
//  contributed to the balanced reversal.
//
//  Use case: "Flip terjadi di resto mana saja?" — surface the
//  individual outlets whose signed QTY deviasi aggregated to
//  the item-level flip pattern shown in the ranking widget.
//
//  H-12 (drilldown trio merge): the per-period SQL skeleton lives
//  in the shared item-outlet-breakdown.ts core (exact i.name match,
//  month prefix matching, standard JOINs incl. OutletPIC, filters
//  with itemName stripped, withStatementTimeout). This file owns
//  only the flip-specific parts: the qtyDeviasi IS NOT NULL guard,
//  the SIGNED + ABS SUM aggregates, the DIRECTION_FROM_SUM_SQL
//  derivation, and the MAX(monthLabel) label resolution.
//
//  Month matching: P1/P2 are passed as EITHER a full month
//  label ("Juli 2026") OR a 3-char short label ("Jul") —
//  handled by the core's monthMatch: 'prefix' mode. The FULL
//  monthLabel is resolved from the DB via MAX(ir."monthLabel")
//  and returned in the period object, so the frontend can render
//  "Juli 2026 WEEK 4" instead of just "Jul W4".
//
//  Sort outlets by |qtyDeviasiSigned| DESC (biggest contributor
//  first — surface the drivers of the flip).
// ============================================================
import { Prisma } from '@prisma/client';
import {
  DIRECTION_FROM_SUM_SQL,
  type SqlFilterOpts,
} from '../shared';
import { queryItemOutletAggregates, toNum } from './item-outlet-breakdown';

// ------------------------------------------------------------
//  Public types
// ------------------------------------------------------------

/** One outlet's contribution to a single flip period. */
export interface FlipDrillOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  /** SIGNED SUM(qtyDeviasi) — negative = LOSS, positive = SURPLUS. */
  qtyDeviasiSigned: number;
  /** SIGNED SUM(nominalDeviasi). */
  nominalDeviasi: number;
  /** Always non-negative SUM(absNominalDeviasi). */
  absNominalDeviasi: number;
  /** LOSS / SURPLUS / NEUTRAL — derived via DIRECTION_FROM_SUM_SQL. */
  direction: string;
}

/** Per-period drill-down result. */
export interface FlipDrillPeriod {
  /** Full month label resolved from the DB (e.g. "Juli 2026"). */
  monthLabel: string;
  /** Per-outlet rows, sorted by |qtyDeviasiSigned| DESC. */
  outlets: FlipDrillOutlet[];
}

export interface FlipDrilldownResult {
  period1: FlipDrillPeriod;
  period2: FlipDrillPeriod;
}

/** Query options. */
export interface FlipDrilldownOpts {
  /** Exact item name (matched via `i.name = ${item}`). */
  item: string;
  /** weekLabel shared by both periods (e.g. "WEEK 4"). */
  weekLabel: string;
  /** P1 month label — full ("Juli 2026") or short ("Jul"). */
  month1Label: string;
  /** P2 month label — full ("Agustus 2026") or short ("Agu"). */
  month2Label: string;
  /** Dashboard filters (area, kelompok, outletCode, picOutletCodes). */
  filters: SqlFilterOpts;
}

// ------------------------------------------------------------
//  Raw row shape returned by the SQL
// ------------------------------------------------------------

interface FlipDrillRawRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  pic: string | null;
  /** MAX(ir."monthLabel") — the resolved full month label for this period. */
  monthLabel: string | null;
  qtyDeviasiSigned: number | bigint | Prisma.Decimal | null;
  nominalDeviasi: number | bigint | Prisma.Decimal | null;
  absNominalDeviasi: number | bigint | Prisma.Decimal | null;
  direction: string;
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------

/**
 * Run a per-outlet aggregate query for ONE period (month + week).
 *
 * @returns `{ monthLabel, outlets }` where monthLabel is the full
 *          month label resolved from the DB (MAX of matched rows),
 *          falling back to the input label when no rows matched.
 *          outlets[] is sorted by |qtyDeviasiSigned| DESC.
 */
async function queryPeriodOutlets(
  item: string,
  weekLabel: string,
  monthLabel: string,
  filters: SqlFilterOpts,
): Promise<{ monthLabel: string; outlets: FlipDrillOutlet[] }> {
  const rows = await queryItemOutletAggregates<FlipDrillRawRow>({
    item,
    month: monthLabel,
    week: weekLabel,
    filters,
    // Short labels ("Jul") must match "Juli 2026" — prefix ILIKE.
    monthMatch: 'prefix',
    // Same WHERE clause pattern as flip-ranking.ts: qtyDeviasi present.
    // (No leading AND — the core adds it.)
    extraWhere: Prisma.sql`ir."qtyDeviasi" IS NOT NULL`,
    selectAggs: Prisma.sql`
      MAX(ir.area) as "area",
      MAX(ir."monthLabel") as "monthLabel",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasiSigned",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      COALESCE(SUM(ir."absNominalDeviasi"), 0) as "absNominalDeviasi",
      ${DIRECTION_FROM_SUM_SQL} as "direction"`,
    // Old GROUP BY: o.code, o.name, pic.pic — identical column set.
    groupByExtra: ', pic.pic',
    orderBy: 'ABS(SUM(ir."qtyDeviasi")) DESC NULLS LAST',
  });

  // Resolve the full month label from the first matched row.
  // All rows in this query share the same monthLabel (matched via the
  // ILIKE prefix), so MAX(ir."monthLabel") is the same across rows —
  // take it from the first row. Fall back to the input label when no
  // rows match (so the frontend still shows SOMETHING sensible).
  const resolvedMonthLabel = rows[0]?.monthLabel ?? monthLabel;

  const outlets: FlipDrillOutlet[] = rows.map((r) => ({
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area ?? '',
    pic: r.pic ?? null,
    qtyDeviasiSigned: toNum(r.qtyDeviasiSigned),
    nominalDeviasi: toNum(r.nominalDeviasi),
    absNominalDeviasi: toNum(r.absNominalDeviasi),
    direction: r.direction,
  }));

  return { monthLabel: resolvedMonthLabel, outlets };
}

// ------------------------------------------------------------
//  Main entry point
// ------------------------------------------------------------

/**
 * Query per-outlet breakdown for BOTH periods of a flip pair.
 *
 * Runs two per-outlet aggregate queries in parallel via Promise.all
 * (each is a single GROUP BY — light enough to run twice in one
 * round-trip). Both queries are wrapped in withStatementTimeout
 * independently.
 *
 * @returns `{ period1, period2 }` — each with monthLabel + outlets[].
 *          outlets[] is sorted by |qtyDeviasiSigned| DESC.
 *          Returns empty outlets[] when the item+period has no data.
 */
export async function queryFlipDrilldown(
  opts: FlipDrilldownOpts,
): Promise<FlipDrilldownResult> {
  const { item, weekLabel, month1Label, month2Label, filters } = opts;

  // Run both queries in parallel — each is a single GROUP BY query
  // bounded by item + month + week filters (~1-50 rows per period).
  const [p1, p2] = await Promise.all([
    queryPeriodOutlets(item, weekLabel, month1Label, filters),
    queryPeriodOutlets(item, weekLabel, month2Label, filters),
  ]);

  return {
    period1: p1,
    period2: p2,
  };
}
