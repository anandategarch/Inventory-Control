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
import { open } from 'fs/promises';
import { normalizeHeader } from '@/lib/excel';

export interface CsvRow {
  [key: string]: string;
}

// ============================================================
//  FIX (BUGHUNT-X5): delimiter sniffing for CSV ingestion.
//  Indonesian-locale Excel's default "Save as CSV" uses ';' as the
//  list separator, while csv-parse's default is ',' — such files used
//  to parse as ONE giant column, so no header mapped to resto/weekLabel
//  and detect failed with the misleading "Tidak ada week label
//  (WEEK 1/2/3/4) di file" error (pointing the user at the data instead
//  of the delimiter).
//
//  We sniff the delimiter ourselves over the first ~2KB instead of using
//  csv-parse 7's built-in `delimiter_auto`: the library's discovery runs
//  an internal pre-parse (`transform({ delimiter: [] })` in
//  delimiter_discover.js) that does NOT inherit `relax_quotes`, so ANY
//  standard quoted CSV (e.g. `...,"1.000,50",...`) crashes it with
//  INVALID_OPENING_QUOTE — verified in the BUGHUNT-FIX-2 scratch harness
//  against csv-parse 7.0.2 (latest 7.x at the time of writing). We also
//  deliberately do NOT use `delimiter: [',', ';', '\t']` — in csv-parse an
//  ARRAY means every member splits fields SIMULTANEOUSLY (not
//  auto-detection), which would tear unquoted fields containing the
//  "other" separator (e.g. decimal commas like `1.000,50` inside a
//  semicolon file) into extra columns.
//
//  Sniff algorithm (csv-parse's own score, restricted to sane candidates):
//  per candidate (',' ';' '\t') count occurrences per complete line, score
//  = total − std — a char that appears often AND consistently on every line
//  wins; random letters/spaces can never be picked because only the three
//  conventional separators are candidates. Ties resolve in candidate order
//  (',' first — the format's global default). A file with none of the three
//  → ',' (single-column files parse identically under any delimiter).
// ============================================================
const SNIFF_BYTES = 2048;
const DELIMITER_CANDIDATES = [',', ';', '\t'] as const;

async function sniffCsvDelimiter(csvPath: string): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(csvPath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    let text = buf.subarray(0, bytesRead).toString('utf-8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
    // Only count COMPLETE lines — the last line in the window may be truncated.
    const lastNl = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    const lines = (lastNl >= 0 ? text.slice(0, lastNl) : text)
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return ',';
    let best = ',';
    let bestScore = 0;
    for (const cand of DELIMITER_CANDIDATES) {
      const counts = lines.map((l) => {
        let n = 0;
        for (let i = 0; i < l.length; i++) if (l[i] === cand) n++;
        return n;
      });
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const mean = total / counts.length;
      const std = Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length);
      const score = total - std;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best;
  } catch {
    // Unreadable now → let the streaming parse below surface the real error.
    return ',';
  } finally {
    await fh?.close().catch(() => {});
  }
}

// ============================================================
//  Stream parse CSV file, yielding one row at a time
//  Usage:
//    for await (const row of parseCsvStream(csvPath)) {
//      // process row — only 1 row in memory at a time
//    }
// ============================================================
export async function* parseCsvStream(csvPath: string): AsyncGenerator<CsvRow> {
  // FIX (BUGHUNT-X5): sniff the delimiter (',' / ';' / '\t') from the first
  // ~2KB — see sniffCsvDelimiter above for why not csv-parse's own
  // delimiter_auto (crashes on quoted CSVs) or the array form (splits on
  // ALL members simultaneously). Pure comma files sniff ',' — identical
  // parse to before; id-ID semicolon files and tab files now parse
  // correctly instead of collapsing into one column.
  const delimiter = await sniffCsvDelimiter(csvPath);
  const parser = parse({
    delimiter,
    columns: (headers: string[]) => headers.map((h: string) => {
      // Normalize headers same way as Excel parser — via the SHARED
      // normalizeHeader (excel.ts), which tries 4 alias strategies
      // (exact / slash-normalized / %-stripped / %-stripped+slash).
      // BUG-Q: this callback previously re-implemented only the first 2
      // strategies inline, so a CSV header like "%deviasi to bom" or
      // "%qty deviasi to bom" (% glued to the letters) fell through to the
      // raw cleaned name in the CSV path while the xlsx path mapped it to
      // the canonical column — those columns were silently dropped during
      // CSV ingestion. normalizeHeader keeps the identical fallback
      // (returns the cleaned name when no alias matches), so all
      // previously-matching headers are unaffected — strictly a superset.
      return normalizeHeader(h);
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
