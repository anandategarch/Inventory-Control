// ============================================================
//  processIngestion — file reader (STEP 1)
//  ----------------------------------------------------------
//  Reads .xlsx (multi-sheet, with _sheetName tagging for the DQ
//  audit — P1-9 fix) or .csv (stream parser) into a flat row list.
//
//  SPLIT-D (pure code motion): extracted verbatim from
//  src/lib/ingestion/process-ingestion.ts (old file deleted;
//  './process-ingestion' from the ingestion barrel now resolves to
//  this folder's index.ts — same import path for every caller).
// ============================================================
import { parseExcelFile } from '@/lib/excel';
import { parseCsvStream } from '@/lib/csv-parser';

export type IngestRawRow = Record<string, unknown> & { _sheetName?: string };

export async function readAllRows(filePath: string, ext: string): Promise<IngestRawRow[]> {
  // STEP 1: Parse Excel directly (skip CSV conversion — 30% faster)
  // P1-9 fix: track sheetName per row for DQ audit
  const allRows: IngestRawRow[] = [];
  if (ext === '.xlsx') {
    const parsed = await parseExcelFile(filePath);
    for (const sheet of parsed.sheets) {
      for (const row of sheet.rows) {
        allRows.push({ ...row, _sheetName: sheet.sheetName });
      }
    }
  } else {
    // CSV: use stream parser
    for await (const rawRow of parseCsvStream(filePath)) {
      allRows.push(rawRow);
    }
  }
  return allRows;
}
