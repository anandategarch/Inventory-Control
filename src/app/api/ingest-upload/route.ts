// ============================================================
//  /api/ingest-upload — Chunked upload, chunks stored in DB
//  Vercel /tmp doesn't persist between invocations, so we
//  store each chunk in FileChunk table. Last chunk returns
//  metadata so frontend can call /api/ingest-process.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateBody, ingestUploadBodySchema } from '@/lib/validation';
import path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// FIX-A-3 (BUG-5-4): Per-chunk + total-file size limits enforced SERVER-SIDE.
// Client-provided `fileSize` is NO LONGER TRUSTED — an attacker could send
// fileSize=0 to bypass the old 50MB check. Actual size is computed by summing
// stored chunk byte lengths from the DB after the last chunk arrives.
const MAX_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk — bounds RAM per request
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total per uploaded file

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-upload:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const chunk = formData.get('chunk') as File | null;
    const chunkIndexStr = formData.get('chunkIndex') as string | null;
    const totalChunksStr = formData.get('totalChunks') as string | null;
    const fileName = formData.get('fileName') as string | null;
    const fileHash = formData.get('fileHash') as string | null;
    // fileSizeStr kept for backward-compat with the client, but is NO LONGER TRUSTED
    // for size enforcement (see FIX-A-3). Actual size is computed server-side below.
    const fileSizeStr = formData.get('fileSize') as string | null;

    // Sprint 1: Zod input validation (scalar form fields; `chunk` File validated by size checks below)
    const validation = validateBody(ingestUploadBodySchema, {
      fileHash: fileHash ?? undefined,
      chunkIndex: chunkIndexStr ?? undefined,
      totalChunks: totalChunksStr ?? undefined,
      fileName: fileName ?? undefined,
      fileSize: fileSizeStr ?? undefined,
    });
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    if (!chunk || chunkIndexStr === null || totalChunksStr === null || !fileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields.' },
        { status: 400 }
      );
    }

    const chunkIndex = parseInt(chunkIndexStr, 10);
    const totalChunks = parseInt(totalChunksStr, 10);
    const ext = path.extname(fileName).toLowerCase();

    if (ext !== '.xlsx' && ext !== '.csv') {
      return NextResponse.json(
        { success: false, error: `Format tidak didukung: ${ext}. Hanya .xlsx dan .csv.` },
        { status: 400 }
      );
    }

    // FIX-A-3 (BUG-5-4): per-chunk size validation — check ACTUAL chunk.size
    // server-side BEFORE calling chunk.arrayBuffer() (which loads the whole chunk
    // into RAM). Prevents OOM from a single oversized chunk.
    if (chunk.size > MAX_CHUNK_SIZE) {
      return NextResponse.json(
        { success: false, error: `Chunk terlalu besar: ${(chunk.size / 1024 / 1024).toFixed(1)}MB. Maks ${MAX_CHUNK_SIZE / 1024 / 1024}MB per chunk.` },
        { status: 413 }
      );
    }

    // Store chunk in DB (persistent across function invocations)
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());
    await db.fileChunk.upsert({
      where: {
        fileHash_chunkIndex: { fileHash, chunkIndex },
      },
      update: {
        data: chunkBuffer,
        totalChunks, // P2-11 fix: store totalChunks for validation
      },
      create: {
        fileHash,
        chunkIndex,
        totalChunks,
        data: chunkBuffer,
      },
    });

    // If not last chunk, return progress
    if (chunkIndex < totalChunks - 1) {
      return NextResponse.json({
        success: true,
        received: chunkIndex,
        totalChunks,
        progress: ((chunkIndex + 1) / totalChunks) * 100,
      });
    }

    // FIX-A-3 (BUG-5-4): Last chunk — verify ACCUMULATED size server-side.
    // Do NOT trust client-provided `fileSize`. Sum actual chunk byte lengths
    // from the DB; if total exceeds MAX_TOTAL_SIZE, reject and delete all
    // chunks to free DB space (avoid orphaned chunk buildup).
    const allChunks = await db.fileChunk.findMany({
      where: { fileHash },
      select: { data: true },
    });
    const totalBytes = allChunks.reduce((sum, c) => sum + c.data.length, 0);
    if (totalBytes > MAX_TOTAL_SIZE) {
      await db.fileChunk.deleteMany({ where: { fileHash } }).catch(() => {});
      return NextResponse.json(
        { success: false, error: `File terlalu besar: ${(totalBytes / 1024 / 1024).toFixed(1)}MB. Maks ${MAX_TOTAL_SIZE / 1024 / 1024}MB.` },
        { status: 413 }
      );
    }

    // DA-03: Add audit log on final chunk upload (forensic trail for file uploads)
    if (chunkIndex === totalChunks - 1) {
      db.auditLog.create({
        data: {
          action: 'INGEST_UPLOAD',
          detail: `File: ${fileName} (${(totalBytes / 1024 / 1024).toFixed(1)}MB, ${totalChunks} chunks, hash: ${fileHash.slice(0, 16)})`,
        },
      }).catch(() => {});
    }

    // Last chunk — return metadata for processing
    return NextResponse.json({
      success: true,
      uploaded: true,
      fileHash,
      fileName,
      fileSize: totalBytes, // FIX-A-3: return server-verified total (not client-provided)
      ext,
      message: 'Upload selesai. Siap untuk processing.',
    });
  } catch (e: unknown) {
    logger.error("[ingest-upload] error:", { error: e });
    return NextResponse.json(
      { success: false, error: (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}
