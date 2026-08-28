// ============================================================
//  validate-input — Stage 1 of /api/ingest-process POST pipeline
//  --------------------------------------------------------
//  Extracted from the original 700-line god function (route.ts:28-205).
//
//  Responsibilities:
//    1. Rate-limit check
//    2. Body parse + Zod validation (ingestProcessBodySchema)
//    3. Required-field presence check
//    4. numberLocale validation (default 'auto')
//    5. Manual rename support (validateManualFileName)
//    6. fileHash + ext validation (path-traversal prevention — FIX-A-1)
//    7. fileName placeholder detection (Google Sheets "Loading..." etc.)
//    8. monthInfo initial parse from filename
//
//  Returns either:
//    - { kind: 'response', response } — short-circuit (rate limit, 400)
//    - { kind: 'continue', ... } — validated input + helpers for stages 2-5
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateBody, ingestProcessBodySchema } from '@/lib/validation';
import { validateManualFileName } from '@/lib/filename';
import { parseMonthFromFilename } from '@/lib/excel';
import { logger } from '@/lib/logger';
import path from 'path';

// FIX-A-1 (BUG-5-1): Sanitize fileHash + ext to prevent path traversal in reassembleFile.
// fileHash must be a hex string (SHA-256 / SHA-512 hex) — no '..', '/', ':', etc.
// ext must be in the upload allowlist. Reject otherwise with 400 before any disk I/O.
const SAFE_FILEHASH_RE = /^[a-f0-9]{8,128}$/i;
const SAFE_EXT_ALLOWLIST = new Set(['.xlsx', '.xls', '.csv']);

export function validateFileMetadata(fileHash: unknown, ext: unknown): { ok: true; fileHash: string; ext: string } | { ok: false; error: string } {
  if (typeof fileHash !== 'string' || !SAFE_FILEHASH_RE.test(fileHash)) {
    return { ok: false, error: 'Invalid fileHash: must be hex-only (a-f0-9), 8-128 chars.' };
  }
  // ext is optional in detect/import payload — fall back to extension parsed from fileName.
  // If provided, it must be in the allowlist.
  let extStr: string;
  if (ext === undefined || ext === null || ext === '') {
    extStr = ''; // caller resolves from fileName via path.extname
  } else if (typeof ext === 'string') {
    extStr = ext.toLowerCase();
    if (!SAFE_EXT_ALLOWLIST.has(extStr)) {
      return { ok: false, error: `Invalid ext: ${extStr}. Allowed: ${[...SAFE_EXT_ALLOWLIST].join(', ')}.` };
    }
  } else {
    return { ok: false, error: 'Invalid ext: must be a string.' };
  }
  return { ok: true, fileHash, ext: extStr };
}

// Shape of the validated input — passed to stages 2-5.
export interface ValidatedInput {
  mode: 'detect' | 'import' | 'import-all';
  fileName: string;          // effective filename (after manual rename / Google Sheets strip)
  rawFileName: string;       // original client-supplied filename (for logging)
  safeFileHash: string;      // validated hex-only fileHash
  fileExt: string;           // validated extension (.xlsx/.xls/.csv)
  manualMode: boolean;       // true if user provided manualFileName
  fileNameIsPlaceholder: boolean; // true if filename looks like "Loading Google Sheet"
  locale: 'auto' | 'id' | 'us';
  monthInfo: ReturnType<typeof parseMonthFromFilename>; // null if not yet resolved (stage 2 may re-resolve from Excel data)
  body: Record<string, unknown>; // raw body (for weekLabel, weeksToImport, fileSize)
}

export type ValidateInputOutcome =
  | { kind: 'response'; response: NextResponse }
  | { kind: 'continue'; input: ValidatedInput };

// Placeholder-name detection — if the user uploaded a Google Sheets file that
// was still "Loading..." when the export happened, the filename is a placeholder
// and we need to extract the real month from the Excel row data (BULAN/BULAN 2 fields).
const PLACEHOLDER_PATTERNS = [
  /loading/i,
  /google\s*(sheet|spreadsheet|試算表|drive)/i,
  /untitled/i,
];

export function isPlaceholderName(name: string): boolean {
  const base = name.replace(/\.(xlsx|csv)$/i, '').trim();
  return PLACEHOLDER_PATTERNS.some(p => p.test(base));
}

/**
 * Helper: extract monthLabel from Excel row data (BULAN / BULAN 2 fields)
 * BULAN field typically contains "171.MEI 26" or "17.MEI 2026"
 * BULAN 2 field typically contains "17.MEI"
 *
 * Exported so parse-excel can call it after parsing — needed in both detect
 * and import modes when the filename is a placeholder.
 */
export function extractMonthFromRows(rows: Array<Record<string, unknown>>): string | null {
  for (const row of rows) {
    const bulan = String(row.bulan ?? row.BULAN ?? '').trim();
    const bulan2 = String(row.bulan2 ?? row['BULAN 2'] ?? row.bulan_2 ?? '').trim();
    // Try BULAN first (has year info)
    for (const candidate of [bulan, bulan2, `${bulan2} 2026`]) {
      if (candidate) {
        const parsed = parseMonthFromFilename(candidate);
        if (parsed) return parsed.monthLabel;
      }
    }
  }
  return null;
}

