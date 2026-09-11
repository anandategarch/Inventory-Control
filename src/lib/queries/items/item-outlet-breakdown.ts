// ============================================================
//  Item → Outlet breakdown core — shared per-item per-outlet drilldown SQL
//  --------------------------------------------------------
//  FIX (H-12 / drilldown trio merge): the "GROUP BY outlet SUM(qty/nominal)
//  for ONE item" SQL skeleton was implemented 3× with only filter/shape
//  differences — queryItemAnomaliOutlets (item-anomali-outlets.ts),
//  queryHeatmapCellDetail (heatmap.ts), and queryPeriodOutlets ×2 periods
//  (flip-drilldown.ts). This module is now the SINGLE implementation of
//  the invariant parts:
//    - EXACT item match (`i.name = ${item}` — never buildSqlFilters' LIKE,
//      which would over-match "CABAI" → "CABAI FROZEN" + "CABAI MERAH")
//    - itemName stripped from dashboard filters (exact match above owns it)
//    - month matching: exact, or prefix (`= label OR ILIKE label||'%'` —
//      flip periods pass short 3-char labels like "Jul")
//    - standard JOINs (Item, Outlet, optional OutletPIC LEFT JOIN)
//    - base GROUP BY (o.code, o.name) + caller-added columns
//    - withStatementTimeout wrapper (30s — matches sibling queries)
//    - BigInt/Decimal → Number coercion helper (toNum)
//
//  Callers own only what genuinely differs: the aggregate SELECT list,
//  extra WHERE predicates (direction / area / qtyDeviasi NOT NULL), the
//  extra GROUP BY columns, ORDER BY, and an optional LIMIT.
//
//  SQL safety (verified against Prisma's actual composition behavior):
//  - Optional fragments (extra WHERE / filters / LIMIT) are interpolated
//    as DIRECT template slots, never Prisma.join-ed — an empty Sql in a
//    template slot contributes zero text (the `${f}` pattern every query
//    in this codebase uses), but an empty fragment INSIDE Prisma.join
//    emits a stray separator ("... AND  AND ..." / trailing "AND") →
//    broken SQL when no dashboard filter is active.
//  - JOINs + GROUP BY extras + ORDER BY are caller-supplied STATIC string
//    literals (no user input — same Prisma.raw convention as nested.ts).
//    Only item/month/week/filters/limit are parameterized.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

