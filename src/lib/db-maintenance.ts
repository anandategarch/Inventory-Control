// ============================================================
//  db-maintenance — runtime DB size hygiene (DB-SIZE-1)
//  --------------------------------------------------------
//  Background: PostgreSQL never returns disk space from DELETEs
//  to the OS on its own — dead tuples are only *reused* by future
//  writes. Two of our tables churn hard (re-importing the same
//  month purges ~54K InventoryRecord + ~39K DQIssue rows per
//  cycle; AggregationCache upserts ~1MB payloads), so without
//  tuning, the database file keeps growing even though the live
//  data stays flat.
//
//  This module hosts two zero-click, self-healing routines wired
//  into /api/status (fire-and-forget, never break the route):
//
//  1. cleanupOrphanedFileChunks — TTL safety net for FileChunk.
//     Chunks (up to 5MB each) are cleaned by fileHash on the
//     happy paths (detect-mode error paths + import success), but
//     LEAK when the user uploads and never clicks "process",
//     when parseExcelFile throws (500 path bypasses per-hash
//     cleanup), or when an instance dies mid-process. Any chunk
//     older than 24h cannot belong to an in-flight upload →
//     safe to delete.
//
//  2. ensureAutovacuumTuning — one-shot per process, idempotent
//     ALTER TABLE SET on the churn-heavy tables so autovacuum
//     triggers at 2% dead tuples (Postgres default 20% is too
//     slow for our re-import pattern) and runs at full speed
//     (cost_delay=0). Once dead tuples are recycled promptly,
//     future inserts REUSE that space instead of appending —
//     the file stops growing.
//
//  For a physical shrink of already-bloated disk (VACUUM FULL),
//  run the one-command CLI:  bun run db:maintenance --vacuum-full
//  (see scripts/db-maintenance.ts).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from './db';
import { logger } from './logger';
import { withStatementTimeout } from './queries/shared';

// ------------------------------------------------------------
//  1. cleanupOrphanedFileChunks — age-based TTL safety net
// ------------------------------------------------------------
const FILE_CHUNK_TTL_MS = 24 * 60 * 60 * 1000; // 24h — see module header

// Opportunistic rate limit — same pattern as cleanupExpiredCache
// (aggregation-cache/store.ts PERF-CACHE-07): at most once per
// 10 minutes so /api/status never pays a DB write per call.
const FILE_CHUNK_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let _lastChunkCleanupAt = 0;

export async function cleanupOrphanedFileChunks(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - _lastChunkCleanupAt < FILE_CHUNK_CLEANUP_INTERVAL_MS) return;
  _lastChunkCleanupAt = now;
  try {
    const cutoff = new Date(now - FILE_CHUNK_TTL_MS);
    const result = await db.fileChunk.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      logger.info(`[db-maintenance] removed ${result.count} orphaned FileChunk row(s) older than ${cutoff.toISOString()}`);
    }
  } catch (e) {
    // Non-blocking — opportunistic cleanup must never fail the caller.
    // (Also fires harmlessly on fresh DBs where FileChunk doesn't exist
    // yet — same graceful behavior as cleanupExpiredCache.)
    logger.error('[db-maintenance] FileChunk cleanup error (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ------------------------------------------------------------
//  2. ensureAutovacuumTuning — faster dead-tuple recycling
// ------------------------------------------------------------
// Table names/scales are OUR hardcoded constants (no user input → no
// injection surface; mirrors the `alias` Prisma.raw precedent in
// buildSqlFilters). autovacuum_vacuum_scale_factor = vacuum when this
// fraction of the table is dead tuples:
//   - InventoryRecord / DQIssue: 0.02 → ~6K dead rows on 306K live rows
//     (default 0.20 would wait for 61K — nearly a full re-import cycle
//     of bloat before vacuuming).
//   - AggregationCache: 0.10 — rows are fewer but churn ~100%.
// autovacuum_vacuum_cost_delay = 0 — vacuum at full speed instead of
// Supabase's throttled default.
const AUTOVACUUM_TUNING: ReadonlyArray<{ table: string; scale: string }> = [
  { table: 'InventoryRecord', scale: '0.02' },
  { table: 'DQIssue', scale: '0.02' },
  { table: 'AggregationCache', scale: '0.10' },
];
let _tuningEnsured = false;

export async function ensureAutovacuumTuning(force = false): Promise<void> {
  if (_tuningEnsured && !force) return;
  // Set the flag BEFORE attempting — a failure (e.g. tables don't exist
  // yet on a fresh DB, or a transient lock timeout) must not retry on
  // every status call. Next process restart retries once.
  _tuningEnsured = true;
  try {
    await withStatementTimeout(async (tx) => {
      for (const { table, scale } of AUTOVACUUM_TUNING) {
        await tx.$executeRaw`ALTER TABLE ${Prisma.raw(`"${table}"`)} SET (autovacuum_vacuum_scale_factor = ${Prisma.raw(scale)}, autovacuum_vacuum_cost_delay = 0)`;
      }
    }, 5000);
    logger.info('[db-maintenance] autovacuum tuning ensured (InventoryRecord/DQIssue 2%, AggregationCache 10%, cost_delay 0)');
  } catch (e) {
    logger.error('[db-maintenance] autovacuum tuning failed (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
  }
}
