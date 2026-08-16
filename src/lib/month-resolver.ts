// ============================================================
//  Shared monthLabel resolver
//
//  BUG FIX (DEEP-AUDIT-API-2 / FIX-DEEP-1):
//  `resolveMonthLabel` was previously inlined in /api/analysis + /api/export-report
//  with identical logic, but missing from 5 other routes that accept the `month`
//  query param (outlet-focus, outlet-items, item-history,
//  drilldown). This module provides a single shared resolver.
//
//  Background: production DB may contain mixed-case `SourceFile.monthLabel`
//  values (e.g., "AGUSTUS 2026" from upload-data.ts vs "Agustus 2026" from
//  dashboard import). PostgreSQL `=` on text is case-sensitive, so a query
//  with the "wrong" case returns 0 rows → "No records found". This resolver
//  maps the user-sent label to the actual DB case via two structures:
//    - exact: Set of labels exactly as stored (fast path for correct case)
//    - lowerToActual: Map<lowercased, actual> (slow path for wrong case)
//
//  The resolver is cached for the lifetime of the server process so repeated
//  calls within the same request (and across requests) skip the DB query.
//  After mutations that change which SourceFile rows exist (ingestion, delete),
//  callers MUST invoke `clearMonthResolverCache()` to invalidate the cache.
// ============================================================
import { db } from '@/lib/db';

export interface MonthResolver {
  /** Map from lowercased monthLabel → actual DB-case monthLabel */
  lowerToActual: Map<string, string>;
  /** Set of monthLabel values exactly as stored in DB */
  exact: Set<string>;
}

// Cache monthLabel lookups to avoid repeated DB queries within same request
// (and across requests until cleared by a mutation).
let _monthLabelCache: MonthResolver | null = null;

/**
 * Returns a cached resolver built from the current set of SourceFile rows.
 * Subsequent calls within the same process reuse the cache until
 * `clearMonthResolverCache()` is invoked.
 */
export async function getMonthResolver(): Promise<MonthResolver> {
  if (_monthLabelCache) return _monthLabelCache;
  const fileMonthKeys = await db.sourceFile.findMany({
    select: { monthLabel: true, monthKey: true },
  });
  _monthLabelCache = {
    lowerToActual: new Map(
      fileMonthKeys.map((f) => [f.monthLabel.toLowerCase(), f.monthLabel]),
    ),
    exact: new Set(fileMonthKeys.map((f) => f.monthLabel)),
  };
  return _monthLabelCache;
}

/**
 * Resolve a user-supplied monthLabel to the actual case stored in the DB.
 * - null/empty input → null
 * - exact match against DB labels → returned as-is (fast path)
 * - case-insensitive match → returns the actual DB-case label
 * - no match at all → returned unchanged (caller can still attempt the query)
 */
export function resolveMonthLabel(
  label: string | null,
  resolver: MonthResolver,
): string | null {
  if (!label) return null;
  if (resolver.exact.has(label)) return label;
  return resolver.lowerToActual.get(label.toLowerCase()) || label;
}

/**
 * Invalidate the resolver cache. Callers MUST invoke this after any mutation
 * that changes which SourceFile rows exist (ingestion, delete-by-month, etc.)
 * so subsequent requests see the new set of monthLabels.
 */
export function clearMonthResolverCache(): void {
  _monthLabelCache = null;
}