/** Coerce a possibly BigInt/Decimal numeric to a JS number (SUM aggregates return Decimal). */
export function toNum(v: number | bigint | Prisma.Decimal | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

/**
 * Strip `itemName` from dashboard filters for exact-match item drilldowns.
 *
 * The caller applies its own EXACT match (`i.name = ${item}`) in the WHERE
 * clause — buildSqlFilters' itemName filter is a LIKE that would over-match
 * a substring against item names ("CABAI" → "CABAI FROZEN" + "CABAI MERAH").
 * Same reason at every call site.
 */
export function outletBreakdownFilters(filters: SqlFilterOpts): SqlFilterOpts {
  return {
    area: filters.area ?? null,
    kelompok: filters.kelompok ?? null,
    outletCode: filters.outletCode ?? null,
    itemName: null,
    picOutletCodes: filters.picOutletCodes ?? null,
  };
}

/** Raw row base shared by every caller: outlet identity columns always present. */
export interface ItemOutletRow {
  outletCode: string;
  outletName: string;
}

export interface ItemOutletAggOpts {
  /** Exact item name (matched via `i.name = ${item}`). */
  item: string;
  month: string;
  week: string;
  filters: SqlFilterOpts;
  /**
   * 'exact' (default): `monthLabel = ${month}`.
   * 'prefix': `(monthLabel = ${month} OR monthLabel ILIKE ${month} || '%')`
   * — flip periods pass EITHER a full label ("Juli 2026") or a short
   * 3-char prefix ("Jul"); the ILIKE arm covers the short form.
   */
  monthMatch?: 'exact' | 'prefix';
  /**
   * Additional parameterized WHERE predicates, WITHOUT the leading AND —
   * the core adds it. e.g. `ir.area = ${areaName}` (heatmap) or
   * `ir."qtyDeviasi" IS NOT NULL` (flip).
   */
  extraWhere?: Prisma.Sql;
  /**
   * Include `LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"` +
   * select `pic.pic` (default true — anomali + flip surface the staff
   * responsible). Pass false when the PIC columns are not needed
   * (heatmap cell detail).
   */
  joinPIC?: boolean;
  /** Aggregate/detail SELECT columns (static SQL with aliases). Never empty. */
  selectAggs: Prisma.Sql;
  /** Extra GROUP BY columns after the shared `o.code, o.name` (static SQL, e.g. `, o.area, pic.pic`). */
  groupByExtra?: string;
  /** Full ORDER BY expression (static SQL, e.g. `ABS(SUM(ir."nominalDeviasi")) DESC`). */
  orderBy: string;
  /** Optional row cap (heatmap passes 1000 as defense-in-depth). */
  limit?: number;
}

/**
 * Run ONE per-outlet aggregate query for a single item.
 *
 * Emits:
 *   SELECT o.code as "outletCode", o.name as "outletName"[, pic.pic], <selectAggs>
 *   FROM "InventoryRecord" ir
 *   JOIN "Item" i ON ir."itemId" = i.id
 *   JOIN "Outlet" o ON ir."outletId" = o.id
 *   [LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"]
 *   WHERE i.name = ${item} AND ir."weekLabel" = ${week} AND <month match>
 *     [AND <extraWhere>] [AND dashboard filters minus itemName]
 *   GROUP BY o.code, o.name[ , groupByExtra]
 *   ORDER BY <orderBy>[ LIMIT ${limit}]
 */
export async function queryItemOutletAggregates<TRow extends ItemOutletRow>(
  opts: ItemOutletAggOpts,
): Promise<TRow[]> {
  const {
    item,
    month,
    week,
    filters,
    monthMatch = 'exact',
    extraWhere,
    joinPIC = true,
    selectAggs,
    groupByExtra,
    orderBy,
    limit,
  } = opts;

  // CRITICAL (found via SQL-capture dry-run): buildSqlFilters' fragments
  // start with `AND` and carry NO leading whitespace — the legacy per-query
  // templates interpolated ${f} on its own line, so the literal `\n      `
  // before the slot supplied the separator. In THIS composed template the
  // slots sit adjacent, so the template carries the explicit ` ${f}` space
  // (a leading space on the slot). It must cover BOTH junction cases:
  //   extraWhere present  → `... > 0` + " " + "AND ir.area ..."
  //   extraWhere absent  → `... = ?`  + " " + "AND ir.area ..." (monthCondition's
  //                         trailing fragment is an empty string)
  // A trailing space before GROUP BY when BOTH are absent is harmless SQL.
  const f = buildSqlFilters(outletBreakdownFilters(filters));

  // Month match — always non-empty.
  const monthCondition =
    monthMatch === 'prefix'
      ? Prisma.sql`(ir."monthLabel" = ${month} OR ir."monthLabel" ILIKE ${month + '%'})`
      : Prisma.sql`ir."monthLabel" = ${month}`;

  // Extra predicates — the core owns the leading AND; empty Sql when absent.
  // (MUST be declared AFTER `const f` — see the CRITICAL junction note above.)
  const extraWhereSql = extraWhere ? Prisma.sql` AND ${extraWhere}` : Prisma.sql``;

  // JOINs — plain space-joined static literals wrapped in Prisma.raw
  // (same convention as nested.ts; empty strings filtered out).
  const joinFragments = [
    'JOIN "Item" i ON ir."itemId" = i.id',
    'JOIN "Outlet" o ON ir."outletId" = o.id',
    ...(joinPIC ? ['LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"'] : []),
  ].join(' ');
  const picSelect = joinPIC ? ', pic.pic' : '';

  const limitSql = limit != null ? Prisma.sql` LIMIT ${limit}` : Prisma.sql``;

  // See the `const f = ...` note above: the ` ${f}` leading space is the
  // separator buildSqlFilters fragments rely on. Never remove it.

  return withStatementTimeout((tx) => tx.$queryRaw<TRow[]>(Prisma.sql`
    SELECT o.code as "outletCode", o.name as "outletName"${Prisma.raw(picSelect)}, ${selectAggs}
    FROM "InventoryRecord" ir
    ${Prisma.raw(joinFragments)}
    WHERE i.name = ${item}
      AND ir."weekLabel" = ${week}
      AND ${monthCondition}${extraWhereSql} ${f}
    GROUP BY o.code, o.name${Prisma.raw(groupByExtra ?? '')}
    ORDER BY ${Prisma.raw(orderBy)}
    ${limitSql}
  `));
}
