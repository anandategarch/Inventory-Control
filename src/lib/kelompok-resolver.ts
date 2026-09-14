// ============================================================
//  Kelompok resolver — shared utilities for kelompok filter.
//
//  FIX (BUG-PERF-4 / BUG-PERF-5 / BUG-BE-2): The kelompokOutletCodes
//  resolution logic (DB fetch + JS filter) was duplicated verbatim in
//  analysis/route.ts + export-report/route.ts (11 lines each). The JS
//  kelompok extraction pattern was duplicated in 3 places. This module
//  centralizes both into reusable functions.
//
//  Also fixes BUG-BE-2 (performance): replaces the old "fetch ALL outlets
//  then filter in JS" pattern with a single SQL query that filters at
//  the DB level using the same LEFT(SUBSTRING(...)) expression as
//  buildSqlFilters.
// ============================================================
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Extract kelompok (3-char prefix) from an outlet code.
 *
 * Outlet codes have two formats:
 *   "1030.BDGSET"   → last segment = "BDGSET" → "BDG"
 *   "B.1001.MLGPAR" → last segment = "MLGPAR" → "MLG"
 *
 * Takes the LAST dot-separated segment's first 3 chars, uppercased.
 * Works for single-segment codes too (returns first 3 chars).
 *
 * FIX (BUG-BE-4 / BUG-EDGE-2): Removed the `if (segs.length < 2) return ''`
 * guard — single-segment codes are valid and should be handled consistently
 * with the SQL extraction (SUBSTRING with '[^.]+$' matches the whole string
 * when there's no dot).
 */
export function extractKelompokFromCode(code: string): string {
  const segs = code.split('.');
  const lastSeg = segs[segs.length - 1] || '';
  return lastSeg.substring(0, 3).toUpperCase();
}

/**
 * Resolve kelompok → list of outlet codes matching that kelompok.
 *
 * Uses DB-level SQL filter (same LEFT(SUBSTRING(...)) expression as
 * buildSqlFilters) for performance — avoids fetching ALL outlets then
 * filtering in JS.
 *
 * FIX (BUG-BE-1): UPPER(${kelompok}) normalizes input to uppercase,
 * making the filter case-insensitive (consistent with buildSqlFilters).
 *
 * @param kelompok The kelompok prefix (e.g. "BDG", "mlg", "Mlg").
 *                 Null, empty, or 'all' → returns empty array (no filter).
 * @returns Array of outlet codes matching the kelompok. Empty if no match.
 */
export async function resolveKelompokOutletCodes(
  kelompok: string | null | undefined,
): Promise<string[]> {
  if (!kelompok || kelompok === 'all') return [];
  try {
    // PERF-API-02: removed withStatementTimeout — Outlet table is 342 rows,
    // query is sub-millisecond. Wrapper added 3 round-trips (BEGIN+SET+COMMIT).
    const rows = await db.$queryRaw<Array<{ code: string }>>`
      SELECT code FROM "Outlet"
      WHERE LEFT(SUBSTRING(code FROM '[^.]+$'), 3) = UPPER(${kelompok})
    `;
    const codes = rows.map((r) => r.code);
    // FIX API-05: return __NO_MATCH__ sentinel when no outlets found (consistent with PIC resolver)
    // so routes can early-return empty instead of querying all outlets.
    return codes.length > 0 ? codes : ['__NO_MATCH__'];
  } catch (e) {
    logger.error('[kelompok-resolver] resolveKelompokOutletCodes failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    // FIX (BUG-3-c R-3): the error path used to return [] — every caller
    // treats an empty array as "no kelompok filter" (resolveOutletCodeFilters
    // normalizes [] → null, drilldown/heatmap skip the filter entirely), so a
    // TRANSIENT DB error silently widened the query to ALL outlets (wrong
    // data served as if correct). Return the __NO_MATCH__ sentinel instead:
    // callers surface an empty/"no data" result — a visible failure rather
    // than a silent one — and the filter is never dropped. Verified callers:
    //   - resolveOutletCodeFilters: length-1 sentinel → noMatch:true → empty
    //     result (6 routes)
    //   - drilldown + heatmap ×2: sentinel → emptyResult early-return
    //   - buildInventoryWhere (analysis + export-report): sentinel flows as a
    //     non-matching outlet code list → 0 rows (same as the pre-existing
    //     []-sentinel path — no behavior change there)
    return ['__NO_MATCH__'];
  }
}
