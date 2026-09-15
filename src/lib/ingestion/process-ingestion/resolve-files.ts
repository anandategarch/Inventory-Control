// ============================================================
//  processIngestion — input file resolution
//  ----------------------------------------------------------
//  Resolves the request body (filePath | dir | fileName | default)
//  into the list of files to ingest, with path-traversal checks
//  (Bug 1 fix) and the "no files found" guard.
//
//  SPLIT-D (pure code motion): extracted verbatim from
//  src/lib/ingestion/process-ingestion.ts (old file deleted;
//  './process-ingestion' from the ingestion barrel now resolves to
//  this folder's index.ts — same import path for every caller).
// ============================================================
import { DATA_DIR, safePath } from '../safe-path';
import { findExcelFiles } from '../find-excel-files';
import type { IngestRequestBody, IngestResult } from '../types';

export type ResolvedInputFiles =
  | { ok: true; files: string[] }
  | { ok: false; errorResult: IngestResult };

export async function resolveInputFiles(body: IngestRequestBody): Promise<ResolvedInputFiles> {
  let files: string[] = [];

  if (body.filePath) {
    const safe = safePath(body.filePath);
    if (!safe) {
      return {
        ok: false,
        errorResult: {
          fileName: body.filePath, status: 'ERROR', rowCount: 0,
          dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked',
        },
      };
    }
    files = [safe];
  } else if (body.dir) {
    const safe = safePath(body.dir);
    if (!safe) {
      return {
        ok: false,
        errorResult: {
          fileName: body.dir, status: 'ERROR', rowCount: 0,
          dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked',
        },
      };
    }
    files = await findExcelFiles(safe);
  } else if (body.fileName) {
    const safe = safePath(body.fileName);
    if (!safe) {
      return {
        ok: false,
        errorResult: {
          fileName: body.fileName, status: 'ERROR', rowCount: 0,
          dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'Path traversal blocked',
        },
      };
    }
    files = [safe];
  } else {
    files = await findExcelFiles();
  }

  if (files.length === 0) {
    return {
      ok: false,
      errorResult: {
        fileName: '(none)',
        status: 'ERROR',
        rowCount: 0,
        dqStatus: 'ERROR',
        dqErrors: 1,
        dqWarnings: 0,
        error: `No .xlsx or .csv files found in ${DATA_DIR}.`,
      },
    };
  }

  return { ok: true, files };
}
