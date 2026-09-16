// ============================================================
//  build-where.ts — shared Prisma WhereInput builder for InventoryRecord.
//
//  FIX (RESTORE-BACKEND-2): The `buildWhere` closure was duplicated
//  verbatim in 2 routes (analysis + export-report) — ~50 lines each.
//  Force-push deleted the shared helper; this restores it.
//
//  Handles: area, itemName (case-insensitive contains), kelompok
//  (via pre-resolved outlet codes), PIC (with sentinel for empty
//  list), outletCode — including all intersections.
//
//  Sentinel pattern: when a filter resolves to "no matching outlets"
//  (e.g. kelompok selected but no outlets match, or PIC has no
//  assigned outlets), we set `outlet.code = { in: ['__NO_MATCH__'] }`
//  instead of skipping the filter. Skipping would show ALL outlets
//  (filter ignored); sentinel returns 0 rows (filter enforced).
//
//  Sentinel is idempotent: if the caller pre-sentineled picOutletCodes
//  (e.g. export-report pre-applies ['__NO_MATCH__'] when empty), the
//  helper passes it through unchanged. If the caller passes a raw
//  empty array (e.g. analysis route), the helper applies the sentinel
//  internally. Both call-sites produce the same Prisma query.
// ============================================================
import { Prisma } from '@prisma/client';
import { escapeLikeWildcards } from '@/lib/queries/shared';

export interface BuildInventoryWhereOpts {
  /** Current week label (e.g. "WEEK 2") */
  week: string;
  /** Current month label (e.g. "Agustus 2026") */
  month: string;
  /** Area filter — 'all' / null / undefined = no filter */
  area?: string | null;
  /** Item name filter — case-insensitive contains */
  itemName?: string | null;
  /** Kelompok prefix (3-char) — 'all' / null = no filter */
  kelompok?: string | null;
  /**
   * Pre-resolved outlet codes matching the kelompok filter.
   * Resolved upstream via `resolveKelompokOutletCodes(kelompok)`.
   * Empty array = kelompok selected but no outlets match → sentinel.
   */
  kelompokOutletCodes?: string[];
  /**
   * Outlet codes for the selected PIC. Resolved upstream via
   * raw SQL `SELECT outletCode FROM OutletPIC WHERE LOWER(pic) = LOWER(${pic})`.
   * - null = no PIC filter
   * - [] = PIC selected but has no outlets → sentinel
   * - ['__NO_MATCH__'] = caller pre-sentineled (treated same as [])
   * - string[] = filter to those outlets
   */
  picOutletCodes?: string[] | null;
  /** Specific outlet code — 'all' / null = no filter */
  outletCode?: string | null;
}

/**
 * Build a Prisma.InventoryRecordWhereInput for the given week/month + filters.
 *
 * Used by /api/analysis (current + previous period record fetches) and
 * /api/export-report (current + previous period record fetches). Replaces
 * the inline `buildWhere` closure that was duplicated in both routes.
 *
 * Behavior:
 *  - Always sets monthLabel + weekLabel (required).
 *  - area filter applied if non-empty and !== 'all'.
 *  - itemName filter uses `contains` with `mode: 'insensitive'` (BUG-NORECORDS-2 fix).
 *  - kelompok filter intersects with PIC + outletCode if multiple are set
 *    (e.g. kelompok=BDG + pic=Andi → only outlets that are both BDG and
 *    assigned to Andi).
 *  - PIC sentinel: empty PIC list → `outlet.code IN ('__NO_MATCH__')` → 0 rows.
 *  - outletCode filter is intersected with PIC/kelompok when both are set.
 *
 * @returns Prisma WhereInput suitable for `db.inventoryRecord.findMany({ where: ... })`
 */
export function buildInventoryWhere(
  opts: BuildInventoryWhereOpts,
): Prisma.InventoryRecordWhereInput {
  const {
    week,
    month,
    area,
    itemName,
    kelompok,
    kelompokOutletCodes = [],
    picOutletCodes = null,
    outletCode,
  } = opts;

  const w: Prisma.InventoryRecordWhereInput = {
    monthLabel: month,
    weekLabel: week,
  };

  if (area && area !== 'all') w.area = area;
  // BUG FIX (BUG-NORECORDS-2): case-insensitive itemName filter (mode: 'insensitive')
  // FIX (BUGHUNT-A4): escape LIKE wildcards first. Verified against the
  // Prisma 6.11 engine's generated SQL: `contains` wraps the value with
  // '%' WITHOUT escaping (`contains 'TEH%'` → `LIKE '%TEH%%'` — the
  // wildcards stay active), so an itemName containing %/_ matched the
  // wrong row set ('%' matched EVERY item — the record path then fed
  // unfiltered records into the response while still reporting
  // filters.itemName='%'). escapeLikeWildcards makes them literal: on
  // PostgreSQL (this app's only connector — prisma/schema.prisma) LIKE's
  // DEFAULT escape character is the backslash, so `\%`/`\_` inside the
  // contains value match the literal characters exactly. A filter with
  // no wildcard chars is a no-op — existing behavior unchanged.
  if (itemName) w.item = { name: { contains: escapeLikeWildcards(itemName), mode: 'insensitive' } };

  if (kelompok && kelompok !== 'all') {
    if (kelompokOutletCodes.length === 0) {
      // kelompok selected but no outlets match — sentinel to return 0 rows
      w.outlet = { code: { in: ['__NO_MATCH__'] } };
    } else if (picOutletCodes !== null) {
      // Intersect kelompok outlets with PIC outlets (or sentinel if empty PIC)
      const picCodes = picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'];
      const intersect = kelompokOutletCodes.filter((c: string) => picCodes.includes(c));
      w.outlet = { code: { in: intersect.length > 0 ? intersect : ['__NO_MATCH__'] } };
    } else if (outletCode && outletCode !== 'all') {
      // Kelompok + specific outlet — outlet must be in kelompok's outlet set
      w.outlet = {
        code: kelompokOutletCodes.includes(outletCode) ? outletCode : '__NO_MATCH__',
      };
    } else {
      // Only kelompok — filter to kelompok's outlets
      w.outlet = { code: { in: kelompokOutletCodes } };
    }
  } else if (picOutletCodes !== null) {
    // PIC selected (no kelompok) — filter to PIC's outlets (or sentinel if empty)
    let codes = picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'];
    // If outletCode also selected, intersect (outletCode must be in PIC list)
    if (outletCode && outletCode !== 'all') {
      codes = codes.includes(outletCode) ? [outletCode] : ['__NO_MATCH__'];
    }
    w.outlet = { code: { in: codes } };
  } else if (outletCode && outletCode !== 'all') {
    // Only outletCode selected (no PIC, no kelompok)
    w.outlet = { code: outletCode };
  }

  return w;
}
