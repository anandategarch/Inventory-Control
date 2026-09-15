// ============================================================
//  Drive Import — network hardening helpers (internal)
//  ----------------------------------------------------------
//  FIX (BUG-3-c SEDANG-2): network hardening — every fetch gets an
//  AbortSignal timeout, every download gets a byte cap, and every
//  res.text() on an HTML body is bounded. Previously a hung / hostile
//  Google endpoint could stall the route until the 300s maxDuration
//  kill ("import drive muter terus") or fill /tmp with an unbounded
//  download.
//
//  NOT re-exported by the folder barrel — internal to ./drive-import/*.
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

// Every fetch carries a 60s abort — Google endpoints normally answer in
// <5s; 60s only trips on a genuinely hung connection.
export const FETCH_TIMEOUT_MS = 60_000;
// Folder listing is a single small HTML page — 30s is plenty.
export const FOLDER_LIST_TIMEOUT_MS = 30_000;

// Hard cap per downloaded file (mirrors the upload path's limit — keep in
// sync with MAX_TOTAL_SIZE in src/app/api/ingest-upload/route.ts, which is
// NOT exported because importing a route module from a lib would drag its
// route-specific Next.js machinery into this module's import graph).
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * FIX (BUG-3-c SEDANG-2): read an HTML/text response body WITHOUT trusting
 * its size. `await res.text()` buffered whatever the server chose to send —
 * a hostile/broken endpoint could stream gigabytes into memory. The declared
 * Content-Length is checked first (cheap reject), then the body is streamed
 * and reading stops (reader.cancel()) once the cap is exceeded.
 */
export async function readTextCapped(res: Response, capBytes: number): Promise<string> {
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
export async function pipelineWithByteCap(
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