/**
 * Stage 1 — validate input + resolve file metadata.
 * Returns either a short-circuit response or the validated input.
 */
export async function validateInput(req: NextRequest): Promise<ValidateInputOutcome> {
  // P2-12 fix: rate limit
  const ip = getClientIP(req);
  const rl = rateLimit(`ingest-process:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
  if (!rl.allowed) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 }
      ),
    };
  }

  const body = await req.json();

  // Sprint 1: Zod input validation (mode/fileName/fileHash required by route)
  const validation = validateBody(ingestProcessBodySchema, body);
  if (!validation.success) {
    return {
      kind: 'response',
      response: NextResponse.json({ success: false, error: validation.error }, { status: 400 }),
    };
  }

  const { mode, fileName: rawFileName, fileHash, fileSize, ext, manualFileName, numberLocale } = body as Record<string, unknown>;

  if (!mode || !rawFileName || !fileHash) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: 'Missing required fields: mode, fileName, fileHash' },
        { status: 400 }
      ),
    };
  }

  // Validate numberLocale if provided (default 'auto' for local file uploads)
  const validLocales = ['auto', 'id', 'us'];
  const locale: 'auto' | 'id' | 'us' = validLocales.includes(numberLocale as string) ? (numberLocale as 'auto' | 'id' | 'us') : 'auto';

  // ============================================================
  // Manual rename support (user override for "Loading Google Sheet" etc.)
  // Uses shared validateManualFileName helper from @/lib/filename for
  // consistency with /api/import-drive (AUDIT-RENAME-2,3,4,9 fix).
  // When manual mode is active, the auto-extract-from-Excel-data fallback
  // is SKIPPED — user explicitly chose this name.
  // ============================================================
  let effectiveRawFileName = rawFileName as string;
  let manualMode = false;
  if (manualFileName && typeof manualFileName === 'string' && (manualFileName as string).trim()) {
    const result = validateManualFileName(manualFileName as string);
    if (!result.ok) {
      return {
        kind: 'response',
        response: NextResponse.json(
          { success: false, error: result.error || 'manualFileName tidak valid.' },
          { status: 400 }
        ),
      };
    }
    effectiveRawFileName = result.cleaned;
    manualMode = true;
    logger.info(`[ingest-process] manual rename: "${rawFileName}" → "${effectiveRawFileName}"`);
  }

  // FIX-A-1 (BUG-5-1): validate fileHash + ext BEFORE reassembleFile to prevent
  // path traversal via malicious fileHash (e.g., "../../etc/cron.d/evil") or ext
  // (e.g., ".php"). Without this, path.join('/tmp/ingest-process', `${fileHash}${ext}`)
  // could escape the intended directory.
  const metaCheck = validateFileMetadata(fileHash, ext);
  if (!metaCheck.ok) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: metaCheck.error },
        { status: 400 }
      ),
    };
  }
  const safeFileHash = metaCheck.fileHash;
  // Resolve final ext: validated client-supplied ext, else fall back to fileName extension.
  const fileExt = metaCheck.ext || path.extname(rawFileName as string).toLowerCase();
  if (!fileExt || !SAFE_EXT_ALLOWLIST.has(fileExt)) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: `Unsupported file extension: "${fileExt}". Allowed: ${[...SAFE_EXT_ALLOWLIST].join(', ')}.` },
        { status: 400 }
      ),
    };
  }

  // FIX: Sanitize fileName — if it's a Google Sheets placeholder like "Loading…",
  // "Loading Google Sheet", or contains those words, we need to extract the real
  // month from the Excel data (BULAN/BULAN 2 fields) after parsing.
  let fileName = effectiveRawFileName;
  // Strip Google Sheets suffixes (only relevant in auto mode; manual name already cleaned)
  if (!manualMode) {
    fileName = fileName.replace(/\s*-\s*Google\s+(Sheets|試算表|Spreadsheet|Drive).*$/i, '').trim();
  }

  // Check if filename is a placeholder — if so, we'll fix it after parsing Excel
  const fileNameIsPlaceholder = isPlaceholderName(fileName);

  // Try to parse month from filename. If placeholder, this will likely fail —
  // we'll re-parse from Excel data after parseExcelFile.
  const monthInfo = parseMonthFromFilename(fileName);
  // (fileExt already validated above via validateFileMetadata — do NOT recompute from raw `ext`.)

  return {
    kind: 'continue',
    input: {
      mode: mode as 'detect' | 'import' | 'import-all',
      fileName,
      rawFileName: rawFileName as string,
      safeFileHash,
      fileExt,
      manualMode,
      fileNameIsPlaceholder,
      locale,
      monthInfo,
      body: body as Record<string, unknown>,
    },
  };
}
