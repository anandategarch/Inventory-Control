// ============================================================
//  file-reassembly — chunk reassembly + /tmp temp-file reuse
//  --------------------------------------------------------
//  Extracted from the original 963-line ingest-process route.ts
//  (REFACTOR-1-a pure-move split). Hosts the path-traversal
//  metadata guard (FIX-A-1 / BUG-5-1), the DB-chunk → /tmp file
//  reassembly, and the PERF-UPLOAD-5 temp-file reuse check shared
//  by all three POST modes (detect / import / import-all).
// ============================================================
import { db } from '@/lib/db';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

// FIX-A-1 (BUG-5-1): Sanitize fileHash + ext to prevent path traversal in reassembleFile.
// fileHash must be a hex string (SHA-256 / SHA-512 hex) — no '..', '/', ':', etc.
// ext must be in the upload allowlist. Reject otherwise with 400 before any disk I/O.
const SAFE_FILEHASH_RE = /^[a-f0-9]{8,128}$/i;
export const SAFE_EXT_ALLOWLIST = new Set(['.xlsx', '.xls', '.csv']);

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

// Reassemble file from DB chunks
export async function reassembleFile(fileHash: string, ext: string): Promise<string> {
  const chunks = await db.fileChunk.findMany({
    where: { fileHash },
    orderBy: { chunkIndex: 'asc' },
    select: { chunkIndex: true, data: true, totalChunks: true },
  });

  if (chunks.length === 0) {
    throw new Error('No chunks found in DB. Upload ulang file.');
  }

  // P2-11 fix: validate chunk count matches expected total
  const expectedTotal = chunks[0]?.totalChunks || 0;
  if (expectedTotal > 0 && chunks.length !== expectedTotal) {
    throw new Error(`Chunk count mismatch: expected ${expectedTotal}, got ${chunks.length}. Upload corrupt atau tidak lengkap.`);
  }

  // Concatenate chunks
  const buffers = chunks.map(c => c.data);
  const combined = Buffer.concat(buffers);

  // Write to /tmp (this is a SINGLE invocation, so /tmp works here)
  const tmpDir = '/tmp/ingest-process';
  if (!existsSync(tmpDir)) {
    await fs.mkdir(tmpDir, { recursive: true });
  }
  const filePath = path.join(tmpDir, `${fileHash}${ext}`);
  await fs.writeFile(filePath, combined);

  return filePath;
}

// PERF-UPLOAD-5: /tmp file reuse between detect → import(-all).
// `detect` leaves the reassembled file at a content-addressed path
// (/tmp/ingest-process/{fileHash}{ext}) for exactly this purpose. The import
// call previously re-downloaded EVERY chunk from Postgres and re-wrote the
// byte-identical file — up to 50MB transferred + reassembled again, seconds
// of pure waste on every upload. Reuse the temp file when present AND
// size-matched (advisory check — `fileSize` comes from the server-verified
// last-chunk sum, FIX-A-3, so a mismatch means a truncated stale temp file
// from an interrupted invocation → fall back to full reassembly). On a cold
// serverless instance there is no temp file → transparent fallback to the
// old chunk-assembly path. fileHash is SHA-256 of content, so a present
// file at this path is byte-identical to what reassembly would produce.
export async function reuseTempFile(fileHash: string, ext: string, expectedSize: number): Promise<string | null> {
  const filePath = path.join('/tmp/ingest-process', `${fileHash}${ext}`);
  try {
    const st = await fs.stat(filePath);
    if (expectedSize > 0 && st.size !== expectedSize) return null;
    return filePath;
  } catch {
    return null; // not present (cold instance / different invocation) → reassemble
  }
}
