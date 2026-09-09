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
    // PERF-UPLOAD-1: dedicated bucket (120/min) — chunk uploads are bounded
    // per-request (5MB) + total (50MB, FIX-A-3), so they don't need the heavy
    // 5/min ingest limit. The old shared bucket failed any file >20MB at
    // chunk #6 with a 429 ("upload lama" / retry loop).
    const rl = rateLimit(`ingest-upload:${ip}`, RATE_LIMITS.ingestUpload.maxRequests, RATE_LIMITS.ingestUpload.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
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
    // Do NOT trust client-provided `fileSize`.
    //
    // PERF-UPLOAD-2: the old implementation called findMany({ select: { data } })
    // and pulled EVERY chunk's full bytes out of Postgres (up to 50MB over the
    // network) just to compute a sum. That re-downloaded the entire file on
    // the LAST chunk of every upload — seconds of pure waste per upload.
    // Postgres computes it in-process instead: SUM(LENGTH(data)) is a TOAST-aware
    // aggregate that transfers only 2 small integers back.
    const [agg] = await db.$queryRaw<Array<{ chunk_count: bigint; total_bytes: bigint }>>`
      SELECT COUNT(*)::bigint AS chunk_count, COALESCE(SUM(LENGTH("data")), 0)::bigint AS total_bytes
      FROM "FileChunk"
      WHERE "fileHash" = ${fileHash}`;
    const totalBytes = Number(agg?.total_bytes ?? 0);
    // PERF-UPLOAD-3: also verify chunk COUNT — the last-arriving chunk must see
    // all totalChunks rows stored (guards against out-of-order delivery and
    // gives reassembleFile's P2-11 count check an earlier, clearer failure).
    const storedChunks = Number(agg?.chunk_count ?? 0);
    if (storedChunks !== totalChunks) {
      return NextResponse.json(
        { success: false, error: `Chunk belum lengkap: ${storedChunks}/${totalChunks} tersimpan. Upload ulang file.` },
        { status: 400 }
      );
    }
    if (totalBytes > MAX_TOTAL_SIZE) {
      await db.fileChunk.deleteMany({ where: { fileHash } }).catch(() => {});
      return NextResponse.json(
        { success: false, error: `File terlalu besar: ${(totalBytes / 1024 / 1024).toFixed(1)}MB. Maks ${MAX_TOTAL_SIZE / 1024 / 1024}MB.` },
        { status: 413 }
      );
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
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Internal server error" },
      { status: 500 }
    );
  }
}
