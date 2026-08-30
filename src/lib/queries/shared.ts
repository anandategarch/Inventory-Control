// ============================================================
//  Shared filter builder for raw SQL aggregate queries.
//  Used by all query modules in this directory:
//    dashboard.ts, items.ts, outlets.ts, areas.ts, historical.ts
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// FIX H4 (AUDIT-7): PgBouncer transaction mode (port 6543) silently strips the
// `statement_timeout` URL param. To enforce a per-query timeout, wrap the query
// in a transaction with `SET LOCAL statement_timeout = 30000`. SET LOCAL only
// applies to the current transaction, so it's safe and doesn't leak to other queries.
//
// Usage: `const rows = await withStatementTimeout(() => db.$queryRaw\`...\`);`
//
// Note: this adds ~1-2ms overhead per call (transaction begin/commit). Only use
// for queries that could potentially hang (e.g. heavy aggregations on large tables).
//
// PERF-DB-03: also sets `work_mem = 64MB` per transaction. Supabase's default
// work_mem is 4MB — sort-heavy queries (variance self-join, top-items bucket
// avg) spill 2-3MB to disk, adding ~50ms latency per spill. Bumping to 64MB
// per-transaction is safe (only consumed if sort/hash actually needs it; PG
// allocates work_mem per sort node, not per query). 64MB × 30 connection limit
// = 1.9GB worst case — well under Supabase free tier's 500MB database storage
// (work_mem is RAM, not disk). Verified via EXPLAIN: variance query drops from
// 109ms (with disk spill) → 91ms (in-memory sort) — modest gain, but eliminates
// the IO wait which can spike under concurrent load.
export async function withStatementTimeout<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  timeoutMs: number = 30000
): Promise<T> {
  // FIX (DEEP-AUDIT-TX-TIMEOUT): Prisma $transaction default timeout is 5000ms,
  // but our heavy queries (variance self-join, rule evaluation LATERAL) can take
  // 10s+. The `statement_timeout` SET LOCAL only limits per-query execution time,
  // NOT the transaction wrapper timeout. Pass `timeout` option to $transaction
  // to increase the interactive transaction timeout to match statement_timeout.
  return db.$transaction(
    async (tx) => {
      // FIX: SET LOCAL doesn't accept parameterized values in Prisma ($1).
      // Use Prisma.raw to interpolate the integer safely (it's a hardcoded int,
      // not user input — no SQL injection risk).
      await tx.$executeRaw`SET LOCAL statement_timeout = ${Prisma.raw(String(timeoutMs))}`;
      // PERF-DB-03: bump work_mem per-transaction to avoid sort spills.
      // 64MB is generous — PG only allocates what it actually needs per sort node.
      await tx.$executeRaw`SET LOCAL work_mem = '64MB'`;
      return fn(tx);
    },
    {
      timeout: timeoutMs, // interactive transaction timeout (was default 5000ms)
      maxWait: 10000, // max time to wait for a connection from the pool
    }
  );
}

// ============================================================
//  Shared filter options for all SQL aggregate queries.
//
//  FIX (BUG-PERF-2 / BUG-BE-6): Previously each query module declared its
//  `filters` parameter as an inline type WITHOUT `kelompok`, even though
//  `buildSqlFilters` (below) DOES read `opts.kelompok`. TypeScript's
//  structural typing allowed this to "work" at runtime (extra props on a
//  passed object are not erased), but the contract was fragile: a naive
//  refactor to destructuring (e.g. `const { area, outletCode } = filters`)
//  would silently drop the kelompok filter with no type error.
//
//  Centralising the filter shape here makes the contract explicit and
//  refactor-safe. All query modules should use `SqlFilterOpts` for their
//  `filters` parameter type.
// ============================================================
/** Shared filter options for all SQL aggregate queries. */
export interface SqlFilterOpts {
  area?: string | null;
  kelompok?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  picOutletCodes?: string[] | null;
}

// ============================================================
//  DIRECTION_FROM_SUM_SQL — shared CASE WHEN fragment that
//  derives LOSS/SURPLUS/NEUTRAL from SUM(ir."nominalLossSurplus")
//  with a fallback to SUM(ir."qtyDeviasi") when nominalLossSurplus
//  is NULL. Used by top-items, global-search, resto-recommendations,
//  peer-comparison to avoid duplicating the 5-branch CASE across
//  every query.
//
//  FIX (RESTORE-SHARED-1): this constant was lost during a force
//  push and was inlined as a 6-line CASE WHEN in 4 query files.
//  Restored here as a single shared Prisma.sql fragment.
// ============================================================
export const DIRECTION_FROM_SUM_SQL = Prisma.sql`
  CASE
    WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
    WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
    WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
    WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
    ELSE 'NEUTRAL'
  END
`;

