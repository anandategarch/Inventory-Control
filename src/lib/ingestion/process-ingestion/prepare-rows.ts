// ============================================================
//  processIngestion — PASS 1: CPU-only row preparation
//  ----------------------------------------------------------
//  STEP 3.5 (PERF PAKET B / F3): validate (non-fastMode) +
//  normalize + derive every row up front and collect the distinct
//  outlet/item candidates. The transaction then resolves ALL of
//  them in a handful of set-based queries (ensureOutletsExist /
//  ensureItemsExist) instead of one sequential upsert per new
//  master-data code.
//
//  SPLIT-D (pure code motion): extracted verbatim from
//  src/lib/ingestion/process-ingestion.ts (old file deleted;
//  './process-ingestion' from the ingestion barrel now resolves to
//  this folder's index.ts — same import path for every caller).
//  seenKeys + allIssues are passed in by the orchestrator and
//  mutated by reference — identical to the original closure flow.
// ============================================================
import { normalizeRow, deriveRecord, type NumberLocale } from '@/engine/transform';
import { validateRow, type DQIssueRow } from '@/engine/validator';
import type { OutletCandidate } from '../process-rows-for-import';
import type { IngestRawRow } from './read-rows';

export type PreparedRow = {
  rowNumber: number;
  n: ReturnType<typeof normalizeRow>;
  derived: ReturnType<typeof deriveRecord>;
};

export interface PrepareRowsResult {
  prepared: PreparedRow[];
  outletCandidates: Map<string, OutletCandidate>;
  itemCandidates: Map<string, string | null>;
}

export function prepareRows(args: {
  allRows: IngestRawRow[];
  fileName: string;
  monthLabel: string;
  fastMode?: boolean;
  numberLocale?: NumberLocale;
  seenKeys: Set<string>;
  allIssues: DQIssueRow[];
}): PrepareRowsResult {
  const { allRows, fileName, monthLabel, fastMode, seenKeys, allIssues } = args;
  const prepared: PreparedRow[] = [];
  const outletCandidates = new Map<string, OutletCandidate>();
  const itemCandidates = new Map<string, string | null>();
  // BUG-Q cleanup: the `skippedErrors` counter that used to live here was
  // dead plumbing — the ERROR issues themselves ARE reported (allIssues →
  // DQIssue rows + summarizeDQ → IngestResult.dqErrors), and no caller ever
  // consumed the row-skip count. Removed (behavior unchanged).
  let totalRows = 0;
  for (const rawRow of allRows) {
    totalRows++;
    const rowNumber = totalRows + 1;

    if (!fastMode) {
      // Validate
      const issues = validateRow(rawRow, rowNumber, seenKeys, rawRow._sheetName, args.numberLocale || 'auto');
      allIssues.push(...issues);

      const hasError = issues.some((i) => i.severity === 'ERROR');
      if (hasError) {
        continue;
      }
    }

    // Normalize — pass numberLocale from body (default 'auto')
    const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel, args.numberLocale || 'auto');
    const derived = deriveRecord(n);
    prepared.push({ rowNumber, n, derived });

    // First occurrence wins — matches the old upsert-on-first-encounter
    // semantics (later rows for the same code/name never re-upserted).
    if (derived.outletCode && !outletCandidates.has(derived.outletCode)) {
      outletCandidates.set(derived.outletCode, {
        code: derived.outletCode,
        name: derived.outletName,
        outletCode: derived.outletNumericCode,
        area: n.area,
      });
    }
    if (n.namaBahan && !itemCandidates.has(n.namaBahan)) {
      itemCandidates.set(n.namaBahan, n.satuan ?? null);
    }
  }

  return { prepared, outletCandidates, itemCandidates };
}
