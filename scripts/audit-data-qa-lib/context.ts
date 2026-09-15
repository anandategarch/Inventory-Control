import { PrismaClient } from '@prisma/client';

// ============================================================
//  context.ts — DB client + logging/query helpers for audit-data-qa
//  ---------------------------------------------------------
//  SPLIT-F (pure code motion): `db`, `out`, `log`, `section`, `raw`
//  were module-level in the former single-file script and are
//  unchanged — `log` still appends to `out` AND echoes to console,
//  `raw` still swallows SQL errors into a logged message + [].
//  The entry calls createDataQaContext() before main() runs, which
//  preserves the original instantiate-then-run sequence.
// ============================================================

export function createDataQaContext() {
  const db = new PrismaClient({ log: ['error', 'warn'] });
  /** Report accumulator — the entry joins this when saving /tmp/audit-data-qa-report.txt */
  const out: string[] = [];
  function log(s: string) { out.push(s); console.log(s); }
  function section(t: string) { log(`\n════════ ${t} ════════`); }
  // TYPE-LEVEL FIX (SPLIT-F, zero runtime impact): the old script declared
  // `raw<T>(...): Promise<T[]>` while every call site passes the full ROW
  // ARRAY type as T (e.g. raw<{ n: bigint }[]>), yielding Promise<{n}[][]>.
  // Generics erase at runtime so behavior was unaffected (scripts/ was never
  // covered by tsconfig), but the signature is corrected to Promise<T> +
  // $queryRawUnsafe<T> so the modules type-check cleanly. Call sites unchanged.
  async function raw<T = any[]>(sql: string, params?: any[]): Promise<T> {
    try {
      return await db.$queryRawUnsafe<T>(sql, ...(params ?? []));
    } catch (e: any) {
      log(`  [SQL ERROR] ${e.message}`);
      return [] as T;
    }
  }
  return { db, out, log, section, raw };
}

export type DataQaContext = ReturnType<typeof createDataQaContext>;
