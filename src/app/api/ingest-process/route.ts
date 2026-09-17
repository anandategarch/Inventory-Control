// ============================================================
//  /api/ingest-process — Process uploaded Excel file
//  --------------------------------------------------------
//  Thin dispatcher (REFACTOR-1-a pure-move split of the former
//  963-line monolith):
//    - POST   → shared request preamble (rate limit, Zod, manual
//               rename, fileHash/ext sanitization, placeholder
//               detection) → dispatch to ./services/{detect,import,
//               import-all}-mode.ts
//    - DELETE → ./services/delete-mode.ts (cleanup chunks)
//  File reassembly helpers live in ./services/file-reassembly.ts.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { parseMonthFromFilename } from '@/lib/excel';
import { validateManualFileName } from '@/lib/filename';
import { validateBody, ingestProcessBodySchema } from '@/lib/validation';
import path from 'path';
import { validateFileMetadata, SAFE_EXT_ALLOWLIST } from './services/file-reassembly';
import { handleDetect } from './services/detect-mode';
import { handleImport } from './services/import-mode';
import { handleImportAll } from './services/import-all-mode';
import { handleDelete } from './services/delete-mode';
import type { IngestProcessContext } from './services/shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Max for Vercel — import can take 1-2 min for large weeks

// FIX: Sanitize fileName — if it's a Google Sheets placeholder like "Loading…",
// "Loading Google Sheet", or contains those words, we need to extract the real
// month from the Excel data (BULAN/BULAN 2 fields) after parsing.
const PLACEHOLDER_PATTERNS = [
  /loading/i,
  /google\s*(sheet|spreadsheet|試算表|drive)/i,
  /untitled/i,
];
const isPlaceholderName = (name: string): boolean => {
  const base = name.replace(/\.(xlsx|csv)$/i, '').trim();
  return PLACEHOLDER_PATTERNS.some(p => p.test(base));
};

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-process:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 }
      );
    }

    const body = await req.json();

    // Sprint 1: Zod input validation (mode/fileName/fileHash required by route)
    const validation = validateBody(ingestProcessBodySchema, body);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // FIX (BUG-3-c SEDANG-3): destructure from the VALIDATED payload (not the
    // raw body) — the schema's bounds (weekLabel format, ≤12 weeksToImport,
    // manualFileName length) used to be decorative because every consumer
    // below re-read the raw JSON.
    const { mode, fileName: rawFileName, fileHash, fileSize, ext, manualFileName, numberLocale } = validation.data;

    if (!mode || !rawFileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: mode, fileName, fileHash' },
        { status: 400 }
      );
    }

    // Validate numberLocale if provided (default 'auto' for local file uploads)
    const locale: 'auto' | 'id' | 'us' = numberLocale ?? 'auto';

    // ============================================================
    // Manual rename support (user override for "Loading Google Sheet" etc.)
    // Uses shared validateManualFileName helper from @/lib/filename for
    // consistency with /api/import-drive (AUDIT-RENAME-2,3,4,9 fix).
    // When manual mode is active, the auto-extract-from-Excel-data fallback
    // is SKIPPED — user explicitly chose this name.
    // ============================================================
    let effectiveRawFileName = rawFileName;
    let manualMode = false;
    if (manualFileName && typeof manualFileName === 'string' && manualFileName.trim()) {
      const result = validateManualFileName(manualFileName);
      if (!result.ok) {
        return NextResponse.json(
          { success: false, error: result.error || 'manualFileName tidak valid.' },
          { status: 400 }
        );
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
      return NextResponse.json(
        { success: false, error: metaCheck.error },
        { status: 400 }
      );
    }
    const safeFileHash = metaCheck.fileHash;
    // Resolve final ext: validated client-supplied ext, else fall back to fileName extension.
    const fileExt = metaCheck.ext || path.extname(rawFileName).toLowerCase();
    if (!fileExt || !SAFE_EXT_ALLOWLIST.has(fileExt)) {
      return NextResponse.json(
        { success: false, error: `Unsupported file extension: "${fileExt}". Allowed: ${[...SAFE_EXT_ALLOWLIST].join(', ')}.` },
        { status: 400 }
      );
    }

    let fileName = effectiveRawFileName;
    // Strip Google Sheets suffixes (only relevant in auto mode; manual name already cleaned)
    if (!manualMode) {
      fileName = fileName.replace(/\s*-\s*Google\s+(Sheets|試算表|Spreadsheet|Drive).*$/i, '').trim();
    }

    // Check if filename is a placeholder — if so, the mode handlers will fix it
    // after parsing Excel (extractMonthFromRows in ./services/shared).
    const fileNameIsPlaceholder = isPlaceholderName(fileName);

    // Try to parse month from filename. If placeholder, this will likely fail —
    // the mode handlers re-parse from Excel data after parseExcelFile.
    let monthInfo = parseMonthFromFilename(fileName);
    // (fileExt already validated above via validateFileMetadata — do NOT recompute from raw `ext`.)

    // Shared context consumed by all three mode handlers.
    // FIX (BUG-3-c SEDANG-3): ctx.body carries the VALIDATED payload
    // (validation.data) — mode handlers no longer read raw JSON.
    const ctx: IngestProcessContext = {
      startedAt,
      body: validation.data,
      rawFileName,
      fileName,
      monthInfo,
      manualMode,
      safeFileHash,
      fileExt,
      fileSize,
      locale,
      fileNameIsPlaceholder,
    };

    // ============================================================
    // MODE 1: DETECT — see ./services/detect-mode.ts
    // ============================================================
    if (mode === 'detect') {
      return handleDetect(ctx);
    }

    // ============================================================
    // MODE 2: IMPORT (one week) — see ./services/import-mode.ts
    // ============================================================
    if (mode === 'import') {
      return handleImport(ctx);
    }

    // ============================================================
    // MODE 3: IMPORT-ALL — see ./services/import-all-mode.ts
    // ============================================================
    if (mode === 'import-all') {
      return handleImportAll(ctx);
    }

    return NextResponse.json(
      { success: false, error: `Unknown mode: ${mode}. Use 'detect', 'import', or 'import-all'.` },
      { status: 400 }
    );
  } catch (e: unknown) {
    logger.error("[ingest-process] error", { error: e });
    // P23 D4: 'Internal server error' → ID — matches the 'Gagal …' convention
    // used by the sibling ingest/import services (e.g. 'Gagal parse Excel').
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Gagal memproses permintaan" },
      { status: 500 }
    );
  }
}

// Cleanup — delete chunks from DB after all weeks processed
// (handler in ./services/delete-mode.ts)
export async function DELETE(req: NextRequest) {
  return handleDelete(req);
}
