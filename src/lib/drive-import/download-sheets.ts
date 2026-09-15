// ============================================================
//  Drive Import — Google Sheets → CSV download
//  ----------------------------------------------------------
//  Download a Google Sheets as .csv file (DIRECT CSV export!)
//  Uses /export?format=csv endpoint — downloads as CSV directly.
//  NO Excel parsing needed! Memory usage: ~0 (stream to disk).
//
//  This is the most efficient way to import Google Sheets:
//    Google Sheets → CSV (direct download) → stream parse → DB
//  Memory: ~5MB total (1 row at a time during parse)
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../logger';
import { FETCH_TIMEOUT_MS, readTextCapped, pipelineWithByteCap } from './http-safety';

export async function downloadGoogleSheetsAsCsv(
  sheetId: string,
  fileName: string,
  destDir: string
): Promise<{ localPath: string; size: number }> {
  await fs.mkdir(destDir, { recursive: true });
  // Ensure filename ends with .csv
  if (!fileName.toLowerCase().endsWith('.csv')) {
    fileName = `${fileName}.csv`;
  }
  const localPath = path.join(destDir, fileName);

  // Export URL — downloads as CSV directly (no Excel parsing needed!)
  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  const res = await fetch(exportUrl, {
    // FIX (BUG-3-c SEDANG-2): 60s abort — a hung Sheets export used to stall
    // until the 300s maxDuration kill.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/csv, application/octet-stream, */*',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`Google Sheets CSV export failed: HTTP ${res.status} ${res.statusText}. Make sure the spreadsheet is shared as "Anyone with link can view".`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // FIX (BUG-3-c SEDANG-2): bounded read (only the first 300 chars are used
    // in the error sample — no need to buffer the whole sign-in page).
    const sample = (await readTextCapped(res, 64 * 1024)).slice(0, 300);
    throw new Error(`Google Sheets returned HTML. Spreadsheet may require sign-in. Sample: ${sample}`);
  }

  if (!res.body) throw new Error('No response body');
  // FIX (BUG-3-c SEDANG-2): byte-capped pipeline — a huge sheet can no longer
  // fill /tmp (partial file is unlinked on cap breach).
  await pipelineWithByteCap(res, localPath);

  const stat = await fs.stat(localPath);
  if (stat.size < 1024) {
    const content = await fs.readFile(localPath, 'utf-8');
    await fs.unlink(localPath);
    throw new Error(`CSV file too small (${stat.size} bytes). Content: ${content.slice(0, 200)}`);
  }

  return { localPath, size: stat.size };
}

// ============================================================
//  Fetch Google Sheets metadata (title) for filename
//  FIX: Google Sheets initial HTML may have <title>Loading…</title>
//  as placeholder before JS loads the real title. We skip placeholder
//  titles and prefer og:title / aria-label / docs-name fallbacks.
//
//  Exported for ./import-url.ts (the orchestrator) — NOT re-exported
//  by the folder barrel (internal to ./drive-import/*), preserving the
//  old module's public API.
// ============================================================
export async function getSheetsTitle(sheetId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`, {
      // FIX (BUG-3-c SEDANG-2): 60s abort + bounded HTML read below.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // The Sheets edit page is a heavy single-page app shell — legitimately
    // up to a few MB. Capped so a hostile response can't balloon memory.
    const html = await readTextCapped(res, 5 * 1024 * 1024);

    // FIX: list of placeholder titles Google uses during loading.
    // These should NOT be used as the real filename.
    const PLACEHOLDER_TITLES = [
      'loading',
      'loading…',
      'loading...',
      'google sheets',
      'google 試算表',
      'google spreadsheets',
      'untitled spreadsheet',
      '',
    ];
    const isPlaceholder = (t: string | null | undefined): boolean => {
      if (!t) return true;
      const lower = t.trim().toLowerCase();
      return PLACEHOLDER_TITLES.includes(lower);
    };

    // Strategy 1: og:title meta tag (most reliable — populated server-side)
    const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogMatch && !isPlaceholder(ogMatch[1])) {
      return ogMatch[1].trim();
    }

    // Strategy 2: <title> tag — strip " - Google Sheets" / " - Google 試算表" suffix
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      const rawTitle = titleMatch[1]
        .replace(/\s*-\s*Google\s+(Sheets|試算表|Spreadsheets)\s*$/i, '')
        .replace(/\s*-\s*Google\s*$/i, '')
        .trim();
      if (!isPlaceholder(rawTitle)) return rawTitle;
    }

    // Strategy 3: docs-name (aria-label on the title input) — populated after JS render
    // Format: <input ... id="docs-title" ... aria-label="Sheet Name" ...>
    const ariaMatch = html.match(/id="docs-title-input"[^>]*aria-label="([^"]+)"/i)
      || html.match(/id="docs-title"[^>]*value="([^"]+)"/i)
      || html.match(/docs-name="([^"]+)"/i);
    if (ariaMatch && !isPlaceholder(ariaMatch[1])) {
      return ariaMatch[1].trim();
    }

    // Strategy 4: og:description often contains the sheet title
    const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (descMatch && !isPlaceholder(descMatch[1])) {
      return descMatch[1].trim();
    }

    return null;
  } catch (e) {
    logger.error("[drive-import] getSheetsTitle failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return null;
}
