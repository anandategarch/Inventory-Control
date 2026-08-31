// ============================================================
//  Ingestion — In-Process Concurrency Lock
//  --------------------------------------------------------
//  Bug 3 fix: race condition — in-process lock per file path.
//  Prevents two concurrent /api/ingest requests from
//  double-processing the same file (would cause duplicate
//  SourceFile rows + double-counted InventoryRecords).
//
//  Module-private — not re-exported from the barrel. Used only
//  by process-ingestion.ts.
// ============================================================
const ingestionLocks = new Set<string>();

export function acquireIngestionLock(key: string): boolean {
  if (ingestionLocks.has(key)) return false;
  ingestionLocks.add(key);
  return true;
}

export function releaseIngestionLock(key: string): void {
  ingestionLocks.delete(key);
}
