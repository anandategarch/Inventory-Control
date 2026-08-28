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
import { withStatementTimeout } from '@/lib/queries/shared';

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
    // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
    // so a hung query (PgBouncer pool exhaustion, slow plan) is killed at
    // 30s rather than blocking the request indefinitely.
    const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ code: string }>>`
      SELECT code FROM "Outlet"
      WHERE LEFT(SUBSTRING(code FROM '[^.]+$'), 3) = UPPER(${kelompok})
    `);
    return rows.map((r) => r.code);
  } catch (e) {
    logger.error('[kelompok-resolver] resolveKelompokOutletCodes failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
