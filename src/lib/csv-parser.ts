// ============================================================
//  CSV Streaming Parser
//  ----------------------------------------------------------
//  Parses CSV files row by row using Node.js streams.
//  Memory usage: ~1 row at a time (very low, ~5MB total).
//
//  This is MUCH lighter than Excel parsing because:
//  - No ZIP decompression
//  - No XML parsing
//  - No shared strings lookup
//  - No formatting detection
//  - Just text → split by delimiter → yield
// ============================================================
import { parse } from 'csv-parse';
import { createReadStream } from 'fs';
import { HEADER_ALIASES } from '@/lib/excel';

export interface CsvRow {
  [key: string]: string;
}

// ============================================================
//  Stream parse CSV file, yielding one row at a time
//  Usage:
//    for await (const row of parseCsvStream(csvPath)) {
//      // process row — only 1 row in memory at a time
//    }
// ============================================================
export async function* parseCsvStream(csvPath: string): AsyncGenerator<CsvRow> {
  const parser = parse({
    columns: (headers: string[]) => headers.map((h: string) => {
      // Normalize headers same way as Excel parser
      const cleaned = h.toLowerCase().replace(/\s+/g, ' ').trim();
      return HEADER_ALIASES[cleaned] || HEADER_ALIASES[cleaned.replace(/\s*\/\s*/g, '/')] || cleaned;
    }),
    skip_empty_lines: true,
    trim: true,
    bom: true, // handle BOM if present
    relax_quotes: true, // handle malformed quotes gracefully
    relax_column_count: true, // handle inconsistent column counts
  });

  const stream = createReadStream(csvPath, 'utf-8');
  stream.pipe(parser);

  for await (const row of parser) {
    yield row as CsvRow;
  }
}

// Bug 5 fix: countCsvRows removed — was dead code, never called anywhere.
// If needed in future, use line count instead of full CSV parse.
