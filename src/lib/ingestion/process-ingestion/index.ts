// ============================================================
//  processIngestion — barrel export
//  ----------------------------------------------------------
//  SPLIT-D (pure code motion): was src/lib/ingestion/process-ingestion.ts
//  (565 lines, old file deleted). './process-ingestion' from
//  src/lib/ingestion/index.ts now resolves to this folder — the
//  barrel re-exports EXACTLY the old public API (only
//  processIngestion; no `export *` → no accidental additions):
//    ./orchestrator       — processIngestion() per-file loop + locks
//    ./resolve-files      — input file resolution (path traversal guard)
//    ./read-rows          — STEP 1 xlsx/csv row reader
//    ./prepare-rows       — PASS 1 CPU-only normalize/derive
//    ./ingest-transaction — the atomic db.$transaction core
// ============================================================
export { processIngestion } from './orchestrator';
