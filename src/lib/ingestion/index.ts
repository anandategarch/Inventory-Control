// ============================================================
//  Ingestion Logic — Barrel Export
//  --------------------------------------------------------
//  Public entry point for all ingestion paths. Re-exports the
//  types + the two orchestrators (processIngestion for full-file
//  /api/ingest + /api/import-drive; processRowsForImport for
//  per-week /api/ingest-process). The DRY helper
//  computeOutletPeriodSales is also re-exported for parity with
//  scripts/backfill-outlet-period-sales.ts and any future caller.
//
//  This file is the public entry point. All existing imports like
//    import { processIngestion, type IngestResult } from '@/lib/ingestion'
//    import { processRowsForImport } from '@/lib/ingestion'
//  keep working unchanged — TypeScript resolves `@/lib/ingestion`
//  to `./ingestion/index.ts` automatically.
//
//  Source split (was src/lib/ingestion.ts, 795 LOC):
//    ./types                    — IngestResult, IngestRequestBody,
//                                 ProcessRowsResult
//    ./safe-path                — DATA_DIR constant + safePath()
//                                 (Bug 1 fix: path traversal protection)
//    ./find-excel-files         — findExcelFiles() directory scanner
//    ./ingestion-lock           — acquireIngestionLock / releaseIngestionLock
//                                 (Bug 3 fix: in-process race lock)
//                                 INTERNAL — not re-exported.
//    ./outlet-period-sales      — computeOutletPeriodSales(tx, sourceFileId)
//                                 DRY (Task 4-b): was duplicated verbatim
//                                 between processIngestion (L479-510) and
//                                 processRowsForImport (L761-792).
//    ./process-ingestion        — processIngestion() main orchestrator
//                                 (BUG2-INGEST-1 atomic transaction,
//                                  BUG-5-5 race-safe upserts,
//                                  BUG2-INGEST-3 tx propagation)
//    ./process-rows-for-import  — processRowsForImport() import flow
//                                 (BUG2-INGEST-3 tx propagation,
//                                  BUG-5-5 race-safe upserts)
//    ./batch-insert             — insertInventoryRecords() batch helper
//                                 (AUDIT-BUG-4: duplicate-tolerant,
//                                  error-strict insert — no silent loss)
//    ./ingestion-lock           — acquireIngestionLock / releaseIngestionLock
//                                 (Bug 3 fix: in-process race lock)
//                                 + acquireDbAdvisoryLock (AUDIT-BUG-5:
//                                 cross-instance pg advisory lock)
//                                 INTERNAL — not re-exported.
// ============================================================
export * from './types';
export * from './safe-path';
export * from './find-excel-files';
export * from './outlet-period-sales';
export * from './batch-insert';
export * from './process-ingestion';
export * from './process-rows-for-import';