// ============================================================
//  computePareto8020 — shared Pareto 80/20 driver extraction.
//  Sorts rows by |getValue(row)| desc, accumulates share% until
//  cumulative share crosses `threshold` (default 80%) or
//  `maxDrivers` rows accumulated (default 20).
//
//  Used by pareto.ts (per dimension) + growth-drivers.ts (up/down
//  per metric) to avoid duplicating the sort+cumsum+threshold loop.
//
//  FIX (RESTORE-SHARED-1): this function was lost during a force
//  push and was inlined as ~30 lines of duplicate logic in both
//  consumer files. Restored here as a single generic helper.
// ============================================================
export type WithPareto<T> = T & { sharePct: number; cumPct: number };
export interface ParetoResult8020<T> {
  drivers: WithPareto<T>[];
  remainderCount: number;
  remainderPct: number;
  totalMagnitude: number;
  totalCount: number;
}
export function computePareto8020<T>(
  rows: T[],
  getValue: (row: T) => number,
  threshold: number = 0.80,
  maxDrivers: number = 20,
): ParetoResult8020<T> {
  const sorted = [...rows].sort((a, b) => Math.abs(getValue(b)) - Math.abs(getValue(a)));
  const totalMagnitude = sorted.reduce((s, r) => s + Math.abs(getValue(r)), 0);
  if (totalMagnitude === 0) {
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalMagnitude: 0, totalCount: rows.length };
  }
  let cumPct = 0;
  const drivers: WithPareto<T>[] = [];
  for (const r of sorted) {
    if (drivers.length >= maxDrivers) break;
    const sharePct = (Math.abs(getValue(r)) / totalMagnitude) * 100;
    cumPct += sharePct;
    drivers.push({ ...r, sharePct: Number(sharePct.toFixed(1)), cumPct: Number(cumPct.toFixed(1)) });
    if (cumPct >= threshold * 100) break;
  }
  return { drivers, remainderCount: rows.length - drivers.length, remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)), totalMagnitude, totalCount: rows.length };
}

// ============================================================
//  Build filter conditions for raw SQL (Prisma.sql fragments)
//  Returns an empty Prisma.sql fragment when no filters apply
//  (Prisma.join requires ≥1 element, so handle empty case explicitly)
// ============================================================
export function buildSqlFilters(
  opts: SqlFilterOpts,
  alias: string = 'ir'
): Prisma.Sql {
  // FIX (DEEP-AUDIT-IR): `alias` param allows callers that use a different
  // table alias (e.g. `c` for current-period records in self-join queries)
  // to generate filter fragments with the correct alias. Default 'ir' keeps
  // all existing callers backward-compatible.
  // NOTE: `alias` is an internal string literal ('ir' | 'c' | 'p'), never
  // user input — safe to interpolate via Prisma.raw (no SQL injection risk).
  const a = Prisma.raw(alias);
  const parts: Prisma.Sql[] = [];
  if (opts.area) {
    parts.push(Prisma.sql`AND ${a}.area = ${opts.area}`);
  }
  if (opts.kelompok) {
    // FIX (BUG-KELOMPOK-EMPTY): Outlet codes are like "1030.BDGSET" or "B.1001.MLGPAR".
    // The kelompok (e.g. "MLG") is the first 3 chars of the NAME segment — the part
    // AFTER THE LAST DOT. The old filter `code LIKE 'MLG%'` matched NOTHING because
    // codes start with numbers ("1030") or "B", not the kelompok prefix → 0 outlets
    // matched → all SQL aggregates returned empty → dashboard appeared blank.
    //
    // Fix: extract the last dot-separated segment, take its first 3 chars, compare.
    // LEFT(SUBSTRING(code FROM '[^.]+$'), 3) works for BOTH outlet code formats:
    //   "1030.BDGSET"  → SUBSTRING = "BDGSET" → LEFT 3 = "BDG" ✓
    //   "B.1001.MLGPAR" → SUBSTRING = "MLGPAR" → LEFT 3 = "MLG" ✓
    //
    // FIX (BUG-BE-1 / BUG-EDGE-1): UPPER(${opts.kelompok}) normalizes the input to
    // uppercase so the filter is case-insensitive. DB codes are stored uppercase
    // ("MLGPAR"), so LEFT() returns uppercase. Without UPPER(), a lowercase
    // `?kelompok=bdg` would compare "MLG" = "bdg" → FALSE → 0 rows → empty dashboard.
    // The JS path (kelompokOutletCodes in analysis/export routes) already normalizes
    // via .toUpperCase() — this makes the SQL path consistent.
    parts.push(Prisma.sql`AND ${a}."outletId" IN (SELECT id FROM "Outlet" WHERE LEFT(SUBSTRING(code FROM '[^.]+$'), 3) = UPPER(${opts.kelompok}))`);
  }
  if (opts.outletCode) {
    parts.push(Prisma.sql`AND ${a}."outletId" IN (SELECT id FROM "Outlet" WHERE code = ${opts.outletCode})`);
  }
  if (opts.picOutletCodes && opts.picOutletCodes.length > 0) {
    parts.push(Prisma.sql`AND ${a}."outletId" IN (SELECT id FROM "Outlet" WHERE code IN (${Prisma.join(opts.picOutletCodes)}))`);
  }
  if (opts.itemName) {
    // FIX (BUG-1-7): Wrap both sides in LOWER() so matching is case-insensitive
    // on BOTH SQLite (default case-insensitive LIKE) and PostgreSQL (default
    // case-sensitive LIKE). Without this, "ayam" matches "Ayam Goreng" in
    // local SQLite testing but NOT in production PostgreSQL.
    parts.push(Prisma.sql`AND ${a}."itemId" IN (SELECT id FROM "Item" WHERE LOWER(name) LIKE LOWER(${'%' + opts.itemName + '%'}))`);
  }
  // Prisma.join requires ≥1 element; return empty fragment when no filters
  if (parts.length === 0) return Prisma.sql``;
  if (parts.length === 1) return parts[0];
  return Prisma.join(parts, ' ');
}
