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
      return fn(tx);
    },
    {
      timeout: timeoutMs, // interactive transaction timeout (was default 5000ms)
      maxWait: 10000, // max time to wait for a connection from the pool
    }
  );
}

// ============================================================
//  Build filter conditions for raw SQL (Prisma.sql fragments)
//  Returns an empty Prisma.sql fragment when no filters apply
//  (Prisma.join requires ≥1 element, so handle empty case explicitly)
// ============================================================
export function buildSqlFilters(
  opts: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
    kelompok?: string | null;
  },
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
    parts.push(Prisma.sql`AND ${a}."outletId" IN (SELECT id FROM "Outlet" WHERE LEFT(SUBSTRING(code FROM '[^.]+$'), 3) = ${opts.kelompok})`);
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
