// ============================================================
//  Google Drive Import Service
//  ----------------------------------------------------------
//  Reads folder/file links from Google Drive (public links only),
//  downloads .xlsx files, and feeds them to the existing ingestion pipeline.
//
//  Supported URL formats:
//    - Folder:        https://drive.google.com/drive/folders/{FOLDER_ID}
//    - File (Drive):  https://drive.google.com/file/d/{FILE_ID}/view
//    - Open:          https://drive.google.com/open?id={FILE_ID}
//    - Direct:        https://drive.google.com/uc?id={FILE_ID}
//    - Sheets:        https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit
//                     (auto-exported as .xlsx via /export?format=xlsx)
//    - Raw ID:        {FILE_ID} (44 chars typical)
// ============================================================
import { logger } from './logger';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveImportResult {
  folderId: string | null;
  downloadedFiles: Array<{
    fileName: string;
    localPath: string;
    size: number;
    success: boolean;
    error?: string;
  }>;
}

// ============================================================
//  FIX (BUG-3-c SEDANG-2): network hardening — every fetch gets an
//  AbortSignal timeout, every download gets a byte cap, and every
//  res.text() on an HTML body is bounded. Previously a hung / hostile
//  Google endpoint could stall the route until the 300s maxDuration
//  kill ("import drive muter terus") or fill /tmp with an unbounded
//  download.
// ============================================================

// Every fetch carries a 60s abort — Google endpoints normally answer in
// <5s; 60s only trips on a genuinely hung connection.
const FETCH_TIMEOUT_MS = 60_000;
// Folder listing is a single small HTML page — 30s is plenty.
const FOLDER_LIST_TIMEOUT_MS = 30_000;

// Hard cap per downloaded file (mirrors the upload path's limit — keep in
// sync with MAX_TOTAL_SIZE in src/app/api/ingest-upload/route.ts, which is
// NOT exported because importing a route module from a lib would drag its
// route-specific Next.js machinery into this module's import graph).
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * FIX (BUG-3-c SEDANG-2): read an HTML/text response body WITHOUT trusting
 * its size. `await res.text()` buffered whatever the server chose to send —
 * a hostile/broken endpoint could stream gigabytes into memory. The declared
 * Content-Length is checked first (cheap reject), then the body is streamed
 * and reading stops (reader.cancel()) once the cap is exceeded.
 */
async function readTextCapped(res: Response, capBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > capBytes) {
    throw new Error(`Response body too large: ${declared} bytes (limit ${capBytes})`);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received > capBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return out;
}

/**
 * FIX (BUG-3-c SEDANG-2): stream a response body to disk while enforcing a
 * byte cap. A plain `pipeline(stream, fileStream)` happily wrote until the
 * disk filled — the counter destroys the source stream once the cap is
 * exceeded, which makes `pipeline` reject with that error; the partial file
 * is removed so /tmp (Vercel's tiny ephemeral disk) never accumulates it.
 */
async function pipelineWithByteCap(
  res: Response,
  localPath: string,
): Promise<void> {
  const source = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream<Uint8Array>);
  let received = 0;
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_DOWNLOAD_BYTES) {
      // Destroying the readable makes pipeline() reject with this error.
      source.destroy(new Error(
        `Download exceeded ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit (got ${received} bytes)`,
      ));
    }
  });
  const fileStream = createWriteStream(localPath);
  try {
    await pipeline(source, fileStream);
  } catch (e) {
    // Remove the partial file — a truncated xlsx/csv is unusable and only
    // wastes the shared /tmp space.
    await fs.unlink(localPath).catch(() => {});
    throw e;
  }
}

// ============================================================
//  Extract ID + type from various Google URL formats
//  Returns type: 'folder' | 'file' | 'sheets'
// ============================================================
export type DriveIdType = { type: 'folder' | 'file' | 'sheets'; id: string };

