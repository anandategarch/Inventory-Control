// ============================================================
//  Ingestion — Concurrency Locks
//  --------------------------------------------------------
//  Two layers:
//
//  1. acquireIngestionLock / releaseIngestionLock (Bug 3 fix)
//     In-process per-file-path Set. Cheap and instant, but only
//     guards a single Node instance — useless on serverless /
//     multi-instance deploys.
//
//  2. acquireDbAdvisoryLock (AUDIT-BUG-5)
//     `SELECT pg_advisory_xact_lock(hashtext(<key>))` executed as
//     the FIRST statement INSIDE the import transaction. PostgreSQL
//     advisory locks are per-session (connection), so they serialize
//     concurrent imports of the same month ACROSS instances/processes,
//     and they auto-release at transaction end (xact-scoped) — no
//     orphaned locks, even if the process crashes mid-transaction.
//
//     Key = monthKey ("2026-08") — the period whose delete+insert
//     critical section must not interleave. Same key space is used by
//     processIngestion (/api/ingest, /api/import-drive) and
//     /api/ingest-process, so full-file and per-week imports of the
//     same month also serialize against each other.
//
//     Best-effort on non-PostgreSQL databases (SQLite dev): if the
//     first attempt fails we log once and skip the lock thereafter —
//     single-instance dev is still guarded by the in-memory lock.
//     On PostgreSQL the only failure modes are connection-level, which
//     fail the whole import anyway.
// ============================================================
import { logger } from '../logger';
import type { Prisma } from '@prisma/client';

const ingestionLocks = new Set<string>();

export function acquireIngestionLock(key: string): boolean {
  if (ingestionLocks.has(key)) return false;
  ingestionLocks.add(key);
  return true;
}

export function releaseIngestionLock(key: string): void {
  ingestionLocks.delete(key);
}

// --- AUDIT-BUG-5: DB advisory lock ---------------------------------------
// null = not probed yet · true = available · false = unavailable (non-PG).
let advisoryLockAvailable: boolean | null = null;

/**
 * Take a transaction-scoped PostgreSQL advisory lock on `key`.
 * MUST be called inside the transaction callback (first statement) —
 * the lock is released automatically when the transaction ends.
 * No-op on databases without pg advisory locks (probed once, cached).
 */
export async function acquireDbAdvisoryLock(
  tx: Prisma.TransactionClient,
  key: string,
): Promise<void> {
  if (advisoryLockAvailable === false) return; // non-PG — skip silently
  try {
    // Tagged template → parameterized $1, no injection surface.
    // hashtext() folds an arbitrary string into an int4 lock key.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    advisoryLockAvailable = true;
  } catch (e) {
    if (advisoryLockAvailable === null) {
      // First failure → assume non-PostgreSQL backend (e.g. SQLite dev).
      // Log once; subsequent calls skip without touching the DB.
      advisoryLockAvailable = false;
      logger.warn(
        `ingestion-lock: pg advisory lock unavailable (${e instanceof Error ? e.message : String(e)}) — ` +
          'cross-instance import serialization disabled (single-instance in-memory lock still active)',
      );
    }
    // A later failure after a successful probe (transient connection error)
    // is swallowed here deliberately: the import itself will fail loudly on
    // the very next statement if the connection is really down.
  }
}
