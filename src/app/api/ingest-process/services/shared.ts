// ============================================================
//  shared — IngestProcessContext + cross-mode helpers
//  --------------------------------------------------------
//  Extracted from the original 963-line ingest-process route.ts
//  (REFACTOR-1-a pure-move split). IngestProcessContext carries the
//  values parsed ONCE by route.ts's shared preamble (rate limit,
//  Zod validation, manual rename, fileHash/ext sanitization,
//  placeholder detection) into the per-mode handlers, which read
//  them via `ctx.*`.
// ============================================================
import { parseMonthFromFilename, type ParsedMonth } from '@/lib/excel';
import type { z } from 'zod';
import type { ingestProcessBodySchema } from '@/lib/validation';

// FIX (BUG-3-c SEDANG-3): `body` used to be the RAW `Record<string, unknown>`
// JSON — mode handlers read weekLabel/weeksToImport/fileSize straight from
// it, so every bound in ingestProcessBodySchema was decorative (an attacker
// could bypass the ≤12-weeks / week-format limits entirely). It now carries
// the Zod-VALIDATED payload only (route.ts passes `validation.data`).
export type IngestProcessBody = z.infer<typeof ingestProcessBodySchema>;

export interface IngestProcessContext {
  /** Request start timestamp — mode responses report `durationMs` from it. */
  startedAt: number;
  /** Zod-VALIDATED request body (FIX BUG-3-c SEDANG-3) — mode handlers read mode-specific fields (weekLabel, weeksToImport, fileSize). */
  body: IngestProcessBody;
  /** Original client-supplied fileName (pre manual-rename / placeholder fix). */
  rawFileName: string;
  /**
   * Effective file name — MUTABLE: mode handlers may reassign it when the
   * filename is a placeholder and the real month is extracted from row data.
   */
  fileName: string;
  /** Month parsed from the filename — MUTABLE for the same reason as `fileName`; null until resolved. */
  monthInfo: ParsedMonth | null;
  /** True when the user explicitly renamed the file via manualFileName. */
  manualMode: boolean;
  /** Path-traversal-safe fileHash (validated hex, FIX-A-1). */
  safeFileHash: string;
  /** Final file extension (validated against SAFE_EXT_ALLOWLIST). */
  fileExt: string;
  /** Client-advisory file size (from the server-verified last-chunk sum, FIX-A-3). */
  fileSize: unknown;
  /** Number locale for CSV separator parsing ('auto' | 'id' | 'us'). */
  locale: 'auto' | 'id' | 'us';
  /** True when fileName matched a Google Sheets placeholder pattern. */
  fileNameIsPlaceholder: boolean;
}

// Helper: extract monthLabel from Excel row data (BULAN / BULAN 2 fields)
// BULAN field typically contains "171.MEI 26" or "17.MEI 2026"
// BULAN 2 field typically contains "17.MEI"
export const extractMonthFromRows = (rows: Array<Record<string, unknown>>): string | null => {
  for (const row of rows) {
    const bulan = String(row.bulan ?? row.BULAN ?? '').trim();
    const bulan2 = String(row.bulan2 ?? row['BULAN 2'] ?? row.bulan_2 ?? '').trim();
    // Try BULAN first (has year info)
    // DA-01 FIX: Use current year instead of hardcoded "2026" — prevents
    // cross-year data corruption in 2027+ when BULAN2 contains only month name.
    const currentYear = new Date().getFullYear();
    for (const candidate of [bulan, bulan2, `${bulan2} ${currentYear}`]) {
      if (candidate) {
        const parsed = parseMonthFromFilename(candidate);
        if (parsed) return parsed.monthLabel;
      }
    }
  }
  return null;
};
