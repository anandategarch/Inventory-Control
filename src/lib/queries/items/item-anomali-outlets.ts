// ============================================================
//  Item Anomali Outlets — per-outlet breakdown for the MINORITY direction
//  --------------------------------------------------------
//  Companion to queryItemConsistency. When the user clicks a row in the
//  "Analisis Pola Item" table (AdvancedAnalysis.tsx), this query fetches
//  the per-outlet rows whose direction is the MINORITY (anomali) direction.
//
//  Example:
//    MINYAK MIE SHALLOT OIL → 187 LOSS + 1 SURPLUS
//    Majority direction = LOSS → anomali = the 1 SURPLUS outlet.
//    This query returns that 1 outlet.
//
//  Approach:
//  - Single per-outlet aggregate query (GROUP BY outlet).
//  - Same WHERE pattern as queryItemConsistency (top-items/by-other-metric.ts):
//      `i.name = ${item}`        (exact match, NOT LIKE)
//      `ir."monthLabel" = ${month}`
//      `ir."weekLabel"  = ${week}`
//      `ir."absNominalLossSurplus" IS NOT NULL AND > 0`
//  - Adds a direction filter based on the `direction` param:
//      'LOSS'   → `ir."nominalLossSurplus" < 0`
//      'SURPLUS' → `ir."nominalLossSurplus" > 0`
//    (Prisma.raw injection is safe — the value is constrained to two
//    hardcoded literals, never user input.)
//  - LEFT JOIN OutletPIC by `o.code = pic."outletCode"` to surface the
//    staff responsible for each outlet.
//  - Sort by ABS(SUM(ir."nominalDeviasi")) DESC (biggest nominal impact
//    first — surface the worst offenders).
//  - Apply buildSqlFilters for area/kelompok/outletCode/picOutletCodes.
//  - Use withStatementTimeout (max 30s — matches sibling queries).
//  - Use DIRECTION_FROM_SUM_SQL shared fragment for the per-outlet
//    LOSS/SURPLUS/NEUTRAL derivation (consistent with flip-drilldown).
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

/** One outlet's contribution to the anomali set. */
export interface AnomaliOutlet {
  outletCode: string;
  outletName: string;
  area: string | null;
  pic: string | null;
  /** SIGNED SUM(qtyDeviasi). */
  qtyDeviasi: number;
  /** SIGNED SUM(nominalDeviasi). */
  nominalDeviasi: number;
  /** LOSS / SURPLUS / NEUTRAL — derived via DIRECTION_FROM_SUM_SQL. */
  direction: string;
}

export interface AnomaliOutletsResult {
  outlets: AnomaliOutlet[];
}

// ------------------------------------------------------------
//  Raw row shape returned by the SQL
// ------------------------------------------------------------

interface AnomaliOutletRawRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  pic: string | null;
  qtyDeviasi: number | bigint | Prisma.Decimal | null;
  nominalDeviasi: number | bigint | Prisma.Decimal | null;
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

// ------------------------------------------------------------
//  Main entry point
// ------------------------------------------------------------

/**
 * Query per-outlet rows whose aggregate direction matches the supplied
 * `direction` (the MINORITY direction of the parent item row).
 *
 * @returns AnomaliOutletsResult — outlets[] sorted by
 *          ABS(SUM(ir."nominalDeviasi")) DESC.
 *          Returns empty outlets[] when the item+filters+direction have
 *          no matching rows.
 */
export async function queryItemAnomaliOutlets(opts: {
  item: string;
  month: string;
  week: string;
  direction: 'LOSS' | 'SURPLUS';
  filters: SqlFilterOpts;
}): Promise<AnomaliOutletsResult> {
  const { item, month, week, direction, filters } = opts;

  // buildSqlFilters with `itemName: null` — we apply an EXACT match
  // (`i.name = ${item}`) in the WHERE clause below, NOT buildSqlFilters'
  // LIKE (which would over-match "CABAI" → "CABAI FROZEN" + "CABAI MERAH").
  // Same pattern as item-peer-comparison.ts + flip-drilldown.ts.
  const f = buildSqlFilters({
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  });

  // Direction filter — constrained to two hardcoded literals, never user
  // input. Prisma.raw is safe here (no SQL injection vector).
  const directionFilter =
    direction === 'LOSS'
      ? Prisma.raw('ir."nominalLossSurplus" < 0')
      : Prisma.raw('ir."nominalLossSurplus" > 0');

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<AnomaliOutletRawRow>>`
    SELECT
      o.code as "outletCode",
      o.name as "outletName",
      o.area,
      pic.pic,
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasi",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      ${DIRECTION_FROM_SUM_SQL} as "direction"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND i.name = ${item}
      AND ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0
      AND ${directionFilter}
      ${f}
    GROUP BY o.code, o.name, o.area, pic.pic
    ORDER BY ABS(SUM(ir."nominalDeviasi")) DESC
  `);

  const outlets: AnomaliOutlet[] = rows.map((r) => ({
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area ?? null,
    pic: r.pic ?? null,
    qtyDeviasi: num(r.qtyDeviasi),
    nominalDeviasi: num(r.nominalDeviasi),
    direction: r.direction,
  }));

  return { outlets };
}
