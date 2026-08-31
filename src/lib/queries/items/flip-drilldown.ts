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
//  Approach:
//  - Run TWO per-outlet aggregate queries (one for P1, one for
//    P2) in parallel via Promise.all. Each query is a single
//    GROUP BY (outlet) — light enough to run twice in 1 round-trip.
//  - Match the SAME WHERE clause pattern as flip-ranking.ts:
//      `i.name = ${item}`         (exact match, NOT LIKE)
//      `ir."weekLabel" = ${week}`  (same weekLabel as P1/P2)
//      `ir."qtyDeviasi" IS NOT NULL`
//  - Month matching: P1/P2 are passed as EITHER a full month
//    label ("Juli 2026") OR a 3-char short label ("Jul").
//    We match via `(ir."monthLabel" = ${month} OR ir."monthLabel" ILIKE ${month + '%'})`
//    so both forms work. The short label comes from the
//    FlipPair.period1Label (e.g. "Jul W4") — frontend passes
//    the "Jul" prefix.
//  - The FULL monthLabel is resolved from the DB via
//    MAX(ir."monthLabel") and returned in the period object,
//    so the frontend can render "Juli 2026 WEEK 4" instead of
//    just "Jul W4".
//  - Apply buildSqlFilters for area/kelompok/outletCode/pic.
//  - Use withStatementTimeout (max 30s per query — matches
//    flip-ranking.ts).
//  - Use DIRECTION_FROM_SUM_SQL shared fragment (same as
//    item-peer-comparison.ts) for LOSS/SURPLUS/NEUTRAL.
//  - Sort outlets by |qtyDeviasiSigned| DESC (biggest
//    contributor first — surface the drivers of the flip).
//
//  Implementation notes:
//  - Prisma.sql tagged templates (zero $queryRawUnsafe).
//  - Coerce Decimal → Number (defensive — SUM returns Decimal).
//  - itemName is NOT passed to buildSqlFilters (we apply an
//    exact `i.name = ${item}` match — LIKE would over-match a
//    substring against item names, same reason as flip-ranking.ts).
// ============================================================
import { Prisma } from '@prisma/client';
import {
  buildSqlFilters,
  DIRECTION_FROM_SUM_SQL,
  withStatementTimeout,
  type SqlFilterOpts,
} from '../shared';

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

/** Coerce a possibly BigInt/Decimal numeric to a JS number. */
function num(v: number | bigint | Prisma.Decimal | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

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
  // buildSqlFilters with `itemName: null` — we apply an EXACT match
  // (`i.name = ${item}`) in the WHERE clause below, NOT buildSqlFilters'
  // LIKE (which would over-match "CABAI" → "CABAI FROZEN" + "CABAI MERAH").
  // Same pattern as item-peer-comparison.ts + flip-ranking.ts.
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<FlipDrillRawRow>>`
    SELECT
      o.code as "outletCode",
      o.name as "outletName",
      MAX(ir.area) as "area",
      pic.pic,
      MAX(ir."monthLabel") as "monthLabel",
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasiSigned",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      COALESCE(SUM(ir."absNominalDeviasi"), 0) as "absNominalDeviasi",
      ${DIRECTION_FROM_SUM_SQL} as "direction"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    WHERE i.name = ${item}
      AND ir."weekLabel" = ${weekLabel}
      AND (ir."monthLabel" = ${monthLabel} OR ir."monthLabel" ILIKE ${monthLabel + '%'})
      AND ir."qtyDeviasi" IS NOT NULL
      ${f}
    GROUP BY o.code, o.name, pic.pic
    ORDER BY ABS(SUM(ir."qtyDeviasi")) DESC NULLS LAST
  `);

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
    qtyDeviasiSigned: num(r.qtyDeviasiSigned),
    nominalDeviasi: num(r.nominalDeviasi),
    absNominalDeviasi: num(r.absNominalDeviasi),
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