export function extractDriveId(url: string): DriveIdType | null {
  if (!url) return null;
  const trimmed = url.trim();

  // Google Sheets: https://docs.google.com/spreadsheets/d/{ID}/edit?usp=sharing
  // Also matches /view, /copy, /export, /htmlview, etc.
  let m = trimmed.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'sheets', id: m[1] };

  // Folder: https://drive.google.com/drive/folders/{ID} or with query
  m = trimmed.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'folder', id: m[1] };

  // File: https://drive.google.com/file/d/{ID}/view (or any path after ID)
  m = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'file', id: m[1] };

  // Open: https://drive.google.com/open?id={ID}
  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'file', id: m[1] };

  // Raw ID only (44 chars typical for Drive files)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return { type: 'file', id: trimmed };
  }

  return null;
}

// ============================================================
//  List files in a public Google Drive folder
//  Uses the embedded folder view (no API key required)
// ============================================================
export async function listDriveFolderFiles(folderId: string): Promise<DriveFile[]> {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  const res = await fetch(url, {
    // FIX (BUG-3-c SEDANG-2): folder listing is one small HTML page — 30s
    // abort keeps a hung connection from eating the route's 300s budget.
    signal: AbortSignal.timeout(FOLDER_LIST_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch folder listing: HTTP ${res.status}`);
  }
  // FIX (BUG-3-c SEDANG-2): bounded read — the listing HTML grows with the
  // file count, so cap it generously (a folder with 10k entries ≈ 2-4MB).
  const html = await readTextCapped(res, 5 * 1024 * 1024);

  // ============================================================
  //  Parse HTML — each file entry has this structure:
  //    <div class="flip-entry" id="entry-{FILE_ID}" ...>
  //      <a href="https://drive.google.com/file/d/{FILE_ID}/view?usp=drive_web" ...>
  //        ...
  //        <div class="flip-entry-title">{FILENAME}</div>
  //      </a>
  //    </div>
  //
  //  Strategy: extract (entry_id, file_id) pairs via the reliable file/d/ link,
  //  then match each to its filename via the flip-entry-title.
  // ============================================================
  const files: DriveFile[] = [];

  // Find all entry blocks — each starts with <div class="flip-entry" id="entry-... and ends before the next one
  const entryBlocks: Array<{ fileId: string; block: string }> = [];
  // Bug 5 fix: limit [^>]* to {0,500} to prevent ReDoS catastrophic backtracking
  const entryStartRegex = /<div class="flip-entry"[^>]{0,500}id="entry-([^"]{1,100})"[^>]{0,500}>/g;
  const starts: Array<{ fileId: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = entryStartRegex.exec(html)) !== null) {
    starts.push({ fileId: m[1], index: m.index });
  }

  // For each entry, extract the block from its start to the next entry's start (or end of html)
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const block = html.slice(start, end);

    // Verify the file ID appears in a file/d/ link (confirms it's a real file, not a folder/sub-element)
    // Bug 5 fix: limit [^"\/]+ to {1,200}
    const fileLinkMatch = block.match(/href="https:\/\/drive\.google\.com\/file\/d\/([^"\/]{1,200})\/view/);
    const realFileId = fileLinkMatch ? fileLinkMatch[1] : starts[i].fileId;

    // Extract filename from flip-entry-title
    // Bug 5 fix: limit [^<]+ to {1,300}
    const titleMatch = block.match(/class="flip-entry-title">([^<]{1,300})</);
    if (titleMatch) {
      const name = titleMatch[1].trim();
      if (name.toLowerCase().endsWith('.xlsx') && !name.startsWith('~$')) {
        files.push({
          id: realFileId,
          name,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
    }
  }

  // Deduplicate by file ID (in case of duplicate matches)
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  return unique;
}

// ============================================================
//  Download a single file from Google Drive
//  Handles "virus scan warning" for large files via multiple strategies
// ============================================================
export async function downloadDriveFile(
  fileId: string,
  fileName: string,
  destDir: string
): Promise<{ localPath: string; size: number }> {
  await fs.mkdir(destDir, { recursive: true });
  // Bug: sanitize fileName — Google Drive title could contain path traversal chars
  const safeFileName = path.basename(fileName).replace(/[^\w.\- ]/g, '_');
  const localPath = path.join(destDir, safeFileName);

  // Strategy 1: Try the direct usercontent URL (most reliable for public files)
  // Google Drive redirects uc?export=download → drive.usercontent.google.com/download?id=
  // We hit the redirect target directly to avoid cookie/redirect issues.
  const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

  let res = await fetch(directUrl, {
    // FIX (BUG-3-c SEDANG-2): 60s abort — a hung Drive connection used to
    // stall until the 300s maxDuration kill.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/octet-stream, application/binary, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  // Strategy 2: If we got HTML (virus scan page), parse for confirm token
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // FIX (BUG-3-c SEDANG-2): the virus-scan interstitial is a small form
    // page — bounded read instead of a raw res.text().
    const html = await readTextCapped(res, 512 * 1024);

    // Try to extract confirm token from form action
    // Bug 5 fix: limit [^"]* to {0,500} to prevent ReDoS
    const confirmMatch = html.match(/action="([^"]{0,500}confirm=([^"&]{1,100})[^"]{0,500})"/);
    if (confirmMatch) {
      const confirmUrl = confirmMatch[1].replace(/&amp;/g, '&');
      // FIX (AUDIT-SECURITY-PERF H2): validate confirmUrl hostname against Google
      // domains before fetching — prevents SSRF via malicious confirm-token URL
      // (attacker could craft a form action pointing to internal services).
      const ALLOWED_DOMAINS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
      let confirmParsed: URL;
      try {
        confirmParsed = new URL(confirmUrl);
      } catch {
        throw new Error(`Invalid confirm URL from Google response`);
      }
      const confirmAllowed = ALLOWED_DOMAINS.some(d => confirmParsed.hostname === d || confirmParsed.hostname.endsWith('.' + d));
      if (!confirmAllowed) {
        throw new Error(`Confirm URL hostname "${confirmParsed.hostname}" not in Google allowlist — possible SSRF`);
      }
      res = await fetch(confirmUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': res.headers.get('set-cookie') || '',
        },
        redirect: 'follow',
      });
    } else {
      // Strategy 3: Try uc?export=download with confirm=t
      const altUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
      res = await fetch(altUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        redirect: 'follow',
      });
    }
  }

  // Final check — if still HTML, file is not accessible
  const finalContentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  if (finalContentType.includes('text/html')) {
    const sample = (await readTextCapped(res, 4 * 1024)).slice(0, 200);
    throw new Error(`Got HTML page instead of file. File may require sign-in or is not shared publicly. Sample: ${sample}`);
  }

  // Stream the file to disk
  // FIX (BUG-3-c SEDANG-2): byte-capped pipeline — destroys the stream and
  // rejects once the download exceeds MAX_DOWNLOAD_BYTES (partial file is
  // unlinked), so a hostile/misbehaving endpoint can't fill /tmp.
  if (!res.body) throw new Error('No response body');
  await pipelineWithByteCap(res, localPath);

  const stat = await fs.stat(localPath);
  // Sanity check — file should be at least 1KB (valid xlsx is typically >5KB)
  if (stat.size < 1024) {
    const content = await fs.readFile(localPath, 'utf-8');
    await fs.unlink(localPath);
    throw new Error(`Downloaded file too small (${stat.size} bytes). Content: ${content.slice(0, 200)}`);
  }

  return { localPath, size: stat.size };
}

// ============================================================
//  Download a Google Sheets as .csv file (DIRECT CSV export!)
//  ----------------------------------------------------------
//  Uses /export?format=csv endpoint — downloads as CSV directly.
//  NO Excel parsing needed! Memory usage: ~0 (stream to disk).
//
//  This is the most efficient way to import Google Sheets:
//    Google Sheets → CSV (direct download) → stream parse → DB
//  Memory: ~5MB total (1 row at a time during parse)
// ============================================================
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
// ============================================================
async function getSheetsTitle(sheetId: string): Promise<string | null> {
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

// ============================================================
//  Main entry point: import from Google Drive URL
//  Supports: folder, file, sheets
// ============================================================
export async function importFromDriveUrl(
  url: string,
  destDir: string
): Promise<DriveImportResult> {
  const parsed = extractDriveId(url);
  if (!parsed) {
    throw new Error(
      'Invalid Google URL. Supported formats:\n' +
      '• Google Drive folder: https://drive.google.com/drive/folders/...\n' +
      '• Google Drive file:   https://drive.google.com/file/d/...\n' +
      '• Google Sheets:       https://docs.google.com/spreadsheets/d/...'
    );
  }

  const downloadedFiles: DriveImportResult['downloadedFiles'] = [];

  if (parsed.type === 'folder') {
    // List all files in folder
    const files = await listDriveFolderFiles(parsed.id);
    if (files.length === 0) {
      throw new Error(`No .xlsx files found in the Google Drive folder (ID: ${parsed.id}). Make sure the folder is shared as "Anyone with link can view".`);
    }

    // Download each file
    for (const file of files) {
      try {
        const { localPath, size } = await downloadDriveFile(file.id, file.name, destDir);
        downloadedFiles.push({ fileName: file.name, localPath, size, success: true });
      } catch (e: unknown) {
        downloadedFiles.push({
          fileName: file.name,
          localPath: '',
          size: 0,
          success: false,
          error: (e instanceof Error ? e.message : String(e)),
        });
      }
    }

    return { folderId: parsed.id, downloadedFiles };

  } else if (parsed.type === 'sheets') {
    // Google Sheets — export as CSV directly (no Excel parsing needed!)
    try {
      const title = await getSheetsTitle(parsed.id);
      let fileName = title || `google_sheets_${parsed.id}`;
      fileName = fileName.replace(/[<>:"/\\|?*]/g, '_').trim();
      // Use .csv extension (downloaded as CSV directly)
      if (!fileName.toLowerCase().endsWith('.csv')) {
        fileName = `${fileName}.csv`;
      }

      const { localPath, size } = await downloadGoogleSheetsAsCsv(parsed.id, fileName, destDir);
      downloadedFiles.push({ fileName, localPath, size, success: true });
    } catch (e: unknown) {
      downloadedFiles.push({
        fileName: '',
        localPath: '',
        size: 0,
        success: false,
        error: (e instanceof Error ? e.message : String(e)),
      });
    }

    return { folderId: null, downloadedFiles };

  } else {
    // Single Google Drive file
    try {
      // First, get file name from Drive metadata
      const metaRes = await fetch(`https://drive.google.com/file/d/${parsed.id}/view`, {
        // FIX (BUG-3-c SEDANG-2): 60s abort — this is best-effort name
        // detection (the fallback name below is used on any failure).
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      let fileName = `drive_file_${parsed.id}.xlsx`;
      if (metaRes.ok) {
        // FIX (BUG-3-c SEDANG-2): bounded read — only the <title> tag is
        // extracted from this page.
        const html = await readTextCapped(metaRes, 2 * 1024 * 1024);
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          // Title format is usually "filename - Google Drive"
          const rawTitle = titleMatch[1].replace(/\s*-\s*Google Drive\s*$/i, '').trim();
          if (rawTitle && rawTitle.toLowerCase().endsWith('.xlsx')) {
            fileName = rawTitle;
          }
        }
      }

      const { localPath, size } = await downloadDriveFile(parsed.id, fileName, destDir);
      downloadedFiles.push({ fileName, localPath, size, success: true });
    } catch (e: unknown) {
      downloadedFiles.push({
        fileName: '',
        localPath: '',
        size: 0,
        success: false,
        error: (e instanceof Error ? e.message : String(e)),
      });
    }

    return { folderId: null, downloadedFiles };
  }
}
