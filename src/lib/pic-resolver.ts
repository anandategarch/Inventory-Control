// ============================================================
import "server-only";
//  PIC Resolver — shared logic for resolving PIC name → outlet codes.
//  Used by 5 API routes: analysis, recommendations, item-search,
//  pareto, export-report.
//
//  Before this module, each route had its own inline:
//    const picRows = await db.$queryRaw`SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})`
//
//  Now all routes call: const picOutletCodes = await resolvePICOutletCodes(pic);
// ============================================================
import { db } from '@/lib/db';

/**
 * Resolve a PIC name to their outlet codes.
 * Returns null if pic is null/empty (no filter).
 * Returns ['__NO_MATCH__'] if PIC exists but has no outlets (sentinel —
 *   callers should return empty results, not query all outlets).
 * Returns string[] of outlet codes if PIC has outlets.
 */
export async function resolvePICOutletCodes(
  pic: string | null | undefined,
): Promise<string[] | null> {
  if (!pic) return null;

  // PERF-API-02: removed withStatementTimeout — OutletPIC table is 341 rows,
  // query is sub-millisecond. Wrapper added 3 round-trips (BEGIN+SET+COMMIT).
  const picRows = await db.$queryRaw<Array<{ outletCode: string }>>`
    SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})
  `;
  const codes = picRows.map((r) => r.outletCode);

  if (codes.length === 0) {
    // PIC has no outlets → return sentinel so callers return empty results
    return ['__NO_MATCH__'];
  }
  return codes;
}

/**
 * Build filterOpts object with PIC outlet codes resolved.
 * Convenience wrapper for routes that need the full filterOpts shape.
 */
export async function resolveFilterOptsWithPIC(
  area: string | null,
  outletCode: string | null,
  itemName: string | null,
  pic: string | null,
): Promise<{
  area: string | null;
  outletCode: string | null;
  itemName: string | null;
  picOutletCodes: string[] | null;
  picHasNoOutlets: boolean; // true if PIC exists but has 0 outlets
}> {
  if (!pic) {
    return { area, outletCode, itemName, picOutletCodes: null, picHasNoOutlets: false };
  }

  const picOutletCodes = await resolvePICOutletCodes(pic);
  if (picOutletCodes && picOutletCodes.length === 1 && picOutletCodes[0] === '__NO_MATCH__') {
    return { area, outletCode, itemName, picOutletCodes: ['__NO_MATCH__'], picHasNoOutlets: true };
  }

  return { area, outletCode, itemName, picOutletCodes, picHasNoOutlets: false };
}
