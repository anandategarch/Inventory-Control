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
//  H-12 (drilldown trio merge): the SQL skeleton lives in the shared
//  item-outlet-breakdown.ts core (exact i.name match, standard JOINs,
//  buildSqlFilters with itemName stripped, withStatementTimeout).
//  This file owns only the anomali-specific parts: the direction +
//  absNominalLossSurplus WHERE fragments and the signed SUM aggregates
//  + DIRECTION_FROM_SUM_SQL direction derivation.
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

  // Direction filter — constrained to two hardcoded literals, never user
  // input. Prisma.raw is safe here (no SQL injection vector).
  const directionFilter =
    direction === 'LOSS'
      ? Prisma.raw('ir."nominalLossSurplus" < 0')
      : Prisma.raw('ir."nominalLossSurplus" > 0');

  const rows = await queryItemOutletAggregates<AnomaliOutletRawRow>({
    item,
    month,
    week,
    filters,
    // Same WHERE pattern as queryItemConsistency (top-items/by-other-metric.ts):
    // absNominalLossSurplus present + positive, then the minority direction sign.
    // (No leading AND — the core adds it.)
    extraWhere: Prisma.sql`ir."absNominalLossSurplus" IS NOT NULL AND ir."absNominalLossSurplus" > 0 AND ${directionFilter}`,
    selectAggs: Prisma.sql`
      o.area,
      COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasi",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi",
      ${DIRECTION_FROM_SUM_SQL} as "direction"`,
    // Old GROUP BY: o.code, o.name, o.area, pic.pic — identical column set.
    groupByExtra: ', o.area, pic.pic',
    orderBy: 'ABS(SUM(ir."nominalDeviasi")) DESC',
  });

  const outlets: AnomaliOutlet[] = rows.map((r) => ({
    outletCode: r.outletCode,
    outletName: r.outletName,
    area: r.area ?? null,
    pic: r.pic ?? null,
    qtyDeviasi: toNum(r.qtyDeviasi),
    nominalDeviasi: toNum(r.nominalDeviasi),
    direction: r.direction,
  }));

  return { outlets };
}
