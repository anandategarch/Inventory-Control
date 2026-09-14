// ============================================================
//  Ingestion — TypeScript Types
//  --------------------------------------------------------
//  Public types shared between processIngestion (full-file)
//  and processRowsForImport (per-week) ingestion paths.
//  Re-exported from the barrel (./index).
// ============================================================
import type { DQIssueRow } from '@/engine/validator';
import type { NumberLocale } from '@/engine/transform';

export interface IngestResult {
  fileName: string;
  status: 'INGESTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqStatus: string;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
}

export interface IngestRequestBody {
  /** Optional single-file path (resolved against DATA_DIR) */
  filePath?: string;
  /** Optional directory path (resolved against DATA_DIR) */
  dir?: string;
  /** Optional single-file name (resolved against DATA_DIR) */
  fileName?: string;
  /** Optional user-provided override for the original filename */
  manualFileName?: string;
  // FIX (BUG-3-c SEDANG-3): `precomputedHash` removed — no caller ever set it
  // (the hash is always computed inside processIngestion via hashFile), so the
  // field was dead weight on the request type.
  /** Number format locale ('auto' | 'id' | 'us') for CSV separator parsing */
  numberLocale?: NumberLocale;
}

export interface ProcessRowsResult {
  inserted: number;
  skippedErrors: number;
  dqIssues: DQIssueRow[];
  /** FIX (AUDIT-BUG-3): rows skipped by the in-memory natural-key dedup
   *  (week|outlet|item|COALESCE(akun,'')) — fastMode callers have no DQ
   *  pipeline, so the count is surfaced here for logging/reporting. */
  skippedDuplicates: number;
}
