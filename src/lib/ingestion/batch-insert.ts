// ============================================================
//  Ingestion — Batch Insert Helper (BUG-4 AUDIT FIX)
//  --------------------------------------------------------
//  Replaces the old inline pattern:
//    try { createMany({ skipDuplicates: true }) }
//    catch { for (rec of batch) { try { create(rec) } catch {} } }
//  The empty per-row `catch {}` swallowed EVERY error — not just
//  duplicates. A connection drop / timeout / data error mid-import
//  silently dropped rows: the import "succeeded" with fewer records,
//  no DQ issue, no error. Silent data loss.
//
//  New semantics:
//    - PostgreSQL happy path: createMany(skipDuplicates) — ON CONFLICT
//      DO NOTHING (no arbiter) skips rows violating ANY unique index,
//      including the NULL-safe COALESCE index added by
//      scripts/fix-null-akun-duplicates.ts (BUG-3).
//    - Fallback (e.g. SQLite, which rejects skipDuplicates): insert
//      rows one-by-one, catching ONLY Prisma P2002 (unique-constraint)
//      as "skipped duplicate" and RETHROWING everything else so the
//      caller's transaction rolls back and the error reaches the user
//      (no more silent loss). Duplicates are counted + logged.
// ============================================================
import { Prisma } from '@prisma/client';
import { logger } from '../logger';

export interface BatchInsertResult {
  /** Rows actually inserted. */
  inserted: number;
  /** Rows skipped because they violated a unique constraint (duplicates). */
  dupSkipped: number;
}

type DbClient = Prisma.TransactionClient;

/** Prisma known-error check: unique-constraint violation (P2002). */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Insert a batch of InventoryRecords with duplicate-tolerant, error-strict
 * semantics. See the module header — duplicates are skipped and counted,
 * every OTHER error propagates (rolling back the caller's transaction).
 */
export async function insertInventoryRecords(
  client: DbClient,
  records: Prisma.InventoryRecordCreateManyInput[],
): Promise<BatchInsertResult> {
  if (records.length === 0) return { inserted: 0, dupSkipped: 0 };

  try {
    // PostgreSQL / MySQL happy path: skipDuplicates → ON CONFLICT DO NOTHING.
    const result = await client.inventoryRecord.createMany({
      data: records,
      skipDuplicates: true,
    });
    return { inserted: result.count, dupSkipped: 0 };
  } catch (batchError) {
    // createMany failed as a whole (e.g. SQLite rejects skipDuplicates,
    // or a genuine DB error). Fall back row-by-row: duplicates (P2002)
    // are skipped + counted; any other error is RETHROWN so the import
    // transaction rolls back instead of silently losing rows (BUG-4).
    logger.warn(
      `batch-insert: createMany failed, falling back to per-row insert — ` +
        (batchError instanceof Error ? batchError.message : String(batchError)),
    );
    let inserted = 0;
    let dupSkipped = 0;
    for (const rec of records) {
      try {
        await client.inventoryRecord.create({ data: rec });
        inserted++;
      } catch (rowError) {
        if (isUniqueViolation(rowError)) {
          dupSkipped++;
          continue;
        }
        // NOT a duplicate → real failure. Stop immediately and rethrow:
        // the caller's transaction must roll back (data loss must be loud).
        logger.error(
          `batch-insert: row insert failed (non-duplicate error) — aborting batch of ${records.length}: ` +
            (rowError instanceof Error ? rowError.message : String(rowError)),
        );
        throw rowError;
      }
    }
    if (dupSkipped > 0) {
      logger.warn(`batch-insert: skipped ${dupSkipped}/${records.length} duplicate row(s) (P2002)`);
    }
    return { inserted, dupSkipped };
  }
}
